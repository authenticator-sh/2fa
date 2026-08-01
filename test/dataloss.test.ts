// Regression scenarios for every path an audit found that ended in permanent
// loss of a user's TOTP seeds. Each one is written from the failure, not from
// the happy path — the previous test suite passed while all of these were live.

import { areas, check, flush, resetState, scenario, syncAccountKeys, throwsNamed } from './harness';

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
  await flush();
  check('an explicit delete is still allowed', (areas.local.authenticator_accounts as any[]).length === 2);

  // A drag in the popup used to delete anything the stale React state had not
  // mentioned — e.g. an account the scanner tab had just added.
  scenario('Reorder with a stale id list keeps the accounts it was not told about');
  await resetState();
  await storage.saveAccounts(ACCOUNTS);
  await storage.reorderAccounts(['a2', 'a1']);
  await flush();
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
  await flush();
  check('committing enables the vault', await vault.isVaultEnabled());
  check('and encrypts the accounts', !JSON.stringify(areas.local.authenticator_accounts).includes('JBSWY3DPEHPK3PXP'));

  // Ciphertext left in sync after the vault was removed used to be merged into
  // local and then throw VaultLockedError forever, with no vault to unlock.
  scenario('Ciphertext from a vault that no longer exists does not brick anything');
  const orphan = (areas.local.authenticator_accounts as any[])[0];
  await storage.disableVault(PASSWORD);
  await flush();
  areas.sync.authenticator_accounts = [orphan]; // as an older build would write it

  const afterOrphan = await storage.getAccounts();
  check('the readable accounts still load', afterOrphan.length === 3, `got ${afterOrphan.length}`);
  check('the unreadable record is quarantined, not counted', storage.quarantinedCount() === 1);
  await storage.updateAccount('a1', { issuer: 'GitHub Inc' });
  await flush();
  check('a later save keeps the quarantined record', JSON.stringify(areas.local.authenticator_accounts).includes(orphan.enc));
  check('and does not lose the readable ones', (await storage.getAccounts()).length === 3);

  scenario('Turning sync off removes what is already there');
  await resetState();
  await storage.saveAccounts(ACCOUNTS);
  await flush();
  check('sync holds the accounts by default', syncAccountKeys().length > 0);
  await storage.setSyncEnabled(false);
  check('disabling purges the accounts from sync', syncAccountKeys().length === 0);
  await storage.saveAccounts(ACCOUNTS);
  await flush();
  check('and later saves do not push again', syncAccountKeys().length === 0);
  check('local still has everything', (await storage.getAccounts()).length === 3);
  await storage.setSyncEnabled(true);
  await flush();
  check('re-enabling pushes the current accounts back', syncAccountKeys().length > 0);

  // A single sync key caps at 8 KB, which silently stopped syncing at ~44
  // accounts — ~22 once encryption roughly doubles each record.
  scenario('Large collections still reach sync');
  await resetState();
  const many = Array.from({ length: 120 }, (_, i) => ({
    id: `m${i}`, name: `user${i}@example.com`, issuer: 'Some Service',
    secret: `JBSWY3DPEHPK3PX${String(i).padStart(3, '0')}`,
    algorithm: 'SHA1', digits: 6, period: 30, createdAt: 1700000000000 + i, color: '#4285f4',
  })) as any[];
  await storage.saveAccounts(many);
  await flush();

  const syncKeys = syncAccountKeys();
  check('the accounts are split across several keys', syncKeys.length > 1, `${syncKeys.length} key(s)`);
  check('no single key exceeds the 8 KB limit',
    syncKeys.every(k => JSON.stringify(areas.sync[k]).length < 8192),
    `largest ${Math.max(...syncKeys.map(k => JSON.stringify(areas.sync[k]).length))} bytes`);
  const roundTripped = syncKeys
    .filter(k => /_\d+$/.test(k))
    .sort((a, b) => Number(a.split('_').pop()) - Number(b.split('_').pop()))
    .flatMap(k => areas.sync[k] as any[]);
  check('every account is present in sync', roundTripped.length === 120, `${roundTripped.length}`);
  check('no overflow was recorded', !(await storage.hasSyncOverflowed()));

  scenario('Shrinking the list clears the leftover chunks');
  await storage.saveAccounts(many.slice(0, 10), { allowShrink: true });
  await flush();
  const afterShrink = syncAccountKeys();
  check('stale chunks are removed', afterShrink.length < syncKeys.length, `${afterShrink.length} left`);
  check('the remaining accounts are intact', (await storage.getAccounts()).length === 10);

  scenario('Enabling the vault scrubs the per-site usage history');
  await resetState();
  await storage.saveAccounts(ACCOUNTS);
  const suggestions = await import('@/utils/suggestions');
  await suggestions.recordAccountUsage('github.com', 'a1');
  check('the history exists beforehand', 'accountUsageByDomain' in areas.local);
  await (await storage.prepareVault(PASSWORD)).commit();
  check('it is gone once the vault is on', !('accountUsageByDomain' in areas.local));
}
