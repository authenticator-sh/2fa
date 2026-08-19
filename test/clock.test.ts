// What happens when the device clock is wrong.
//
// Every check below is the same defect wearing different clothes: a bare
// `Date.now() - stamp` comparison that a backwards clock turns negative, so the
// deadline never arrives and the feature waits forever in silence. It shipped
// in six places at once — the clock check, the vault's auto-lock, the daily
// backup, the sync settle window, tombstones, and the backup reminder — because
// nothing in the suite ever moved the clock.
//
// The scenarios are written from the trigger, not the helper: a dead CMOS
// battery, a dual-boot machine, a VM resume, someone fixing a wrong date.

import { areas, backupRows, check, flush, resetState, scenario, setBackupRows } from './harness';

const PASSWORD = 'correct horse battery staple';
const ACCOUNTS: any[] = [
  { id: 'a1', name: 'alice@example.com', issuer: 'GitHub', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, createdAt: 1 },
];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export async function run(): Promise<void> {
  const clock = await import('@/utils/clock');
  const vault = await import('@/utils/vault');
  const storage = await import('@/utils/storage');
  const autoBackup = await import('@/utils/auto-backup');
  const tombstones = await import('@/utils/tombstones');
  const reminder = await import('@/utils/backup-reminder');

  /** Run `fn` with the device clock pinned to `deviceMs`. */
  const at = async <T>(deviceMs: number, fn: () => Promise<T>): Promise<T> => {
    const real = Date.now;
    (Date as any).now = () => deviceMs;
    try {
      return await fn();
    } finally {
      (Date as any).now = real;
    }
  };

  scenario('A stamp from the future is not a measurement');
  {
    const now = Date.now();
    check('a past stamp measures its age', Math.abs((clock.ageOf(now - 5_000) ?? -1) - 5_000) < 50);
    check('a future stamp is refused', clock.ageOf(now + HOUR) === null);
    check('so is a missing one', clock.ageOf(undefined) === null && clock.ageOf(NaN) === null);
    check('a live deadline holds', clock.deadlinePending(now + MINUTE, HOUR));
    check('a passed deadline does not', !clock.deadlinePending(now - MINUTE, HOUR));
    check('and neither does one beyond its own window', !clock.deadlinePending(now + 400 * DAY, 7 * DAY));
  }

  // The vault's idle deadline is the only thing enforcing auto-lock: there is
  // no alarm and no timer, just this subtraction on every key read.
  scenario('Winding the clock back does not disable auto-lock');
  await resetState();
  {
    await storage.saveAccounts(ACCOUNTS);
    const prepared = await storage.prepareVault(PASSWORD);
    await prepared.commit();
    await flush();
    await vault.setAutoLockMinutes(15);
    check('the vault starts unlocked', await vault.isUnlocked());

    // Someone sets the system clock back an hour while the machine is idle.
    const key = await at(Date.now() - HOUR, () => vault.getMasterKeyBytes());
    check('the key is withheld', key === null);
    check('and the vault is locked, not merely idle', !(await vault.isUnlocked()));
  }

  scenario('One snapshot from a fast clock does not end the daily backup');
  await resetState();
  {
    // Written while the clock read tomorrow, then the clock was corrected.
    setBackupRows([{ id: 'glitch', accounts: ACCOUNTS, timestamp: Date.now() + DAY }]);
    await autoBackup.autoBackup(ACCOUNTS);
    await flush();
    check('a fresh snapshot is still taken', backupRows.length === 2, `${backupRows.length} rows`);

    const latest = await autoBackup.getLatestBackup();
    check('and recovery prefers the trustworthy one', latest?.id !== 'glitch', String(latest?.id));
  }

  // stampNow deliberately puts stamps AHEAD of a backwards-running clock. Read
  // with ageOf they look like the future, i.e. untrustworthy — which turned the
  // backup's own newest snapshot into one it refused to count.
  scenario('Snapshots keep advancing after the clock is corrected');
  await resetState();
  {
    // A popup opened while the clock was two days fast: the snapshot and the
    // high-water mark were both written then. Now the clock is correct again.
    areas.local.clockHighWater = Date.now() + 2 * DAY;
    setBackupRows([{ id: 'from-the-fast-clock', accounts: ACCOUNTS, timestamp: Date.now() + 2 * DAY, accountCount: 1 }]);

    await autoBackup.autoBackup([...ACCOUNTS, { ...ACCOUNTS[0], id: 'a2', name: 'bob@example.com' }]);
    await flush();
    check('a snapshot is taken', backupRows.length === 2, `${backupRows.length} rows`);

    const latest = await autoBackup.getLatestBackup();
    check('and it is the one recovery would use', latest?.accountCount === 2, JSON.stringify(latest?.accountCount));

    // Second open, same day: the snapshot just written must count as recent, or
    // the daily backup runs on every single popup open forever.
    await autoBackup.autoBackup(ACCOUNTS);
    await flush();
    check('the daily backup does not fire again the same day', backupRows.length === 2, `${backupRows.length} rows`);
  }

  scenario('A fresh export keeps the reminder quiet, a future-stamped one does not');
  await resetState();
  {
    setBackupRows([{ id: 'today', accounts: ACCOUNTS, timestamp: Date.now(), accountCount: 1 }]);
    await reminder.markBackupDone(3);
    check('an export just now silences it', !(await reminder.shouldShowBackupReminder(5)));

    // Written while the clock was days fast: unusable as an age, and the safe
    // reading of "we cannot tell when you last exported" is to ask again.
    areas.local.backupReminder = {
      lastManualBackupDate: Date.now() + 2 * DAY,
      accountCountAtLastBackup: 3,
      snoozedUntil: null,
    };
    check('an unusable export date asks again', await reminder.shouldShowBackupReminder(5));
  }

  scenario('A sync settle window stamped in the future heals itself');
  await resetState();
  {
    // A fresh profile whose first sync read happened on a fast clock. Left as
    // it was, this profile would never push to sync again — no offsite copy.
    areas.local.syncFirstReadAt = Date.now() + DAY;
    delete areas.local.syncObserved;

    await storage.getStoredAccounts();
    await flush();
    const restamped = areas.local.syncFirstReadAt as number;
    check('the impossible stamp is replaced', restamped <= Date.now(), String(restamped));
    check('and the window can now elapse', clock.ageOf(restamped) !== null);
  }

  scenario('Deletions recorded on a wrong clock still stick');
  await resetState();
  {
    // A machine with a dead battery reports 2015; the user deletes an account.
    const longAgo = Date.UTC(2015, 0, 1);
    await at(longAgo, () => tombstones.markDeleted(['JBSWY3DPEHPK3PXP']));
    const recorded = await tombstones.deletedHere();
    check('the deletion is recorded', await recorded('JBSWY3DPEHPK3PXP'));

    // The clock is fixed. The old cutoff called this tombstone eleven years old
    // and dropped it on the next write, and the account came back from sync.
    await tombstones.markDeleted(['MFRGGZDFMZTWQ2LK']);
    await flush();
    const after = await tombstones.deletedHere();
    check('and survives the clock being corrected', await after('JBSWY3DPEHPK3PXP'));
  }

  scenario('A backup reminder snoozed on a wrong clock comes back');
  await resetState();
  {
    // Snoozed for "seven days" while the clock read ten years ahead.
    await at(Date.now() + 3650 * DAY, () => reminder.snoozeReminder());
    check('the reminder is not retired for a decade', await reminder.shouldShowBackupReminder(5));
  }
}
