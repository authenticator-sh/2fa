import type { Account } from '@/types';
import { isVaultEnabled } from './vault';

const STORAGE_KEY = 'accountUsageByDomain';
const ENABLED_KEY = 'suggestionsEnabled';
const GENERIC_SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac']);

/**
 * What is remembered about one account on one domain, split by what the use
 * actually proves.
 *
 * `site` counts uses tied to the page: a code inserted into a field there, or
 * one picked in direct answer to quick fill asking which account the site
 * wants. `copy` counts codes copied out of the popup, which carry the hostname
 * of whatever tab happened to be open and often have nothing to do with it —
 * a VPN code going into a desktop client, an SSH prompt, a game launcher.
 *
 * A bare number is what every version up to this one wrote, and every one of
 * those was a popup copy, so that is exactly how it is read.
 */
interface UsageEntry {
  s: number;
  c: number;
}

type UsageMap = Record<string, Record<string, UsageEntry | number>>;

/** What a single use proves about the account belonging to a site. */
export type UsageKind = 'site' | 'copy';

function readEntry(value: UsageEntry | number | undefined): UsageEntry {
  if (typeof value === 'number') return { s: 0, c: value };
  return {
    s: Number.isFinite(value?.s) ? (value as UsageEntry).s : 0,
    c: Number.isFinite(value?.c) ? (value as UsageEntry).c : 0,
  };
}

/** On by default — the suggestion is the main reason to use this on desktop. */
export async function areSuggestionsEnabled(): Promise<boolean> {
  const result = await chrome.storage.local.get(ENABLED_KEY);
  return result[ENABLED_KEY] !== false;
}

export async function setSuggestionsEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [ENABLED_KEY]: enabled });
  // Turning the feature off means the per-site usage history stops being
  // collected AND what was already collected goes away — someone switching
  // this off is objecting to the record existing, not just to the highlight.
  if (!enabled) {
    await chrome.storage.local.remove(STORAGE_KEY);
    if (hasSessionStorage()) await chrome.storage.session.remove(STORAGE_KEY).catch(() => {});
  }
}

// Strips subdomains down to a registrable domain. Good enough for a usage
// heuristic (not security-sensitive) — doesn't consult a real public suffix list,
// so exotic multi-part TLDs beyond the common co.uk-style pattern may over-strip.
export function getBaseDomain(hostname: string): string {
  const parts = hostname.split('.').filter(Boolean);
  if (parts.length <= 2) return hostname;

  const tld = parts[parts.length - 1];
  const sld = parts[parts.length - 2];
  if (tld.length === 2 && GENERIC_SECOND_LEVEL.has(sld) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

function hasSessionStorage(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.storage && !!chrome.storage.session;
}

/**
 * Where the per-site history is allowed to live.
 *
 * prepareVault scrubs this key before it commits, because "which services does
 * this person hold" is exactly the metadata the vault promises a stolen profile
 * will not give up. But nothing stopped the next copied code from writing it
 * straight back — including while the vault was locked, since copying a code
 * needs no key — so the promise held for about a day. With a vault configured
 * the history now lives in chrome.storage.session, the same place the active
 * group filter goes, and any local copy is removed the moment we see it.
 */
async function scrubLocalUsage(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY).catch(() => {});
}

async function getUsageMap(): Promise<UsageMap> {
  if (await isVaultEnabled()) {
    await scrubLocalUsage();
    if (!hasSessionStorage()) return {};
    try {
      const session = await chrome.storage.session.get(STORAGE_KEY);
      const stored = session[STORAGE_KEY];
      return stored && typeof stored === 'object' ? (stored as UsageMap) : {};
    } catch {
      return {};
    }
  }

  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY, (result) => resolve(result[STORAGE_KEY] || {}));
  });
}

export async function recordAccountUsage(
  hostname: string,
  accountId: string,
  kind: UsageKind = 'copy'
): Promise<void> {
  if (!(await areSuggestionsEnabled())) return;

  const vaultOn = await isVaultEnabled();
  if (vaultOn && !hasSessionStorage()) {
    // Chrome older than 102 has nowhere memory-backed to put this. The
    // suggestion is a convenience; the vault's guarantee is not.
    await scrubLocalUsage();
    return;
  }

  const domain = getBaseDomain(hostname);
  const usage = await getUsageMap();
  usage[domain] = usage[domain] || {};
  const entry = readEntry(usage[domain][accountId]);
  usage[domain][accountId] = kind === 'site' ? { ...entry, s: entry.s + 1 } : { ...entry, c: entry.c + 1 };

  if (vaultOn) {
    await chrome.storage.session.set({ [STORAGE_KEY]: usage }).catch(() => {});
    return;
  }

  await new Promise<void>((resolve) => chrome.storage.local.set({ [STORAGE_KEY]: usage }, () => resolve()));
}

/**
 * Which account the popup should pin for this site, in order of what the
 * evidence is actually worth.
 *
 * 1. An account used *on this site* — inserted into a field here, or picked
 *    when quick fill asked about this site.
 * 2. The account the site names, when it names exactly one: issuer or label
 *    matching the domain.
 * 3. Among several accounts the site names, whichever has been copied here
 *    most — the copy cannot say which site a code went to, but it can break a
 *    tie between accounts that already belong to this one.
 * 4. Failing all that, whatever has been copied here most.
 *
 * Rung 2 sitting above rung 4 is the whole point. Copying a VPN code off the
 * popup while Vercel is open used to make that VPN account Vercel's remembered
 * account, displacing the Vercel entry sitting right there with the site's own
 * name on it — one incidental copy beating the only piece of evidence that
 * actually mentions the site. A copy still teaches us something where nothing
 * else does, which is why it stays in the list at all.
 */
export async function getSuggestedAccountId(hostname: string, accounts: Account[]): Promise<string | null> {
  const domain = await matchableDomain(hostname, accounts);
  if (!domain) return null;

  const used = await usageOn(domain, accounts);
  if (used.site) return used.site;

  const matches = textMatches(domain, accounts);
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) {
    const copiedHere = used.copyRank.find(id => matches.some(match => match.id === id));
    return copiedHere || matches[0].id;
  }

  return used.copyRank[0] || null;
}

/** How a fill candidate was arrived at, weakest last. */
export type SuggestionSource = 'history' | 'text';

export interface FillCandidate {
  accountId: string;
  source: SuggestionSource;
}

/**
 * Which account to insert into the page without asking.
 *
 * The first two rungs above and no more. A code copied while a page was open
 * is never on its own a reason to type that code into the page, and neither is
 * a name that fits more than one account: the popup can show its best guess
 * and let the user look at it, but a fill has no such moment, and plenty of
 * these forms submit themselves on the last digit, spending one of the few
 * attempts the service allows.
 *
 * Returning null is not a failure. It means "ask", and the caller opens the
 * popup — where whatever the user picks is recorded as evidence about the
 * site, so the same question is not asked twice.
 */
export async function getFillCandidate(hostname: string, accounts: Account[]): Promise<FillCandidate | null> {
  const domain = await matchableDomain(hostname, accounts);
  if (!domain) return null;

  const used = await usageOn(domain, accounts);
  if (used.site) return { accountId: used.site, source: 'history' };

  const matches = textMatches(domain, accounts);
  return matches.length === 1 ? { accountId: matches[0].id, source: 'text' } : null;
}

/** The domain to match on, or null when there is nothing to match against. */
async function matchableDomain(hostname: string, accounts: Account[]): Promise<string | null> {
  if (!hostname || accounts.length === 0) return null;
  if (!(await areSuggestionsEnabled())) return null;
  return getBaseDomain(hostname);
}

/**
 * What this domain has learned, ignoring accounts since deleted: the account
 * used on the site itself, and every account copied while it was open, most
 * copied first.
 */
async function usageOn(
  domain: string,
  accounts: Account[]
): Promise<{ site: string | null; copyRank: string[] }> {
  const usage = await getUsageMap();
  const domainUsage = usage[domain];
  if (!domainUsage) return { site: null, copyRank: [] };

  const entries = Object.entries(domainUsage)
    .filter(([id]) => accounts.some(acc => acc.id === id))
    .map(([id, value]) => ({ id, ...readEntry(value) }));

  const onSite = entries.filter(entry => entry.s > 0).sort((a, b) => b.s - a.s);
  const copied = entries.filter(entry => entry.c > 0).sort((a, b) => b.c - a.c);

  return { site: onSite[0]?.id || null, copyRank: copied.map(entry => entry.id) };
}

/**
 * Accounts whose issuer or name reads like this domain, in list order.
 *
 * Used before anything has been learned about a site, which is every account's
 * first sign-in.
 */
function textMatches(domain: string, accounts: Account[]): Account[] {
  const domainCore = domain.split('.')[0].toLowerCase();
  if (domainCore.length < 3) return [];

  return accounts.filter(acc => {
    const issuer = acc.issuer.toLowerCase();
    const name = acc.name.toLowerCase();
    return (issuer.length >= 3 && (issuer.includes(domainCore) || domainCore.includes(issuer))) ||
      (name.length >= 3 && name.includes(domainCore));
  });
}
