// Putting an automatic snapshot back.
//
// The snapshots have been written daily since 1.10.0 and nothing could reach
// them, so "I updated and everything is gone" had no answer even when seven
// copies of the list were sitting in IndexedDB. These are the rules the restore
// path has to keep: it only ever adds, it survives being pressed twice, and it
// must not disturb the records the live store is holding for a vault this
// device cannot open.

import { areas, check, flush, resetState, scenario, setBackupRows, throwsNamed } from './harness';

const PASSWORD = 'correct horse battery staple';

const ACCOUNTS: any[] = [
  { id: 'a1', name: 'alice@example.com', issuer: 'GitHub', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, createdAt: 1, group: 'Work' },
  { id: 'a2', name: 'bob@example.com', issuer: 'Google', secret: 'KRSXG5CTMVRXEZLU', algorithm: 'SHA1', digits: 6, period: 30, createdAt: 2 },
];

/** What the popup's empty list looks like from storage's side. */
function emptyTheStore(): void {
  for (const key of Object.keys(areas.local)) {
    if (key.startsWith('authenticator_accounts')) delete areas.local[key];
  }
  for (const key of Object.keys(areas.sync)) {
    if (key.startsWith('authenticator_accounts')) delete areas.sync[key];
  }
}

export async function run(): Promise<void> {
  const storage = await import('@/utils/storage');
  const backups = await import('@/utils/auto-backup');
  const vault = await import('@/utils/vault');

  scenario('A snapshot brings back a list that has been emptied');
  await resetState();
  await storage.saveAccounts(ACCOUNTS);
  await flush();
  await backups.autoBackup(await storage.getStoredAccounts());

  const summaries = await backups.listBackupSummaries();
  check('one copy is listed', summaries.length === 1, `got ${summaries.length}`);
  check('it says how many accounts it holds', summaries[0]?.accountCount === 2, String(summaries[0]?.accountCount));
  check('and it carries no records with it', (summaries[0] as any).accounts === undefined);

  emptyTheStore();
  check('the list is empty to start with', (await storage.getAccounts()).length === 0);

  const restored = await storage.restoreFromSnapshot(await backups.restoreFromBackup(summaries[0].id));
  await flush();
  check('both accounts are reported restored', restored.added === 2, JSON.stringify(restored));
  const back = await storage.getAccounts();
  check('both are readable again', back.length === 2, `got ${back.length}`);
  check('the secret survived', back.find(a => a.id === 'a1')?.secret === 'JBSWY3DPEHPK3PXP');
  check('so did the group', back.find(a => a.id === 'a1')?.group === 'Work');

  scenario('Pressing restore twice is harmless');
  const second = await storage.restoreFromSnapshot(await backups.restoreFromBackup(summaries[0].id));
  await flush();
  check('nothing is added the second time', second.added === 0, JSON.stringify(second));
  check('and the copy is reported as already here', second.skipped === 2, JSON.stringify(second));
  check('the list is unchanged', (await storage.getAccounts()).length === 2);

  // The snapshot is up to a day old, and the person restoring it has usually
  // re-added an account or two by hand already. Replacing the list with the
  // snapshot would delete exactly that work.
  scenario('A snapshot never replaces what is already here');
  await resetState();
  await storage.saveAccounts(ACCOUNTS);
  await flush();
  await backups.autoBackup(await storage.getStoredAccounts());
  const [older] = await backups.listBackupSummaries();

  await storage.addAccount({
    id: 'a3',
    name: 'carol@example.com',
    issuer: 'AWS',
    secret: 'MFRGGZDFMZTWQ2LK',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    createdAt: 3,
  } as any);
  await flush();
  await storage.deleteAccount('a1');
  await flush();

  const merged = await storage.restoreFromSnapshot(await backups.restoreFromBackup(older.id));
  await flush();
  const afterMerge = await storage.getAccounts();
  check('the deleted account comes back', afterMerge.some(a => a.secret === 'JBSWY3DPEHPK3PXP'));
  check('the account added since is still here', afterMerge.some(a => a.id === 'a3'));
  check('nothing is duplicated', afterMerge.length === 3, `got ${afterMerge.length}`);
  check('one addition is reported, not two', merged.added === 1, JSON.stringify(merged));

  // decodeAccounts keeps the unreadable records of the LIVE store in module
  // state, and every save writes them back. Decoding a snapshot through it
  // would swap that list for the snapshot's — and the next save would drop the
  // records it displaced, which are precisely the ones whose only copy is here.
  scenario("Restoring leaves another vault's records untouched");
  await resetState();
  const foreign = { id: 'f1', v: 'a-vault-from-another-device', fp: 'fingerprint', enc: 'ciphertext' };
  areas.local.authenticator_accounts = [ACCOUNTS[0], foreign];
  await backups.autoBackup([ACCOUNTS[1]]);
  const [copy] = await backups.listBackupSummaries();

  const withForeign = await storage.restoreFromSnapshot(await backups.restoreFromBackup(copy.id));
  await flush();
  const stored = areas.local.authenticator_accounts as any[];
  check('the unreadable record is still on disk', stored.some(record => record.id === 'f1'));
  check('its ciphertext is unchanged', stored.find(record => record.id === 'f1')?.enc === 'ciphertext');
  check('the restored account was added', withForeign.added === 1, JSON.stringify(withForeign));
  check('and both readable accounts are listed', (await storage.getAccounts()).length === 2);

  // Switching the vault on replaces the snapshots, so a cleartext one does not
  // normally outlive it — but a snapshot taken afterwards can still hold
  // cleartext records, because a second device on an older build keeps pushing
  // them into sync and the snapshot is of the merged list. Restoring those must
  // not put cleartext back next to the ciphertext.
  scenario('Cleartext records in a copy are re-encrypted on the way in');
  await resetState();
  await (await storage.prepareVault(PASSWORD)).commit();
  await flush();
  setBackupRows([
    { id: 'backup_cleartext', timestamp: Date.now(), accounts: ACCOUNTS, version: 'test', accountCount: 2 },
  ]);
  const [plain] = await backups.listBackupSummaries();

  const intoVault = await storage.restoreFromSnapshot(await backups.restoreFromBackup(plain.id));
  await flush();
  check('the accounts are restored', intoVault.added === 2, JSON.stringify(intoVault));
  const encrypted = areas.local.authenticator_accounts as any[];
  check('every record on disk is ciphertext', encrypted.every(record => typeof record.enc === 'string'), JSON.stringify(encrypted.map(r => Object.keys(r))));
  check('and they read back through the vault', (await storage.getAccounts()).length === 2);

  // Ids survive an export and an import, so two records can legitimately arrive
  // carrying the same one. `deleteAccount` filters the list by id: with a
  // collision in place, deleting either account deletes both — one click away
  // from the screen the restore is offered on.
  scenario('A copy whose id is already taken does not collide with it');
  await resetState();
  areas.local.authenticator_accounts = [
    { id: 'shared-id', name: 'kept', issuer: 'Here', secret: 'MFRGGZDFMZTWQ2LK', algorithm: 'SHA1', digits: 6, period: 30, createdAt: 1 },
  ];
  setBackupRows([
    {
      id: 'backup_collision',
      timestamp: Date.now(),
      accountCount: 1,
      version: 'test',
      accounts: [
        { id: 'shared-id', name: 'restored', issuer: 'Copy', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, createdAt: 2 },
      ],
    },
  ]);
  const [collision] = await backups.listBackupSummaries();
  const collided = await storage.restoreFromSnapshot(await backups.restoreFromBackup(collision.id));
  await flush();
  const both = await storage.getAccounts();
  check('the account is restored alongside the existing one', collided.added === 1 && both.length === 2, JSON.stringify(collided));
  check('the two ids are different', new Set(both.map(a => a.id)).size === 2, JSON.stringify(both.map(a => a.id)));
  await storage.deleteAccount('shared-id');
  await flush();
  const survivor = await storage.getAccounts();
  check('deleting one leaves the other', survivor.length === 1, `got ${survivor.length}`);
  check('and it is the restored one', survivor[0]?.secret === 'JBSWY3DPEHPK3PXP', survivor[0]?.secret);

  // Every open surface reloads on a storage event, so a save that changes
  // nothing costs a sync push and a reload of the list they are already showing.
  scenario('A copy with nothing readable in it is not written at all');
  await resetState();
  await storage.saveAccounts(ACCOUNTS);
  await flush();
  const revisionBefore = areas.local.authenticator_accounts_rev;
  setBackupRows([
    {
      id: 'backup_foreign',
      timestamp: Date.now(),
      accountCount: 1,
      version: 'test',
      accounts: [{ id: 'g1', v: 'another-vault', fp: 'fingerprint', enc: 'ciphertext' }],
    },
  ]);
  const [foreignOnly] = await backups.listBackupSummaries();
  const nothing = await storage.restoreFromSnapshot(await backups.restoreFromBackup(foreignOnly.id));
  await flush();
  check('it reports the records it could not read', nothing.unreadable === 1, JSON.stringify(nothing));
  check('nothing is reported as restored or skipped', nothing.added === 0 && nothing.skipped === 0, JSON.stringify(nothing));
  check('and no write happened', areas.local.authenticator_accounts_rev === revisionBefore, String(areas.local.authenticator_accounts_rev));

  // Snapshots written by a build that did not record the count would otherwise
  // describe themselves as empty — and a copy that says it holds nothing is one
  // the UI offers no way to restore.
  scenario('A copy that never recorded its count is measured from its records');
  setBackupRows([
    { id: 'backup_old', timestamp: Date.now(), version: 'test', accounts: ACCOUNTS } as any,
  ]);
  const [counted] = await backups.listBackupSummaries();
  check('the count comes from the records', counted.accountCount === 2, String(counted.accountCount));

  scenario('A locked vault refuses the restore rather than writing cleartext');
  await resetState();
  await storage.saveAccounts(ACCOUNTS);
  await flush();
  await (await storage.prepareVault(PASSWORD)).commit();
  await flush();
  const [current] = await backups.listBackupSummaries();
  await vault.lock();
  check(
    'restoring throws VaultLockedError',
    await throwsNamed('VaultLockedError', async () =>
      storage.restoreFromSnapshot(await backups.restoreFromBackup(current.id))
    )
  );
  await vault.unlockWithPassword(PASSWORD);
  check('the accounts are still there afterwards', (await storage.getAccounts()).length === 2);
}
