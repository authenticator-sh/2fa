import { parseMigrationURL, type MigrationAccount } from './migration-parser';
import { isUsableSecret } from './totp';

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

  if (!trimmedUrl.startsWith('otpauth://')) {
    console.error('URL does not start with otpauth://');
    return null;
  }

  // HOTP is parsed far enough to recognise it, then refused. Storing it as TOTP
  // — which is what "treat hotp as totp" did here — produced an account that
  // looked healthy, ticked over every 30 seconds, and was never once valid,
  // because the counter it actually depends on has nowhere to live.
  if (trimmedUrl.startsWith('otpauth://hotp/')) {
    throw new UnsupportedOTPTypeError();
  }

  if (!trimmedUrl.startsWith('otpauth://totp/')) {
    console.error('URL is not a totp URL');
    return null;
  }

  try {
    const urlObj = new URL(trimmedUrl);
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

    // Parse the path: can be "Issuer:Account" or just "Account"
    const pathParts = decodeURIComponent(urlObj.pathname.substring(1)).split(':');
    const issuer = params.get('issuer') || (pathParts.length > 1 ? pathParts[0] : 'Unknown');
    // Google writes "Issuer: Account" with a space after the colon.
    const name = (pathParts.length > 1 ? pathParts[1] : pathParts[0] || 'Account').trim();

    const algorithm = parseAlgorithm(params.get('algorithm'));
    const digits = parseDigits(params.get('digits'));
    const period = parsePeriod(params.get('period'));

    console.log('Successfully parsed:', { name, issuer, algorithm, digits, period });

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
 * Parses any QR code URL - either standard otpauth:// or migration otpauth-migration://
 * Returns a result object indicating the type and containing parsed account(s)
 */
export function parseQRCode(url: string): ParsedQRResult | null {
  const trimmedUrl = url.trim();

  // Check if it's a migration URL
  if (trimmedUrl.startsWith('otpauth-migration://')) {
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
    const skipped = migrationAccounts.length - usable.length;

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
  if (trimmedUrl.startsWith('otpauth://')) {
    console.log('Detected standard otpauth URL');
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

export function generateRandomColor(): string {
  const colors = [
    '#3b82f6', // blue
    '#8b5cf6', // violet
    '#ec4899', // pink
    '#f59e0b', // amber
    '#10b981', // emerald
    '#06b6d4', // cyan
    '#f97316', // orange
    '#6366f1', // indigo
  ];
  return colors[Math.floor(Math.random() * colors.length)];
}
