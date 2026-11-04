// Websites the user has tied to an account by hand.
//
// Everything else that connects an account to a site is a guess: the issuer
// reading like the domain, or the history of where its codes were used. With
// seventy accounts the guesses run out — three accounts on one company's
// domain, a service whose name is nothing like its address — and the only
// thing left was scrolling. A site set here is not a guess, so it outranks
// them all.
//
// Matching is by hostname, most specific first. A site covers itself and its
// subdomains, but a subdomain that has an account of its own gets only that
// one: with `main.com` on one account and `sub1.main.com` on another,
// sub1.main.com offers only the second, main.com and sub2.main.com only the
// first. That is what people with several apps under one parent domain asked
// for, and it still lets `google.com` cover accounts.google.com for everyone
// else, who would never think to type the subdomain.

import type { Account } from '@/types';
import { publicSuffixLength } from './public-suffix';

/** More than anyone needs, few enough that a pasted list cannot bloat a record. */
export const MAX_SITES = 20;
const MAX_HOST_LENGTH = 253;

/** www. is the same site to everyone who types it, and to every service we know of. */
function stripWww(host: string): string {
  return host.startsWith('www.') && host.length > 4 ? host.slice(4) : host;
}

/**
 * A website as typed — `example.com`, `https://sub.example.com/login`,
 * `WWW.Example.com.` — as the hostname it is stored under, or null when it is
 * not one.
 *
 * Refuses a bare public suffix (`co.uk`, `github.io`): tied to an account it
 * would claim every site under it, which is never what was meant.
 */
export function normalizeSite(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;

  let host: string;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    host = url.hostname;
  } catch {
    return null;
  }

  host = stripWww(host.toLowerCase().replace(/\.+$/, ''));
  if (!host || host.length > MAX_HOST_LENGTH) return null;
  if (host.startsWith('[')) return host; // IPv6, kept as the URL wrote it.
  if (/^\d+(\.\d+){3}$/.test(host)) return host;

  const labels = host.split('.');
  if (labels.some(label => !label)) return null;
  if (labels.length === 1) return host === 'localhost' ? host : null;
  if (labels.length <= publicSuffixLength(labels)) return null;
  return host;
}

/** What an account's `sites` holds, cleaned: valid, unique, in the order given. */
export function normalizeSiteList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    const site = normalizeSite(entry);
    if (site && !out.includes(site)) out.push(site);
    if (out.length >= MAX_SITES) break;
  }
  return out;
}

/** The sites of an account, safe on any record. */
export function sitesOf(account: Pick<Account, 'sites'>): string[] {
  return normalizeSiteList(account.sites);
}

/** The page's hostname as sites are compared against it. */
export function pageHost(hostname: string): string {
  return stripWww(hostname.toLowerCase().replace(/\.+$/, ''));
}

/**
 * How closely a site covers the page: the site's length when it is the page's
 * host or a parent of it, -1 when it does not cover it at all. Longer is more
 * specific, since a parent is always a suffix of its children.
 */
function coverage(site: string, host: string): number {
  if (host === site) return site.length;
  return host.endsWith(`.${site}`) ? site.length : -1;
}

/** The closest any of this account's sites comes to the page, -1 for none. */
function bestCoverage(account: Pick<Account, 'sites'>, host: string): number {
  let best = -1;
  for (const site of sitesOf(account)) best = Math.max(best, coverage(site, host));
  return best;
}

/**
 * The accounts tied to this page, most specific site first and only those:
 * when sub1.main.com has an account of its own, the one on main.com is not
 * among them. In list order within that.
 */
export function accountsForSite<T extends Pick<Account, 'sites'>>(hostname: string, accounts: readonly T[]): T[] {
  const host = pageHost(hostname);
  if (!host) return [];
  let best = -1;
  const scored = accounts.map(account => {
    const score = bestCoverage(account, host);
    if (score > best) best = score;
    return score;
  });
  if (best < 0) return [];
  return accounts.filter((_, index) => scored[index] === best);
}

/**
 * Whether an account has been tied to some other place and not to this one.
 *
 * Such an account is left out of every guess about this page. The user has
 * said where it belongs; offering it on a sibling subdomain because its issuer
 * reads like the parent domain is the one thing they asked us not to do.
 */
export function boundElsewhere(account: Pick<Account, 'sites'>, hostname: string): boolean {
  const sites = sitesOf(account);
  return sites.length > 0 && bestCoverage(account, pageHost(hostname)) < 0;
}

/** Whether this exact host is one of the account's sites (not merely covered by a parent). */
export function hasExactSite(account: Pick<Account, 'sites'>, hostname: string): boolean {
  return sitesOf(account).includes(pageHost(hostname));
}

/** The account's sites with this host added or taken away, for an update. */
export function toggleSite(account: Pick<Account, 'sites'>, hostname: string): string[] | undefined {
  const host = normalizeSite(hostname);
  const sites = sitesOf(account);
  if (!host) return sites.length ? sites : undefined;
  const next = sites.includes(host) ? sites.filter(site => site !== host) : [...sites, host].slice(0, MAX_SITES);
  return next.length ? next : undefined;
}
