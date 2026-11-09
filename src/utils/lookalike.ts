// Is this page dressed up as the site an account belongs to?
//
// Real-time phishing (Evilginx, Tycoon 2FA and the like) puts a copy of the
// real sign-in page on an address of its own and relays the password and the
// 2FA code to the real site while the code still works. A TOTP code cannot
// tell where it is being typed; we can, because we know the page's address and
// where each account has been used.
//
// The one rule this file lives by: a warning that cries wolf is worse than
// none — people learn to click through it, and then it protects nobody. So
// "this page is not one we have seen the account on" is never a reason on its
// own: codes are copied with any tab open (a VPN client, an SSH prompt), and
// services sign in on more domains than anyone can list. Only an address that
// *imitates* a name the account already carries counts:
//
// - homoglyph: the same name in look-alike letters — gіthub with a Cyrillic і,
//   g1thub, paypa1, rnicrosoft, pay-pal;
// - typo: one letter off a name of six or more — githuh, gihtub, paypall;
// - lure: the name plus a phishing word — github-login, secure-paypal,
//   githubverify, github-com;
// - embedded: the real address worn as a subdomain — github.com.verify.xyz.
//
// The names come from what is known about the account: the sites the user
// tied to it, the sites its code was inserted on, and the issuer. And the
// same name on another domain (amazon.de for an Amazon account) is left
// alone: brands own their country domains, and quick fill asks there instead
// of warning (see getFillCandidate).

import type { Account } from '@/types';
import { KNOWN_REAL_DOMAINS } from './known-domains';
import { publicSuffixLength } from './public-suffix';

export type LookalikeKind = 'homoglyph' | 'typo' | 'lure' | 'embedded';

export interface Lookalike {
  kind: LookalikeKind;
  /** What the page imitates, as shown to the user: a domain, or the issuer. */
  like: string;
  /** Whether `like` is a site the account was used on, or only its issuer's name. */
  basis: 'site' | 'issuer';
}

interface Reference {
  /** The name compared against: a registrable label (github) or an issuer word. */
  core: string;
  /** The registrable domain, for a reference that is a site. */
  domain?: string;
  display: string;
  basis: 'site' | 'issuer';
}

/** Below this a one-letter difference is just another word: apple/apply, slack/stack. */
const TYPO_MIN = 6;
/** Below this a name is too short to be recognised inside another one. */
const NAME_MIN = 4;

/**
 * Words a phishing address adds to a brand. Not "online", "app", "cloud" or
 * "community": microsoftonline.com, githubapp.com and steamcommunity.com are
 * the brands' own.
 */
const LURES = new Set([
  'login', 'log', 'logon', 'signin', 'sign', 'signon', 'auth', 'authenticate', 'authentication',
  'verify', 'verification', 'verified', 'validate', 'validation', 'confirm', 'confirmation',
  'secure', 'security', 'safe', 'protect', 'protection', 'account', 'accounts', 'acc', 'id',
  'support', 'help', 'helpdesk', 'service', 'services', 'team', 'official', 'update', 'updates',
  'recovery', 'recover', 'restore', 'unlock', 'unblock', 'reset', 'access', 'session', 'portal',
  'wallet', 'mfa', '2fa', 'otp', 'sso', 'billing', 'payment', 'payments', 'claim', 'reward',
  'rewards', 'gift', 'bonus', 'airdrop', 'appeal', 'appeals', 'review', 'notice', 'alert', 'alerts',
  'www', 'com', 'net', 'org', 'io', 'co', 'web',
]);

/** Issuer words that name no brand: a page called login-portal.com imitates nobody. */
const GENERIC = new Set([
  'login', 'account', 'accounts', 'admin', 'secure', 'security', 'mail', 'email', 'cloud', 'server',
  'vpn', 'portal', 'auth', 'test', 'demo', 'home', 'work', 'office', 'user', 'users', 'team', 'bank',
  'wallet', 'exchange', 'shop', 'store', 'personal', 'business', 'company', 'corp', 'main', 'backup',
  'master', 'root', 'default', 'service', 'services', 'online', 'my', 'web', 'site', 'app', 'apps',
]);

/** Letters that pass for Latin ones, and the Latin letter they pass for. */
const CONFUSABLE: Record<string, string> = {
  // Cyrillic
  'а': 'a', 'е': 'e', 'ё': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ї': 'i',
  'ј': 'j', 'ѕ': 's', 'һ': 'h', 'ԁ': 'd', 'ԛ': 'q', 'ԝ': 'w', 'ӏ': 'l', 'к': 'k', 'ь': 'b', 'ɡ': 'g',
  // Greek
  'α': 'a', 'β': 'b', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ο': 'o', 'ρ': 'p', 'τ': 't', 'υ': 'u',
  'χ': 'x', 'ω': 'w',
  // Latin look-alikes NFKD leaves alone
  'ı': 'i', 'ł': 'l', 'ø': 'o', 'đ': 'd', 'ħ': 'h', 'ŀ': 'l', 'ɩ': 'l',
  // Digits
  '0': 'o', '1': 'l', '3': 'e', '5': 's',
};

/** Letters and digits only, lowercase. */
function norm(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * What a name looks like rather than what it spells: accents dropped, look-alike
 * letters mapped to the Latin they imitate, and the pairs that read as one
 * letter (rn → m, vv → w, cl → d) and i/l/1 folded together.
 */
export function skeleton(text: string): string {
  let out = '';
  for (const char of text.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '')) {
    out += CONFUSABLE[char] ?? char;
  }
  return out
    // Letters with no Latin twin stay as they are, so a Cyrillic name never
    // collapses into some unrelated Latin one.
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .replace(/rn/g, 'm')
    .replace(/vv/g, 'w')
    .replace(/cl/g, 'd')
    .replace(/[il]/g, 'l');
}

/** Damerau–Levenshtein distance, stopping early once it passes `max`. */
function editDistance(a: string, b: string, max = 1): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) rows.push([i, ...new Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let best = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, rows[i - 2][j - 2] + 1);
      }
      rows[i][j] = value;
      best = Math.min(best, value);
    }
    if (best > max) return max + 1;
  }
  return rows[a.length][b.length];
}

// --- Punycode (RFC 3492), decode only -----------------------------------------
// The URL parser hands us hostnames in their xn-- form; the letters a homoglyph
// attack relies on are only visible decoded.

function decodePunycodeLabel(label: string): string {
  if (!label.startsWith('xn--')) return label;
  const input = label.slice(4);
  const base = 36, tMin = 1, tMax = 26, skew = 38, damp = 700;
  const output: number[] = [];
  const delimiter = input.lastIndexOf('-');
  for (let j = 0; j < Math.max(delimiter, 0); j++) output.push(input.charCodeAt(j));
  let n = 128, bias = 72, i = 0;
  const adapt = (delta: number, points: number, first: boolean) => {
    delta = first ? Math.floor(delta / damp) : delta >> 1;
    delta += Math.floor(delta / points);
    let k = 0;
    while (delta > ((base - tMin) * tMax) >> 1) {
      delta = Math.floor(delta / (base - tMin));
      k += base;
    }
    return k + Math.floor(((base - tMin + 1) * delta) / (delta + skew));
  };
  const digit = (code: number) =>
    code - 48 < 10 ? code - 22 : code - 65 < 26 ? code - 65 : code - 97 < 26 ? code - 97 : base;
  for (let index = delimiter > 0 ? delimiter + 1 : 0; index < input.length;) {
    const oldi = i;
    for (let w = 1, k = base; ; k += base) {
      if (index >= input.length) return label;
      const d = digit(input.charCodeAt(index++));
      if (d >= base) return label;
      i += d * w;
      const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
      if (d < t) break;
      w *= base - t;
    }
    bias = adapt(i - oldi, output.length + 1, oldi === 0);
    n += Math.floor(i / (output.length + 1));
    i %= output.length + 1;
    output.splice(i++, 0, n);
  }
  try {
    return String.fromCodePoint(...output);
  } catch {
    return label;
  }
}

/** The hostname with every xn-- label decoded. */
export function decodeHost(hostname: string): string {
  return hostname.toLowerCase().split('.').map(decodePunycodeLabel).join('.');
}

// --- Domains --------------------------------------------------------------------

interface SplitHost {
  /** Labels left of the registrable domain: login.github.com → [login]. */
  sub: string[];
  /** The registrable label: github for login.github.com, example for x.example.co.uk. */
  core: string;
  /** The registrable domain. */
  domain: string;
}

function splitHost(hostname: string): SplitHost | null {
  const host = hostname.toLowerCase().replace(/\.+$/, '');
  if (!host || host.includes(':') || /^\d+(\.\d+){3}$/.test(host)) return null;
  const labels = host.split('.').filter(Boolean);
  const suffix = publicSuffixLength(labels);
  if (labels.length <= suffix) return null;
  const at = labels.length - suffix - 1;
  return { sub: labels.slice(0, at), core: labels[at], domain: labels.slice(at).join('.') };
}

/** A site reference: the registrable domain of a host the account belongs on. */
function siteReference(host: string): Reference | null {
  const split = splitHost(decodeHost(host));
  if (!split || norm(split.core).length < NAME_MIN) return null;
  return { core: split.core, domain: split.domain, display: split.domain, basis: 'site' };
}

/**
 * What the issuer names: the issuer as a domain when it is one
 * ("accounts.example.com"), else its first word and the whole of it run together
 * ("Epic Games" → epic, epicgames). Words that name no brand are left out.
 */
function issuerReferences(issuer: string): Reference[] {
  const text = issuer.trim();
  if (!text) return [];
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(text)) {
    const site = siteReference(text);
    return site ? [{ ...site, basis: 'issuer', display: text }] : [];
  }
  const words = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const out: Reference[] = [];
  for (const core of new Set([words[0] ?? '', words.join('')])) {
    if (core.length >= NAME_MIN && !GENERIC.has(core)) out.push({ core, display: text, basis: 'issuer' });
  }
  return out;
}

/** Everything an account is known by, for lookalikeOf. */
export function referencesFor(account: Pick<Account, 'issuer' | 'sites'>, usedOn: readonly string[]): Reference[] {
  const refs: Reference[] = [];
  const seen = new Set<string>();
  const add = (ref: Reference | null) => {
    const key = ref ? `${ref.core}|${ref.domain ?? ''}` : '';
    if (ref && !seen.has(key)) {
      seen.add(key);
      refs.push(ref);
    }
  };
  for (const site of Array.isArray(account.sites) ? account.sites : []) {
    if (typeof site === 'string') add(siteReference(site));
  }
  for (const host of usedOn) add(siteReference(host));
  for (const ref of issuerReferences(String(account.issuer ?? ''))) add(ref);
  return refs;
}

/** Whether the label is the name and nothing but lures: github-login, secure-paypal, githubverify. */
function nameWithLures(label: string, core: string): boolean {
  const parts = label.split('-').filter(Boolean);
  if (parts.length > 1) {
    let named = false;
    for (const part of parts) {
      if (!named && (part === core || skeleton(part) === skeleton(core))) named = true;
      else if (!LURES.has(part) && !/^\d+$/.test(part)) return false;
    }
    return named;
  }
  const whole = norm(label);
  if (whole === core) return false;
  if (whole.startsWith(core)) return LURES.has(whole.slice(core.length));
  if (whole.endsWith(core)) return LURES.has(whole.slice(0, whole.length - core.length));
  return false;
}

/**
 * The page imitates one of these names, or null.
 *
 * `trusted` are names the page may legitimately be: every other account's, so
 * that a user with both Stripe and Strike is not warned on strike.me for the
 * Stripe code, and the page itself once the user has said it is genuine.
 */
export function lookalikeOf(
  hostname: string,
  refs: readonly Reference[],
  trusted: readonly Reference[] = []
): Lookalike | null {
  const page = splitHost(decodeHost(hostname));
  if (!page) return null;
  const pageNorm = norm(page.core);
  const pageSkeleton = skeleton(page.core);

  const hit = (ref: Reference, kind: LookalikeKind): Lookalike => ({ kind, like: ref.display, basis: ref.basis });

  // A site the account belongs on, a well-known real service, or a name the
  // page simply is.
  if (refs.some(ref => ref.domain === page.domain)) return null;
  if (KNOWN_REAL_DOMAINS.has(page.domain)) return null;
  if (trusted.some(ref => ref.domain === page.domain || norm(ref.core) === pageNorm)) return null;
  // The same name, spelled the same: the brand on another top-level domain
  // (amazon.de), which quick fill asks about rather than warns. Spelled with a
  // hyphen more or less, it is only the same name when all we have is the
  // issuer — "My Bank" may well live at my-bank.com. Against a site the account
  // was actually used on, pay-pal.com is not paypal.com.
  const sameName = refs.filter(ref => norm(ref.core) === pageNorm);
  if (sameName.length > 0) {
    const respelt = sameName.find(ref => ref.basis === 'site' && ref.core !== page.core);
    return respelt && !sameName.some(ref => ref.core === page.core) ? hit(respelt, 'homoglyph') : null;
  }

  for (const ref of refs) {
    const refNorm = norm(ref.core);
    const refSkeleton = skeleton(ref.core);
    if (refSkeleton.length < NAME_MIN) continue;

    if (pageSkeleton === refSkeleton) return hit(ref, 'homoglyph');
    if (refSkeleton.length >= TYPO_MIN && pageSkeleton.length >= TYPO_MIN && editDistance(pageSkeleton, refSkeleton) <= 1) {
      return hit(ref, 'typo');
    }
    if (nameWithLures(page.core, refNorm)) return hit(ref, 'lure');

    // github.com.verify.xyz, github-com.verify.xyz: the name followed by a
    // top-level domain, worn on the left of somebody else's.
    for (let i = 0; i < page.sub.length; i++) {
      const label = page.sub[i];
      const next = page.sub[i + 1] ?? page.core;
      const named = skeleton(label) === refSkeleton || label.split('-').some(part => skeleton(part) === refSkeleton);
      if (named && (/^(com|net|org|io|co)$/.test(next) || /-(com|net|org|io|co)$/.test(label))) return hit(ref, 'embedded');
    }
  }
  return null;
}
