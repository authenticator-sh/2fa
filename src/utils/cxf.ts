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
// Shape, as CXF 1.0 (Proposed Standard, errata of 2026-03-09,
// https://fidoalliance.org/specs/cx/cxf-v1.0-ps-errata-20260309.html) has it:
// - the root is a Header: `{version: {major, minor}, exporterRpId,
//   exporterDisplayName, timestamp, accounts}` (§3.1). Each Account holds
//   `items`; each Item a list of `credentials` discriminated by `type`.
// - a TOTP credential is `{type: 'totp', secret, period, digits, algorithm,
//   username?, issuer?}` (§3.3.16): the secret "MUST be a Base32 string" — the
//   same encoding we already store, so no re-encoding step can corrupt it — and
//   the algorithm is one of `sha1`, `sha256`, `sha512`, lowercase.
// - "importers MUST ignore TOTP entries with unknown algorithm values". So do
//   we, and count them, and treat a digit count or period we cannot generate
//   the same way: a guess would be a code that is wrong every time.
// - real files put a TOTP credential next to a `basic-auth` one inside a single
//   login item. Import therefore walks every credential of every item rather
//   than assuming one credential per item, or it would silently drop the 2FA
//   half of every password-manager export.
//
// Up to 1.13.x our export followed an earlier working draft instead: the root
// was the Account itself, `{version: 1, exporter, items, …}`. Those files are in
// people's backups and still read.

import type { Account } from '@/types';
import { cleanSecret, isSteamAccount, isUsableSecret } from './totp';
import { ImportRejectedError, normalizeAlgorithm, normalizeDigits, normalizePeriod } from './import-formats';
import { clampLabel, readAlgorithm, readDigits, readPeriod, withinSecretLimit } from './qr-parser';

/** The level of the standard this file is written to (§3.1.1). */
const CXF_VERSION = { major: 1, minor: 0 } as const;
const EXPORTER_RP_ID = 'authenticator.sh';
const EXPORTER_NAME = 'Authenticator';

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
  creationAt?: number;
  modifiedAt?: number;
  title: string;
  subtitle?: string;
  credentials: CxfTotpCredential[];
}

interface CxfAccount {
  id: string;
  username: string;
  email: string;
  collections: unknown[];
  items: CxfItem[];
}

interface CxfHeader {
  version: { major: number; minor: number };
  exporterRpId: string;
  exporterDisplayName: string;
  timestamp: number;
  accounts: CxfAccount[];
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

/**
 * The accounts a CXF file can carry. Steam Guard is not one of them: a TOTP
 * credential has no field that says "Steam", so the other side would read the
 * secret as a six-digit TOTP account — a code Steam never accepts, with nothing
 * to show it is wrong. Left out, and counted by the caller, instead.
 */
export function cxfExportable(accounts: Account[]): Account[] {
  return accounts.filter(account => !isSteamAccount(account));
}

export function buildCxfFile(allAccounts: Account[]): string {
  const accounts = cxfExportable(allAccounts);
  const now = Math.floor(Date.now() / 1000);

  const document: CxfHeader = {
    version: { ...CXF_VERSION },
    exporterRpId: EXPORTER_RP_ID,
    exporterDisplayName: EXPORTER_NAME,
    timestamp: now,
    accounts: [
      {
        id: newId(),
        // The spec wants the exporting user's account identity here, and
        // allows an empty username. We have never asked for one and are not
        // about to start for the sake of a header field, so both stay empty
        // rather than carrying something invented.
        username: '',
        email: '',
        collections: [],
        items: accounts.map((account) => ({
          id: newId(),
          creationAt: toSeconds(account.createdAt),
          modifiedAt: now,
          title: account.issuer || account.name || 'Unknown',
          subtitle: account.name || undefined,
          credentials: [
            {
              type: 'totp' as const,
              // Unpadded: the padding carries nothing, and a strict reader on
              // the other side may not expect it after a migration import put
              // it there.
              secret: cleanSecret(account.secret).replace(/=+$/, ''),
              // Repaired the way generation repairs them, not copied. A record
              // imported from a file without these fields has none, and
              // `undefined.toLowerCase()` turned "export" into "Export failed"
              // for every account in the list, not just that one. What goes out
              // must be what this app computes codes with, or the other side
              // gets different codes from the same secret.
              period: normalizePeriod(account.period),
              digits: normalizeDigits(account.digits),
              algorithm: normalizeAlgorithm(account.algorithm).toLowerCase() as CxfAlgorithm,
              username: account.name || undefined,
              issuer: account.issuer || undefined,
            },
          ],
        })),
      },
    ],
  };

  return JSON.stringify(document, null, 2);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** A CXF 1.x Header: `version` is `{major, minor}`, the data under `accounts`. */
function isStandardHeader(parsed: Record<string, unknown>): boolean {
  const version = record(parsed.version);
  return Array.isArray(parsed.accounts) && typeof version?.major === 'number';
}

/** What we and the early drafts wrote: the Account as the root, `version` a number. */
function isDraftDocument(parsed: Record<string, unknown>): boolean {
  // `items` alone is too weak a signal — our own plain backup could grow one.
  // A draft CXF document always carries a version and an exporter alongside it.
  return Array.isArray(parsed.items) && typeof parsed.version === 'number' && typeof parsed.exporter === 'string';
}

export function isCxfFile(text: string): boolean {
  try {
    const parsed = record(JSON.parse(text));
    // Our own plain backup has `accounts` too, but its `version` is a string
    // ("2.0"), never the `{major, minor}` pair, so the two cannot be confused.
    return !!parsed && (isStandardHeader(parsed) || isDraftDocument(parsed));
  } catch {
    return false;
  }
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Every Item in the document, from under each Account or, in a draft file, the root. */
function itemsOf(parsed: Record<string, unknown>): unknown[] {
  if (isStandardHeader(parsed)) {
    // A new major version is by definition a breaking change (§3.1.1): the same
    // field names may mean something else. Refused rather than half-read.
    if ((parsed.version as { major: number }).major !== CXF_VERSION.major) {
      throw new ImportRejectedError('unknown-format');
    }
    return (parsed.accounts as unknown[]).flatMap(account => {
      const items = record(account)?.items;
      return Array.isArray(items) ? items : [];
    });
  }
  return Array.isArray(parsed.items) ? parsed.items : [];
}

/**
 * Pull every TOTP credential out of a CXF document, and count the ones that
 * could not be used.
 *
 * Tolerant on purpose, in both directions:
 * - one malformed item never costs the file. A person importing this has
 *   already left their old provider; rejecting 200 accounts over one bad row is
 *   how a migration becomes a data-loss event.
 * - only `secret` is irreplaceable. A missing title, username or issuer is
 *   filled in, never a reason to drop the row.
 *
 * Counted, not just dropped: a file whose every TOTP secret was unusable used
 * to come back as an empty list, which the importer took for an empty file and
 * reported as "Import successful!" with nothing added. `unsupported` is the
 * credentials whose algorithm, digits or period we cannot generate with.
 */
export function readCxf(text: string): { accounts: Account[]; unreadable: number; unsupported: number } {
  const parsed = record(JSON.parse(text)) ?? {};
  const items = itemsOf(parsed);
  const accounts: Account[] = [];
  let unreadable = 0;
  let unsupported = 0;

  items.forEach((entry, itemIndex) => {
    const item = record(entry);
    if (!item) return;
    const credentials = Array.isArray(item.credentials) ? item.credentials : [];

    credentials.forEach((credential, credentialIndex) => {
      const raw = record(credential);
      if (!raw) return;
      // Passwords, passkeys, notes: other credentials of the same login, not
      // accounts we failed to read.
      if (asText(raw.type).toLowerCase() !== 'totp') return;

      const secret = cleanSecret(asText(raw.secret));
      // Not a judgement call: without a usable secret there is no account, and
      // storing one would render a permanently wrong code instead of failing.
      if (!isUsableSecret(secret) || !withinSecretLimit(secret)) {
        unreadable++;
        return;
      }

      const algorithm = readAlgorithm(raw.algorithm);
      const digits = readDigits(raw.digits);
      const period = readPeriod(raw.period);
      if (algorithm === null || digits === null || period === null) {
        unsupported++;
        return;
      }

      const title = asText(item.title);
      const name = asText(raw.username) || asText(item.subtitle);
      // The title is the service name in other vendors' files, so it stands in
      // for a missing issuer — but not when it merely repeats the account name.
      // Our own export writes the name there when there is no issuer, because
      // CXF wants a title on every item, and reading it back as the issuer
      // turned "bob" with no issuer into "bob: bob".
      const issuer = clampLabel(asText(raw.issuer) || (title !== name ? title : ''));

      accounts.push({
        id: `cxf-${Date.now()}-${itemIndex}-${credentialIndex}-${Math.random().toString(36).slice(2, 8)}`,
        name: clampLabel(name || issuer || 'Unknown'),
        issuer,
        secret,
        algorithm,
        digits,
        period,
        createdAt:
          typeof item.creationAt === 'number' && item.creationAt > 0
            ? item.creationAt * 1000
            : Date.now(),
      });
    });
  });

  return { accounts, unreadable, unsupported };
}

/** The usable accounts only. */
export function readCxfFile(text: string): Account[] {
  return readCxf(text).accounts;
}

export function cxfFileName(): string {
  return `authenticator-cxf-${new Date().toISOString().slice(0, 10)}.json`;
}
