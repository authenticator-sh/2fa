// Credential Exchange Format — the FIDO Alliance interchange format that
// Apple, Google, 1Password, Bitwarden and Dashlane are converging on.
//
// Why we speak it at all: CXF covers TOTP secrets, not just passkeys, so it is
// the first format in this product's lifetime that lets someone move their 2FA
// accounts between vendors without a vendor-specific parser on either side.
// "You are not held hostage here" is the whole positioning, and an export the
// rest of the industry can read is the strongest possible version of it.
//
// What we deliberately do NOT implement: CXP, the *protocol* half. That one
// negotiates a direct provider-to-provider transfer through the platform and
// needs OS integration we cannot have from an extension. The format is a JSON
// file, which is exactly what our export and import already move around.
//
// Shape notes, since the spec is still a working draft:
// - the document root is an Account holding `items`; each Item carries a list
//   of `credentials` discriminated by `type`.
// - a TOTP credential is `{type: 'totp', secret, period, digits, algorithm,
//   username, issuer}` with the secret in RFC 4648 Base32 — the same encoding
//   we already store, so no re-encoding step can corrupt it.
// - real files put a TOTP credential next to a `basic-auth` one inside a single
//   login item. Import therefore walks every credential of every item rather
//   than assuming one credential per item, or it would silently drop the 2FA
//   half of every password-manager export.

import type { Account } from '@/types';
import { cleanSecret, isUsableSecret } from './totp';

const CXF_VERSION = 1;
const EXPORTER = 'authenticator.sh';

type CxfAlgorithm = 'sha1' | 'sha256' | 'sha512';

interface CxfTotpCredential {
  type: 'totp';
  secret: string;
  period: number;
  digits: number;
  algorithm: CxfAlgorithm;
  username?: string;
  issuer?: string;
}

interface CxfItem {
  id: string;
  creationAt: number;
  modifiedAt: number;
  type: 'login';
  title: string;
  subtitle?: string;
  credentials: CxfTotpCredential[];
}

interface CxfDocument {
  version: number;
  exporter: string;
  timestamp: number;
  id: string;
  userName: string;
  email: string;
  collections: unknown[];
  items: CxfItem[];
}

/** Base64url without padding, which is how CXF spells every identifier. */
function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function newId(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

/** Unix seconds. CXF timestamps are seconds, ours are milliseconds. */
function toSeconds(milliseconds: number): number {
  const seconds = Math.floor(milliseconds / 1000);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : Math.floor(Date.now() / 1000);
}

export function buildCxfFile(accounts: Account[]): string {
  const now = Math.floor(Date.now() / 1000);

  const document: CxfDocument = {
    version: CXF_VERSION,
    exporter: EXPORTER,
    timestamp: now,
    id: newId(),
    // The spec wants the exporting user's account identity here. We have never
    // asked for one and are not about to start for the sake of a header field,
    // so both stay empty rather than carrying something invented.
    userName: '',
    email: '',
    collections: [],
    items: accounts.map((account) => ({
      id: newId(),
      creationAt: toSeconds(account.createdAt),
      modifiedAt: now,
      type: 'login' as const,
      title: account.issuer || account.name || 'Unknown',
      subtitle: account.name || undefined,
      credentials: [
        {
          type: 'totp' as const,
          secret: cleanSecret(account.secret),
          period: account.period,
          digits: account.digits,
          algorithm: account.algorithm.toLowerCase() as CxfAlgorithm,
          username: account.name || undefined,
          issuer: account.issuer || undefined,
        },
      ],
    })),
  };

  return JSON.stringify(document, null, 2);
}

export function isCxfFile(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) return false;
    // `items` alone is too weak a signal — our own plain backup could grow one.
    // A CXF document always carries a version and an exporter alongside it.
    return typeof parsed.version === 'number' && typeof parsed.exporter === 'string';
  } catch {
    return false;
  }
}

function normalizeAlgorithm(value: unknown): Account['algorithm'] {
  const text = typeof value === 'string' ? value.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
  if (text === 'SHA256') return 'SHA256';
  if (text === 'SHA512') return 'SHA512';
  // Anything else, including the absent field, is SHA-1: it is the default in
  // RFC 6238 and what every issuer that does not say otherwise means. Guessing
  // differently produces codes that are confidently wrong rather than absent.
  return 'SHA1';
}

function normalizeDigits(value: unknown): number {
  const digits = Number(value);
  // 7 is issued in the wild; the range check mirrors types/index.ts, which
  // deliberately does not narrow this to 6 | 8.
  return Number.isInteger(digits) && digits >= 6 && digits <= 10 ? digits : 6;
}

function normalizePeriod(value: unknown): number {
  const period = Number(value);
  return Number.isInteger(period) && period > 0 && period <= 300 ? period : 30;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Pull every TOTP credential out of a CXF document.
 *
 * Tolerant on purpose, in both directions:
 * - one malformed item never costs the file. A person importing this has
 *   already left their old provider; rejecting 200 accounts over one bad row is
 *   how a migration becomes a data-loss event.
 * - only `secret` is irreplaceable. A missing title, username or issuer is
 *   filled in, never a reason to drop the row.
 */
export function readCxfFile(text: string): Account[] {
  const parsed = JSON.parse(text) as Partial<CxfDocument>;
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  const accounts: Account[] = [];

  items.forEach((item, itemIndex) => {
    if (!item || typeof item !== 'object') return;
    const credentials = Array.isArray(item.credentials) ? item.credentials : [];

    credentials.forEach((credential, credentialIndex) => {
      if (!credential || typeof credential !== 'object') return;
      if (asText((credential as CxfTotpCredential).type).toLowerCase() !== 'totp') return;

      const raw = credential as Partial<CxfTotpCredential>;
      const secret = cleanSecret(asText(raw.secret));
      // Not a judgement call: without a usable secret there is no account, and
      // storing one would render a permanently wrong code instead of failing.
      if (!isUsableSecret(secret)) return;

      const issuer = asText(raw.issuer) || asText(item.title);
      const name = asText(raw.username) || asText(item.subtitle) || issuer || 'Unknown';

      accounts.push({
        id: `cxf-${Date.now()}-${itemIndex}-${credentialIndex}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        issuer,
        secret,
        algorithm: normalizeAlgorithm(raw.algorithm),
        digits: normalizeDigits(raw.digits),
        period: normalizePeriod(raw.period),
        createdAt:
          typeof item.creationAt === 'number' && item.creationAt > 0
            ? item.creationAt * 1000
            : Date.now(),
      });
    });
  });

  return accounts;
}

export function cxfFileName(): string {
  return `authenticator-cxf-${new Date().toISOString().slice(0, 10)}.json`;
}
