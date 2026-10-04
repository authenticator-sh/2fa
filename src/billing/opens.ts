// How often this install is opened: a count per UTC day, sent with the daily
// check-in and dropped once the server has it. Nothing about what was looked
// at — only that the extension was opened, so the admin can tell people who
// use it from browsers that merely run with it installed.

import { withLock } from '@/utils/write-lock';
import { BILLING_KEYS } from './state';

export interface OpenDay {
  /** The UTC day, yyyy-mm-dd. */
  d: string;
  n: number;
}

const OPENS_LOCK = 'authenticator-billing-opens';
/** Days kept while the server cannot be reached; older ones are dropped. */
const KEEP_DAYS = 14;
const MAX_PER_DAY = 1000;

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

async function readOpens(): Promise<Record<string, number>> {
  try {
    const found = (await chrome.storage.local.get(BILLING_KEYS.opens))[BILLING_KEYS.opens];
    if (!found || typeof found !== 'object' || Array.isArray(found)) return {};
    const out: Record<string, number> = {};
    for (const [d, n] of Object.entries(found as Record<string, unknown>)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && typeof n === 'number' && Number.isInteger(n) && n > 0) out[d] = Math.min(n, MAX_PER_DAY);
    }
    return out;
  } catch {
    return {};
  }
}

/** Counts one open of the extension. Never throws. */
export async function countOpen(now = Date.now()): Promise<void> {
  try {
    await withLock(OPENS_LOCK, async () => {
      const opens = await readOpens();
      const today = utcDay(now);
      opens[today] = Math.min((opens[today] ?? 0) + 1, MAX_PER_DAY);
      const oldest = utcDay(now - (KEEP_DAYS - 1) * 86_400_000);
      for (const d of Object.keys(opens)) if (d < oldest) delete opens[d];
      await chrome.storage.local.set({ [BILLING_KEYS.opens]: opens });
    });
  } catch (error) {
    console.warn('billing: could not count an open', error);
  }
}

/** The counts not yet delivered, oldest day first. */
export async function peekOpens(): Promise<OpenDay[]> {
  const opens = await readOpens();
  return Object.keys(opens)
    .sort()
    .map(d => ({ d, n: opens[d]! }));
}

/** Takes off what the server received; opens counted while the request was out stay. */
export async function ackOpens(sent: readonly OpenDay[]): Promise<void> {
  if (!sent.length) return;
  await withLock(OPENS_LOCK, async () => {
    const opens = await readOpens();
    for (const { d, n } of sent) {
      const left = (opens[d] ?? 0) - n;
      if (left > 0) opens[d] = left;
      else delete opens[d];
    }
    await chrome.storage.local.set({ [BILLING_KEYS.opens]: opens });
  });
}
