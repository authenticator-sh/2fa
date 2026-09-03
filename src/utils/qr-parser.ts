import { parseMigrationURL, type MigrationAccount } from './migration-parser';
import { cleanSecret, isUsableSecret } from './totp';

export interface ParsedOTPAuth {
  name: string;
  issuer: string;
  secret: string;
  algorithm: 'SHA1' | 'SHA256' | 'SHA512';
  /** 6 and 8 dominate, but 7 exists in the wild and otpauth generates it. */
  digits: number;
  period: number;
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
 * The QR was read and understood — and describes something we will not store.
 *
 * Distinct from the `null` return, which means "could not be parsed at all".
 * Conflating the two told a user with a counter-based token that their QR was
 * corrupt, sending them to re-export a code that would never work either.
 */
export class UnsupportedOTPTypeError extends Error {
  constructor(message = 'Counter-based (HOTP) codes are not supported') {
    super(message);
    this.name = 'UnsupportedOTPTypeError';
  }
}

const ALGORITHMS = ['SHA1', 'SHA256', 'SHA512'] as const;

/**
 * `SHA-256` (hyphenated) appears in real issuer URIs and otpauth accepts it, so
 * matching the bare form only used to downgrade those accounts to SHA1 —
 * silently, and forever.
 */
function parseAlgorithm(raw: string | null): 'SHA1' | 'SHA256' | 'SHA512' {
  const name = (raw || 'SHA1').toUpperCase().replace(/-/g, '');
  return (ALGORITHMS as readonly string[]).includes(name)
    ? (name as 'SHA1' | 'SHA256' | 'SHA512')
    : 'SHA1';
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

  if (kind !== 'totp') {
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
    if (!isUsableSecret(secret)) {
      console.error('Secret in URL is not valid base32');
      return null;
    }

    // Parse the path: can be "Issuer:Account" or just "Account". Everything
    // after the FIRST colon is the account — splitting on every colon dropped
    // the tail of labels like "Acme:a:b@example.com", silently storing "a".
    const path = decodeURIComponent(urlObj.pathname.replace(/^\//, ''));
    const separator = path.indexOf(':');
    const issuer = params.get('issuer') || (separator >= 0 ? path.slice(0, separator) : 'Unknown');
    // Google writes "Issuer: Account" with a space after the colon.
    const name = (separator >= 0 ? path.slice(separator + 1) : path || 'Account').trim();

    const algorithm = parseAlgorithm(params.get('algorithm'));
    const digits = parseDigits(params.get('digits'));
    const period = parsePeriod(params.get('period'));

    // Nothing is logged here on purpose. This used to print the name and issuer
    // of every account it parsed, which was one line per user action back when
    // a parse meant one scanned image. Bulk import made it one line per
    // account: pasting a 200-account export wrote the user's entire 2FA
    // inventory — every service, every username — into the console, where a
    // screen share or an open inspector puts it on display. That is the exact
    // metadata the vault exists to keep off disk.

    return {
      name,
      issuer: issuer.trim(),
      secret,
      algorithm,
      digits,
      period,
    };
  } catch (error) {
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
  // Written out even at their defaults: an importer that assumes different ones
  // produces a confidently wrong code, which is the failure with no symptom.
  params.set('algorithm', account.algorithm);
  params.set('digits', String(account.digits));
  params.set('period', String(account.period));

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
    // entries and importing the rest beats refusing the whole export, as long
    // as the caller is told how many were left behind.
    const usable = migrationAccounts.filter(
      (account: MigrationAccount) => account.type !== 'hotp' && isUsableSecret(account.secret)
    );
    // Entries the protobuf parser could not read never reach `migrationAccounts`
    // at all, so counting only what it returned reported them as nothing at
    // all: a code holding twelve accounts, two of them damaged, said "10
    // imported" with no remainder. `unreadable` is what the parser dropped
    // before this filter ever saw it.
    const skipped = migrationAccounts.length - usable.length + payload.unreadable;

    if (usable.length === 0) {
      if (migrationAccounts.every((account: MigrationAccount) => account.type === 'hotp')) {
        throw new UnsupportedOTPTypeError();
      }
      return null;
    }

    const accounts: ParsedOTPAuth[] = usable.map((account: MigrationAccount) => ({
      name: account.name,
      issuer: account.issuer,
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
