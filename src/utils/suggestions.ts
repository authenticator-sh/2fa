import type { Account } from '@/types';
import { isVaultEnabled } from './vault';
import { publicSuffixLength } from './public-suffix';
import { accountsForSite, boundElsewhere } from './account-sites';

const STORAGE_KEY = 'accountUsageByDomain';
const ENABLED_KEY = 'suggestionsEnabled';

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

/**
 * The registrable domain a hostname belongs to: everything the same owner
 * controls, and the key the per-site history is filed under.
 *
 * This used to keep two labels unless the second-level one was on a short list
 * of co/com/org-style names, which folded whole public zones into one "site":
 * hometax.go.kr and gov24.go.kr both became go.kr, so an account used on one
 * government service was inserted unasked on another, and every github.io or
 * vercel.app tenant shared one history with every other. The suffixes now come
 * from a cut of the Public Suffix List (see public-suffix.ts). Entries filed
 * under the old, folded keys simply stop matching — asking once more is the
 * safe direction, and there is no way to tell which site they were earned on.
 */
export function getBaseDomain(hostname: string): string {
  // An address has no registrable part, and trimming it to its last two
  // octets would merge every host on the same /16.
  if (hostname.includes(':') || /^\d+(\.\d+){3}$/.test(hostname)) return hostname;

  const parts = hostname.toLowerCase().split('.').filter(Boolean);
  const suffix = publicSuffixLength(parts);
  // The hostname is itself a public suffix (github.io, co.uk): nothing to strip.
  if (parts.length <= suffix) return hostname;
  return parts.slice(-(suffix + 1)).join('.');
}

/**
 * The hostname a suggestion can be made for, or null for anything that is not
 * a web page — chrome://, file://, the extension's own pages, no URL at all.
 */
export function hostnameOf(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.hostname : null;
  } catch {
    return null;
  }
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
 * Every domain each account's code was used on *in the page* — inserted there,
 * or picked when quick fill asked about it. Copies are left out: they carry
 * whatever tab happened to be open.
 */
export async function siteHistory(): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const usage = await getUsageMap();
  for (const [domain, byAccount] of Object.entries(usage)) {
    if (!byAccount || typeof byAccount !== 'object') continue;
    for (const [id, value] of Object.entries(byAccount)) {
      if (readEntry(value).s <= 0) continue;
      const list = out.get(id);
      if (list) list.push(domain);
      else out.set(id, [domain]);
    }
  }
  return out;
}

/**
 * Which accounts the popup should pin for this site, best first, and whether
 * the user tied them to it themselves.
 *
 * 0. Accounts whose websites (set by hand in Edit) cover this page — all of
 *    them, the most specific site only; see account-sites.ts. Among them, the
 *    one used here before goes first.
 *
 * Failing that, one account, in order of what the evidence is worth:
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
 *
 * An account tied to other websites takes no part in rungs 1–4: the user has
 * said where it belongs. The sites count even with suggestions switched off —
 * that switch is about what we learn and guess, and a site typed in by hand is
 * neither.
 */
export async function getSiteSuggestions(
  hostname: string,
  accounts: Account[]
): Promise<{ ids: string[]; explicit: boolean }> {
  if (!hostname || accounts.length === 0) return { ids: [], explicit: false };

  const bound = accountsForSite(hostname, accounts);
  if (bound.length > 0) {
    const used = (await areSuggestionsEnabled()) ? await usageOn(getBaseDomain(hostname), bound) : null;
    const first = used?.site ?? used?.copyRank[0];
    const ids = bound.map(acc => acc.id);
    return { ids: first ? [first, ...ids.filter(id => id !== first)] : ids, explicit: true };
  }

  const id = await guessedAccountId(hostname, accounts);
  return { ids: id ? [id] : [], explicit: false };
}

/** The one account the popup should pin for this site, or null. */
export async function getSuggestedAccountId(hostname: string, accounts: Account[]): Promise<string | null> {
  return (await getSiteSuggestions(hostname, accounts)).ids[0] ?? null;
}

async function guessedAccountId(hostname: string, all: Account[]): Promise<string | null> {
  const accounts = guessable(hostname, all);
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

/** The accounts a guess about this page may land on: not those tied to other sites. */
function guessable(hostname: string, accounts: Account[]): Account[] {
  return accounts.filter(acc => !boundElsewhere(acc, hostname));
}

/** How a fill candidate was arrived at, weakest last. */
export type SuggestionSource = 'site' | 'history' | 'text';

export interface FillCandidate {
  accountId: string;
  source: SuggestionSource;
}

/**
 * Which account to insert into the page without asking.
 *
 * An account the user tied to this site, when exactly one is; when several
 * are, the one of them used here before. Otherwise the first two rungs above
 * and no more. A code copied while a page was open is never on its own a
 * reason to type that code into the page, and neither is a name that fits
 * more than one account: the popup can show its best guess and let the user
 * look at it, but a fill has no such moment, and plenty of these forms submit
 * themselves on the last digit, spending one of the few attempts the service
 * allows.
 *
 * Returning null is not a failure. It means "ask", and the caller opens the
 * popup — where whatever the user picks is recorded as evidence about the
 * site, so the same question is not asked twice.
 */
export async function getFillCandidate(hostname: string, all: Account[]): Promise<FillCandidate | null> {
  if (!hostname || all.length === 0) return null;

  const bound = accountsForSite(hostname, all);
  if (bound.length === 1) return { accountId: bound[0].id, source: 'site' };
  if (bound.length > 1) {
    if (!(await areSuggestionsEnabled())) return null;
    const used = await usageOn(getBaseDomain(hostname), bound);
    return used.site ? { accountId: used.site, source: 'site' } : null;
  }

  const accounts = guessable(hostname, all);
  const domain = await matchableDomain(hostname, accounts);
  if (!domain) return null;

  const used = await usageOn(domain, accounts);
  if (used.site) return { accountId: used.site, source: 'history' };

  const matches = textMatches(domain, accounts);
  if (matches.length !== 1) return null;

  // The name fits, but where has this account actually been used? If it has
  // been put into pages on other domains and never this one — the GitHub
  // account on github.co, the Amazon one on amazon.de — the name alone is not
  // enough to type a code in unasked. Asking costs one pick, which is then
  // remembered; a typosquat on another top-level domain costs the code.
  const usedOn = (await siteHistory()).get(matches[0].id) ?? [];
  if (usedOn.length > 0 && !usedOn.includes(domain)) return null;
  return { accountId: matches[0].id, source: 'text' };
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
 *
 * The site's label has to be whole words of the issuer or name — one word
 * ("amazon" in "Amazon Web Services", "github" in "alice@github.com") or
 * several run together ("epicgames" for "Epic Games", "mybank" for "my-bank"
 * and "My Bank"). It used to be a bare substring in both directions, so the
 * "hub" of hub.xyz named GitHub, box.com named Dropbox, lab.io named GitLab
 * and dropbox.com named an account called Box — and with one such account in
 * the list, quick fill typed its live code into that unrelated page unasked.
 */
function textMatches(domain: string, accounts: Account[]): Account[] {
  const domainCore = compact(domain.split('.')[0]);
  if (domainCore.length < 3) return [];

  return accounts.filter(acc =>
    // String(), not a bare .toLowerCase(): a record from an older build or an
    // outside exporter can hold `issuer: null`, and this runs on every popup
    // open against the whole list — one such record threw here and took the
    // suggestion for every other account down with it.
    namesSite(String(acc.issuer ?? ''), domainCore) || namesSite(String(acc.name ?? ''), domainCore)
  );
}

/** Lowercase letters and digits only, in any script. */
function compact(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Whether a run of consecutive words in `text` spells `core` exactly, starting
 * at the first word or at a host inside it ("alice@github.com",
 * "accounts.google.com"). Not from a word in the middle of a phrase: "Web" of
 * "Amazon Web Services" is not web.dev, "Games" of "Epic Games" not games.com.
 */
function namesSite(text: string, core: string): boolean {
  const lower = text.toLowerCase();
  const words: string[] = [];
  const starts: number[] = [];
  for (const match of lower.matchAll(/[\p{L}\p{N}]+/gu)) {
    const before = lower[match.index - 1];
    if (words.length === 0 || before === '@' || before === '.') starts.push(words.length);
    words.push(match[0]);
  }
  for (const start of starts) {
    let run = '';
    for (let end = start; end < words.length && run.length < core.length; end++) {
      run += words[end];
      if (run === core) return true;
    }
  }
  return false;
}
