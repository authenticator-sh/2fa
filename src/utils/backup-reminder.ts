const STORAGE_KEY = 'backupReminder';

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
  state.snoozedUntil = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days
  await setState(state);
}

export async function shouldShowBackupReminder(accountCount: number): Promise<boolean> {
  if (accountCount < 3) return false;

  const state = await getState();
  const now = Date.now();

  // Snoozed — don't show
  if (state.snoozedUntil && now < state.snoozedUntil) return false;

  // Never exported — show
  if (!state.lastManualBackupDate) return true;

  // Exported more than 30 days ago AND new accounts added since
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  const isOld = (now - state.lastManualBackupDate) > THIRTY_DAYS;
  const hasNewAccounts = accountCount > state.accountCountAtLastBackup;

  return isOld && hasNewAccounts;
}
