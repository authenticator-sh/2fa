// Decides when to offer the password vault.
//
// Not at install time: a fresh user has nothing to protect yet, and asking for
// a password plus a recovery code before they have seen a single code is how
// you lose them on the onboarding. Not settings-only either — almost nobody
// opens settings, and the people who most need this are the least likely to go
// looking. So we wait until the user has enough accounts that the value is
// obvious, then offer once, quietly, and take "later" for an answer.

const STORAGE_KEY = 'vaultPrompt';

const MIN_ACCOUNTS = 2;
const SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_PROMPTS = 3;

interface VaultPromptState {
  dismissedForever: boolean;
  snoozedUntil: number | null;
  timesShown: number;
}

const DEFAULT_STATE: VaultPromptState = {
  dismissedForever: false,
  snoozedUntil: null,
  timesShown: 0,
};

async function getState(): Promise<VaultPromptState> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return { ...DEFAULT_STATE, ...(result[STORAGE_KEY] || {}) };
}

async function setState(state: VaultPromptState): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

export async function shouldShowVaultPrompt(accountCount: number, vaultEnabled: boolean): Promise<boolean> {
  if (vaultEnabled || accountCount < MIN_ACCOUNTS) return false;

  const state = await getState();
  if (state.dismissedForever) return false;
  if (state.timesShown >= MAX_PROMPTS) return false;
  if (state.snoozedUntil && Date.now() < state.snoozedUntil) return false;

  return true;
}

export async function markVaultPromptShown(): Promise<void> {
  const state = await getState();
  await setState({ ...state, timesShown: state.timesShown + 1 });
}

export async function snoozeVaultPrompt(): Promise<void> {
  const state = await getState();
  await setState({ ...state, snoozedUntil: Date.now() + SNOOZE_MS });
}

export async function dismissVaultPromptForever(): Promise<void> {
  const state = await getState();
  await setState({ ...state, dismissedForever: true });
}
