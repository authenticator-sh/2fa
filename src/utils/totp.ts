import * as OTPAuth from 'otpauth';
import type { Account, TOTPCode } from '@/types';
import { ageOf, steadyAgeOf, steadyStamp, type SteadyStamp } from './clock';

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

/**
 * How long one measurement keeps a correction alive.
 *
 * This was 48 hours, "long enough to survive a weekend offline". What it
 * actually survived was the fix: a clock five minutes slow, measured once, then
 * corrected by the OS — and every code for the next two days came out five
 * minutes ahead. Nothing could clear it offline, and quick fill, which never
 * measures, filled those codes into sign-in forms.
 *
 * A stale correction is not a smaller error than none; it is the same size
 * error pointed the other way. So a correction lives exactly as long as the
 * measurement that justified it — the same five minutes after which an
 * "off" reading is re-checked anyway (CACHE_TTL_OFF_MS in time-sync.ts). The
 * cost falls on the one case that loses: a drifting clock AND no network.
 * Codes are for signing in to something over that network, so it is rarely
 * absent when one is needed.
 */
export const OFFSET_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * A page that stays open — the side panel, the floating window — asks for a
 * new measurement this long into a correction's life, so a healthy one is
 * renewed before it lapses instead of codes flickering to the uncorrected
 * value and back. The minute of slack is twenty times the fetch timeout.
 */
const OFFSET_REFRESH_AFTER_MS = 4 * 60 * 1000;

/**
 * Wall and monotonic clocks disagreeing by more than this since a measurement
 * means the wall clock was stepped, and whatever we measured against it is
 * gone. Matches the deadzone below which time-sync.ts does not correct at all:
 * a smaller jump would not have earned a correction either.
 */
const CLOCK_JUMP_TOLERANCE_MS = 3_000;

const DEFAULT_PERIOD = 30;
const DEFAULT_DIGITS = 6;

/** RFC 4648 base32, optionally padded. Anything else makes otpauth throw. */
const BASE32 = /^[A-Z2-7]+=*$/;

/**
 * How long a page shows "checking the clock" instead of a code, at most.
 *
 * The measurement it waits for gives up after three seconds (FETCH_TIMEOUT_MS
 * in time-sync.ts); the rest is storage on either side of it. Bounded here as
 * well, and not only by that measurement finishing, because a flag nothing
 * clears would hide every code on the page — the one failure worse than a code
 * that is a few seconds out.
 */
const PENDING_MAX_MS = 5_000;

// Signed correction (ms) between the device clock and true UTC. Applied to code
// generation so codes stay valid even when the system clock drifts. It is only
// ever set from a HIGH-CONFIDENCE time-sync measurement (see time-sync.ts).
// When we're not sure, it stays 0 — meaning "trust the local clock", which is
// the safe default and matches the historical behavior.
let timeOffsetMs = 0;
// When the measurement behind timeOffsetMs was taken, on both clocks.
let offsetMeasured: SteadyStamp | null = null;
// Whether this page took that measurement itself, and has had the monotonic
// clock running under it ever since. See keepWitnessedTimeOffset.
let offsetWitnessed = false;
// The measurement a renewal has already been asked for. Once per measurement:
// a renewal that fails leaves the same one in force, and asking again on every
// read — once a second per page — hammered the time sources for the whole
// last minute of its life. Retrying a failure is time-sync's job, on a backoff.
let renewalAskedFor: SteadyStamp | null = null;

// A correction that was in force has just lapsed, and the measurement that
// would replace it is under way. See isTimeOffsetPending.
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

let refreshOffset: (() => Promise<unknown>) | null = null;
let refreshing = false;

const offsetListeners = new Set<() => void>();
let notifyQueued = false;

/**
 * Tell whoever draws codes that the correction changed.
 *
 * Deferred to a microtask because the most common place a correction lapses is
 * inside getTimeOffsetMs, which runs during a render: a listener that set React
 * state synchronously from there would be updating one component while React
 * is rendering another. Coalesced, so a drop followed at once by a new value
 * redraws once.
 */
function notifyOffsetChanged(): void {
  if (notifyQueued || offsetListeners.size === 0) return;
  notifyQueued = true;
  queueMicrotask(() => {
    notifyQueued = false;
    for (const listener of [...offsetListeners]) listener();
  });
}

/**
 * Be told whenever the correction codes are generated with changes — set,
 * renewed to a different value, dropped — or starts or stops being checked.
 *
 * Codes used to pick a new correction up on their next one-second tick, so a
 * popup opened with a stored correction drew uncorrected codes first, and a
 * copy in that second put the wrong one on the clipboard.
 */
export function subscribeTimeOffset(listener: () => void): () => void {
  offsetListeners.add(listener);
  return () => void offsetListeners.delete(listener);
}

/**
 * Who to ask for a new measurement when a correction is about to lapse.
 * time-sync.ts registers itself; this module cannot import it, since it
 * imports us.
 */
export function setTimeOffsetRefresher(refresh: (() => Promise<unknown>) | null): void {
  refreshOffset = refresh;
}

function requestRefresh(): void {
  if (!refreshOffset || refreshing) return;
  refreshing = true;
  refreshOffset()
    .catch(() => {})
    .finally(() => {
      refreshing = false;
      settleTimeOffset();
    });
}

/**
 * A correction that was being applied is gone, and a measurement to replace it
 * is on its way. Only with somebody to take that measurement: without one
 * there is nothing to wait for.
 */
function markPending(): void {
  if (!refreshOffset) return;
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(settleTimeOffset, PENDING_MAX_MS);
  notifyOffsetChanged();
}

/**
 * The measurement a lapsed correction was waiting for has finished, whatever
 * it found. time-sync.ts calls this at the end of every measurement.
 */
export function settleTimeOffset(): void {
  if (!pendingTimer) return;
  clearTimeout(pendingTimer);
  pendingTimer = null;
  notifyOffsetChanged();
}

/**
 * Whether codes are about to change because the clock is being measured again
 * after a correction lapsed.
 *
 * In that window the uncorrected code is the one most likely to be wrong: the
 * clock needed correcting a few minutes ago, and nothing has said it stopped.
 * A popup opened more than five minutes after the last one used to draw exactly
 * those codes for the second or three the measurement took. Callers show that
 * the clock is being checked instead, and a copy waits for the answer.
 */
export function isTimeOffsetPending(): boolean {
  return pendingTimer !== null;
}

/**
 * Resolves once no measurement is pending — at once when none is. Never waits
 * longer than PENDING_MAX_MS.
 */
export function whenTimeOffsetSettled(): Promise<void> {
  if (!isTimeOffsetPending()) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = subscribeTimeOffset(() => {
      if (isTimeOffsetPending()) return;
      unsubscribe();
      resolve();
    });
  });
}

function clearOffset(): void {
  const had = timeOffsetMs !== 0;
  timeOffsetMs = 0;
  offsetMeasured = null;
  offsetWitnessed = false;
  if (had) notifyOffsetChanged();
}

/**
 * Apply a correction. `measuredAgoMs` is how old the measurement behind it
 * already is — a cached reading is not a new one, and restamping it as new
 * would let one measurement keep itself alive forever.
 *
 * `witnessed` says this page took the measurement just now, rather than reading
 * it back from storage or from another page's cache. Only then has the
 * monotonic clock been running under it since, so only then can a step of the
 * wall clock — the OS fixing it — be seen. A reading from disk defaults to
 * unwitnessed because its age is not zero.
 */
export function setTimeOffsetMs(ms: number, measuredAgoMs = 0, witnessed = measuredAgoMs === 0): void {
  const next = Number.isFinite(ms) ? ms : 0;
  if (next === 0) {
    clearOffset();
    return;
  }
  const changed = next !== timeOffsetMs;
  timeOffsetMs = next;
  offsetMeasured = steadyStamp(Math.max(0, measuredAgoMs));
  offsetWitnessed = witnessed;
  if (changed) notifyOffsetChanged();
}

/**
 * The correction to apply right now — 0 unless a measurement recent enough to
 * still be true says otherwise.
 *
 * Checked on every read rather than once at load, because the popup reads this
 * every second for as long as it is open, and the side panel is open for days:
 * an offset that was only ever checked on the way in stayed applied in a
 * long-lived page long after the clock under it had been fixed.
 */
export function getTimeOffsetMs(): number {
  if (timeOffsetMs === 0 || !offsetMeasured) return 0;

  const age = steadyAgeOf(offsetMeasured, CLOCK_JUMP_TOLERANCE_MS);
  if (age === null || age > OFFSET_MAX_AGE_MS) {
    // The clock was stepped since we measured it, or the measurement is too old
    // to vouch for it. Fall back to the local clock and measure again — and
    // say so, since until that measurement lands the local clock is the one
    // thing we know was wrong a few minutes ago.
    clearOffset();
    markPending();
    requestRefresh();
    return 0;
  }

  if (age >= OFFSET_REFRESH_AFTER_MS && renewalAskedFor !== offsetMeasured) {
    renewalAskedFor = offsetMeasured;
    requestRefresh();
  }
  return timeOffsetMs;
}

/**
 * A measurement was attempted and could not be taken. Keep the correction if
 * it is still good, drop it otherwise; returns whether it was kept.
 *
 * This used to drop it unconditionally, on the argument that 0 is the local
 * clock and so moves nothing anywhere new. In a page that stays open that was
 * wrong: one renewal attempted while the network was down threw away a
 * correction with a minute of life left, and — 0 being the one value that asks
 * for no renewal — nothing ever measured again. The side panel went on showing
 * uncorrected codes for as long as it stayed open.
 *
 * Kept only when witnessed, because only then is "still good" knowable. The
 * danger with an old correction is the OS fixing the clock under it, and in a
 * page that took the measurement itself the monotonic clock catches that step
 * on the next read. A correction read back from disk carries no such history:
 * the clock may have been fixed before this page, or this service worker, ever
 * started — the quick-fill case — and a failed check is no evidence that it
 * was not. That one still goes, as before.
 *
 * A failed check is also no evidence against a witnessed one. Fixing a clock
 * takes the same network the check just failed to reach, so the likeliest
 * state of a clock that needed correcting a minute ago, offline, is that it
 * still does.
 */
export function keepWitnessedTimeOffset(): boolean {
  if (timeOffsetMs === 0 || !offsetMeasured) return false;
  if (offsetWitnessed) {
    const age = steadyAgeOf(offsetMeasured, CLOCK_JUMP_TOLERANCE_MS);
    if (age !== null && age <= OFFSET_MAX_AGE_MS) return true;
  }
  clearOffset();
  return false;
}

// Load a persisted correction so codes are already adjusted on the very first
// render, before the async network re-check finishes.
export async function loadTimeOffset(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(OFFSET_STORAGE_KEY);
    const record: unknown = stored[OFFSET_STORAGE_KEY];

    const dated =
      typeof record === 'object' &&
      record !== null &&
      Number.isFinite((record as StoredOffset).ms) &&
      Number.isFinite((record as StoredOffset).at);

    if (dated) {
      const { ms, at } = record as StoredOffset;
      // A stamp from the future means the clock moved since we measured, which
      // invalidates the measurement as surely as an expired one does.
      const age = ageOf(at) ?? Infinity;
      if (age <= OFFSET_MAX_AGE_MS) {
        setTimeOffsetMs(ms, age, false);
        return;
      }
    }

    // Stale, malformed, or a bare number from an older version: trust the local
    // clock again and drop the record so it cannot be resurrected.
    setTimeOffsetMs(0);
    // A dated one that expired means this clock needed correcting the last
    // time anyone looked, and the caller is about to look again: say so for
    // the second that takes, rather than draw the codes most likely to be
    // wrong. An undated one is of unknown age — years, as likely as minutes —
    // and does not earn the wait.
    if (dated && (record as StoredOffset).ms !== 0) markPending();
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
export async function persistTimeOffset(ms: number, measuredAt: number = Date.now()): Promise<void> {
  try {
    if (ms === 0) {
      await chrome.storage.local.remove(OFFSET_STORAGE_KEY);
      return;
    }
    await chrome.storage.local.set({
      [OFFSET_STORAGE_KEY]: { ms, at: measuredAt } satisfies StoredOffset,
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
  //
  // Measured without the padding. `A=======` is eight characters long and
  // carries no key at all; counting the `=` let it through to exactly the
  // empty-key HMAC this floor exists to stop.
  return cleaned.replace(/=+$/, '').length >= 2 && BASE32.test(cleaned);
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

// ---- Steam Guard ------------------------------------------------------------
//
// Steam computes exactly what TOTP computes — HMAC-SHA1 of the 30-second step,
// dynamically truncated to 31 bits — and then spells that number in base 26
// with an alphabet that has no vowels and nothing that reads as another
// character, least significant digit first, five characters long.

const STEAM_ALPHABET = '23456789BCDFGHJKMNPQRTVWXY';
const STEAM_LENGTH = 5;
const STEAM_PERIOD = 30;

/**
 * How many decimal digits otpauth is asked for on a Steam account.
 *
 * otpauth ends with `truncated % 10 ** digits`. The truncated value is below
 * 2^31, which has ten decimal digits, so asking for ten makes that modulo a
 * no-op and the "code" it returns is the whole 31-bit number, zero-padded —
 * the input Steam's own alphabet step needs. Reusing the library this way
 * keeps one HMAC implementation in the product rather than two.
 */
const STEAM_RAW_DIGITS = 10;

export function isSteamAccount(account: Pick<Account, 'type'>): boolean {
  return account.type === 'steam';
}

function steamCode(raw: string): string {
  let value = Number(raw);
  let out = '';
  for (let i = 0; i < STEAM_LENGTH; i++) {
    out += STEAM_ALPHABET[value % STEAM_ALPHABET.length];
    value = Math.floor(value / STEAM_ALPHABET.length);
  }
  return out;
}

/**
 * The generator for an account, with every parameter already repaired.
 *
 * Shared by the live code and by sharing, which computes a run of future codes
 * from the same generator — the two must never disagree about the period or
 * the digit count, or the recipient of a link would hold codes for slots the
 * sender's own popup never shows.
 */
function buildTOTP(account: Account): OTPAuth.TOTP {
  const secret = cleanSecret(account.secret);
  // otpauth accepts an empty secret and emits a plausible six-digit code from
  // it, so the check has to happen here rather than being left to the library.
  if (!isUsableSecret(secret)) throw new InvalidSecretError();

  // Steam fixes all three parameters. Whatever the record says about them is
  // ignored rather than trusted: an importer that stored digits 6 for a Steam
  // entry must not be able to change the code.
  if (isSteamAccount(account)) {
    return new OTPAuth.TOTP({
      issuer: account.issuer,
      label: account.name,
      algorithm: 'SHA1',
      digits: STEAM_RAW_DIGITS,
      period: STEAM_PERIOD,
      secret,
    });
  }

  return new OTPAuth.TOTP({
    issuer: account.issuer,
    label: account.name,
    algorithm: safeAlgorithm(account.algorithm),
    digits: safeDigits(account.digits),
    period: safePeriod(account.period),
    secret,
  });
}

function codeFrom(totp: OTPAuth.TOTP, account: Account, timestampMs: number): string {
  const raw = totp.generate({ timestamp: timestampMs });
  return isSteamAccount(account) ? steamCode(raw) : raw;
}

/** The period and code length actually used to generate, after repair. */
export function totpParams(account: Account): { period: number; digits: number } {
  if (isSteamAccount(account)) return { period: STEAM_PERIOD, digits: STEAM_LENGTH };
  return { period: safePeriod(account.period), digits: safeDigits(account.digits) };
}

/**
 * The code for one moment, given as a Unix timestamp in milliseconds.
 *
 * No clock correction is applied here: the caller names the instant. The
 * moment-of-now path below applies the measured offset before it calls this.
 */
export function generateCodeAt(account: Account, timestampMs: number): string {
  return codeFrom(buildTOTP(account), account, timestampMs);
}

/** "Now" as code generation sees it: the device clock plus the correction. */
export function correctedNow(): number {
  return Date.now() + getTimeOffsetMs();
}

/** The code and countdown for one corrected instant. */
function generateTOTPAt(account: Account, correctedMs: number): TOTPCode {
  const totp = buildTOTP(account);
  const { period } = totpParams(account);

  const code = codeFrom(totp, account, correctedMs);
  const nowSec = Math.floor(correctedMs / 1000);
  const remaining = period - (nowSec % period);

  return {
    code,
    remaining,
    period,
  };
}

export function generateTOTP(account: Account): TOTPCode {
  return generateTOTPAt(account, correctedNow());
}

/** Accounts whose failure has already been logged; see tryGenerateTOTP. */
const reportedBroken = new Set<string>();

/**
 * Generation that cannot take the popup down.
 *
 * `useTOTP` generates inside a `useState` initialiser, i.e. during render, so a
 * throw here does not spoil one row — React unwinds to the root boundary and
 * every account disappears, on this open and every open after it, with the bad
 * record still on disk. One unreadable secret must cost exactly one row.
 */
export function tryGenerateTOTP(account: Account): TOTPCode | null {
  return tryGenerateTOTPAt(account, correctedNow());
}

function tryGenerateTOTPAt(account: Account, correctedMs: number): TOTPCode | null {
  try {
    return generateTOTPAt(account, correctedMs);
  } catch (error) {
    // Once per account, not once per tick: a broken row re-renders every
    // second in every open window, and the console was nothing but this.
    if (!reportedBroken.has(account.id)) {
      reportedBroken.add(account.id);
      console.error('Could not generate a code for account', account.id, error);
    }
    return null;
  }
}

/**
 * One account's code as a page shows it, with what it was computed for.
 *
 * `counter` is the slot the code belongs to — ⌊corrected seconds / period⌋ —
 * and a code is a function of the account and that slot alone. So a page that
 * ticks every second only has to run the HMAC when the slot changes; the other
 * twenty-nine ticks move the countdown and nothing else.
 */
export interface LiveTOTP {
  account: Account;
  counter: number;
  /** Null when the secret cannot produce a code — see tryGenerateTOTP. */
  totp: TOTPCode | null;
}

/**
 * The live code for `account` at `correctedMs`, reusing `previous` wherever it
 * is still true.
 *
 * Returns `previous` itself when nothing a reader could see has changed, so a
 * React state update with it is skipped outright. A change of correction needs
 * no special case: it moves the counter, or it moves nothing that matters.
 */
export function advanceTOTP(
  account: Account,
  previous: LiveTOTP | null,
  correctedMs: number = correctedNow()
): LiveTOTP {
  const { period } = totpParams(account);
  const nowSec = Math.floor(correctedMs / 1000);
  const counter = Math.floor(nowSec / period);

  if (previous && previous.account === account && previous.counter === counter) {
    if (!previous.totp) return previous;
    const remaining = period - (nowSec % period);
    if (previous.totp.remaining === remaining) return previous;
    return { ...previous, totp: { ...previous.totp, remaining } };
  }

  return { account, counter, totp: tryGenerateTOTPAt(account, correctedMs) };
}
