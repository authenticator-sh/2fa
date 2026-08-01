// Regression scenarios for every path an audit found that ended in permanent
// loss of a user's TOTP seeds. Each one is written from the failure, not from
// the happy path — the previous test suite passed while all of these were live.

import { areas, check, flush, resetState, scenario, throwsNamed } from './harness';

const PASSWORD = 'correct horse battery staple';

const ACCOUNTS: any[] = [
  { id: 'a1', name: 'alice@example.com', issuer: 'GitHub', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, createdAt: 1 },
  { id: 'a2', name: 'bob@example.com', issuer: 'Google', secret: 'KRSXG5CTMVRXEZLU', algorithm: 'SHA1', digits: 6, period: 30, createdAt: 2 },
  { id: 'a3', name: 'vpn', issuer: 'vpn', secret: 'MFRGGZDFMZTWQ2LK', algorithm: 'SHA1', digits: 6, period: 30, createdAt: 3 },
];

export async function run(): Promise<void> {
  const storage = await import('@/utils/storage');
  const vault = await import('@/utils/vault');

  // A transient read failure used to become `[]`, and the next click committed
  // that empty list to both stores.
  await resetState();
  scenario('A failed read must not become a destructive write');
  await storage.saveAccounts(ACCOUNTS);
  areas.sync.authenticator_accounts = 'not-an-array-at-all';
  check('a corrupt sync value does not yield an empty list', !(await storage.getAccounts().catch(() => null))?.length === false);
  delete areas.sync.authenticator_accounts;

  scenario('saveAccounts refuses to shrink the store silently');
  check('writing fewer accounts than are stored throws', await throwsNamed('Error', () => storage.saveAccounts([ACCOUNTS[0]])));
  check('the stored accounts are untouched', (areas.local.authenticator_accounts as any[]).length === 3);
  await storage.deleteAccount('a2');
  check('an explicit delete is still allowed', (areas.local.authenticator_accounts as any[]).length === 2);

  // A drag in the popup used to delete anything the stale React state had not
  // mentioned — e.g. an account the scanner tab had just added.
  scenario('Reorder with a stale id list keeps the accounts it was not told about');
  await resetState();
  await storage.saveAccounts(ACCOUNTS);
  await storage.reorderAccounts(['a2', 'a1']);
  const afterReorder = await storage.getAccounts();
  check('nothing is deleted', afterReorder.length === 3, `got ${afterReorder.length}`);
  check('the requested order is applied first', afterReorder.slice(0, 2).map(a => a.id).join() === 'a2,a1');
  check('the unmentioned account is kept', afterReorder.some(a => a.id === 'a3'));

  scenario('Nothing is written until the recovery code is confirmed');
  await resetState();
  await storage.saveAccounts(ACCOUNTS);
  const prepared = await storage.prepareVault(PASSWORD);
  check('no vault metadata on disk yet', !('vault_meta' in areas.local));
  check('accounts are still cleartext', typeof (areas.local.authenticator_accounts as any[])[0].secret === 'string');
  check('the vault is not enabled', !(await vault.isVaultEnabled()));
  check('a recovery code is available to show', prepared.recoveryCode.length > 0);
  await prepared.commit();
  check('committing enables the vault', await vault.isVaultEnabled());
  check('and encrypts the accounts', !JSON.stringify(areas.local.authenticator_accounts).includes('JBSWY3DPEHPK3PXP'));

  // Ciphertext left in sync after the vault was removed used to be merged into
  // local and then throw VaultLockedError forever, with no vault to unlock.
  scenario('Ciphertext from a vault that no longer exists does not brick anything');
  const orphan = (areas.local.authenticator_accounts as any[])[0];
  await storage.disableVault(PASSWORD);
  areas.sync.authenticator_accounts = [...(areas.sync.authenticator_accounts as any[]), orphan];

  const afterOrphan = await storage.getAccounts();
  check('the readable accounts still load', afterOrphan.length === 3, `got ${afterOrphan.length}`);
  check('the unreadable record is quarantined, not counted', storage.quarantinedCount() === 1);
  await storage.updateAccount('a1', { issuer: 'GitHub Inc' });
  check('a later save keeps the quarantined record', JSON.stringify(areas.local.authenticator_accounts).includes(orphan.enc));
  check('and does not lose the readable ones', (await storage.getAccounts()).length === 3);

  scenario('Turning sync off removes what is already there');
  await resetState();
  await storage.saveAccounts(ACCOUNTS);
  await flush();
  check('sync holds the accounts by default', Array.isArray(areas.sync.authenticator_accounts));
  await storage.setSyncEnabled(false);
  check('disabling purges the accounts from sync', !('authenticator_accounts' in areas.sync));
  await storage.saveAccounts(ACCOUNTS);
  await flush();
  check('and later saves do not push again', !('authenticator_accounts' in areas.sync));
  check('local still has everything', (await storage.getAccounts()).length === 3);
  await storage.setSyncEnabled(true);
  check('re-enabling pushes the current accounts back', Array.isArray(areas.sync.authenticator_accounts));

  scenario('Enabling the vault scrubs the per-site usage history');
  await resetState();
  await storage.saveAccounts(ACCOUNTS);
  const suggestions = await import('@/utils/suggestions');
  await suggestions.recordAccountUsage('github.com', 'a1');
  check('the history exists beforehand', 'accountUsageByDomain' in areas.local);
  await (await storage.prepareVault(PASSWORD)).commit();
  check('it is gone once the vault is on', !('accountUsageByDomain' in areas.local));
}
