// The vault operations that can leave a user with no way in.
//
// Everything here is about a half-completed change of state: a browser that
// refuses IndexedDB midway through turning protection off, two Settings screens
// both switching it on, an iteration count that stops describing the wrapper it
// was written beside. None of these lose a byte on the happy path, and each of
// them ends with accounts nobody can open.

import { areas, check, faults, flush, resetFaults, resetState, scenario } from './harness';

const PASSWORD = 'correct horse battery staple';

const ACCOUNTS: any[] = [
  { id: 'a1', name: 'alice@example.com', issuer: 'GitHub', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, createdAt: 1 },
  { id: 'a2', name: 'bob@example.com', issuer: 'Google', secret: 'KRSXG5CTMVRXEZLU', algorithm: 'SHA1', digits: 6, period: 30, createdAt: 2 },
];

const storedRecords = (): any[] => (areas.local.authenticator_accounts as any[]) ?? [];
const isCleartext = (record: any) => typeof record?.secret === 'string';

export async function run(): Promise<void> {
  const storage = await import('@/utils/storage');
  const vault = await import('@/utils/vault');

  // Turning protection off writes cleartext to local and pushes it to sync
  // before it touches the snapshots. A throw between those steps left the
  // secrets in the clear on Google's servers under a vault that still read as
  // enabled — and the caller reported it as a wrong password.
  scenario('Turning the vault off finishes even when IndexedDB refuses');
  await resetState();
  await storage.saveAccounts(ACCOUNTS);
  await flush();
  await (await storage.prepareVault(PASSWORD)).commit();
  await flush();
  check('the records are encrypted to begin with', storedRecords().every(r => !isCleartext(r)));

  faults.indexedDB = true;
  let disableError: unknown = null;
  await storage.disableVault(PASSWORD).catch(err => {
    disableError = err;
  });
  resetFaults();
  await flush();

  check('disabling is not reported as a failure', disableError === null, String(disableError));
  check('the vault metadata is gone', areas.local.vault_meta === undefined);
  check(
    'cleartext on disk is never left under a live vault',
    (areas.local.vault_meta === undefined) === storedRecords().every(isCleartext),
    JSON.stringify({ meta: areas.local.vault_meta !== undefined, cleartext: storedRecords().map(isCleartext) })
  );
  const afterDisable = await storage.getAccounts();
  check('and both accounts survive', afterDisable.length === 2, String(afterDisable.length));

  // Settings can now be open in the floating window and the side panel at the
  // same time. Both pass the prepare-time check; the second commit used to
  // overwrite the first vault's metadata, so the recovery code the user had
  // just written onto paper opened nothing.
  scenario('A second vault setup cannot overwrite the first');
  await resetState();
  await storage.saveAccounts(ACCOUNTS);
  await flush();
  const first = await storage.prepareVault(PASSWORD);
  const second = await storage.prepareVault('a different password entirely');
  await first.commit();
  await flush();
  const vaultIdAfterFirst = (areas.local.vault_meta as any)?.vaultId;

  const secondOutcome = await second.commit().then(
    () => 'resolved',
    () => 'rejected'
  );
  await flush();
  check('the second commit is refused', secondOutcome === 'rejected', secondOutcome);
  check(
    'the first vault still owns the metadata',
    (areas.local.vault_meta as any)?.vaultId === vaultIdAfterFirst
  );
  await vault.lock();
  await vault.unlockWithPassword(PASSWORD);
  const reopened = await storage.getAccounts().catch(() => null);
  check('and the original password still opens it', reopened?.length === 2, JSON.stringify(reopened?.length));

  // unwrapWith derives at meta.iterations; changePassword built the wrapper at
  // the module default and carried the old count forward. Nothing but 600 000
  // has ever shipped, so this has never fired — a one-line bump of the
  // constant, or metadata arriving by sync from a build with a different one,
  // is the whole distance between here and a vault no password opens.
  //
  // The invariant is in two halves, and both are checked below: the count
  // written beside a new wrapper is the count that wrapper was built with, and
  // that field really does govern unwrapping — so the two drifting apart is
  // not cosmetic.
  scenario('Changing the password keeps the iteration count describing the wrapper');
  await resetState();
  await storage.saveAccounts(ACCOUNTS);
  await flush();
  await (await storage.prepareVault(PASSWORD)).commit();
  await flush();

  const { PBKDF2_ITERATIONS } = await import('@/utils/crypto');
  await vault.changePassword(PASSWORD, 'a brand new password');
  await flush();
  check(
    'the stored count is the one the new wrapper was built with',
    (await vault.getVaultMeta())!.iterations === PBKDF2_ITERATIONS,
    String((await vault.getVaultMeta())!.iterations)
  );
  await vault.lock();
  await vault.unlockWithPassword('a brand new password');
  const withNewPassword = await storage.getAccounts().catch(() => null);
  check('and the new password opens the vault', withNewPassword?.length === 2, JSON.stringify(withNewPassword?.length));

  // Why the line above is not decoration: point the field at any other number
  // and the same correct password stops working. A build that bumped the
  // constant while spreading the old count forward produced exactly this state
  // on every vault whose password was changed afterwards.
  scenario('A count that stops describing its wrapper locks the vault for good');
  const driftMeta = await vault.getVaultMeta();
  await vault.saveVaultMeta({ ...driftMeta!, iterations: driftMeta!.iterations - 1 });
  await flush();
  await vault.lock();
  const openedAfterDrift = await vault.unlockWithPassword('a brand new password').then(
    () => true,
    () => false
  );
  check('the correct password no longer unwraps the key', openedAfterDrift === false);
  await vault.saveVaultMeta(driftMeta!);
  await flush();

  scenario('Resetting with the recovery code keeps it in step too');
  await resetState();
  await storage.saveAccounts(ACCOUNTS);
  await flush();
  const prepared = await storage.prepareVault(PASSWORD);
  await prepared.commit();
  await flush();

  const rotated = await vault.resetPasswordWithRecoveryCode(prepared.recoveryCode, 'password after recovery');
  await flush();
  check(
    'the count is rewritten with the wrappers',
    (await vault.getVaultMeta())!.iterations === PBKDF2_ITERATIONS,
    String((await vault.getVaultMeta())!.iterations)
  );
  await vault.lock();
  await vault.unlockWithPassword('password after recovery');
  const afterRecovery = await storage.getAccounts().catch(() => null);
  check('the new password works', afterRecovery?.length === 2, JSON.stringify(afterRecovery?.length));
  await vault.lock();
  const codeWorks = await vault.unlockWithRecoveryCode(rotated).then(
    () => true,
    () => false
  );
  check('and so does the rotated recovery code', codeWorks);
}
