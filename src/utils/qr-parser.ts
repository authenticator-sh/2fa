import { parseMigrationURL, type MigrationAccount } from './migration-parser';
import { cleanSecret, isUsableSecret } from './totp';
import type { TranslationKey } from './i18n-keys';

export interface ParsedOTPAuth {
  name: string;
  issuer: string;
  secret: string;
  algorithm: 'SHA1' | 'SHA256' | 'SHA512';
  /** 6 and 8 dominate, but 7 exists in the wild and otpauth generates it. */
  digits: number;
  period: number;
  /** Present only for Steam Guard; see Account.type. */
  type?: 'steam';
}

export interface ParsedQRResult {
  type: 'single' | 'migration';
  accounts: ParsedOTPAuth[];
  /** Entries the parser refused, so the caller can say so rather than imply a clean import. */
  skipped?: number;
  /**
   * Which code of a multi-code Google Authenticator export this was.
   *
   * Present only when the export was split. `index` is 1-based for display.
   */
  batch?: { index: number; total: number };
}

/**
 * Why a code that was read and understood is refused.
 *
 * - `hotp`: counter-based. It has its own message because the fix is specific:
 *   there is none, the account needs a different authenticator.
 * - `other`: an OTP kind we do not generate (mOTP, Yandex) or parameters we
 *   cannot honour — MD5, four digits, a two-hour period.
 */
export type UnsupportedReason = 'hotp' | 'other';

/**
 * The QR was read and understood — and describes something we will not store.
 *
 * Distinct from the `null` return, which means "could not be parsed at all".
 * Conflating the two told a user with a counter-based token that their QR was
 * corrupt, sending them to re-export a code that would never work either.
 */
export class UnsupportedOTPTypeError extends Error {
  constructor(readonly reason: UnsupportedReason = 'hotp') {
    super(
      reason === 'hotp'
        ? 'Counter-based (HOTP) codes are not supported'
        : 'This code uses an OTP type or parameters that are not supported'
    );
    this.name = 'UnsupportedOTPTypeError';
  }
}

export type OTPAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

const ALGORITHMS = ['SHA1', 'SHA256', 'SHA512'] as const;

/**
 * `SHA-256` (hyphenated) appears in real issuer URIs and otpauth accepts it, so
 * matching the bare form only used to downgrade those accounts to SHA1 —
 * silently, and forever.
 *
 * This one REPAIRS: it is for writing out a record we already hold, where the
 * value has to match what generation computes with. Reading a value someone
 * else wrote goes through readAlgorithm below, which refuses instead.
 */
function parseAlgorithm(raw: string | null): OTPAlgorithm {
  const name = (raw || 'SHA1').toUpperCase().replace(/-/g, '');
  return (ALGORITHMS as readonly string[]).includes(name) ? (name as OTPAlgorithm) : 'SHA1';
}

/** Out-of-range values are dropped rather than coerced: see safePeriod in totp.ts. */
function parsePeriod(raw: string | null): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 && n <= 3600 ? Math.floor(n) : 30;
}

function parseDigits(raw: string | null): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 6 && n <= 10 ? n : 6;
}

// ---- reading parameters someone else wrote ----------------------------------
//
// Absent means the default; present and unsupported means REFUSED. These used to
// be one rule — anything unrecognised became the default — so `algorithm=MD5`
// was stored as SHA1, `digits=4` as 6 and `period=7200` as 30: a healthy-looking
// card whose every code is wrong, with nothing anywhere to say so. A default is
// a guess about a value nobody wrote down; replacing a value somebody DID write
// down is not a guess, it is a different account. Refused, the entry is counted
// as unsupported and the user is told.
//
// The accepted ranges are the ones generation honours (safePeriod, safeDigits,
// safeAlgorithm in totp.ts) — a value those would repair is a value we cannot
// generate with.

/** Missing, null or blank: nobody said, so the RFC default stands. */
function unstated(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

/** Raivo and the URI parameters spell numbers as strings; "6" is 6. */
function asNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value.trim());
  return NaN;
}

/** The algorithm a file or link states, SHA1 when it states none, null when it states one we cannot use. */
export function readAlgorithm(value: unknown): OTPAlgorithm | null {
  if (unstated(value)) return 'SHA1';
  if (typeof value !== 'string') return null;
  // `SHA-256`, `sha256` and KeePass's `HMAC-SHA-256` all name the same thing.
  const name = value.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^HMAC/, '');
  return (ALGORITHMS as readonly string[]).includes(name) ? (name as OTPAlgorithm) : null;
}

/** 6 when unstated; null for anything outside 6–10. Steam's 5 is Steam's own path. */
export function readDigits(value: unknown): number | null {
  if (unstated(value)) return 6;
  const n = asNumber(value);
  return Number.isInteger(n) && n >= 6 && n <= 10 ? n : null;
}

/**
 * 30 when unstated; null outside 1–3600 seconds. A fraction is refused too: the
 * old floor turned 30.5 into 30, which is a different time step, not the same
 * one rounded.
 */
export function readPeriod(value: unknown): number | null {
  if (unstated(value)) return 30;
  const n = asNumber(value);
  return Number.isInteger(n) && n >= 1 && n <= 3600 ? n : null;
}

// ---- size limits --------------------------------------------------------------
//
// Nothing capped either before, so a link or a file could hand over a secret of
// 100 000 characters and have it stored, synced and HMAC'd every second.

/**
 * Longest secret we accept, in Base32 characters once separators are removed.
 *
 * RFC 6238 suggests keys as long as the hash (64 bytes for SHA-512, 103
 * characters); some issuers use the 128-byte HMAC block size (205). 512
 * characters is 320 bytes — past anything a real issuer uses, with room to
 * spare, and still far short of a size that costs anything. A longer "secret"
 * is not a key someone was issued, so it is refused rather than cut: a
 * truncated key is a different key.
 */
export const MAX_SECRET_LENGTH = 512;

/**
 * Longest account name or issuer we keep, in characters.
 *
 * Cut rather than refused: this is display text, the account is still the
 * account, and losing a working 2FA seed over a long label would be the wrong
 * trade. 256 fits the longest legal e-mail address (254) with room over.
 */
export const MAX_LABEL_LENGTH = 256;

/** A secret within MAX_SECRET_LENGTH once cleaned. */
export function withinSecretLimit(secret: string): boolean {
  return cleanSecret(secret).replace(/=+$/, '').length <= MAX_SECRET_LENGTH;
}

/** Display text cut to MAX_LABEL_LENGTH, by code point so no emoji is split in half. */
export function clampLabel(value: string): string {
  if (value.length <= MAX_LABEL_LENGTH) return value;
  return Array.from(value).slice(0, MAX_LABEL_LENGTH).join('').trim();
}

/** Whether the link names Steam as its issuer, in the parameter or the label. */
function issuedBySteam(urlObj: URL): boolean {
  const label = decodeLabel(urlObj.pathname.replace(/^\//, ''));
  const separator = label.indexOf(':');
  const issuers = [urlObj.searchParams.get('issuer') || '', separator >= 0 ? label.slice(0, separator) : ''];
  return issuers.some(issuer => issuer.trim().toLowerCase() === 'steam');
}

export function parseOTPAuthURL(url: string): ParsedOTPAuth | null {
  // Never log the URL itself — it carries ?secret=.
  const trimmedUrl = url.trim();

  // Matched through URL rather than by string prefix. RFC 3986 makes the scheme
  // and authority case-insensitive, and exporters do write `OTPAUTH://TOTP/…`;
  // prefix matching rejected those as "invalid QR code", and rejected
  // `otpauth://totp?secret=…` — no slash before the query — along with them.
  let urlObj: URL;
  try {
    urlObj = new URL(trimmedUrl);
  } catch {
    console.error('Not a URL');
    return null;
  }

  if (urlObj.protocol !== 'otpauth:') {
    console.error('URL does not start with otpauth://');
    return null;
  }

  const kind = urlObj.hostname.toLowerCase();

  // HOTP is parsed far enough to recognise it, then refused. Storing it as TOTP
  // — which is what "treat hotp as totp" did here — produced an account that
  // looked healthy, ticked over every 30 seconds, and was never once valid,
  // because the counter it actually depends on has nowhere to live.
  if (kind === 'hotp') {
    throw new UnsupportedOTPTypeError();
  }

  // Steam Guard travels three ways: Aegis and most apps write its own
  // `otpauth://steam/` scheme, KeePassXC writes a TOTP link with
  // `encoder=steam`, and Steam itself hands out a plain TOTP link issued by
  // "Steam" — the `uri` field of every Steam Desktop Authenticator maFile, and
  // the thing people copy out of it. Read as plain TOTP, each is a six-digit
  // code Steam never accepts; Steam issues no other kind of code, so an issuer
  // of Steam is as good as saying so.
  const steam =
    kind === 'steam' ||
    (kind === 'totp' &&
      ((urlObj.searchParams.get('encoder') || '').toLowerCase() === 'steam' || issuedBySteam(urlObj)));

  if (kind !== 'totp' && !steam) {
    // Another OTP kind — mOTP, Yandex's `yaotp` — is understood and refused,
    // like HOTP. Returning null called it a damaged code, which sends the user
    // off to rescan something that will never be accepted. An empty or
    // malformed kind is still just unreadable.
    if (/^[a-z][a-z0-9-]*$/.test(kind)) throw new UnsupportedOTPTypeError('other');
    console.error('URL is not a totp URL');
    return null;
  }

  try {
    const params = urlObj.searchParams;

    const secret = params.get('secret');
    if (!secret) {
      console.error('No secret found in URL');
      return null;
    }

    // Checked here rather than left to the card: an unusable secret reaching
    // storage is what took the whole popup down on every subsequent open.
    if (!isUsableSecret(secret) || !withinSecretLimit(secret)) {
      console.error('Secret in URL is not valid base32');
      return null;
    }

    // Parse the path: can be "Issuer:Account" or just "Account". Everything
    // after the FIRST colon is the account — splitting on every colon dropped
    // the tail of labels like "Acme:a:b@example.com", silently storing "a".
    const path = decodeLabel(urlObj.pathname.replace(/^\//, ''));
    const separator = path.indexOf(':');
    // No issuer is left empty, not filled in as "Unknown". The .txt export
    // omits `issuer=` for an account that has none, so inventing one here made
    // every such account come back from its own backup renamed — and the edit
    // form had to special-case the invented word to hide it.
    const issuer = clampLabel((params.get('issuer') || (separator >= 0 ? path.slice(0, separator) : '')).trim());
    // Google writes "Issuer: Account" with a space after the colon.
    const name = clampLabel((separator >= 0 ? path.slice(separator + 1) : path || 'Account').trim());

    if (steam) {
      // The parameters are Steam's, whatever the link says: an exporter that
      // wrote digits=6 on a Steam entry must not change the code it produces.
      return {
        name,
        issuer: issuer || 'Steam',
        secret,
        algorithm: 'SHA1',
        digits: 5,
        period: 30,
        type: 'steam',
      };
    }

    // Stated and unusable is refused, not defaulted: see readAlgorithm.
    const algorithm = readAlgorithm(params.get('algorithm'));
    const digits = readDigits(params.get('digits'));
    const period = readPeriod(params.get('period'));
    if (algorithm === null || digits === null || period === null) {
      throw new UnsupportedOTPTypeError('other');
    }

    // Nothing is logged here on purpose. This used to print the name and issuer
    // of every account it parsed, which was one line per user action back when
    // a parse meant one scanned image. Bulk import made it one line per
    // account: pasting a 200-account export wrote the user's entire 2FA
    // inventory — every service, every username — into the console, where a
    // screen share or an open inspector puts it on display. That is the exact
    // metadata the vault exists to keep off disk.

    return {
      name,
      issuer,
      secret,
      algorithm,
      digits,
      period,
    };
  } catch (error) {
    // A refusal is an answer, not a parse failure; it has to reach the caller.
    if (error instanceof UnsupportedOTPTypeError) throw error;
    console.error('Error parsing OTP Auth URL:', error);
    return null;
  }
}

/**
 * The inverse of `parseOTPAuthURL`: an account as a shareable `otpauth://` URI.
 *
 * Kept in this file deliberately. The two functions are one format read from
 * both ends, and `parse(build(a)) == a` is the contract that makes plain-text
 * export worth offering at all — a backup nobody can read back is not a backup.
 * The round-trip is covered in totp.test.ts; break either side and it fails.
 *
 * Never log the return value: it carries the secret.
 */
export function buildOTPAuthURL(account: ParsedOTPAuth): string {
  // Coerced rather than assumed. Every parser in this codebase produces
  // strings, but a backup file is a text file a person can edit, and one record
  // whose issuer arrived as null threw out of the .txt export — so the user
  // asking for a backup got "Export failed" and no way to get ANY account out.
  // The one bad row must cost its own line, not the whole file.
  const issuer = String(account.issuer ?? '').trim();
  const name = String(account.name ?? '').trim();

  // "Issuer:Account" is the label every other authenticator expects to find in
  // the path, so it is emitted even though `issuer=` below is what this parser
  // reads first.
  //
  // Colons are stripped from the issuer HERE ONLY. The label is split at its
  // first colon, so an issuer carrying one would hand the remainder of itself
  // to the account name — "Acme: Inc" + "u@x" reads back as name "Inc:u@x".
  // The true issuer still travels intact in the query parameter, which both
  // this parser and the spec prefer, so nothing is actually lost. A colon in
  // the *name* is safe while an issuer is present: everything after the first
  // one is the name.
  //
  // The two halves are encoded separately so the separator stays a literal
  // colon. Encoding the joined label would emit %3A, which this parser decodes
  // correctly but stricter readers elsewhere split on before decoding.
  //
  // With no issuer there is no `issuer=` to fall back on, so a colon in the
  // name is read back as one: `{issuer:"", name:"a:b@x.com"}` returned as
  // `{issuer:"a", name:"b@x.com"}`. An empty issuer is reachable — the edit
  // form stores whatever is left when the field is cleared. Emitting the
  // separator anyway keeps the split where it belongs.
  const label = issuer
    ? `${encodeURIComponent(issuer.replace(/:/g, ''))}:${encodeURIComponent(name)}`
    : name.includes(':')
      ? `:${encodeURIComponent(name)}`
      : encodeURIComponent(name);

  const params = new URLSearchParams();
  params.set('secret', cleanSecret(account.secret));
  if (issuer) params.set('issuer', issuer);

  // Steam Guard as Aegis writes it, which is what the other apps that know
  // Steam read. Its own scheme rather than `totp` plus a flag: a reader that
  // does not know Steam then refuses the line instead of importing a TOTP
  // account that shows digits Steam never accepts — our own versions before
  // this one included.
  if (account.type === 'steam') {
    params.set('algorithm', 'SHA1');
    params.set('digits', '5');
    params.set('period', '30');
    return `otpauth://steam/${label}?${params.toString().replace(/\+/g, '%20')}`;
  }
  // Written out even at their defaults: an importer that assumes different ones
  // produces a confidently wrong code, which is the failure with no symptom.
  //
  // Repaired the way generation repairs them. A record imported from a file
  // that lacked these fields has none, and the export wrote
  // `algorithm=undefined&digits=undefined&period=undefined` — which other apps
  // refuse, and which reads back here as defaults only by luck.
  params.set('algorithm', parseAlgorithm(account.algorithm ?? null));
  params.set('digits', String(parseDigits(account.digits == null ? null : String(account.digits))));
  params.set('period', String(parsePeriod(account.period == null ? null : String(account.period))));

  // URLSearchParams spells a space `+`, which is form encoding rather than RFC
  // 3986. Readers that follow the RFC take it literally and import an issuer
  // called "Acme+Inc"; %20 is read as a space by both.
  return `otpauth://totp/${label}?${params.toString().replace(/\+/g, '%20')}`;
}

/**
 * Parses any QR code URL - either standard otpauth:// or migration otpauth-migration://
 * Returns a result object indicating the type and containing parsed account(s)
 */
export function parseQRCode(url: string): ParsedQRResult | null {
  const trimmedUrl = url.trim();
  // The scheme is case-insensitive per RFC 3986 and exporters do write it in
  // capitals. This is the function every caller actually uses — scanning,
  // uploading, pasting and importing all arrive here — so a case-sensitive
  // prefix test refused those QR codes as invalid no matter how tolerant
  // parseOTPAuthURL below became.
  const scheme = trimmedUrl.toLowerCase();

  // Check if it's a migration URL
  if (scheme.startsWith('otpauth-migration://')) {
    console.log('Detected migration URL');
    const payload = parseMigrationURL(trimmedUrl);

    if (!payload || payload.accounts.length === 0) {
      console.error('Failed to parse migration URL');
      return null;
    }

    const migrationAccounts = payload.accounts;
    const batch =
      payload.batchSize && payload.batchSize > 1
        ? { index: (payload.batchIndex ?? 0) + 1, total: payload.batchSize }
        : undefined;

    // A migration batch routinely mixes types. Dropping the counter-based
    // entries — and those whose algorithm or digit count we cannot generate
    // with — and importing the rest beats refusing the whole export, as long
    // as the caller is told how many were left behind.
    const usable = migrationAccounts.filter(
      (account: MigrationAccount) =>
        account.type === 'totp' && isUsableSecret(account.secret) && withinSecretLimit(account.secret)
    );
    // Entries the protobuf parser could not read never reach `migrationAccounts`
    // at all, so counting only what it returned reported them as nothing at
    // all: a code holding twelve accounts, two of them damaged, said "10
    // imported" with no remainder. `unreadable` is what the parser dropped
    // before this filter ever saw it.
    const skipped = migrationAccounts.length - usable.length + payload.unreadable;

    if (usable.length === 0) {
      // Every entry understood and refused: say why, rather than "invalid".
      if (payload.unreadable === 0 && migrationAccounts.every((account: MigrationAccount) => account.type !== 'totp')) {
        throw new UnsupportedOTPTypeError(
          migrationAccounts.every((account: MigrationAccount) => account.type === 'hotp') ? 'hotp' : 'other'
        );
      }
      return null;
    }

    const accounts: ParsedOTPAuth[] = usable.map((account: MigrationAccount) => ({
      name: clampLabel(account.name),
      issuer: clampLabel(account.issuer),
      secret: account.secret,
      algorithm: account.algorithm,
      digits: account.digits,
      period: 30, // Google Authenticator uses 30 seconds by default
    }));

    console.log(`Parsed ${accounts.length} account(s) from a migration QR, skipped ${skipped}`);

    return {
      type: 'migration',
      accounts,
      skipped,
      batch,
    };
  }

  // Try parsing as standard otpauth:// URL
  if (scheme.startsWith('otpauth://')) {
    const parsed = parseOTPAuthURL(trimmedUrl);

    if (!parsed) {
      console.error('Failed to parse otpauth URL');
      return null;
    }

    return {
      type: 'single',
      accounts: [parsed],
    };
  }

  console.error('Unknown QR code format');
  return null;
}

/**
 * Whether the text claims to be one of ours: an `otpauth://` link or a Google
 * Authenticator export.
 *
 * `parseQRCode` returns null both for a QR that is simply something else — a
 * URL, a Wi-Fi code — and for one of these whose payload cannot be read. The
 * two need different answers. The camera should keep looking past the first,
 * and stop on the second, because rescanning the same code yields the same
 * damaged payload; "invalid QR code" for the second sends the user hunting for
 * a different code when the one they have is the right one, exported badly.
 */
export function isAuthenticatorQR(text: string): boolean {
  return /^otpauth(-migration)?:\/\//i.test(text.trim());
}

/**
 * The message for a QR that did not produce an account: `error` is what
 * `parseQRCode` threw, if it threw. One place, so the scanner, the popup and
 * both upload paths cannot drift apart on which failure is which.
 */
export function qrFailureKey(text: string, error?: unknown): TranslationKey {
  if (error instanceof UnsupportedOTPTypeError) {
    return error.reason === 'hotp' ? 'addAccount.errorHotp' : 'addAccount.errorUnsupportedCode';
  }
  return isAuthenticatorQR(text) ? 'addAccount.errorDamagedQR' : 'addAccount.errorInvalidQR';
}

export const ACCOUNT_COLORS = [
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#f59e0b', // amber
  '#10b981', // emerald
  '#06b6d4', // cyan
  '#f97316', // orange
  '#6366f1', // indigo
] as const;

export function generateRandomColor(): string {
  return ACCOUNT_COLORS[Math.floor(Math.random() * ACCOUNT_COLORS.length)];
}

/**
 * A colour for a record that has none, derived from its own text.
 *
 * Not every account arrives with one: CXF import builds accounts without the
 * field, and any backup written before colours existed restores without it.
 * Falling back to a single grey turned exactly the migration case — a whole
 * vault imported at once — into a column of identical grey circles, which is
 * the case the avatar is for. Deriving it costs nothing, needs no migration,
 * and is stable across reloads, which a random pick at render time would not be.
 */
export function colorForKey(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return ACCOUNT_COLORS[Math.abs(hash) % ACCOUNT_COLORS.length];
}

/**
 * A label is display text, not something to reject a code over. A bare `%` —
 * "50%off:bob" — makes decodeURIComponent throw, and that took the whole QR
 * down as invalid, secret and all.
 */
function decodeLabel(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
