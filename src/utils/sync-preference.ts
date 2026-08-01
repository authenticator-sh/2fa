// Whether the accounts and the vault metadata may travel through Chrome Sync.
//
// Its own module because both storage.ts and vault.ts have to honour it, and
// vault.ts cannot import storage.ts — storage.ts already imports vault.ts.
// Reading the key in two places instead would have let them drift, which is
// exactly what happened: turning sync off removed the vault metadata from
// Google's servers and the next password change quietly put it back.

const SYNC_ENABLED_KEY = 'syncEnabled';

/** On by default: most people expect their accounts on their other machines. */
export async function isSyncEnabled(): Promise<boolean> {
  const result = await chrome.storage.local.get(SYNC_ENABLED_KEY);
  return result[SYNC_ENABLED_KEY] !== false;
}

export async function setSyncPreference(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [SYNC_ENABLED_KEY]: enabled });
}
