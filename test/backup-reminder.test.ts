// When the backup reminder speaks up — above all, that it stays quiet at the
// one moment someone has just proved they have a backup: right after restoring
// from it.

import { areas, check, faults, resetStateFreshProfile, scenario, setBackupRows } from './harness';

const DAY = 24 * 60 * 60 * 1000;

export async function run(): Promise<void> {
  const reminder = await import('@/utils/backup-reminder');

  // A restore happens on a new install, and there the first automatic snapshot
  // is written by a load nobody waits for. The reminder read "no snapshots"
  // before it landed and asked the user to back up the accounts they had just
  // restored from a backup.
  scenario('Restoring on a fresh profile does not ask for a backup');
  await resetStateFreshProfile();
  await reminder.markBackupDone(5);
  check(
    'quiet right after the import, before any snapshot exists',
    !(await reminder.shouldShowBackupReminder(5))
  );

  scenario('A day on with no snapshots it still asks: IndexedDB is not there');
  await resetStateFreshProfile();
  faults.indexedDB = true;
  areas.local.backupReminder = {
    lastManualBackupDate: Date.now() - 2 * DAY,
    accountCountAtLastBackup: 5,
    snoozedUntil: null,
  };
  check('asks when snapshots cannot be written', await reminder.shouldShowBackupReminder(5));

  scenario('With snapshots in place, a file from this month keeps it quiet');
  await resetStateFreshProfile();
  setBackupRows([{ id: 'today', accounts: [], timestamp: Date.now(), accountCount: 5 }]);
  areas.local.backupReminder = {
    lastManualBackupDate: Date.now() - 2 * DAY,
    accountCountAtLastBackup: 5,
    snoozedUntil: null,
  };
  check('quiet', !(await reminder.shouldShowBackupReminder(5)));
}
