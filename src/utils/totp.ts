import * as OTPAuth from 'otpauth';
import type { Account, TOTPCode } from '@/types';
import { ageOf } from './clock';

const OFFSET_STORAGE_KEY = 'timeOffsetMs';

/**
 * A correction is a patch over a clock we measured once. It is stored WITH the
 * moment we measured it, because a stale patch is worse than none: a user who
 * sees our warning and fixes their clock would otherwise keep generating codes
 * shifted by the old drift, forever, with nothing able to notice or clear it.
 *
 * Older versions stored a bare number with no timestamp. Those are of unknown
 * age by construction, so they are discarded rather than trusted.
 */
interface StoredOffset {
  ms: number;
  at: number; // Date.now() at the moment of the measurement
}

// Beyond this, a correction has to be re-earned by a fresh measurement. Long
// enough to survive a weekend offline, short enough that a fixed clock heals.
const OFFSET_MAX_AGE_MS = 48 * 60 * 60 * 1000;

const DEFAULT_PERIOD = 30;
const DEFAULT_DIGITS = 6;

/** RFC 4648 base32, optionally padded. Anything else makes otpauth throw. */
const BASE32 = /^[A-Z2-7]+=*$/;

// Signed correction (ms) between the device clock and true UTC. Applied to code
// generation so codes stay valid even when the system clock drifts. It is only
// ever set from a HIGH-CONFIDENCE time-sync measurement (see time-sync.ts).
// When we're not sure, it stays 0 — meaning "trust the local clock", which is
// the safe default and matches the historical behavior.
let timeOffsetMs = 0;

export function setTimeOffsetMs(ms: number): void {
  timeOffsetMs = Number.isFinite(ms) ? ms : 0;
}

export function getTimeOffsetMs(): number {
  return timeOffsetMs;
}

// Load a persisted correction so codes are already adjusted on the very first
// render, before the async network re-check finishes.
export async function loadTimeOffset(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(OFFSET_STORAGE_KEY);
    const record: unknown = stored[OFFSET_STORAGE_KEY];

    if (
      typeof record === 'object' &&
      record !== null &&
      Number.isFinite((record as StoredOffset).ms) &&
      Number.isFinite((record as StoredOffset).at)
    ) {
      const { ms, at } = record as StoredOffset;
      // A stamp from the future means the clock moved since we measured, which
      // invalidates the measurement as surely as an expired one does.
      const age = ageOf(at) ?? Infinity;
      if (age <= OFFSET_MAX_AGE_MS) {
        timeOffsetMs = ms;
        return;
      }
    }

    // Stale, malformed, or a bare number from an older version: trust the local
    // clock again and drop the record so it cannot be resurrected.
    timeOffsetMs = 0;
    if (record !== undefined) {
      await chrome.storage.local.remove(OFFSET_STORAGE_KEY).catch(() => {});
    }
  } catch {
    // best-effort — fall back to the local clock
  }
}

/**
 * Persist a correction (or 0 to clear one). Owned here rather than by the
 * caller so the record shape and the storage key live in exactly one place.
 */
export async function persistTimeOffset(ms: number): Promise<void> {
  try {
    if (ms === 0) {
      await chrome.storage.local.remove(OFFSET_STORAGE_KEY);
      return;
    }
    await chrome.storage.local.set({
      [OFFSET_STORAGE_KEY]: { ms, at: Date.now() } satisfies StoredOffset,
    });
  } catch {
    // best-effort — the in-memory correction still applies for this session
  }
}

/** A secret that otpauth cannot build a generator from. */
export class InvalidSecretError extends Error {
  constructor() {
    super('Secret is not valid base32');
    this.name = 'InvalidSecretError';
  }
}

/**
 * Characters that sit *between* base32 groups and carry no information: ASCII
 * and Unicode spaces, every dash Unicode defines, and the underscore.
 *
 * Listed by code point on purpose. Written as a regex character class instead,
 * a raw dash beside another character silently becomes a range boundary and the
 * class starts eating letters — the kind of bug that would corrupt secrets
 * rather than fail loudly.
 *
 * Note what is deliberately NOT here: digits like 0, 1 and 8. They are invalid
 * base32, so stripping them would turn a genuinely corrupt secret into a
 * well-formed one that generates confident, wrong codes. They must survive to
 * be caught by validation.
 */
const SEPARATORS = new Set<number>([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, // ASCII whitespace
  0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006,
  0x2007, 0x2008, 0x2009, 0x200a, 0x200b, 0x202f, 0x205f, 0x3000, // Unicode spaces
  0x2d, 0x5f, // hyphen-minus, underscore
  0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212, 0xff0d, // dashes
]);

/**
 * Strip the separators people and third-party exporters put between groups.
 *
 * otpauth throws a TypeError on any character outside the base32 alphabet, and
 * a hyphen is the single most likely one to arrive: grouped seeds are how
 * secrets are printed on setup pages, how people write them down, and how
 * several exporters format them. Whitespace alone was stripped here before,
 * which left `ABCD-EFGH-...` to throw during render and take the popup with it.
 */
export function cleanSecret(secret: string): string {
  let out = '';
  for (const ch of String(secret ?? '')) {
    if (!SEPARATORS.has(ch.codePointAt(0) as number)) out += ch;
  }
  return out.toUpperCase();
}

/**
 * Whether otpauth can actually generate from this secret.
 *
 * Distinct from `validateSecret`: that one is the manual form's quality gate and
 * additionally insists on a sensible length. This one answers the narrower
 * question every render depends on — will constructing a TOTP throw.
 */
export function isUsableSecret(secret: unknown): boolean {
  if (typeof secret !== 'string') return false;
  const cleaned = cleanSecret(secret);
  // Two characters is the shortest base32 that carries a whole byte. One
  // character decodes to NOTHING, and otpauth will happily HMAC that empty key
  // and hand back a confident six-digit code no service will ever accept.
  //
  // It is a floor, not a validity check: HMAC zero-pads, so a two-character
  // secret still produces a plausible code from one byte of key. Anything that
  // short is already broken — the point here is only that a record which cannot
  // carry a key at all fails visibly instead of generating digits.
  return cleaned.length >= 2 && BASE32.test(cleaned);
}

export function validateSecret(secret: string): boolean {
  const cleaned = cleanSecret(secret);
  return BASE32.test(cleaned) && cleaned.length >= 16;
}

/**
 * The parameter guards below are deliberately applied at generation, not only
 * where a QR or a file is parsed.
 *
 * Records written by every version up to 1.11.0 are already on disk with these
 * values unchecked, so hardening the parsers alone would leave every account
 * imported before the fix generating wrong codes forever. Reading defensively
 * repairs them in place, without a migration.
 */
function safePeriod(value: unknown): number {
  const n = Number(value);
  // A zero, negative or NaN period makes otpauth emit the same code at every
  // timestamp: a frozen, permanently wrong code behind a healthy countdown,
  // because ProgressRing quietly substitutes a sane value for display.
  return Number.isFinite(n) && n >= 1 && n <= 3600 ? Math.floor(n) : DEFAULT_PERIOD;
}

function safeDigits(value: unknown): number {
  const n = Number(value);
  // 7 and 9 are rare but real, and otpauth handles them. Narrowing them to 6 —
  // as the QR parser used to — produces a valid-looking code for the wrong
  // account, which is worse than refusing outright.
  return Number.isInteger(n) && n >= 6 && n <= 10 ? n : DEFAULT_DIGITS;
}

function safeAlgorithm(value: unknown): 'SHA1' | 'SHA256' | 'SHA512' {
  // `SHA-256` is what several issuers put in the URI; otpauth accepts it and the
  // old whitelist did not, silently downgrading those accounts to SHA1.
  const name = String(value ?? '').toUpperCase().replace(/-/g, '');
  return name === 'SHA256' || name === 'SHA512' ? name : 'SHA1';
}

export function generateTOTP(account: Account): TOTPCode {
  const secret = cleanSecret(account.secret);
  // otpauth accepts an empty secret and emits a plausible six-digit code from
  // it, so the check has to happen here rather than being left to the library.
  if (!isUsableSecret(secret)) throw new InvalidSecretError();

  const period = safePeriod(account.period);

  const totp = new OTPAuth.TOTP({
    issuer: account.issuer,
    label: account.name,
    algorithm: safeAlgorithm(account.algorithm),
    digits: safeDigits(account.digits),
    period,
    secret,
  });

  const correctedMs = Date.now() + timeOffsetMs;
  const code = totp.generate({ timestamp: correctedMs });
  const nowSec = Math.floor(correctedMs / 1000);
  const remaining = period - (nowSec % period);

  return {
    code,
    remaining,
    period,
  };
}

/**
 * Generation that cannot take the popup down.
 *
 * `useTOTP` generates inside a `useState` initialiser, i.e. during render, so a
 * throw here does not spoil one row — React unwinds to the root boundary and
 * every account disappears, on this open and every open after it, with the bad
 * record still on disk. One unreadable secret must cost exactly one row.
 */
export function tryGenerateTOTP(account: Account): TOTPCode | null {
  try {
    return generateTOTP(account);
  } catch (error) {
    console.error('Could not generate a code for account', account.id, error);
    return null;
  }
}
