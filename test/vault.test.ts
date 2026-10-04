// Scenarios for the encrypted vault. These cover the paths where a bug means
// permanent loss of somebody's 2FA seeds, so they are deliberately end-to-end:
// real WebCrypto, real storage module, mocked browser only.

import { areas, backupRows, check, flush, resetState, scenario, setBackupRows, throwsNamed } from './harness';

const PASSWORD = 'correct horse battery staple';

// Field orders as they actually occur: accounts created by older builds and by
// the Google Authenticator migration import do not put `id` first, and `color`
// is optional. A round-trip check that compares serialised JSON fails on these
// even though the data is intact — that shipped once, hence this fixture.
const ACCOUNTS: any[] = [
  { name: 'alice@example.com', issuer: 'GitHub', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, createdAt: 1, id: 'a1' },
  { issuer: 'Google', secret: 'KRSXG5CTMVRXEZLU', id: 'a2', name: 'bob@example.com', period: 60, digits: 8, algorithm: 'SHA256', createdAt: 2, color: '#0f0' },
  { id: 'a3', name: 'vpn', issuer: 'vpn', secret: 'MFRGGZDFMZTWQ2LK', algorithm: 'SHA1', digits: 6, period: 30, createdAt: 3 },
];

export async function run(): Promise<void> {
  const storage = await import('@/utils/storage');
  const vault = await import('@/utils/vault');
  const backupFile = await import('@/utils/backup-file');

  // --- enabling ----------------------------------------------------------
  await resetState();
  scenario('Enabling the vault');
  await storage.saveAccounts(ACCOUNTS);
  setBackupRows([{ id: 'legacy', accounts: ACCOUNTS, timestamp: 1 }]);

  const prepared = await storage.prepareVault(PASSWORD);
  const recoveryCode = prepared.recoveryCode;
  check('nothing is written before the recovery code is confirmed',
    !('vault_meta' in areas.local) && typeof (areas.local.authenticator_accounts as any[])[0].secret === 'string');
  await prepared.commit();
  await flush();
  const localJson = JSON.stringify(areas.local.authenticator_accounts);

  check('issues a recovery code', /^[A-Z2-9]{5}(-[A-Z2-9]{5})+$/.test(recoveryCode), recoveryCode);
  check('accepts accounts whose id is not the first field', (await storage.getAccounts()).length === 3);
  check('leaves no cleartext secret in local', !localJson.includes('JBSWY3DPEHPK3PXP'));
  check('leaves no service name in local', !localJson.includes('GitHub'));
  check('leaves no cleartext secret in sync', !JSON.stringify(areas.sync.authenticator_accounts ?? '').includes('JBSWY3DPEHPK3PXP'));
  check('wipes pre-existing cleartext snapshots', !JSON.stringify(backupRows).includes('JBSWY3DPEHPK3PXP'));
  check('is unlocked afterwards', await vault.isUnlocked());

  const decoded = await storage.getAccounts();
  const byId = Object.fromEntries(decoded.map(a => [a.id, a]));
  check('preserves every secret', ACCOUNTS.every(a => byId[a.id]?.secret === a.secret));
  check('preserves the optional colour field', byId.a2.color === '#0f0' && !('color' in byId.a3));
  check('preserves numeric field types', byId.a2.digits === 8 && byId.a2.period === 60);

  // --- locking -----------------------------------------------------------
  scenario('Locking and unlocking');
  await vault.lock();
  check('reading while locked raises VaultLockedError', await throwsNamed('VaultLockedError', () => storage.getAccounts()));
  check('a wrong password is rejected', await throwsNamed('WrongPasswordError', () => vault.unlockWithPassword('wrong')));
  check('stays locked after a wrong attempt', !(await vault.isUnlocked()));
  await vault.unlockWithPassword(PASSWORD);
  check('the correct password unlocks', (await storage.getAccounts()).length === 3);

  // --- mutation ----------------------------------------------------------
  scenario('Editing while encrypted');
  await storage.deleteAccount('a2');
  await flush();
  check('delete by id works through encryption', (await storage.getAccounts()).every(a => a.id !== 'a2'));
  await storage.reorderAccounts(['a3', 'a1']);
  await flush();
  check('reorder by id works', (await storage.getAccounts()).map(a => a.id).join() === 'a3,a1');
  await storage.updateAccount('a1', { issuer: 'GitHub Inc' });
  await flush();
  check('edits round-trip', (await storage.getAccounts()).find(a => a.id === 'a1')?.issuer === 'GitHub Inc');

  // --- sync from an older device ----------------------------------------
  // An older build writes the accounts to one un-chunked key; we must still
  // read it, and still collapse the duplicate it introduces.
  scenario('Cleartext arriving from an older device');
  areas.sync.authenticator_accounts = [ACCOUNTS[0]];
  const merged = await storage.getAccounts();
  check('the duplicate is collapsed, not shown twice', merged.filter(a => a.secret === ACCOUNTS[0].secret).length === 1, `got ${merged.length}`);

  // --- password management ----------------------------------------------
  scenario('Changing the password');
  await vault.changePassword(PASSWORD, 'a completely different password');
  await flush();
  check('accounts survive a password change', (await storage.getAccounts()).length === 2);
  await vault.lock();
  check('the old password stops working', await throwsNamed('WrongPasswordError', () => vault.unlockWithPassword(PASSWORD)));
  await vault.unlockWithPassword('a completely different password');
  check('the new password works', (await storage.getAccounts()).length === 2);

  scenario('Recovering a forgotten password');
  await vault.lock();
  const recovery = await vault.prepareRecovery(recoveryCode, 'third password');
  await recovery.commit();
  const rotated = recovery.recoveryCode;
  check('the recovery code restores access', (await storage.getAccounts()).length === 2);
  check('the recovery code is rotated', rotated !== recoveryCode);
  check('the spent recovery code is refused', await throwsNamed('WrongPasswordError', () => vault.unlockWithRecoveryCode(recoveryCode)));
  await vault.unlockWithRecoveryCode(rotated.toLowerCase().replace(/-/g, ' '));
  check('the new code is accepted in sloppy form', await vault.isUnlocked());
  await vault.unlockWithPassword('third password');
  check('the new password works', await vault.isUnlocked());

  // --- export files ------------------------------------------------------
  scenario('Password-protected export');
  const accounts = await storage.getAccounts();
  const file = await backupFile.buildEncryptedBackupFile(accounts, 'file password');
  check('is recognised as encrypted', backupFile.isEncryptedBackupFile(file));
  check('exposes no secret', !file.includes('JBSWY3DPEHPK3PXP'));
  check('exposes no service name', !file.includes('GitHub'));
  check('rejects a wrong password', await throwsNamed('WrongExportPasswordError', () => backupFile.readEncryptedBackupFile(file, 'nope')));
  check('round-trips exactly', JSON.stringify(await backupFile.readEncryptedBackupFile(file, 'file password')) === JSON.stringify(accounts));
  check('a plain export is not mistaken for an encrypted one', !backupFile.isEncryptedBackupFile(backupFile.buildPlainBackupFile(accounts)));

  // The count comes from the file and PBKDF2 runs on the popup's thread: a
  // crafted file with iterations 1e10 froze the popup for hours.
  scenario('An encrypted export cannot ask for an absurd amount of work');
  const parsed = JSON.parse(file);
  check('what every version wrote is accepted',
    parsed.iterations === 600_000 &&
      parsed.iterations >= backupFile.MIN_BACKUP_ITERATIONS &&
      parsed.iterations <= backupFile.MAX_BACKUP_ITERATIONS);
  const withIterations = (iterations: unknown) => JSON.stringify({ ...parsed, iterations });
  const refusedFast = async (iterations: unknown) => {
    const outcome = await Promise.race([
      backupFile.readEncryptedBackupFile(withIterations(iterations), 'file password').then(
        () => 'opened',
        (error: Error) => error.name
      ),
      new Promise<string>(resolve => setTimeout(() => resolve('still deriving'), 2_000)),
    ]);
    return outcome === 'DamagedBackupFileError';
  };
  check('ten billion is refused before any derivation', await refusedFast(1e10));
  check('so is just past the ceiling', await refusedFast(backupFile.MAX_BACKUP_ITERATIONS + 1));
  // Before the bounds these came back as "wrong password" — for the right one.
  check('and a count too low to be ours', await refusedFast(1));
  check('and one that is not a whole number', await refusedFast(600_000.5));
  check('and a missing one', await refusedFast(undefined));
  check('and one written as a string', await refusedFast('600000'));
  const messages = await import('@/utils/import-message');
  const damagedText = messages.importErrorMessage(new backupFile.DamagedBackupFileError('x'), 'en');
  check('the refusal is said as such, not as "check the file format"',
    /damaged or was made by a newer version/.test(damagedText), damagedText);

  // --- disabling ---------------------------------------------------------
  scenario('Disabling the vault');
  check('a wrong password cannot disable it', await throwsNamed('WrongPasswordError', () => storage.disableVault('nope')));
  await storage.disableVault('third password');
  await flush();
  check('the vault metadata is gone', !(await vault.isVaultEnabled()));
  check('accounts are readable again', (await storage.getAccounts()).length === 2);
  check('local holds cleartext once more', typeof areas.local.authenticator_accounts[0].secret === 'string');
  check('snapshots are readable again', backupRows.length > 0 && !backupRows[backupRows.length - 1].accounts[0].enc);

  // --- surfaces that outlive the popup -----------------------------------
  // The popup was the whole lifetime of a page: the idle deadline was checked
  // when the accounts loaded, which was once per open. The floating window and
  // the side panel stay open for hours, so "lock after 5 minutes" quietly meant
  // "never" there until enforceAutoLock existed.
  scenario('Auto-lock in a page that stays open');
  await resetState();
  await storage.saveAccounts(ACCOUNTS);
  await (await storage.prepareVault(PASSWORD)).commit();
  await vault.setAutoLockMinutes(5);
  await flush();
  check('the vault is open to begin with', await vault.isUnlocked());
  check('and enforcing the deadline early is a no-op', (await vault.enforceAutoLock()) === false);

  // Six minutes idle, written the way a real session ages.
  const stale = areas.session.vault_session;
  areas.session.vault_session = { ...stale, lastActivity: Date.now() - 6 * 60_000 };
  check('past the deadline it locks', (await vault.enforceAutoLock()) === true);
  check('and the key is actually gone', !(await vault.isUnlocked()));

  scenario('Polling the deadline cannot hold the vault open by itself');
  await vault.unlockWithPassword(PASSWORD);
  await vault.setAutoLockMinutes(5);
  const beforePolling = (areas.session.vault_session as any).lastActivity;
  await new Promise(resolve => setTimeout(resolve, 5));
  await vault.enforceAutoLock();
  check('checking does not count as activity',
    (areas.session.vault_session as any).lastActivity === beforePolling);
  await vault.noteVaultActivity();
  check('but the user doing something does',
    (areas.session.vault_session as any).lastActivity > beforePolling);

  // Two surfaces are open at once now. Locking one must lock them all, and the
  // in-memory copy this context holds must not answer "still unlocked".
  scenario('A lock in one surface is seen by the others');
  await vault.unlockWithPassword(PASSWORD);
  check('unlocked in this context', await vault.isUnlocked());
  delete areas.session.vault_session; // another surface locked it
  check('the session store wins over the local copy', !(await vault.isUnlocked()));

  // Every key read refreshes the activity stamp by writing the session back,
  // key included. A read that had fetched the session just before "Lock now"
  // — quick fill in the service worker, while the popup's button was pressed —
  // wrote the key straight back after the lock removed it.
  scenario('Lock now is not undone by a key read already in flight');
  await vault.unlockWithPassword(PASSWORD);
  const inFlight = vault.getMasterKeyBytes();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.all([inFlight, vault.lock()]);
  await flush();
  check('the key is gone from the session', !areas.session.vault_session);
  check('and the vault reads as locked', !(await vault.isUnlocked()));

  // "Every time" used to change the setting and nothing else: the key stayed
  // in session storage, where 0 checks no deadline, so the next popup — hours
  // later — opened without a password, and quick fill in the service worker
  // could read the key all along.
  scenario('Switching to "password every time" takes the key out of shared storage');
  await vault.lock();
  await vault.setAutoLockMinutes(15);
  await vault.unlockWithPassword(PASSWORD);
  await flush();
  check('unlocked on 15 minutes, the key is in session storage', !!areas.session.vault_session);
  await vault.setAutoLockMinutes(0);
  await flush();
  check('switching to 0 removes it', !areas.session.vault_session);
  check('this page stays open — the user is looking at it', await vault.isUnlocked());
  check('and reading the key keeps it out of storage', !areas.session.vault_session);

  const otherContext = () =>
    import(new URL(`../src/utils/vault.ts?ctx=autolock-${Math.random()}`, import.meta.url).href) as Promise<
      typeof import('@/utils/vault')
    >;
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 5 * 3600_000;
    const later = await otherContext();
    check('a popup opened five hours later asks for the password', !(await later.isUnlocked()));
    check('and so does anything else reading the key — quick fill included',
      (await later.getMasterKeyBytes()) === null);
  } finally {
    Date.now = realNow;
  }

  scenario('A key left in session storage on "every time" is treated as expired');
  const leftover = { mk: Buffer.from((await vault.getMasterKeyBytes())!).toString('base64'), lastActivity: Date.now() };
  areas.session.vault_session = leftover; // written before the switch, or by a racing context
  const fresh = await otherContext();
  check('another context does not take it, however recent', (await fresh.getMasterKeyBytes()) === null);
  check('and it is cleared rather than left behind', !areas.session.vault_session);
  check('the page that switched still has its own copy', await vault.isUnlocked());

  scenario('"Until the browser closes" is untouched');
  await vault.lock();
  await vault.setAutoLockMinutes(-1);
  await vault.unlockWithPassword(PASSWORD);
  await flush();
  check('the key is shared with other contexts', !!areas.session.vault_session);
  areas.session.vault_session = { ...(areas.session.vault_session as any), lastActivity: Date.now() - 5 * 3600_000 };
  check('and still opens them hours later', await (await otherContext()).isUnlocked());
  await vault.lock();
  await vault.setAutoLockMinutes(15);

  scenario('Recovery codes: same shape, no modulo bias');
  const { generateRecoveryCode, normalizeRecoveryCode } = await import('@/utils/crypto');
  const shape = /^[A-NP-Z2-9]{5}(-[A-NP-Z2-9]{5}){3}$/;
  const codes = Array.from({ length: 3000 }, () => generateRecoveryCode());
  check('four groups of five from the same 33 symbols', codes.every(code => shape.test(code)), codes.find(c => !shape.test(c)));
  check('normalised the way old codes are', normalizeRecoveryCode(codes[0].toLowerCase()) === codes[0].replace(/-/g, ''));
  // `byte % 33` gave the first 24 symbols 8/256 each and the last 9 7/256: over
  // 60 000 symbols that is ~1875 against ~1641, a 14% gap. Uniform sampling
  // leaves a gap well under 3%; the noise at this size is about 1%.
  const alphabet = 'ABCDEFGHIJKLMNPQRSTUVWXYZ23456789';
  const counts = new Array(alphabet.length).fill(0);
  for (const code of codes) for (const ch of code.replace(/-/g, '')) counts[alphabet.indexOf(ch)]++;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const head = mean(counts.slice(0, 24));
  const tail = mean(counts.slice(24));
  check('the last nine symbols are drawn as often as the rest', Math.abs(head - tail) / tail < 0.03,
    `first 24: ${head.toFixed(0)}, last 9: ${tail.toFixed(0)}`);
  const realRandom = crypto.getRandomValues.bind(crypto);
  let calls = 0;
  try {
    // First draw: every byte in the rejected zone. Then zeros.
    (crypto as any).getRandomValues = (array: Uint8Array) => {
      array.fill(calls++ === 0 ? 255 : 0);
      return array;
    };
    check('a byte of 231 or more never picks a symbol', generateRecoveryCode() === 'AAAAA-AAAAA-AAAAA-AAAAA');
  } finally {
    (crypto as any).getRandomValues = realRandom;
  }

  scenario('A share link password has the export password floor');
  const { sharePasswordTooShort } = await import('@/components/ShareModal');
  check('no password is still allowed', !sharePasswordTooShort(''));
  check('a short one is refused', sharePasswordTooShort('abc'));
  check('seven characters is still short', sharePasswordTooShort('1234567'));
  check('eight is enough', !sharePasswordTooShort('12345678'));

  scenario('An account added elsewhere reaches an open list');
  check('a write to the primary copy is a reason to reload',
    storage.affectsStoredAccounts('local', { authenticator_accounts: {} }));
  check('a sync write is not — the next read merges it anyway',
    !storage.affectsStoredAccounts('sync', { authenticator_accounts: {} }));
  check('and neither is an unrelated local key',
    !storage.affectsStoredAccounts('local', { darkMode: {} }));
}
