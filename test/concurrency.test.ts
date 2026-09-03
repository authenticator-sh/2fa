// Two surfaces writing the account list at once.
//
// Until 1.13.0 this could not happen: an action popup is destroyed the moment
// it loses focus, so there was only ever one context in a position to edit. A
// floating window and a side panel stay open for hours, beside the scanner tab
// and the passkey page — and every mutation is a read-modify-write over one
// array. Two of them deciding from the same read, each writing what it worked
// out, loses whichever landed first, and both screens say the account was
// added.
//
// The length guard in saveAccounts does not see it: eleven written over eleven
// is not a shrink. These scenarios are the ones that guard actually misses.

import { areas, check, flush, resetState, scenario } from './harness';

const account = (id: string, secret: string) => ({
  id,
  name: `${id}@example.com`,
  issuer: 'Example',
  secret,
  algorithm: 'SHA1' as const,
  digits: 6,
  period: 30,
  createdAt: Number(id.replace(/\D/g, '')) || 1,
});

/** Distinct base32 seeds — storage collapses accounts that share one. */
const SEEDS = [
  'JBSWY3DPEHPK3PXP',
  'KRSXG5CTMVRXEZLU',
  'MFRGGZDFMZTWQ2LK',
  'NBSWY3DPEB3W64TM',
  'ONSWG4TFORZTA5DI',
  'PJSXG33VOQQDCMBA',
];

const storedRecords = (): any[] => (areas.local.authenticator_accounts as any[]) ?? [];
const storedIds = (): string[] => storedRecords().map(record => record.id).sort();

export async function run(): Promise<void> {
  const storage = await import('@/utils/storage');

  // The plainest form of it: two clicks, two contexts, one tick apart.
  scenario('Two accounts added at the same moment both survive');
  await resetState();
  await storage.saveAccounts([account('a1', SEEDS[0])]);
  await flush();
  await Promise.all([
    storage.addAccount(account('b2', SEEDS[1]) as any),
    storage.addAccount(account('c3', SEEDS[2]) as any),
  ]);
  await flush();
  check(
    'both are on disk, not just the later one',
    storedIds().join() === 'a1,b2,c3',
    storedIds().join()
  );

  // The release's own example: "scan an account on the scanner page and it
  // appears in the window you left open". The window is not merely watching —
  // it can be adding one of its own at the same time.
  scenario('A scan and a paste-import at the same moment keep every account');
  await resetState();
  await storage.saveAccounts([account('a1', SEEDS[0])]);
  await flush();
  const [batch] = await Promise.all([
    storage.addMultipleAccounts([account('b2', SEEDS[1]), account('c3', SEEDS[2])] as any),
    storage.addAccount(account('d4', SEEDS[3]) as any),
  ]);
  await flush();
  check(
    'the batch and the single add both land',
    storedIds().join() === 'a1,b2,c3,d4',
    storedIds().join()
  );
  check('and the batch reports what it actually wrote', batch.added === 2, String(batch.added));

  // A delete is the one operation allowed to shrink the store, so the guard
  // steps aside for it — which is exactly when a concurrent add is defenceless.
  scenario('An account added while another is being deleted is not swept away');
  await resetState();
  await storage.saveAccounts([account('a1', SEEDS[0]), account('a2', SEEDS[1])]);
  await flush();
  await Promise.all([
    storage.deleteAccount('a1'),
    storage.addAccount(account('b3', SEEDS[2]) as any),
  ]);
  await flush();
  check(
    'the delete took only its own account',
    storedIds().join() === 'a2,b3',
    storedIds().join()
  );

  // An edit computed from a stale list used to be refused outright — the guard
  // fired and the Save button simply stopped working. It should now go through.
  scenario('An edit racing an add is applied rather than refused');
  await resetState();
  await storage.saveAccounts([account('a1', SEEDS[0])]);
  await flush();
  const outcomes = await Promise.allSettled([
    storage.updateAccount('a1', { name: 'renamed@example.com' }),
    storage.addAccount(account('b2', SEEDS[1]) as any),
  ]);
  await flush();
  check(
    'neither operation was rejected',
    outcomes.every(o => o.status === 'fulfilled'),
    JSON.stringify(outcomes.map(o => (o.status === 'rejected' ? String(o.reason) : 'ok')))
  );
  const afterEdit = await storage.getAccounts();
  check('the rename stuck', afterEdit.find(a => a.id === 'a1')?.name === 'renamed@example.com');
  check('and the new account is there too', afterEdit.some(a => a.id === 'b2'));

  // Reordering sends the ids React knows about. A drag started before a scan
  // finished must not decide the list on its own.
  scenario('A drag started before a scan lands does not drop the scanned account');
  await resetState();
  await storage.saveAccounts([account('a1', SEEDS[0]), account('a2', SEEDS[1])]);
  await flush();
  await Promise.all([
    storage.reorderAccounts(['a2', 'a1']),
    storage.addAccount(account('b3', SEEDS[2]) as any),
  ]);
  await flush();
  check(
    'all three accounts are stored',
    storedIds().join() === 'a1,a2,b3',
    storedIds().join()
  );

  // Six writers at once is not a realistic user, but it is what a retry storm
  // or a burst of storage events looks like, and none of them may be dropped.
  scenario('Six writers at once lose nothing between them');
  await resetState();
  await storage.saveAccounts([account('a0', SEEDS[0])]);
  await flush();
  await Promise.all(
    SEEDS.slice(1).map((seed, i) => storage.addAccount(account(`w${i + 1}`, seed) as any))
  );
  await flush();
  const all = await storage.getAccounts();
  check('every one of them is stored', all.length === SEEDS.length, `got ${all.length}`);
  check(
    'and no seed was written twice',
    new Set(all.map(a => a.secret)).size === all.length,
    JSON.stringify(all.map(a => a.secret))
  );

  // A second record carrying the same seed used to be written to disk and then
  // hidden by the read path that collapses duplicates. From there the store and
  // the list disagreed about how many accounts existed, every non-shrinking
  // write was refused by the guard, and the next import erased the hidden one.
  scenario('A secret that is already stored never becomes a second hidden record');
  await resetState();
  await storage.saveAccounts([account('a1', SEEDS[0])]);
  await flush();
  await storage.addAccount({ ...account('b2', SEEDS[0]), name: 'a different name' } as any);
  await flush();
  check('nothing was appended', storedRecords().length === 1, String(storedRecords().length));
  check(
    'and the record that was already there is untouched',
    storedRecords()[0].id === 'a1',
    JSON.stringify(storedRecords()[0]?.id)
  );

  // Four spellings of one seed. Every parser normalises on the way in, so these
  // reach storage from a hand-edited backup or another app's export file.
  scenario('One seed spelled four ways is one account');
  await resetState();
  await storage.saveAccounts([account('a1', 'JBSWY3DPEHPK3PXP')]);
  await flush();
  const spellings = ['jbswy3dpehpk3pxp', 'JBSWY3DPEHPK3PXP=', 'JBSW-Y3DP-EHPK-3PXP', 'JBSW Y3DP EHPK 3PXP'];
  const batch2 = await storage.addMultipleAccounts(
    spellings.map((secret, i) => account(`v${i}`, secret)) as any
  );
  await flush();
  check('none of them is added', batch2.added === 0, String(batch2.added));
  check('all four are reported as already here', batch2.skipped === 4, String(batch2.skipped));
  check('and the store still holds one account', storedRecords().length === 1, String(storedRecords().length));

  // The queue must survive a failed write. A rejected save that wedged it would
  // silently stop every later mutation in the session — worse than the race.
  scenario('A failed write does not wedge the writer queue');
  await resetState();
  await storage.saveAccounts([account('a1', SEEDS[0])]);
  await flush();
  const { faults, resetFaults } = await import('./harness');
  faults.failLocalSetFor = 'authenticator_accounts';
  const refused = await storage.addAccount(account('b2', SEEDS[1]) as any).then(
    () => 'resolved',
    () => 'rejected'
  );
  resetFaults();
  check('the failing write is reported to its caller', refused === 'rejected', refused);
  await storage.addAccount(account('c3', SEEDS[2]) as any);
  await flush();
  check(
    'and the next write still goes through',
    storedIds().join() === 'a1,c3',
    storedIds().join()
  );
}
