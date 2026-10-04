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

import { areas, check, flush, resetState, scenario, setWebLocks, storageContext, withLatency, USER_ADD } from './harness';

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
    storage.addAccount(account('b2', SEEDS[1]) as any, USER_ADD),
    storage.addAccount(account('c3', SEEDS[2]) as any, USER_ADD),
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
    storage.addMultipleAccounts([account('b2', SEEDS[1]), account('c3', SEEDS[2])] as any, USER_ADD),
    storage.addAccount(account('d4', SEEDS[3]) as any, USER_ADD),
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
    storage.addAccount(account('b3', SEEDS[2]) as any, USER_ADD),
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
    storage.addAccount(account('b2', SEEDS[1]) as any, USER_ADD),
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
    storage.addAccount(account('b3', SEEDS[2]) as any, USER_ADD),
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
    SEEDS.slice(1).map((seed, i) => storage.addAccount(account(`w${i + 1}`, seed) as any, USER_ADD))
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
  await storage.addAccount({ ...account('b2', SEEDS[0]), name: 'a different name' } as any, USER_ADD);
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
  , USER_ADD);
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
  const refused = await storage.addAccount(account('b2', SEEDS[1]) as any, USER_ADD).then(
    () => 'resolved',
    () => 'rejected'
  );
  resetFaults();
  check('the failing write is reported to its caller', refused === 'rejected', refused);
  await storage.addAccount(account('c3', SEEDS[2]) as any, USER_ADD);
  await flush();
  check(
    'and the next write still goes through',
    storedIds().join() === 'a1,c3',
    storedIds().join()
  );

  // Every open surface reloads on onChanged, so the local write inside a delete
  // triggers a read while sync still holds the old list. With the tombstone
  // written only after the save, that read merged the account straight back.
  // The mocked storage resolves as microtasks and never shows the race, so this
  // one runs with real latency.
  for (const withVault of [false, true]) {
    scenario(`A reload during a delete does not bring the account back${withVault ? ' (vault on)' : ''}`);
    await resetState();
    await storage.saveAccounts([account('a1', SEEDS[0]), account('b2', SEEDS[1])] as any);
    await flush();
    if (withVault) {
      await (await storage.prepareVault('correct horse battery staple')).commit();
      await flush();
    }
    const restore = withLatency(2);
    const reload = (changes: any, area: string) => {
      if (storage.affectsStoredAccounts(area, changes)) storage.getAccounts().catch(() => {});
    };
    chrome.storage.onChanged.addListener(reload);
    try {
      await storage.deleteAccount('b2');
      await new Promise(resolve => setTimeout(resolve, 50));
      await flush();
    } finally {
      chrome.storage.onChanged.removeListener(reload);
      restore();
    }
    const visible = (await storage.getAccounts()).map(a => a.id).join();
    check('the deleted account stays deleted', visible === 'a1', visible);
  }

  // --- separate contexts ---------------------------------------------------
  //
  // Everything above runs in ONE module instance, where the in-context queue
  // alone serialises the writers. A popup and the scanner tab are two instances
  // that share nothing but chrome.storage and navigator.locks — which is where
  // the 1.13.0 revision check lost: it compared the stamp, then encrypted, read
  // for the shrink guard and read the stamp again before writing, and the other
  // context's write landed in between. Measured with 1–5 ms of latency: a delete
  // racing an add brought the deleted account back 48 times in 50.

  const kinds = ['delete', 'add', 'edit', 'reorder'] as const;
  const losses: Record<(typeof kinds)[number], string[]> = { delete: [], add: [], edit: [], reorder: [] };
  const restoreLatency = withLatency(2);
  try {
    for (let round = 0; round < 4; round++) {
      for (const kind of kinds) {
        await resetState();
        const base = [account('a1', SEEDS[0]), account('a2', SEEDS[1])];
        areas.local.authenticator_accounts = base;
        areas.sync.authenticator_accounts_0 = base;

        const tag = `${kind}-${round}`;
        const [popup, scanner] = [await storageContext(`p-${tag}`), await storageContext(`s-${tag}`)];
        // Every open surface reloads on onChanged, as useAccounts does.
        const reloads = [popup, scanner].map(ctx => (changes: any, area: string) => {
          if (ctx.affectsStoredAccounts(area, changes)) ctx.getAccounts().catch(() => {});
        });
        reloads.forEach(listener => chrome.storage.onChanged.addListener(listener));

        const first = {
          delete: () => popup.deleteAccount('a1'),
          add: () => popup.addAccount(account('x3', SEEDS[2]) as any, USER_ADD),
          edit: () => popup.updateAccount('a2', { name: 'renamed' }),
          reorder: () => popup.reorderAccounts(['a2', 'a1']),
        }[kind];
        // Offsets across the window the old check left open: the second writer
        // starts while the first is between its read and its write.
        const offset = round * 4;
        await Promise.all([
          first(),
          new Promise(resolve => setTimeout(resolve, offset)).then(() =>
            scanner.addAccount(account('y4', SEEDS[3]) as any, USER_ADD)
          ),
        ]);
        await new Promise(resolve => setTimeout(resolve, 40));
        // Reopened a few times, from both sides, so a loss that a later merge
        // would paper over — or a resurrection a later read would cause — shows.
        for (let i = 0; i < 2; i++) {
          await popup.getAccounts();
          await scanner.getAccounts();
        }
        await new Promise(resolve => setTimeout(resolve, 40));
        reloads.forEach(listener => chrome.storage.onChanged.removeListener(listener));

        const ids = (await popup.getAccounts()).map(a => a.id).sort().join();
        const expected = {
          delete: 'a2,y4',
          add: 'a1,a2,x3,y4',
          edit: 'a1,a2,y4',
          reorder: 'a1,a2,y4',
        }[kind];
        if (ids !== expected) losses[kind].push(`offset ${offset}: ${ids}`);
        if (kind === 'edit' && !(await popup.getAccounts()).some(a => a.name === 'renamed')) {
          losses.edit.push(`offset ${offset}: the rename was lost`);
        }
      }
    }
  } finally {
    restoreLatency();
  }

  scenario('A delete in one window and an add in another: gone stays gone, added stays added');
  check('in every round', losses.delete.length === 0, losses.delete.join('; '));
  scenario('Two windows adding at once keep both accounts');
  check('in every round', losses.add.length === 0, losses.add.join('; '));
  scenario('A rename in one window and an add in another keep both');
  check('in every round', losses.edit.length === 0, losses.edit.join('; '));
  scenario('A drag in one window and an add in another keep every account');
  check('in every round', losses.reorder.length === 0, losses.reorder.join('; '));

  // A delete writes its marker first and its list second (see deleteAccount).
  // Any save landing between the two used to call forgetDeleted for every
  // identity in ITS list — which still held the account being deleted — and
  // wiped the marker. The delete's own write then removed the record from
  // local, but with no marker the stale sync copy merged it straight back, for
  // good. Replayed here step by step, as another context would interleave.
  scenario('A save that does not add an account leaves a deletion marker alone');
  await resetState();
  areas.local.authenticator_accounts = [account('a1', SEEDS[0]), account('a2', SEEDS[1])];
  areas.sync.authenticator_accounts_0 = [account('a1', SEEDS[0]), account('a2', SEEDS[1])];
  {
    const other = await storageContext('marker-other');
    const tombstones = await import('@/utils/tombstones');
    // The deleting context has written its marker and not yet its list.
    await tombstones.markDeleted([SEEDS[0]]);
    await other.updateAccount('a2', { name: 'renamed' });
    await flush();
    const wasDeleted = await tombstones.deletedHere();
    check('the marker survives a save that merely still held the account', await wasDeleted(SEEDS[0]));
    // The delete's own write lands; sync still holds a1, as it does whenever
    // the push is slow or refused.
    areas.local.authenticator_accounts = (areas.local.authenticator_accounts as any[]).filter(r => r.id !== 'a1');
    areas.sync.authenticator_accounts_0 = [account('a1', SEEDS[0]), account('a2', SEEDS[1])];
    const ids = (await other.getAccounts()).map(a => a.id).join();
    check('and the deleted account stays out', ids === 'a2', ids);
  }

  // --- what the open page shows -------------------------------------------
  //
  // Every open surface reloads on every storage event, and reads do not finish
  // in the order they started: a read that has to replay a held sync push waits
  // for the accounts lock with the list it already read, while a read started
  // after the next write finishes at once. Applied in arrival order, the older
  // list landed last and stayed on screen.
  scenario('A reload that started first but finished last does not put the older list on screen');
  await resetState();
  {
    const { createAccountsLoader } = await import('@/hooks/useAccounts');
    await storage.saveAccounts([account('a1', SEEDS[0]), account('a2', SEEDS[1])] as any);
    await flush();
    const screen: { accounts: any[] } = { accounts: [] };
    const loader = createAccountsLoader(patch => {
      if (patch.accounts) screen.accounts = patch.accounts;
    });
    // A held push is waiting to be replayed, so the first read will queue for
    // the lock after reading — behind the writer standing in for another window.
    areas.local.syncPushPending = true;
    let release!: () => void;
    const writerHolds = new Promise<void>(resolve => (release = resolve));
    const writer = navigator.locks.request('authenticator-accounts', () => writerHolds);
    await flush();

    const older = loader.load({ quiet: true });
    await flush();
    // The other window's add lands while it holds the lock…
    areas.local.authenticator_accounts = [
      ...(areas.local.authenticator_accounts as any[]),
      account('a3', SEEDS[2]),
    ];
    // …and the storage event it fires starts a second read, which sees it.
    await loader.load({ quiet: true });
    release();
    await writer;
    await older;
    await flush();
    const ids = screen.accounts.map(a => a.id).join();
    check('the screen shows the newest list', ids === 'a1,a2,a3', ids);
  }

  scenario('Reloading a list that is already on screen keeps it there');
  await resetState();
  {
    const { createAccountsLoader } = await import('@/hooks/useAccounts');
    await storage.saveAccounts([account('a1', SEEDS[0])] as any);
    const spinners: boolean[] = [];
    const loader = createAccountsLoader(patch => {
      if (patch.loading !== undefined) spinners.push(patch.loading);
    });
    await loader.reload();
    check('the first load shows the spinner', spinners[0] === true, spinners.join());
    spinners.length = 0;
    await loader.load({ quiet: true });
    check('a quiet reload never does', !spinners.includes(true), spinners.join());
    spinners.length = 0;
    // What App calls after an import or a restore.
    await loader.reload();
    check('nor does a reload once a list is shown', !spinners.includes(true), spinners.join());
    loader.clear();
    spinners.length = 0;
    await loader.reload();
    check('after a lock the next load shows it again', spinners[0] === true, spinners.join());
  }

  scenario('Locking while a read is in flight keeps the decrypted list off screen');
  await resetState();
  {
    const { createAccountsLoader } = await import('@/hooks/useAccounts');
    await storage.saveAccounts([account('a1', SEEDS[0])] as any);
    let shown: any[] = [];
    const loader = createAccountsLoader(patch => {
      if (patch.accounts) shown = patch.accounts;
    });
    const inFlight = loader.load();
    loader.clear();
    await inFlight;
    check('nothing is published after the lock', shown.length === 0, shown.map(a => a.id).join());
  }

  // Web Locks are missing on old Chrome builds; the in-context queue must still
  // serialise one window's own writers, as it did before the lock existed.
  scenario('Without Web Locks one window still never loses its own writes');
  setWebLocks(false);
  try {
    await resetState();
    await storage.saveAccounts([account('a1', SEEDS[0])]);
    await Promise.all(SEEDS.slice(1, 4).map((seed, i) => storage.addAccount(account(`n${i}`, seed) as any, USER_ADD)));
    await flush();
    check('every add landed', storedIds().join() === 'a1,n0,n1,n2', storedIds().join());
  } finally {
    setWebLocks(true);
  }
}

