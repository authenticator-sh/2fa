import { checkBackupHealth } from './auto-backup';
import { ageOf, deadlinePending } from './clock';

const STORAGE_KEY = 'backupReminder';

const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
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

  // No automatic snapshots either. That means IndexedDB is unavailable on this
  // profile — blocked site data, a corrupt profile, a full disk — and the
  // silent half of the safety net is simply not there. Nothing surfaced this
  // before: checkBackupHealth existed and had no callers, so the only remaining
  // protection was a manual export the user had no reason to think about.
  const health = await checkBackupHealth();
  if (!health.hasBackups) return true;

  // Exported more than 30 days ago AND new accounts added since. An export
  // stamped in the future counts as old rather than as "just backed up".
  // An export stamped in the future counts as old rather than as "just backed
  // up": nudging someone to export again costs a click, and the other direction
  // costs them every account.
  const isOld = (ageOf(state.lastManualBackupDate) ?? Infinity) > THIRTY_DAYS;
  const hasNewAccounts = accountCount > state.accountCountAtLastBackup;

  return isOld && hasNewAccounts;
}
