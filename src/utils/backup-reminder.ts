import { checkBackupHealth } from './auto-backup';
import { ageOf, deadlinePending } from './clock';

const STORAGE_KEY = 'backupReminder';

const ONE_DAY = 24 * 60 * 60 * 1000;
const SNOOZE_MS = 7 * ONE_DAY;
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

interface BackupReminderState {
  lastManualBackupDate: number | null;
  accountCountAtLastBackup: number;
  snoozedUntil: number | null;
}

async function getState(): Promise<BackupReminderState> {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY, (result) => {
      resolve(result[STORAGE_KEY] || {
        lastManualBackupDate: null,
        accountCountAtLastBackup: 0,
        snoozedUntil: null,
      });
    });
  });
}

async function setState(state: BackupReminderState): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: state }, resolve);
  });
}

export async function markBackupDone(accountCount: number): Promise<void> {
  const state = await getState();
  state.lastManualBackupDate = Date.now();
  state.accountCountAtLastBackup = accountCount;
  state.snoozedUntil = null;
  await setState(state);
}

export async function snoozeReminder(): Promise<void> {
  const state = await getState();
  state.snoozedUntil = Date.now() + SNOOZE_MS;
  await setState(state);
}

export async function shouldShowBackupReminder(accountCount: number): Promise<boolean> {
  if (accountCount < 3) return false;

  const state = await getState();

  // Snoozed — don't show. A snooze reaching further out than the snooze itself
  // was written on a wrong clock, and honouring it would retire one of the two
  // things standing between the user and losing every account.
  if (deadlinePending(state.snoozedUntil, SNOOZE_MS)) return false;

  // Never exported — show
  if (!state.lastManualBackupDate) return true;

  // An export stamped in the future counts as old rather than as "just backed
  // up": nudging someone to export again costs a click, and the other direction
  // costs them every account.
  const exportAge = ageOf(state.lastManualBackupDate) ?? Infinity;

  // No automatic snapshots either. That means IndexedDB is unavailable on this
  // profile — blocked site data, a corrupt profile, a full disk — and the
  // silent half of the safety net is simply not there. Nothing surfaced this
  // before: checkBackupHealth existed and had no callers, so the only remaining
  // protection was a manual export the user had no reason to think about.
  //
  // Only once the file is more than a day old. The first snapshot is written by
  // a load nobody awaits, so on a fresh profile — which is where people restore
  // from a file — this ran before it landed and asked the user to back up the
  // accounts they had restored from a backup a second earlier. A file from the
  // last day covers the gap until the first snapshot is due anyway; after that,
  // no snapshots really does mean there is no IndexedDB to write them to.
  if (exportAge > ONE_DAY) {
    const health = await checkBackupHealth();
    if (!health.hasBackups) return true;
  }

  // Exported more than 30 days ago AND new accounts added since.
  const isOld = exportAge > THIRTY_DAYS;
  const hasNewAccounts = accountCount > state.accountCountAtLastBackup;

  return isOld && hasNewAccounts;
}
