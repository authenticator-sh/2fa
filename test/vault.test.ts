// Scenarios for the encrypted vault. These cover the paths where a bug means
// permanent loss of somebody's 2FA seeds, so they are deliberately end-to-end:
// real WebCrypto, real storage module, mocked browser only.

import { areas, backupRows, check, resetState, scenario, setBackupRows, throwsNamed } from './harness';

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
  check('delete by id works through encryption', (await storage.getAccounts()).every(a => a.id !== 'a2'));
  await storage.reorderAccounts(['a3', 'a1']);
  check('reorder by id works', (await storage.getAccounts()).map(a => a.id).join() === 'a3,a1');
  await storage.updateAccount('a1', { issuer: 'GitHub Inc' });
  check('edits round-trip', (await storage.getAccounts()).find(a => a.id === 'a1')?.issuer === 'GitHub Inc');

  // --- sync from an older device ----------------------------------------
  scenario('Cleartext arriving from an older device');
  areas.sync.authenticator_accounts = [...(areas.sync.authenticator_accounts as any[]), ACCOUNTS[0]];
  const merged = await storage.getAccounts();
  check('the duplicate is collapsed, not shown twice', merged.filter(a => a.secret === ACCOUNTS[0].secret).length === 1, `got ${merged.length}`);

  // --- password management ----------------------------------------------
  scenario('Changing the password');
  await vault.changePassword(PASSWORD, 'a completely different password');
  check('accounts survive a password change', (await storage.getAccounts()).length === 2);
  await vault.lock();
  check('the old password stops working', await throwsNamed('WrongPasswordError', () => vault.unlockWithPassword(PASSWORD)));
  await vault.unlockWithPassword('a completely different password');
  check('the new password works', (await storage.getAccounts()).length === 2);

  scenario('Recovering a forgotten password');
  await vault.lock();
  const rotated = await vault.resetPasswordWithRecoveryCode(recoveryCode, 'third password');
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

  // --- disabling ---------------------------------------------------------
  scenario('Disabling the vault');
  check('a wrong password cannot disable it', await throwsNamed('WrongPasswordError', () => storage.disableVault('nope')));
  await storage.disableVault('third password');
  check('the vault metadata is gone', !(await vault.isVaultEnabled()));
  check('accounts are readable again', (await storage.getAccounts()).length === 2);
  check('local holds cleartext once more', typeof areas.local.authenticator_accounts[0].secret === 'string');
  check('snapshots are readable again', backupRows.length > 0 && !backupRows[backupRows.length - 1].accounts[0].enc);
}
