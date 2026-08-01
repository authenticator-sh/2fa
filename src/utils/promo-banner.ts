export const PROMO_URL = 'https://chromewebstore.google.com/detail/password-manager/afdkmocgccmemgiblaemcfhhgmjoabkl?utm_source=2fa';

const STORAGE_KEY = 'crossPromo';
const ONE_WEEK = 7 * 24 * 60 * 60 * 1000;

interface CrossPromoState {
  firstOpenDate: number | null;
  dismissed: boolean;
}

async function getState(): Promise<CrossPromoState> {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY, (result) => {
      resolve(result[STORAGE_KEY] || { firstOpenDate: null, dismissed: false });
    });
  });
}

async function setState(state: CrossPromoState): Promise<void> {
  return new Promise((resolve) => chrome.storage.local.set({ [STORAGE_KEY]: state }, () => resolve()));
}

export async function recordFirstOpen(): Promise<void> {
  const state = await getState();
  if (state.firstOpenDate === null) {
    state.firstOpenDate = Date.now();
    await setState(state);
  }
}

export async function dismissPromoBanner(): Promise<void> {
  const state = await getState();
  state.dismissed = true;
  await setState(state);
}

export async function shouldShowPromoBanner(): Promise<boolean> {
  const state = await getState();
  if (state.dismissed || !state.firstOpenDate) return false;
  return Date.now() - state.firstOpenDate >= ONE_WEEK;
}
