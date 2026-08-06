// The paths where something goes wrong and the user's accounts have to survive
// it anyway.
//
// Everything here is a regression test for a way the 1.10/1.11 code could lose
// or hide someone's 2FA seeds. None of these are hypothetical: each mirrors a
// specific failure traced through the shipping code.

import { areas, check, faults, flush, resetState, scenario, syncAccountKeys } from './harness';

const PASSWORD = 'correct horse battery staple';

const ACCOUNTS: any[] = [
  { id: 'a1', name: 'alice@example.com', issuer: 'GitHub', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, createdAt: 1, group: 'Work' },
  { id: 'a2', name: 'bob@example.com', issuer: 'Google', secret: 'KRSXG5CTMVRXEZLU', algorithm: 'SHA1', digits: 6, period: 30, createdAt: 2 },
];

/** Cyrillic text costs two UTF-8 bytes per character, CJK three. */
const CYRILLIC: any[] = Array.from({ length: 40 }, (_, i) => ({
  id: `c${i}`,
  name: `почта-пользователя-${i}@пример.рф`,
  issuer: 'Госуслуги — личный кабинет',
  secret: 'JBSWY3DPEHPK3PXP',
  algorithm: 'SHA1',
  digits: 6,
  period: 30,
  createdAt: i,
  group: 'Работа и финансы',
}));

export async function run(): Promise<void> {
  const storage = await import('@/utils/storage');
  const vault = await import('@/utils/vault');

  // The snapshots live in IndexedDB, which can be unavailable for reasons that
  // have nothing to do with us — site data blocked, a corrupted profile, a full
  // disk. That used to throw straight into the commit's catch, which deleted
  // vault_meta: the only copy of the key for the ciphertext that had already
  // been written. Every account, gone, behind an error toast.
  scenario('Enabling password protection survives IndexedDB being unavailable');
  await resetState();
  await storage.saveAccounts(ACCOUNTS);
  await flush();
  faults.indexedDB = true;
  let enableError: unknown = null;
  try {
    const prepared = await storage.prepareVault(PASSWORD);
    await prepared.commit();
  } catch (error) {
    enableError = error;
  }
  await flush();
  check('enabling the vault still succeeds', enableError === null, String(enableError));
  check('the vault metadata is there', areas.local.vault_meta !== undefined);
  const afterIdbFailure = await storage.getAccounts();
  check('both accounts are still readable', afterIdbFailure.length === 2, `got ${afterIdbFailure.length}`);
  check('the secret is intact', afterIdbFailure.find(a => a.id === 'a1')?.secret === 'JBSWY3DPEHPK3PXP');
  faults.indexedDB = false;
  await storage.disableVault(PASSWORD);
  await flush();

  // And when the commit does fail, the rollback has to put the accounts back —
  // not just remove the metadata. Clearing vault_meta on its own is what turned
  // a failed write into permanent data loss.
  //
  // The fault is armed on the metadata *read* rather than the ciphertext write,
  // so the encrypted records really do land in local first. Failing the write
  // instead would leave the cleartext untouched and prove nothing about the
  // rollback: this has to break at a point where local no longer holds anything
  // the user could open.
  scenario('A failed vault commit puts the accounts back');
  await resetState();
  await storage.saveAccounts(ACCOUNTS);
  await flush();
  let commitFailed = false;
  let ciphertextLanded = false;
  try {
    const prepared = await storage.prepareVault(PASSWORD);
    faults.failLocalGetFor = 'vault_meta';
    await prepared.commit();
  } catch {
    commitFailed = true;
    // Captured inside the catch, before the assertions below re-read storage.
    ciphertextLanded = true;
  } finally {
    faults.failLocalGetFor = null;
  }
  await flush();
  check('the commit reported failure', commitFailed);
  check('it got far enough to have written ciphertext', ciphertextLanded);
  check('no half-configured vault is left behind', areas.local.vault_meta === undefined);
  check('the vault is not enabled', (await vault.isVaultEnabled()) === false);
  const restored = areas.local.authenticator_accounts as any[];
  check('the stored records are readable again', Array.isArray(restored) && restored.every(r => 'secret' in r), JSON.stringify(restored)?.slice(0, 120));
  const afterRollback = await storage.getAccounts();
  check('both accounts came back', afterRollback.length === 2, `got ${afterRollback.length}`);
  check('in the clear, as they were', afterRollback.find(a => a.id === 'a2')?.secret === 'KRSXG5CTMVRXEZLU');

  // chrome.storage.sync measures its 8 KB per-item quota in UTF-8 bytes, while
  // String.length counts UTF-16 code units. Chunking against the latter meant a
  // chunk that measured 7 KB was really over 9 KB for a Cyrillic or CJK user,
  // and the whole write was rejected — silently, since local had already saved.
  scenario('Sync chunks stay under the per-item quota for non-ASCII accounts');
  await resetState();
  await storage.saveAccounts(CYRILLIC);
  await flush();
  const keys = syncAccountKeys();
  check('the accounts reached sync', keys.length > 0);
  const encoder = new TextEncoder();
  const oversized = keys.filter(
    key => encoder.encode(JSON.stringify(areas.sync[key])).length + key.length > 8192
  );
  check(
    'every chunk fits the 8192-byte limit',
    oversized.length === 0,
    oversized.map(k => `${k}=${encoder.encode(JSON.stringify(areas.sync[k])).length}B`).join(' ')
  );

  // The warning in Settings is the only thing that tells a user sync has stopped.
  // It was set when the chunk count ran over, but not when the write itself was
  // rejected — which is the more common way to hit the ceiling.
  scenario('A rejected sync write raises the overflow warning');
  await resetState();
  await storage.saveAccounts(ACCOUNTS);
  await flush();
  check('no warning while sync is healthy', (await storage.hasSyncOverflowed()) === false);
  faults.failSyncSet = true;
  await storage.saveAccounts([...ACCOUNTS, { ...ACCOUNTS[0], id: 'a3', secret: 'MFRGGZDFMZTWQ2LK' }]);
  await flush();
  faults.failSyncSet = false;
  check('the warning is raised', (await storage.hasSyncOverflowed()) === true);
  const localAfterSyncFailure = await storage.getAccounts();
  check('local kept every account', localAfterSyncFailure.length === 3, `got ${localAfterSyncFailure.length}`);

  // Reads take the union of local and sync, so a record in sync but not local
  // is treated as an account from another device. That is also exactly what a
  // record this device just deleted looks like until the sync write lands —
  // and the popup reloads the instant the delete resolves. The account was
  // written straight back to local, "deleted" only worked on the second try,
  // and the code kept working the whole time.
  scenario('Deleting an account works the first time');
  await resetState();
  await storage.saveAccounts(ACCOUNTS);
  await flush();
  await storage.deleteAccount('a1');
  // No flush: reloading immediately is the case that used to fail.
  const straightAfter = await storage.getAccounts();
  check('it is gone right away', straightAfter.length === 1, straightAfter.map(a => a.id).join(','));
  await flush();
  const afterSettle = await storage.getAccounts();
  check('and stays gone once sync settles', afterSettle.length === 1, afterSettle.map(a => a.id).join(','));
  check('and is gone from disk, not just the list', ((areas.local.authenticator_accounts as any[]) ?? []).length === 1);
  check('the other account is untouched', afterSettle[0]?.secret === 'KRSXG5CTMVRXEZLU');

  // Worse than a one-off for anyone whose sync writes are being rejected — over
  // quota, rate-limited: for them the stale copy never goes away, so deleting
  // never worked at all. Waiting for the sync write cannot help here; only the
  // record of what was deleted can.
  scenario('A deletion sticks even when the sync write is failing');
  await resetState();
  await storage.saveAccounts(ACCOUNTS);
  await flush();
  faults.failSyncSet = true;
  await storage.deleteAccount('a1');
  const withBrokenSync = await storage.getAccounts();
  check('still deleted', withBrokenSync.length === 1, withBrokenSync.map(a => a.id).join(','));
  await flush();
  check('and on the next read too', (await storage.getAccounts()).length === 1);
  check('the stale copy is indeed still in sync', JSON.stringify(areas.sync).includes('JBSWY3DPEHPK3PXP'));
  faults.failSyncSet = false;

  // The marker must not turn into a block on ever having that account again.
  scenario('An account can be added back after being deleted');
  await resetState();
  await storage.saveAccounts(ACCOUNTS);
  await flush();
  await storage.deleteAccount('a1');
  await flush();
  await storage.addAccount({ ...ACCOUNTS[0], id: 'a1-again' });
  await flush();
  const readded = await storage.getAccounts();
  check('it is back', readded.some(a => a.secret === 'JBSWY3DPEHPK3PXP'), readded.map(a => a.id).join(','));
  check('and survives a reload', (await storage.getAccounts()).length === 2);

  // The union exists so a second device's accounts show up. That still has to
  // happen — the fix must only suppress what this device deleted.
  scenario('Accounts from another device still arrive');
  await resetState();
  await storage.saveAccounts([ACCOUNTS[0]]);
  await flush();
  await storage.deleteAccount('a1');
  await flush();
  // A record this device has never seen, sitting in sync as if pushed by a
  // second browser.
  areas.sync['authenticator_accounts_9'] = [
    { id: 'remote', name: 'carol', issuer: 'Remote', secret: 'NBSWY3DPEHPK3PXQ', algorithm: 'SHA1', digits: 6, period: 30, createdAt: 9 },
  ];
  const withRemote = await storage.getAccounts();
  check('the remote account is picked up', withRemote.some(a => a.id === 'remote'), withRemote.map(a => a.id).join(','));
  check('the deleted one is still not', !withRemote.some(a => a.secret === 'JBSWY3DPEHPK3PXP'));

  // One entry with an empty name used to make the entire file unimportable —
  // on the day someone reaches for their only backup.
  scenario('One damaged entry no longer costs the whole backup file');
  await resetState();
  const damaged = JSON.stringify([
    { id: 'g1', name: '', issuer: 'GitHub', secret: 'JBSWY3DPEHPK3PXP', period: 30 },
    { id: 'g2', name: 'bob@example.com', issuer: 'Google', secret: 'KRSXG5CTMVRXEZLU', period: 30 },
    { name: 'no id', issuer: 'Dropbox', secret: 'MFRGGZDFMZTWQ2LK', period: 30 },
    { id: 'g4', name: 'no secret', issuer: 'Nothing' },
  ]);
  const outcome = await storage.importAccounts(damaged);
  await flush();
  const recovered = await storage.getAccounts();
  check('the three usable accounts are restored', recovered.length === 3, `got ${recovered.length}`);
  check('the nameless one kept its secret', recovered.some(a => a.secret === 'JBSWY3DPEHPK3PXP'));
  check('it was given a name to show', recovered.every(a => typeof a.name === 'string' && a.name.length > 0));
  check('the one with no id got one', recovered.every(a => typeof a.id === 'string' && a.id.length > 0));
  check('the unusable entry is counted, not hidden', outcome.unreadable === 1, JSON.stringify(outcome));

  // A `group` that is not a string threw on `.trim()` during render. With no
  // error boundary that blanked the popup — on every open, permanently, with the
  // record still on disk and the export button out of reach.
  scenario('A group of the wrong type cannot reach storage');
  await resetState();
  await storage.importAccounts(
    JSON.stringify([
      { id: 'n1', name: 'a', issuer: 'A', secret: 'JBSWY3DPEHPK3PXP', period: 30, group: 1337 },
      { id: 'n2', name: 'b', issuer: 'B', secret: 'KRSXG5CTMVRXEZLU', period: 30, group: { evil: true } },
      { id: 'n3', name: 'c', issuer: 'C', secret: 'MFRGGZDFMZTWQ2LK', period: 30, group: 'Work' },
    ])
  );
  await flush();
  const typed = await storage.getAccounts();
  check('all three imported', typed.length === 3, `got ${typed.length}`);
  check(
    'every group is a string or absent',
    typed.every(a => a.group === undefined || typeof a.group === 'string'),
    JSON.stringify(typed.map(a => a.group))
  );
  check('the real group survived', typed.find(a => a.id === 'n3')?.group === 'Work');
  check('trim() is safe on every record', typed.every(a => (a.group?.trim() ?? '') !== null));

  // Long enough to bloat every record and eat the sync budget; display truncates
  // it to nothing readable anyway.
  scenario('An absurdly long group name is clamped on import');
  await resetState();
  await storage.importAccounts(
    JSON.stringify([
      { id: 'l1', name: 'a', issuer: 'A', secret: 'JBSWY3DPEHPK3PXP', period: 30, group: 'G'.repeat(5000) },
    ])
  );
  await flush();
  const clamped = (await storage.getAccounts())[0];
  check('the name is cut to a sane length', (clamped.group?.length ?? 0) <= 64, `${clamped.group?.length}`);

  // Whitespace-only is the same as no group everywhere else in the app; storing
  // it would put an unnameable chip in the filter strip.
  scenario('A whitespace-only group imports as no group at all');
  await resetState();
  await storage.importAccounts(
    JSON.stringify([
      { id: 'w1', name: 'a', issuer: 'A', secret: 'JBSWY3DPEHPK3PXP', period: 30, group: '   ' },
    ])
  );
  await flush();
  check('the field is gone', (await storage.getAccounts())[0].group === undefined);

  // A file that is entirely unreadable is an error, not a silent no-op that
  // reports success and leaves the user believing they restored something.
  scenario('A file with nothing usable in it still fails loudly');
  await resetState();
  let rejected = false;
  try {
    await storage.importAccounts(JSON.stringify([{ id: 'x', name: 'x' }, { nope: true }]));
  } catch {
    rejected = true;
  }
  check('the import is rejected', rejected);
  check('nothing was written', (await storage.getAccounts()).length === 0);
}
