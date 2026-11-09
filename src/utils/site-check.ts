// The warning before a code goes into a page that imitates the account's site,
// and the daily count that says how often codes go where.
//
// See lookalike.ts for what counts as imitating, and why so little does.

import type { Account } from '@/types';
import { track } from '@/billing/events';
import { accountsForSite } from './account-sites';
import { lookalikeOf, referencesFor, type Lookalike } from './lookalike';
import { getBaseDomain, recordAccountUsage, siteHistory } from './suggestions';
import { isVaultEnabled } from './vault';

/** How the code was about to leave: copied from our window, or typed into the page. */
export type CodeVia = 'copy' | 'fill';

const ENABLED_KEY = 'siteWarnEnabled';
const TRUSTED_KEY = 'siteWarnTrusted';
const DAILY_KEY = 'codeSitesDaily';

type Trusted = Record<string, string[]>;

/** On unless switched off in Settings. */
export async function isSiteWarnEnabled(): Promise<boolean> {
  try {
    const found = await chrome.storage.local.get(ENABLED_KEY);
    return found[ENABLED_KEY] !== false;
  } catch {
    return true;
  }
}

export async function setSiteWarnEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [ENABLED_KEY]: enabled });
}

/**
 * Pages the user said were genuine for an account, kept apart from the usage
 * history because that one is off when suggestions are, and the answer must
 * hold either way. Held in memory-backed session storage while a vault is set
 * up, like the history: which services someone holds is what a vault protects.
 */
async function readTrusted(): Promise<Trusted> {
  try {
    const area = (await isVaultEnabled()) ? chrome.storage.session : chrome.storage.local;
    if (!area) return {};
    const found = await area.get(TRUSTED_KEY);
    const value = found[TRUSTED_KEY];
    return value && typeof value === 'object' ? (value as Trusted) : {};
  } catch {
    return {};
  }
}

async function writeTrusted(trusted: Trusted): Promise<void> {
  try {
    const vault = await isVaultEnabled();
    const area = vault ? chrome.storage.session : chrome.storage.local;
    if (vault) await chrome.storage.local.remove(TRUSTED_KEY).catch(() => {});
    await area?.set({ [TRUSTED_KEY]: trusted });
  } catch {
    // Forgetting an answer means asking once more, which is the safe side.
  }
}

/**
 * Whether this page imitates a site the account belongs on, or null.
 *
 * Null for a page the account was tied to by hand, used on before, or said to
 * be genuine; for one whose name is simply another account's (Strike when you
 * also hold Stripe); and for anything that is not a web page.
 */
export async function checkSite(hostname: string | null | undefined, account: Account, all: readonly Account[]): Promise<Lookalike | null> {
  if (!hostname) return null;
  try {
    if (!(await isSiteWarnEnabled())) return null;
    if (accountsForSite(hostname, [account]).length > 0) return null;
    const domain = getBaseDomain(hostname);
    const trusted = await readTrusted();
    if (trusted[domain]?.includes(account.id)) return null;

    const history = await siteHistory();
    const refs = referencesFor(account, history.get(account.id) ?? []);
    if (refs.length === 0) return null;
    const others = all
      .filter(other => other.id !== account.id)
      .flatMap(other => referencesFor(other, history.get(other.id) ?? []));
    return lookalikeOf(hostname, refs, others);
  } catch {
    return null;
  }
}

/** The user looked at the warning and said the page is the real one. */
export async function trustSite(hostname: string, accountId: string): Promise<void> {
  const domain = getBaseDomain(hostname);
  const trusted = await readTrusted();
  const ids = trusted[domain] ?? [];
  if (!ids.includes(accountId)) trusted[domain] = [...ids, accountId].slice(-20);
  await writeTrusted(trusted);
  // And it is evidence about the site, the same as a pick for it would be.
  await recordAccountUsage(hostname, accountId, 'site').catch(() => {});
}

export function reportSiteWarn(via: CodeVia, warning: Lookalike): void {
  void track('site_warn', { via, kind: warning.kind, basis: warning.basis });
}

export function reportSiteWarnAnswer(via: CodeVia, warning: Lookalike, proceed: boolean): void {
  void track('site_warn_answer', { via, kind: warning.kind, basis: warning.basis, proceed });
}

// --- How often codes go where -------------------------------------------------
// One event a day at most, with counts and nothing else: no site, no account.
// `here` — the page is one the account was tied to or used on; `elsewhere` —
// the account has such pages and this is not one; `unknown` — it has none yet;
// `warned` — the warning above was shown.

interface Daily {
  day: string;
  copy: number;
  fill: number;
  here: number;
  elsewhere: number;
  unknown: number;
  warned: number;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function emptyDay(day: string): Daily {
  return { day, copy: 0, fill: 0, here: 0, elsewhere: 0, unknown: 0, warned: 0 };
}

/**
 * Count one code that went to a page (copied with it open, or filled into it).
 * Sends the previous day's counts when the day has turned.
 */
export async function countCodeUse(
  via: CodeVia,
  hostname: string | null | undefined,
  account: Account,
  warned: boolean
): Promise<void> {
  if (!hostname) return;
  try {
    const domain = getBaseDomain(hostname);
    const tied = accountsForSite(hostname, [account]).length > 0;
    const usedOn = (await siteHistory()).get(account.id) ?? [];
    const sites = Array.isArray(account.sites) ? account.sites.length : 0;
    const where = tied || usedOn.includes(domain) ? 'here' : usedOn.length > 0 || sites > 0 ? 'elsewhere' : 'unknown';

    const found = await chrome.storage.local.get(DAILY_KEY);
    const stored = found[DAILY_KEY] as Daily | undefined;
    const day = today();
    let counts = stored && typeof stored === 'object' && typeof stored.day === 'string' ? stored : emptyDay(day);
    if (counts.day !== day) {
      const { day: _sent, ...previous } = counts;
      await track('code_sites', { ...previous });
      counts = emptyDay(day);
    }
    counts[via] += 1;
    counts[where] += 1;
    if (warned) counts.warned += 1;
    await chrome.storage.local.set({ [DAILY_KEY]: counts });
  } catch {
    // Counting must not break the thing counted.
  }
}
