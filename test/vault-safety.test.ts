// The vault operations that can leave a user with no way in.
//
// Everything here is about a half-completed change of state: a browser that
// refuses IndexedDB midway through turning protection off, two Settings screens
// both switching it on, an iteration count that stops describing the wrapper it
// was written beside. None of these lose a byte on the happy path, and each of
// them ends with accounts nobody can open.

import { areas, check, faults, flush, resetFaults, resetState, scenario, storageContext, throwsNamed, withLatency, USER_ADD } from './harness';

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

  const reset = await vault.prepareRecovery(prepared.recoveryCode, 'password after recovery');
  await reset.commit();
  const rotated = reset.recoveryCode;
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

  // "Recovery didn't work", from a store review. The reset used to be saved
  // before its replacement code was shown. Saving writes the unlocked key to
  // session storage, the popup's storage listener reads that as an unlock and
  // swaps the lock screen for the account list — so the new code was on screen
  // for about 50 ms. The user got in once; the next forgotten password met a
  // code that had already been spent.
  //
  // What keeps the screen up is that preparing emits nothing the listener
  // accepts. That is what these checks pin down.
  const opens = (attempt: Promise<unknown>) => attempt.then(() => true, () => false);
  const heard: string[] = [];
  const listener = (changes: Record<string, unknown>, areaName: string) => {
    if (vault.affectsVaultSession(areaName, changes)) heard.push(Object.keys(changes).join(','));
  };

  scenario('Preparing a recovery writes nothing and unlocks nothing');
  await resetState();
  await storage.saveAccounts(ACCOUNTS);
  await flush();
  const original = await storage.prepareVault(PASSWORD);
  await original.commit();
  await flush();
  await vault.lock();
  await flush();

  const localMetaBefore = JSON.stringify(areas.local.vault_meta);
  const syncedMetaBefore = JSON.stringify(areas.sync.vault_meta);
  chrome.storage.onChanged.addListener(listener);
  const pending = await vault.prepareRecovery(original.recoveryCode, 'password after recovery');
  await flush();
  chrome.storage.onChanged.removeListener(listener);

  check('the popup hears nothing, so the new code stays on screen', heard.length === 0, JSON.stringify(heard));
  check('the vault is still locked', !(await vault.isUnlocked()));
  check('local metadata is byte-for-byte unchanged', JSON.stringify(areas.local.vault_meta) === localMetaBefore);
  check('and so is the synced copy', JSON.stringify(areas.sync.vault_meta) === syncedMetaBefore);
  check(
    'a replacement code is ready to show',
    pending.recoveryCode !== original.recoveryCode && /^[A-Z2-9]{5}(-[A-Z2-9]{5})+$/.test(pending.recoveryCode),
    pending.recoveryCode
  );

  // A popup that loses focus on that screen simply drops `pending`.
  scenario('Walking away from the new code leaves the old way in working');
  check('the original password still opens it', await opens(vault.unlockWithPassword(PASSWORD)));
  await vault.lock();
  check('and so does the original recovery code', await opens(vault.unlockWithRecoveryCode(original.recoveryCode)));
  await vault.lock();
  check(
    'the code from the abandoned screen opens nothing',
    await throwsNamed('WrongPasswordError', () => vault.unlockWithRecoveryCode(pending.recoveryCode))
  );

  scenario('Confirming the new code is what makes the reset real');
  heard.length = 0;
  chrome.storage.onChanged.addListener(listener);
  await pending.commit();
  await flush();
  chrome.storage.onChanged.removeListener(listener);
  check('the commit unlocks, and the popup hears it', heard.length > 0 && (await vault.isUnlocked()), JSON.stringify(heard));
  check('every account is readable', (await storage.getAccounts()).length === 2);
  await vault.lock();
  check('the spent code is refused', await throwsNamed('WrongPasswordError', () => vault.unlockWithRecoveryCode(original.recoveryCode)));
  check('the forgotten password is refused', await throwsNamed('WrongPasswordError', () => vault.unlockWithPassword(PASSWORD)));
  check('the new password opens it', await opens(vault.unlockWithPassword('password after recovery')));
  await vault.lock();
  check('the code the user typed back opens it', await opens(vault.unlockWithRecoveryCode(pending.recoveryCode)));
  await vault.lock();

  scenario('A second Finish does not write the reset twice');
  const revision = (await vault.getVaultMeta())!.rev;
  await pending.commit();
  check('the revision did not move', (await vault.getVaultMeta())!.rev === revision, `${revision} -> ${(await vault.getVaultMeta())!.rev}`);

  scenario('A wrong recovery code is refused before anything is built');
  const metaBeforeWrongCode = JSON.stringify(areas.local.vault_meta);
  check(
    'it reads as a wrong code, not as some other failure',
    await throwsNamed('WrongPasswordError', () => vault.prepareRecovery('AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFGGH', 'whatever password'))
  );
  check('and writes nothing', JSON.stringify(areas.local.vault_meta) === metaBeforeWrongCode);

  // The new-code screen is one the user lingers on, and another window can
  // turn protection off, or off and on again, meanwhile. The master key held by
  // a prepared reset opens only the vault it came from.
  scenario('A reset prepared against a vault that is gone or rebuilt is refused');
  const stale = await vault.prepareRecovery(pending.recoveryCode, 'stale reset password');
  await vault.unlockWithPassword('password after recovery');
  await storage.disableVault('password after recovery');
  await flush();
  let refusedWhileOff = false;
  try {
    await stale.commit();
  } catch {
    refusedWhileOff = true;
  }
  check('refused while protection is off', refusedWhileOff);
  check('and it did not bring a vault back', areas.local.vault_meta === undefined);

  const rebuilt = await storage.prepareVault('a rebuilt vault password');
  await rebuilt.commit();
  await flush();
  const rebuiltMeta = JSON.stringify(areas.local.vault_meta);
  let refusedAfterRebuild = false;
  try {
    await stale.commit();
  } catch {
    refusedAfterRebuild = true;
  }
  check('refused again once a different vault exists — a failed commit can be retried, and is re-checked', refusedAfterRebuild);
  check("the new vault's metadata is untouched", JSON.stringify(areas.local.vault_meta) === rebuiltMeta);
  await vault.lock();
  check('its own password still opens it', await opens(vault.unlockWithPassword('a rebuilt vault password')));
  check('every account is still readable', (await storage.getAccounts()).length === 2);

  // The reset is spread over the metadata as it stands at commit, not as it
  // stood when the code was shown — and a reset unlinks every passkey, so one
  // linked while the code was on screen goes too. Spreading the prepare-time
  // copy would have kept it: that copy had no passkey to drop.
  scenario('A passkey added while the new code is on screen is unlinked by the reset too');
  const beforePasskey = await vault.prepareRecovery(rebuilt.recoveryCode, 'password after second recovery');
  const masterKey = await vault.getMasterKeyBytes();
  const PRF = new Uint8Array(32).fill(7);
  await vault.attachPasskey(masterKey!, 'Y3JlZA==', 'c2FsdA==', PRF, 'Laptop');
  await flush();
  await beforePasskey.commit();
  await flush();
  check('the passkey is no longer registered', (await vault.getVaultPasskey()) === null);
  await vault.lock();
  check('and no longer opens the vault', !(await opens(vault.unlockWithPasskey(PRF))));
  check('as does the password set by the reset', await opens(vault.unlockWithPassword('password after second recovery')));
  await vault.lock();

  // --- another window writing while protection changes state ---------------
  //
  // Turning the vault on or off rewrites every record, and until the accounts
  // lock covered them neither did so under the lock every other writer takes.
  // These run with real storage latency and the adding window as a separate
  // module instance, the way the scanner tab sits beside Settings.

  // Off, with an add landing in the middle. The add encoded its list while
  // vault_meta still existed, wrote that ciphertext after the cleartext, and
  // then the metadata — the only key to it — was deleted: every account
  // unreadable by the password and by the recovery code alike.
  scenario('An account added while protection is being turned off stays readable');
  await resetState();
  await storage.saveAccounts([...ACCOUNTS, { ...ACCOUNTS[0], id: 'a3', secret: 'MFRGGZDFMZTWQ2LK' }]);
  await (await storage.prepareVault(PASSWORD)).commit();
  await flush();
  {
    const scanner = await storageContext('vault-off-scanner');
    const restore = withLatency(2);
    let adding: Promise<unknown> | null = null;
    // Started the moment the cleartext lands — the window between that write
    // and the metadata being cleared.
    const onWrite = (changes: any, area: string) => {
      const next = changes.authenticator_accounts?.newValue;
      if (area === 'local' && !adding && Array.isArray(next) && next.some(isCleartext)) {
        adding = scanner.addAccount({ ...ACCOUNTS[0], id: 'n4', secret: 'NBSWY3DPEB3W64TM' }, USER_ADD).catch(e => e);
      }
    };
    chrome.storage.onChanged.addListener(onWrite);
    try {
      await storage.disableVault(PASSWORD);
      await adding;
      await flush();
    } finally {
      chrome.storage.onChanged.removeListener(onWrite);
      restore();
    }
    check('the add ran inside the window', adding !== null);
    check('protection is off', !('vault_meta' in areas.local));
    check('nothing on disk is ciphertext', storedRecords().every(isCleartext), JSON.stringify(storedRecords().map(r => r.id)));
    const visible = await storage.getAccounts();
    check('all four accounts are readable', visible.length === 4, `${visible.length} readable, ${storage.quarantinedCount()} held`);
  }

  // On, with an add at the same moment. The add read the list before the
  // ciphertext landed and wrote its cleartext version after it: a live vault
  // with every secret readable beneath it — and pushed to sync from there.
  scenario('An account added while protection is being turned on is encrypted with the rest');
  await resetState();
  await storage.saveAccounts(ACCOUNTS);
  await flush();
  {
    const scanner = await storageContext('vault-on-scanner');
    const prepared = await storage.prepareVault(PASSWORD);
    const restore = withLatency(2);
    try {
      await Promise.all([
        prepared.commit(),
        scanner.addAccount({ ...ACCOUNTS[0], id: 'n3', secret: 'MFRGGZDFMZTWQ2LK' }, USER_ADD).catch(e => e),
      ]);
      await flush();
    } finally {
      restore();
    }
    const synced = Object.keys(areas.sync)
      .filter(key => key.startsWith('authenticator_accounts'))
      .flatMap(key => areas.sync[key] as any[]);
    check('protection is on', 'vault_meta' in areas.local);
    check('no secret sits in the clear in local', !storedRecords().some(isCleartext), JSON.stringify(storedRecords().map(r => r.id)));
    check('nor in sync', !synced.some(isCleartext));
    const visible = await storage.getAccounts();
    check('and the added account is among them', visible.some(a => a.id === 'n3'), visible.map(a => a.id).join());
  }

  // A password change derives two PBKDF2 keys before it writes. Spreading the
  // metadata it read BEFORE them over whatever happened meanwhile threw away a
  // passkey registered in the other window during those seconds.
  scenario('A passkey registered during a password change survives it');
  await resetState();
  await storage.saveAccounts(ACCOUNTS);
  await (await storage.prepareVault(PASSWORD)).commit();
  {
    const PRF = new Uint8Array(32).fill(9);
    const masterKey = await vault.getMasterKeyBytes();
    const changing = vault.changePassword(PASSWORD, 'a password chosen meanwhile');
    await vault.attachPasskey(masterKey!, 'Y3JlZA==', 'c2FsdA==', PRF, 'Phone');
    await changing;
    await flush();
    check('the passkey is still registered', (await vault.getVaultPasskey())?.label === 'Phone');
    await vault.lock();
    check('the new password opens the vault', await opens(vault.unlockWithPassword('a password chosen meanwhile')));
    await vault.lock();
    check('and so does the passkey', await opens(vault.unlockWithPasskey(PRF)));
    await vault.lock();
  }

  // Cleartext arriving from an older device is sealed on the way in, not
  // persisted as it came.
  scenario('Cleartext merged from sync under a vault lands encrypted');
  await resetState();
  await storage.saveAccounts(ACCOUNTS);
  await (await storage.prepareVault(PASSWORD)).commit();
  await flush();
  areas.sync.authenticator_accounts_5 = [{ ...ACCOUNTS[0], id: 'old-device', secret: 'NBSWY3DPEB3W64TM' }];
  {
    const visible = await storage.getAccounts();
    check('the account from the older device is shown', visible.some(a => a.id === 'old-device'));
    check('and stored as ciphertext', !storedRecords().some(isCleartext), JSON.stringify(storedRecords().map(r => r.id)));
    // The cleartext copy is still in sync, compared by secret, while the
    // sealed one in local is compared by fingerprint. Sealing it again on every
    // read appended a copy per read, and each write fired the reload that did
    // the next one.
    const settled = storedRecords().length;
    let events = 0;
    const count = (changes: any, area: string) => { if (storage.affectsStoredAccounts(area, changes)) events++; };
    chrome.storage.onChanged.addListener(count);
    for (let i = 0; i < 5; i++) await storage.getAccounts();
    await flush();
    chrome.storage.onChanged.removeListener(count);
    check('later reads do not seal it again', storedRecords().length === settled, `${settled} → ${storedRecords().length}`);
    check('and write nothing', events === 0, `${events} storage events`);
  }
  await vault.lock();
  areas.sync.authenticator_accounts_6 = [{ ...ACCOUNTS[0], id: 'while-locked', secret: 'ONSWG4TFORZTA5DI' }];
  await storage.getStoredAccounts();
  check('while locked it is left in sync, not written to local in the clear', !storedRecords().some(isCleartext));
}
