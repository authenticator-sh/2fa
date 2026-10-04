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
  SYNC_QUOTA_BYTES_PER_ITEM,
  syncAccountKeys,
  syncItemBytes,
  throwsNamed, USER_ADD } from './harness';

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

  // A user with 11 accounts had 22 records on disk: sync held the same seeds
  // spelled differently, the merge took them for new accounts, decode folded
  // them back. Every add then wrote "11 + 1" over 22 and was refused, forever.
  const respelled = ACCOUNTS.map(a => ({ ...a, id: `${a.id}-sync`, secret: a.secret.toLowerCase().replace(/(.{4})/g, '$1 ').trim() }));
  const extra = { id: 'a4', name: 'new', issuer: 'pub', secret: 'NSY2V7QAAAAAAAAA', algorithm: 'SHA1', digits: 6, period: 30, createdAt: 4 };

  scenario('The merge does not take a respelled seed for a new account');
  await resetState();
  await storage.saveAccounts(respelled);
  await flush();
  areas.local.authenticator_accounts = ACCOUNTS.map(a => ({ ...a }));
  await storage.getAccounts();
  check('local keeps one record per seed', (areas.local.authenticator_accounts as any[]).length === 3,
    `${(areas.local.authenticator_accounts as any[]).length} records`);

  scenario('A store already holding duplicates still accepts new accounts');
  await resetState();
  areas.local.authenticator_accounts = [...ACCOUNTS.map(a => ({ ...a })), ...respelled];
  check('the duplicates are folded for display', (await storage.getAccounts()).length === 3);
  let addError: unknown = null;
  await storage.addAccount(extra as any, USER_ADD).catch(e => { addError = e; });
  check('adding an account succeeds', addError === null, String(addError));
  check('the new account is there', (await storage.getAccounts()).some(a => a.id === 'a4'));
  check('writing fewer than the visible accounts is still refused',
    await throwsNamed('Error', () => storage.saveAccounts([ACCOUNTS[0]])));

  // A fresh install holds its first push until sync has had time to download.
  // The replay of that push used to carry local only, and prune the rest.
  scenario('Replaying a held push keeps the accounts that arrived from sync');
  await resetStateFreshProfile();
  await storage.getAccounts();
  await storage.addAccount({ ...extra, id: 'fresh' } as any, USER_ADD);
  await flush();
  const fromOldMachine = Array.from({ length: 30 }, (_, i) => ({
    ...ACCOUNTS[0], id: `o${i}`, name: 'x'.repeat(300), secret: 'JBSWY3DPEHPK3PX' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[i],
  }));
  areas.sync.authenticator_accounts_0 = fromOldMachine.slice(0, 15);
  areas.sync.authenticator_accounts_1 = fromOldMachine.slice(15);
  check('this device sees both', (await storage.getAccounts()).length === 31);
  await flush();
  const inCloud = syncAccountKeys().reduce((n, k) => n + (areas.sync[k] as any[]).length, 0);
  check('the cloud copy keeps all of them', inCloud === 31, `${inCloud} in sync`);

  // A password-manager export can carry one TOTP on two items, or one seed in
  // two spellings. Both were stored, one was folded away on display, and the
  // count said two were added.
  scenario('Import folds duplicates inside the file and never reuses an id');
  await resetState();
  await storage.saveAccounts(ACCOUNTS);
  const importFile = [
    { ...extra, id: 'a1' },                                         // new seed, taken id
    { ...extra, id: 'x2', secret: extra.secret.toLowerCase() },     // same seed again
  ];
  const imported = await storage.importAccounts(JSON.stringify(importFile), USER_ADD);
  const afterImport = await storage.getAccounts();
  check('one account is reported added', imported.added === 1, String(imported.added));
  check('one record is written', (areas.local.authenticator_accounts as any[]).length === 4,
    `${(areas.local.authenticator_accounts as any[]).length} records`);
  check('every id is unique', new Set(afterImport.map(a => a.id)).size === afterImport.length);
  check('the original a1 is untouched', afterImport.find(a => a.id === 'a1')?.secret === ACCOUNTS[0].secret);

  scenario('Adding a seed that is already here says so');
  check('a new seed reports added', await storage.addAccount({ ...extra, id: 'y1', secret: 'KRUGS4ZANFZSAYJA' } as any, USER_ADD));
  check('the same seed again reports not added',
    !(await storage.addAccount({ ...extra, id: 'y2', secret: 'kruGS4ZA NFZSAYJA' } as any, USER_ADD)));

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
  check('another vault\'s record is counted as locked away', storage.lockedAwayCount() === 1);
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
  //
  // Names in Cyrillic and CJK on purpose. Chrome charges UTF-8 bytes of key
  // plus value, and `String.length` counts UTF-16 units: a Cyrillic letter is
  // two bytes for one unit, a CJK one three. Measured the old way, ASCII-only
  // names could never show a chunk sized by the wrong ruler.
  const scripts = ['почта.иванов@пример.рф', '北京总部财务部门工作邮箱张伟的账户', 'ユーザー田中太郎の会社アカウント'];
  const many = Array.from({ length: 120 }, (_, i) => ({
    id: `m${i}`, name: `${scripts[i % 3]} ${i}`, issuer: i % 2 ? 'Госуслуги' : '支付宝 Alipay',
    secret: `JBSWY3DPEHPK3PX${String(i).padStart(3, '0')}`,
    algorithm: 'SHA1', digits: 6, period: 30, createdAt: 1700000000000 + i, color: '#4285f4',
  })) as any[];
  await storage.saveAccounts(many);
  await flush();

  const syncKeys = syncAccountKeys();
  const itemBytes = syncKeys.map(k => syncItemBytes(k, areas.sync[k]));
  check('the accounts are split across several keys', syncKeys.length > 1, `${syncKeys.length} key(s)`);
  check('no single key exceeds the 8 KB limit, in UTF-8 bytes',
    itemBytes.every(bytes => bytes <= SYNC_QUOTA_BYTES_PER_ITEM),
    `largest ${Math.max(...itemBytes)} bytes`);
  const roundTripped = syncKeys
    .filter(k => /_\d+$/.test(k))
    .sort((a, b) => Number(a.split('_').pop()) - Number(b.split('_').pop()))
    .flatMap(k => areas.sync[k] as any[]);
  check('every account is present in sync', roundTripped.length === 120, `${roundTripped.length}`);
  check('no overflow was recorded', !(await storage.hasSyncOverflowed()));

  // Shrunk by deleting, the way the list really shrinks. A bare save of a
  // shorter list no longer takes accounts out of sync: every push merges what
  // sync holds, so only what this device marked deleted is left behind — which
  // is what keeps a push from wiping an account another device just added.
  scenario('Shrinking the list clears the leftover chunks');
  for (const gone of many.slice(10)) await storage.deleteAccount(gone.id);
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
  } as any, USER_ADD);
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

  // --- sync switched off on this device -----------------------------------
  //
  // The sync area belongs to the Google account, not to this machine: every
  // Chrome signed in to it shares it. Turning sync off here purges it once —
  // the setting promises exactly that — and from then on this device stays out
  // of it. It used to go on reading it, adopting it, and wiping it.

  scenario('A device with sync off leaves the other machines’ cloud copy alone');
  await resetState();
  await storage.saveAccounts([ACCOUNTS[0]]);
  await storage.setSyncEnabled(false);
  await flush();
  // Another machine, sync on, puts its own accounts up afterwards.
  areas.sync.authenticator_accounts_0 = [ACCOUNTS[1], ACCOUNTS[2]];
  {
    const here = (await storage.getAccounts()).map(a => a.id).join();
    check('its accounts are not pulled onto this device', here === 'a1', here);
    await storage.updateAccount('a1', { name: 'renamed' });
    await storage.addAccount({ ...ACCOUNTS[0], id: 'a4', secret: 'NBSWY3DPEB3W64TM' }, USER_ADD);
    await flush();
    check('and a save here does not delete them from sync', syncAccountKeys().length === 1 && (areas.sync.authenticator_accounts_0 as any[]).length === 2);
  }

  scenario('A device with sync off is not locked behind another machine’s password');
  await resetState();
  await storage.saveAccounts(ACCOUNTS);
  await storage.setSyncEnabled(false);
  {
    // The other machine switches protection on and its metadata syncs up.
    const other = await vault.createVaultMeta('the other machine’s password');
    areas.sync.vault_meta = other.meta;
    check('this device still has no vault', !(await vault.isVaultEnabled()));
    check('its metadata is not adopted', !('vault_meta' in areas.local));
    const here = await storage.getAccounts().catch(error => error);
    check('and the accounts open without anyone’s password', Array.isArray(here) && here.length === 3, String(here));
  }

  // --- records that are not accounts --------------------------------------

  // One `null` in local — or in a sync chunk, which every device reads — made
  // every read throw; after the retries that is "Failed to load accounts" on
  // every machine sharing the area, with the data still on disk.
  for (const where of ['local', 'sync'] as const) {
    scenario(`A null record in ${where} does not stop the list loading`);
    await resetState();
    await storage.saveAccounts(ACCOUNTS);
    await flush();
    const junk = [null, 'garbage', {}, { id: 'n', secret: 12345 }];
    if (where === 'local') {
      areas.local.authenticator_accounts = [...(areas.local.authenticator_accounts as any[]), ...junk];
    } else {
      areas.sync.authenticator_accounts_0 = [...(areas.sync.authenticator_accounts_0 as any[]), ...junk];
    }
    const loaded = await storage.getAccounts().catch(error => error);
    check('the list loads', Array.isArray(loaded), String(loaded));
    check('with the three real accounts and nothing else', Array.isArray(loaded) && loaded.length === 3 && loaded.every((a: any) => typeof a.id === 'string'));
    check('the rest is held, not shown', storage.quarantinedCount() === junk.length, String(storage.quarantinedCount()));
    // Held, but not an account under some other password — the banner that
    // says so sent people with protection off looking for one.
    check('and not counted as locked away', storage.lockedAwayCount() === 0, String(storage.lockedAwayCount()));
    const added = await storage.addAccount({ ...ACCOUNTS[0], id: 'a4', secret: 'NBSWY3DPEB3W64TM' }, USER_ADD).catch(error => error);
    check('an account can still be added', added === true, String(added));
    const kept = areas.local.authenticator_accounts as any[];
    check('a save keeps what it could not read', kept.includes(null) && kept.includes('garbage'), JSON.stringify(kept.slice(-5)));
  }

  // Two records carrying one id — a hand-edited backup, an older import — meant
  // deleting either card deleted both, and a drag wrote one of them twice and
  // lost the other.
  scenario('Accounts sharing an id are told apart');
  await resetState();
  {
    const dup = [
      { ...ACCOUNTS[0], id: 'dup' },
      { ...ACCOUNTS[1], id: 'dup', name: 'second' },
      ACCOUNTS[2],
      { ...ACCOUNTS[0], id: undefined, secret: 'NBSWY3DPEB3W64TM', name: 'no id' },
    ];
    delete (dup[3] as any).id;
    areas.local.authenticator_accounts = dup;
    const loaded = await storage.getAccounts();
    const ids = loaded.map(a => a.id);
    check('every account has an id of its own', ids.length === 4 && new Set(ids).size === 4 && ids.every(id => typeof id === 'string' && id), JSON.stringify(ids));
    check('and the repair is written down', new Set((areas.local.authenticator_accounts as any[]).map(r => r.id)).size === 4);

    await storage.reorderAccounts(['a3', 'dup', 'dup']);
    const secrets = (await storage.getAccounts()).map(a => a.secret);
    check('a drag naming an id twice keeps every account once', new Set(secrets).size === 4 && secrets.length === 4, JSON.stringify(secrets));

    await storage.deleteAccount('dup');
    const left = (await storage.getAccounts()).map(a => a.name);
    check('deleting one card deletes one account', left.length === 3 && left.includes('second'), JSON.stringify(left));
  }

  // `issuer: null` is in real stores. Search, the site suggestion and quick
  // fill all call .toLowerCase() on it, and one such account blanked the popup
  // the moment anything was typed.
  scenario('Text fields come out of storage as text');
  await resetState();
  areas.local.authenticator_accounts = [
    { ...ACCOUNTS[0], issuer: null },
    { ...ACCOUNTS[1], name: null, group: 7 },
  ];
  {
    const loaded = await storage.getAccounts();
    check('issuer, name and group are strings or absent',
      loaded.every(a => typeof a.name === 'string' && typeof a.issuer === 'string' && (a.group === undefined || typeof a.group === 'string')),
      JSON.stringify(loaded.map(a => [a.name, a.issuer, a.group])));
    const suggestions = await import('@/utils/suggestions');
    const suggested = await suggestions.getSuggestedAccountId('github.com', loaded).then(() => 'ok', error => String(error));
    check('and the site suggestion does not throw on them', suggested === 'ok', suggested);
  }

  // --- deletions that come back --------------------------------------------

  // The marker hashed the raw secret while the merge compares the normalised
  // one: a sync copy spelling the seed differently — an older device's
  // `jbsw y3dp…` for this one's `JBSWY3DP…` — matched no marker and came back.
  scenario('A deleted account does not return in another spelling');
  await resetState();
  await storage.saveAccounts([ACCOUNTS[0], ACCOUNTS[1]]);
  await flush();
  faults.failSyncSet = true; // the sync copy never catches up
  areas.sync.authenticator_accounts_0 = [
    { ...ACCOUNTS[0], secret: 'jbsw y3dp ehpk 3pxp' },
    ACCOUNTS[1],
  ];
  await storage.deleteAccount('a1');
  await flush();
  {
    const ids = (await storage.getAccounts()).map(a => a.id).join();
    faults.failSyncSet = false;
    check('it stays deleted', ids === 'a2', ids);
  }

  // Two records of one seed show as one card. Deleting that card has to take
  // the hidden copy's marker too, or the copy's own sync record brings it back.
  scenario('Deleting an account also retires its hidden copies');
  await resetState();
  {
    const hidden = { ...ACCOUNTS[0], id: 'hidden', secret: 'JBSWY3DPEHPK3PXP======' };
    areas.local.authenticator_accounts = [ACCOUNTS[0], hidden, ACCOUNTS[1]];
    areas.sync.authenticator_accounts_0 = [ACCOUNTS[0], hidden, ACCOUNTS[1]];
    faults.failSyncSet = true;
    await storage.deleteAccount('a1');
    await flush();
    const ids = (await storage.getAccounts()).map(a => a.id).join();
    faults.failSyncSet = false;
    check('neither copy comes back', ids === 'a2', ids);
  }

  // The marker used to name a seed only in the form it was stored in when it
  // was deleted: the secret with protection off, the fingerprint with it on.
  // Switch protection over, and another device's copy arrives in the other
  // form — and came back.
  {
    const crypto = await import('@/utils/crypto');
    /** Another device's copy of an account, sealed under this device's vault. */
    const sealed = async (account: any) => {
      const meta = await vault.getVaultMeta();
      const { dataKey, fingerprintKey } = await vault.deriveKeys((await vault.getMasterKeyBytes())!);
      const { id, ...fields } = account;
      return {
        id,
        v: meta!.vaultId,
        fp: await crypto.fingerprintSecret(fingerprintKey, account.secret),
        enc: await crypto.encryptJson(fields, dataKey),
      };
    };

    scenario('An account deleted before protection was switched on stays deleted after');
    await resetState();
    await storage.saveAccounts([ACCOUNTS[0], ACCOUNTS[1]]);
    await flush();
    await storage.deleteAccount('a1');
    await flush();
    areas.sync.authenticator_accounts_0 = [ACCOUNTS[0], ACCOUNTS[1]];
    check('a cleartext copy is kept out', (await storage.getAccounts()).map(a => a.id).join() === 'a2');
    await (await storage.prepareVault(PASSWORD)).commit();
    await flush();
    areas.sync.authenticator_accounts_0 = [await sealed(ACCOUNTS[0]), await sealed(ACCOUNTS[1])];
    await vault.lock();
    // Locked, the copy cannot be opened to see which seed it is — and a
    // fingerprint no marker names is not the same as "not deleted".
    await storage.getStoredAccounts().catch(() => {});
    await vault.unlockWithPassword(PASSWORD);
    {
      const ids = (await storage.getAccounts()).map(a => a.id).join();
      check('an encrypted copy is kept out too', ids === 'a2', ids);
    }

    scenario('An account deleted under protection stays deleted once it is off');
    await resetState();
    await storage.saveAccounts([ACCOUNTS[0], ACCOUNTS[1]]);
    await (await storage.prepareVault(PASSWORD)).commit();
    await flush();
    await storage.deleteAccount('a1');
    await flush();
    // An older device still pushing cleartext, while protection is on here…
    areas.sync.authenticator_accounts_0 = [{ ...ACCOUNTS[0], secret: 'jbsw y3dp ehpk 3pxp' }];
    {
      const ids = (await storage.getAccounts()).map(a => a.id).join();
      check('a cleartext copy is kept out under the vault', ids === 'a2', ids);
    }
    // …and after it is switched off.
    await storage.disableVault(PASSWORD);
    await flush();
    areas.sync.authenticator_accounts_0 = [ACCOUNTS[0], ACCOUNTS[1]];
    {
      const ids = (await storage.getAccounts()).map(a => a.id).join();
      check('and with the vault off', ids === 'a2', ids);
    }

    // What 1.13.3 recorded for a delete under a vault: the fingerprint alone.
    scenario('A deletion recorded by an older build as a fingerprint still keeps cleartext out');
    await resetState();
    await storage.saveAccounts([ACCOUNTS[1]]);
    await (await storage.prepareVault(PASSWORD)).commit();
    await flush();
    const tombstones = await import('@/utils/tombstones');
    await tombstones.markDeleted([(await sealed(ACCOUNTS[0])).fp]);
    areas.sync.authenticator_accounts_0 = [ACCOUNTS[0]];
    {
      const ids = (await storage.getAccounts()).map(a => a.id).join();
      check('the cleartext copy is kept out', ids === 'a2', ids);
    }
    await storage.addAccount(ACCOUNTS[0], USER_ADD);
    {
      const ids = (await storage.getAccounts()).map(a => a.id).sort().join();
      check('and adding it back here still works', ids === 'a1,a2', ids);
    }
  }

  // Replacing an "Invalid key" changes the seed under the same card. The old
  // seed's sync copy is still up there — for good, when sync writes are being
  // refused — and with no marker the next read took it for another device's
  // account: the broken card, back beside the repaired one.
  scenario('A replaced key does not come back from sync as a second card');
  await resetState();
  {
    const broken = { ...ACCOUNTS[1], id: 'bad', secret: 'AB1' };
    await storage.saveAccounts([ACCOUNTS[0], broken]);
    await flush();
    faults.failSyncSet = true;
    await storage.updateAccount('bad', { secret: 'MFRGGZDFMZTWQ2LK' });
    await flush();
    const loaded = (await storage.getAccounts()).map(a => `${a.id}:${a.secret}`).join();
    faults.failSyncSet = false;
    check('only the repaired card is there', loaded === 'a1:JBSWY3DPEHPK3PXP,bad:MFRGGZDFMZTWQ2LK', loaded);
  }

  // A save's push used to send local alone and prune every chunk beyond it.
  // An account another device wrote to sync after this one's last read was
  // not in local, so the push overwrote it — and it never reached local
  // either. Here the other device's write lands the moment this one saves.
  scenario("A save's push keeps an account another device has just put in sync");
  await resetState();
  await storage.saveAccounts([ACCOUNTS[0]]);
  await flush();
  {
    const local: any = chrome.storage.local;
    const set = local.set;
    let landed = false;
    local.set = async (items: Record<string, unknown>, ...rest: unknown[]) => {
      const result = await set.call(local, items, ...rest);
      if (!landed && 'authenticator_accounts' in items) {
        landed = true;
        areas.sync.authenticator_accounts_0 = [...(areas.sync.authenticator_accounts_0 as any[]), ACCOUNTS[2]];
      }
      return result;
    };
    try {
      await storage.updateAccount('a1', { name: 'renamed' });
      await flush();
    } finally {
      local.set = set;
    }
    const inSync = (areas.sync.authenticator_accounts_0 as any[]).map(r => r.id).sort().join();
    check('the other device\'s account is still in sync', inSync === 'a1,a3', inSync);
    const ids = (await storage.getAccounts()).map(a => a.id).sort().join();
    check('and reaches this device', ids === 'a1,a3', ids);
  }

  scenario('Editing an account that is already gone says so');
  await resetState();
  await storage.saveAccounts([ACCOUNTS[0]]);
  check('found and saved', (await storage.updateAccount('a1', { name: 'x' })) === true);
  const revisionBefore = areas.local.authenticator_accounts_rev;
  check('gone', (await storage.updateAccount('deleted-elsewhere', { name: 'x' })) === false);
  check('and nothing is written', areas.local.authenticator_accounts_rev === revisionBefore);
}
