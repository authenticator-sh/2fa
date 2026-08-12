// Regression scenarios for every path an audit found that ended in permanent
// loss of a user's TOTP seeds. Each one is written from the failure, not from
// the happy path — the previous test suite passed while all of these were live.

import {
  areas,
  check,
  faults,
  flush,
  resetState,
  resetStateFreshProfile,
  scenario,
  syncAccountKeys,
  throwsNamed,
} from './harness';

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

  // The setting says it removes data from Google's servers. The wrapped master
  // key is the part that matters most, and it used to come back on the next
  // password change.
  scenario('Turning sync off keeps the vault metadata off too');
  await resetState();
  await storage.saveAccounts(ACCOUNTS);
  await (await storage.prepareVault(PASSWORD)).commit();
  await flush();
  check('vault metadata reaches sync while sync is on', 'vault_meta' in areas.sync);

  await storage.setSyncEnabled(false);
  await flush();
  check('turning sync off removes it', !('vault_meta' in areas.sync));

  await vault.changePassword(PASSWORD, 'an entirely different password');
  await flush();
  check('a password change does not push it back', !('vault_meta' in areas.sync));
  check('and the new password still works locally', !!(await vault.unlockWithPassword('an entirely different password')));

  await storage.setSyncEnabled(true);
  await flush();
  check('re-enabling restores the metadata too', 'vault_meta' in areas.sync);
  check('along with the accounts', syncAccountKeys().length > 0);

  scenario('Enabling the vault scrubs the per-site usage history');
  await resetState();
  await storage.saveAccounts(ACCOUNTS);
  const suggestions = await import('@/utils/suggestions');
  await suggestions.recordAccountUsage('github.com', 'a1');
  check('the history exists beforehand', 'accountUsageByDomain' in areas.local);
  await (await storage.prepareVault(PASSWORD)).commit();
  check('it is gone once the vault is on', !('accountUsageByDomain' in areas.local));

  // --- fixes for the 2026-08-12 audit ------------------------------------

  // Every other write path carries quarantined records through untouched.
  // Enabling the vault was the one exception, and it erased them.
  scenario('Enabling the vault keeps records it cannot read');
  await resetState();
  await storage.saveAccounts(ACCOUNTS);
  const foreign = { id: 'foreign-1', v: 'some-other-vault', fp: 'ff', enc: 'unreadable' };
  areas.local.authenticator_accounts = [...(areas.local.authenticator_accounts as any[]), foreign];
  const beforeCommit = (areas.local.authenticator_accounts as any[]).length;
  await (await storage.prepareVault(PASSWORD)).commit();
  await flush();
  const afterCommit = areas.local.authenticator_accounts as any[];
  check('the record count is unchanged', afterCommit.length === beforeCommit, `${afterCommit.length} vs ${beforeCommit}`);
  check('the foreign record is still on disk', afterCommit.some(r => r.id === 'foreign-1'));

  // prepare() and commit() are separated by the recovery-code screen, which the
  // user is expected to linger on. The scanner tab can add accounts throughout.
  scenario('Accounts added while the recovery code is on screen survive the commit');
  await resetState();
  await storage.saveAccounts(ACCOUNTS);
  const pending = await storage.prepareVault(PASSWORD);
  await storage.addAccount({
    id: 'late', name: 'added-during-setup', issuer: 'Scanner',
    secret: 'NBSWY3DPEHPK3PXQ', algorithm: 'SHA1', digits: 6, period: 30, createdAt: 99,
  } as any);
  await pending.commit();
  await flush();
  const afterLate = await storage.getAccounts();
  check('the late account is there', afterLate.some(a => a.id === 'late'), JSON.stringify(afterLate.map(a => a.id)));
  check('and so is everything else', afterLate.length === ACCOUNTS.length + 1, String(afterLate.length));

  // The rollback used to clear vault_meta even when restoring the cleartext had
  // failed — ciphertext on disk with its only key deleted.
  scenario('A rollback that cannot restore the cleartext keeps the key');
  await resetState();
  await storage.saveAccounts(ACCOUNTS);
  const doomed = await storage.prepareVault(PASSWORD);
  faults.failLocalSetFor = 'authenticator_accounts';
  let commitFailed = false;
  try {
    await doomed.commit();
  } catch {
    commitFailed = true;
  }
  faults.failLocalSetFor = null;
  check('the commit reports failure', commitFailed);
  check('vault_meta is kept rather than deleted', 'vault_meta' in areas.local);
  check('the accounts are still readable on disk', (areas.local.authenticator_accounts as any[]).length === 3);

  // vault_meta is compared on a wall clock, so a second device with a skewed
  // clock — or simply a second vault — could overwrite the only wrapping that
  // opens this device's ciphertext.
  scenario('Vault metadata from a different vault is never adopted');
  await resetState();
  await storage.saveAccounts(ACCOUNTS);
  await (await storage.prepareVault(PASSWORD)).commit();
  await flush();
  const ownMeta = areas.local.vault_meta as any;
  areas.sync.vault_meta = { ...ownMeta, vaultId: 'a-different-vault', updatedAt: Date.now() + 60_000 };
  const resolved = await vault.getVaultMeta();
  check('the local vault id wins', resolved?.vaultId === ownMeta.vaultId, String(resolved?.vaultId));
  check('local metadata is left alone', (areas.local.vault_meta as any).vaultId === ownMeta.vaultId);
  check('the accounts still open with the original password', !!(await vault.unlockWithPassword(PASSWORD)));

  scenario('A newer copy of the SAME vault is still adopted');
  areas.sync.vault_meta = { ...ownMeta, updatedAt: (ownMeta.updatedAt ?? 0) + 60_000, iterations: ownMeta.iterations };
  const sameVault = await vault.getVaultMeta();
  check('the password-change path still works', (sameVault?.updatedAt ?? 0) > (ownMeta.updatedAt ?? 0));

  // A fresh profile cannot tell "sync is empty" from "sync has not downloaded
  // yet", and writing into that window replaced the cloud copy.
  scenario('A brand-new profile does not write into an undownloaded sync area');
  await resetStateFreshProfile();
  await storage.saveAccounts(ACCOUNTS);
  await flush();
  check('nothing was pushed', syncAccountKeys().length === 0, JSON.stringify(syncAccountKeys()));
  check('the push is recorded as pending', areas.local.syncPushPending === true);
  check('local still has every account', (areas.local.authenticator_accounts as any[]).length === 3);

  scenario('The held push is replayed once the area can be trusted');
  // Backdate the first read past the settle window, as a later session would.
  areas.local.syncFirstReadAt = Date.now() - 10 * 60 * 1000;
  await storage.getAccounts();
  await flush();
  check('the accounts reach sync on the next read', syncAccountKeys().length > 0, JSON.stringify(syncAccountKeys()));
  check('the pending flag is cleared', areas.local.syncPushPending === false);

  scenario('An established profile is never held back');
  await resetState();
  await storage.saveAccounts(ACCOUNTS);
  await flush();
  check('the push goes straight through', syncAccountKeys().length > 0);

  scenario('Sync content that is already present bypasses the hold entirely');
  await resetStateFreshProfile();
  areas.sync.authenticator_accounts_0 = [ACCOUNTS[0]];
  await storage.saveAccounts(ACCOUNTS);
  await flush();
  check('an area with data is written normally', syncAccountKeys().length > 0, JSON.stringify(syncAccountKeys()));
}
