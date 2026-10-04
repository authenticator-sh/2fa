import { ageOf } from './clock';
import {
  getTimeOffsetMs,
  isTimeOffsetPending,
  keepWitnessedTimeOffset,
  persistTimeOffset,
  setTimeOffsetMs,
  setTimeOffsetRefresher,
  settleTimeOffset,
} from './totp';

export interface TimeSyncResult {
  // synced is true when the clock is fine OR when we simply couldn't measure
  // confidently — we never raise an alarm on an uncertain reading.
  synced: boolean;
  // confident is true only when two independent sources agree, which is the
  // gate for both showing a notice AND correcting code generation.
  confident: boolean;
  offsetMs: number;      // signed device→UTC correction; 0 when not confident
  offsetSeconds: number; // signed, for display
}

const CACHE_KEY = 'timeSyncCache';
const DISMISS_KEY = 'timeNoticeDismissedOffset'; // offsetSeconds at last dismissal

// Asymmetric TTLs: a confidently-synced clock stays valid for hours; an
// out-of-sync reading is rechecked soon so a fixed clock clears quickly.
const CACHE_TTL_OK_MS = 6 * 60 * 60 * 1000;
const CACHE_TTL_OFF_MS = 5 * 60 * 1000;

const FETCH_TIMEOUT_MS = 3000;
// The midpoint estimator's error is bounded by RTT/2, so the fetch timeout
// already caps it at 1.5s — an order of magnitude below the smallest thing we
// act on. A stricter cap here buys no accuracy and costs whole samples on
// mobile and high-latency links, where dropping one sample used to disable the
// entire check.
const MAX_RTT_MS = FETCH_TIMEOUT_MS;
// Two sources must agree within this to be trusted. Kept at or below
// CORRECT_DEADZONE_MS: sources that disagree by more than the smallest
// correction we would apply are not agreeing in any useful sense.
const AGREE_TOLERANCE_MS = 3_000;
// Only surface a notice past this — well beyond TOTP's real ±30–90s tolerance,
// so a correctly-measured small drift never nags the user.
const WARN_THRESHOLD_MS = 90_000;
// Don't bother correcting sub-deadzone drift; cap corrections to a sane bound so
// an absurd reading can never be applied to code generation.
const CORRECT_DEADZONE_MS = 3_000;
const CORRECT_CAP_MS = 12 * 60 * 60 * 1000;

interface TimeSyncCacheEntry {
  result: TimeSyncResult;
  cachedAt: number;
}

/** The correction a confident measurement calls for: 0 inside the deadzone or past the cap. */
function correctionFor(result: TimeSyncResult): number {
  const abs = Math.abs(result.offsetMs);
  return abs >= CORRECT_DEADZONE_MS && abs <= CORRECT_CAP_MS ? result.offsetMs : 0;
}

async function readCache(): Promise<{ result: TimeSyncResult; age: number } | null> {
  try {
    const stored = await chrome.storage.local.get(CACHE_KEY);
    const entry: TimeSyncCacheEntry | undefined = stored[CACHE_KEY];
    if (!entry) return null;
    // Only a confident, healthy reading that corrects nothing earns the long
    // TTL. An unmeasurable one used to inherit it through `synced: true`, so a
    // single failed check (offline, blocked, captive portal) suppressed every
    // retry for six hours. And a reading that DOES correct — a clock 3-90s out
    // is "synced" but still corrected — is the only thing keeping that
    // correction alive, so it cannot outlive it: served from a six-hour cache,
    // it re-applied a drift the OS had long since fixed.
    const longLived = entry.result.confident && entry.result.synced && correctionFor(entry.result) === 0;
    const ttl = longLived ? CACHE_TTL_OK_MS : CACHE_TTL_OFF_MS;
    // A stamp from the future means the clock moved backwards since we wrote
    // the entry — the exact failure this check exists to catch. Untrusted reads
    // as expired; the old bare subtraction read it as infinitely fresh and
    // turned the check off for good.
    const age = ageOf(entry.cachedAt) ?? Infinity;
    if (age < ttl) return { result: entry.result, age };
  } catch {
    // ignore — cache is best-effort
  }
  return null;
}

async function writeCache(result: TimeSyncResult): Promise<void> {
  try {
    await chrome.storage.local.set({
      [CACHE_KEY]: { result, cachedAt: Date.now() } satisfies TimeSyncCacheEntry,
    });
  } catch {
    // ignore — cache is best-effort
  }
}

// Sources that stamp whole seconds truncate downwards, so their answer is half
// a second early on average. Nudge it back — but only when there is no
// sub-second part, so a source with real millisecond precision is left alone.
function compensateWholeSecond(ms: number): number {
  return ms % 1000 === 0 ? ms + 500 : ms;
}

// Akamai's anycast time service: served from the edge nearest the user, which
// makes it both the fastest and the most widely reachable of the three.
async function fetchAkamaiTime(signal: AbortSignal): Promise<number> {
  const response = await fetch('https://time.akamai.com/?iso', {
    cache: 'no-store',
    signal,
  });
  if (!response.ok) throw new Error(`time.akamai.com ${response.status}`);
  // e.g. "2026-08-18T10:38:08Z" — explicit Z, so Date parses it as UTC.
  const ms = Date.parse((await response.text()).trim());
  if (!Number.isFinite(ms)) throw new Error('time.akamai.com bad datetime');
  return compensateWholeSecond(ms);
}

// Cloudflare's trace endpoint, which every Cloudflare-fronted host exposes.
// The body is plain `key=value` lines; `ts` is a UNIX timestamp in seconds.
async function fetchCloudflareTrace(signal: AbortSignal): Promise<number> {
  const response = await fetch('https://cloudflare.com/cdn-cgi/trace', {
    cache: 'no-store',
    signal,
  });
  if (!response.ok) throw new Error(`cloudflare.com ${response.status}`);
  const match = /^ts=([0-9.]+)$/m.exec(await response.text());
  if (!match) throw new Error('cloudflare.com no ts');
  const ms = Math.round(Number(match[1]) * 1000);
  if (!Number.isFinite(ms) || ms <= 0) throw new Error('cloudflare.com bad ts');
  return compensateWholeSecond(ms);
}

async function fetchTimeApiIo(signal: AbortSignal): Promise<number> {
  const response = await fetch('https://timeapi.io/api/time/current/zone?timeZone=UTC', {
    cache: 'no-store',
    signal,
  });
  if (!response.ok) throw new Error(`timeapi.io ${response.status}`);
  const data = await response.json();
  // timeapi.io's `dateTime` lacks a timezone designator; build UTC from fields.
  const ms = Date.UTC(
    data.year,
    data.month - 1,
    data.day,
    data.hour,
    data.minute,
    data.seconds,
    data.milliSeconds ?? 0
  );
  if (!Number.isFinite(ms)) throw new Error('timeapi.io bad fields');
  return ms;
}

interface Sample {
  offset: number; // serverMs - local midpoint
  rtt: number;
}

/**
 * The pool. Three independent operators, so no single one going dark can take
 * the feature with it — which is exactly what happened when this was a pair and
 * worldtimeapi.org stopped answering: one dead host meant the pair could never
 * agree, and the check silently stopped warning AND stopped correcting.
 *
 * Every entry must answer cross-origin from a chrome-extension:// origin
 * without host permissions. `npm run check:deps` verifies that they still do.
 */
export interface TimeSource {
  name: string;
  url: string;
  fetchServerMs: (signal: AbortSignal) => Promise<number>;
}

export const SOURCES: ReadonlyArray<TimeSource> = [
  { name: 'akamai', url: 'https://time.akamai.com/?iso', fetchServerMs: fetchAkamaiTime },
  { name: 'timeapi.io', url: 'https://timeapi.io/api/time/current/zone?timeZone=UTC', fetchServerMs: fetchTimeApiIo },
  { name: 'cloudflare', url: 'https://cloudflare.com/cdn-cgi/trace', fetchServerMs: fetchCloudflareTrace },
];

/**
 * The best estimate among samples that corroborate each other: the largest
 * group agreeing within tolerance, represented by its lowest-latency member,
 * with how many samples it speaks for. Fewer than two agreeing samples is not
 * an estimate, and returns null.
 */
function agreeingEstimate(samples: Sample[]): { member: Sample; size: number } | null {
  let best: { member: Sample; size: number } | null = null;

  for (const candidate of samples) {
    const group = samples.filter((s) => Math.abs(s.offset - candidate.offset) <= AGREE_TOLERANCE_MS);
    if (group.length < 2) continue;

    const member = group.reduce((a, b) => (a.rtt <= b.rtt ? a : b));
    const better =
      best === null || group.length > best.size || (group.length === best.size && member.rtt < best.member.rtt);
    if (better) best = { member, size: group.length };
  }

  return best;
}

// One measurement with NTP-style latency compensation: the server timestamp is
// compared against the MIDPOINT of the request, not the moment the response
// happened to arrive — so network latency is not mistaken for clock drift.
async function sample(
  fetchServerMs: (signal: AbortSignal) => Promise<number>,
  signal: AbortSignal
): Promise<Sample | null> {
  try {
    const t0 = Date.now();
    const serverMs = await fetchServerMs(signal);
    const t1 = Date.now();
    const rtt = t1 - t0;
    if (rtt > MAX_RTT_MS) return null; // too laggy to trust
    return { offset: serverMs - (t0 + t1) / 2, rtt };
  } catch {
    return null;
  }
}

/**
 * Make code generation follow a measurement `ageMs` old: its correction when it
 * is confident and within sane bounds, none otherwise.
 *
 * A reading we could not take is not evidence of anything, and it changes only
 * what it has to. A correction this page measured itself and is still watching
 * stays until its own five minutes are up — dropping it on one failed renewal
 * is how a side panel lost its correction for good (keepWitnessedTimeOffset
 * has the whole argument). Any other correction is cleared, as it always was:
 * read back from disk or from another page, nothing here can tell whether the
 * clock was fixed under it, and Settings must never say "unknown" over codes
 * that are being corrected by something nobody can vouch for. Only a confident
 * reading ever sets a non-zero value, which is the guard that matters.
 *
 * The measurement's own age travels with it, so a reading served from the
 * cache does not come back as a fresh one and extend itself. `witnessed` is
 * whether this page just took it.
 */
async function applyCorrection(result: TimeSyncResult, ageMs = 0, witnessed = false): Promise<void> {
  if (!result.confident) {
    // Kept: the record on disk already says when it was measured, and lapses
    // on its own. Cleared: off the disk too, so no other page revives it.
    if (keepWitnessedTimeOffset()) return;
    setTimeOffsetMs(0);
    await persistTimeOffset(0);
    return;
  }
  const next = correctionFor(result);
  setTimeOffsetMs(next, ageMs, witnessed);
  await persistTimeOffset(next, Date.now() - ageMs);
}

/**
 * The reading to show for `result`.
 *
 * A reading we could not take, over a correction that was kept (see
 * applyCorrection), is shown as the measurement that correction came from.
 * Shown as "unknown", Settings said "codes use your device clock as-is" over
 * codes that were being adjusted, and the banner vanished while the drift it
 * described was still being corrected.
 */
function shownResult(result: TimeSyncResult): TimeSyncResult {
  if (result.confident) return result;
  const kept = getTimeOffsetMs();
  if (kept === 0) return result;
  return {
    synced: Math.abs(kept) < WARN_THRESHOLD_MS,
    confident: true,
    offsetMs: kept,
    offsetSeconds: Math.round(kept / 1000),
  };
}

/**
  * Three states, because there are three: the clock is fine, the clock is off,
  * or we could not find out. The last one used to be folded into the first —
  * `synced: true` with `confident: false` — which is precisely why a feature
  * that had stopped working for everyone looked healthy from the outside.
  */
export type ClockState = 'ok' | 'off' | 'unknown';

export interface ClockStatus {
  state: ClockState;
  /** Signed drift in seconds; 0 unless the clock was actually measured. */
  offsetSeconds: number;
  /** Whether code generation is currently being adjusted for that drift. */
  corrected: boolean;
}

/** The status to show for a reading already in hand — what watchClock hands a page. */
export function clockStatusOf(measured: TimeSyncResult): ClockStatus {
  const result = shownResult(measured);
  // `corrected` is read off what code generation is doing, not derived from
  // the measurement. Derived, it said "not corrected" for an unknown clock
  // while a correction from an earlier reading was still being applied — the
  // one screen meant to explain wrong codes, contradicting them.
  const corrected = getTimeOffsetMs() !== 0;
  if (!result.confident) return { state: 'unknown', offsetSeconds: 0, corrected };

  return {
    state: result.synced ? 'ok' : 'off',
    offsetSeconds: result.offsetSeconds,
    corrected,
  };
}

/** The clock as last measured, for display. Cheap: shares the cache. */
export async function getClockStatus(): Promise<ClockStatus> {
  return clockStatusOf(await checkTimeSync());
}

/** Measure now, ignoring the cache. */
async function remeasure(): Promise<TimeSyncResult> {
  await chrome.storage.local.remove(CACHE_KEY).catch(() => {});
  // Drop any measurement already in flight: it read the cache before we cleared
  // it, so handing the user its answer would make "check now" a button that
  // returns the very reading they pressed it to replace.
  inFlight = null;
  return checkTimeSync();
}

/** Measure again now, ignoring the cache — what the "check now" button does. */
export async function recheckClock(): Promise<ClockStatus> {
  return clockStatusOf(await remeasure());
}

// Renewal for pages that stay open: totp.ts asks shortly before a correction
// lapses, and again the moment it notices the clock was stepped under it. The
// cache is bypassed on purpose — it holds the very measurement being renewed.
setTimeOffsetRefresher(remeasure);

// One measurement per popup open, however many callers ask. The banner and the
// settings line both want the answer, and without this they race each other
// into two independent rounds of network requests on every open.
let inFlight: Promise<TimeSyncResult> | null = null;

export async function checkTimeSync(): Promise<TimeSyncResult> {
  if (inFlight) return inFlight;
  const current = measure()
    .then((result) => {
      afterMeasurement(result);
      return result;
    })
    .finally(() => {
      // Superseded by "check now" or a renewal, it is not the answer anyone is
      // waiting for; the measurement that replaced it settles instead.
      if (inFlight !== current) return;
      inFlight = null;
      // Whatever it found, a page waiting on it to draw codes can stop.
      settleTimeOffset();
    });
  inFlight = current;
  return current;
}

async function measure(): Promise<TimeSyncResult> {
  const cached = await readCache();
  if (cached) {
    // Keep code generation in step with the latest measurement, at that
    // measurement's age. loadTimeOffset may have just discarded the stored
    // correction — written by a version that stored no timestamp — while this
    // cached measurement is recent enough to still be true. Without this,
    // upgrading from 1.11.0 with a clock 3-90s out silently dropped the
    // correction and then reported "your clock is fine" for six hours, which
    // is the exact combination that makes codes fail with nothing on screen to
    // explain it. The other way round, a cached reading we could not take
    // clears a correction nothing here vouches for any more.
    //
    // Read first, because reading is what notices a correction lapsing or the
    // clock being stepped under it — and then this cache holds the very
    // measurement being replaced, and a new one is already on its way. And
    // left alone when it is already the correction in force: restamped from
    // the cache, it would lose the monotonic history this page has for it,
    // which is what lets a step of the clock be seen at all.
    const current = getTimeOffsetMs();
    if (!isTimeOffsetPending()) {
      const next = cached.result.confident ? correctionFor(cached.result) : 0;
      if (current === 0 || current !== next) await applyCorrection(cached.result, cached.age);
    }
    return cached.result;
  }

  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const settled = await Promise.allSettled(SOURCES.map((source) => sample(source.fetchServerMs, signal)));
  const samples = settled
    .filter((s): s is PromiseFulfilledResult<Sample> => s.status === 'fulfilled' && s.value !== null)
    .map((s) => s.value);

  const agreed = agreeingEstimate(samples);
  // Every source that answered, agreeing — or a dissent that changes nothing.
  //
  // With three sources a majority is two, and two was all it took: two
  // answering the same wrong time (a proxy rewriting both, a shared upstream
  // gone bad) moved every code by up to the twelve-hour cap while the third
  // said the device was right. A dissent is now read with the device clock as
  // the tie-breaker. If the majority says the device is fine, the device agrees
  // with it and the odd one out is outvoted. If the majority wants to move the
  // codes and somebody who answered says otherwise, nothing is settled: the
  // reading is uncertain, corrects nothing new and is retried. A clock that is
  // really hours out — the time zone written as UTC — is still corrected
  // whenever the sources that answer agree, with one of them down or all three
  // up; only a source answering with a different time holds it back.
  const trusted =
    agreed !== null &&
    (agreed.size === samples.length || Math.abs(agreed.member.offset) < CORRECT_DEADZONE_MS);

  let result: TimeSyncResult;
  if (agreed && trusted) {
    const offsetMs = agreed.member.offset;
    result = {
      synced: Math.abs(offsetMs) < WARN_THRESHOLD_MS,
      confident: true,
      offsetMs,
      offsetSeconds: Math.round(offsetMs / 1000),
    };
  } else {
    // Fewer than two agreeing samples, or a dissent over a correction →
    // uncertain. Never alarm, and correct nothing new.
    result = { synced: true, confident: false, offsetMs: 0, offsetSeconds: 0 };
  }

  await writeCache(result);
  await applyCorrection(result, 0, true);

  if (result.confident && result.synced) {
    // The clock is provably fine, so an old dismissal has done its job. Left
    // behind, it goes on suppressing any future warning of a similar size — a
    // genuinely new problem, silenced by a decision made about a different one.
    await chrome.storage.local.remove(DISMISS_KEY).catch(() => {});
  }

  return result;
}

async function readDismissedOffset(): Promise<number | null> {
  try {
    const stored = await chrome.storage.local.get(DISMISS_KEY);
    const v = stored[DISMISS_KEY];
    return typeof v === 'number' ? v : null;
  } catch {
    return null;
  }
}

// Record that the user dismissed the notice for roughly the current offset, so
// it doesn't reappear until the situation changes materially.
export async function dismissTimeNotice(offsetSeconds: number): Promise<void> {
  try {
    await chrome.storage.local.set({ [DISMISS_KEY]: Math.abs(offsetSeconds) });
  } catch {
    // best-effort
  }
}

// Returns the (positive) offset in seconds when a notice should be shown, or
// null. A notice appears only when we are confident the clock is materially off
// and the user hasn't already dismissed a similar reading.
export async function getTimeSyncNotice(): Promise<number | null> {
  return noticeFor(await checkTimeSync());
}

/** The notice for a reading already in hand — see getTimeSyncNotice. */
export async function noticeFor(measured: TimeSyncResult): Promise<number | null> {
  const result = shownResult(measured);
  if (!result.confident || result.synced) return null;

  const offsetSeconds = Math.abs(result.offsetSeconds);
  const dismissed = await readDismissedOffset();
  if (dismissed !== null && Math.abs(dismissed - offsetSeconds) < 60) return null;

  return offsetSeconds;
}

// ---- Pages that stay open ----------------------------------------------------
//
// The popup measures once and is gone in a minute. The side panel and the
// floating window stay open for days, through Wi-Fi dropping, laptops sleeping
// and the OS fixing the clock, and one measurement taken when they opened
// described none of that. Worse, a failed one described it permanently: with
// the correction gone, the only thing that ever asked for a new measurement —
// a correction about to lapse — was gone with it.
//
// So a page that stays open watches: a reading we could not take is retried
// on a backoff, straight away when the network comes back or the page is shown
// again, and every reading, from anywhere, is handed to the page to display.

/**
 * How long to wait before trying again after a reading we could not take:
 * a minute, then longer, never more than five — the life of a correction, so
 * a clock that needs one is never without it for longer than that once the
 * network is back.
 */
const RETRY_DELAYS_MS = [60_000, 2 * 60_000, 4 * 60_000, 5 * 60_000];

const watchers = new Set<(result: TimeSyncResult) => void>();
let failedInARow = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function cancelRetry(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

function retryNow(): void {
  cancelRetry();
  remeasure().catch(() => {});
}

function afterMeasurement(result: TimeSyncResult): void {
  for (const watcher of [...watchers]) {
    try {
      watcher(result);
    } catch {
      // one broken display must not stop the others, or the retries below
    }
  }

  if (result.confident) {
    failedInARow = 0;
    cancelRetry();
    return;
  }
  if (watchers.size === 0 || retryTimer) return;
  const delay = RETRY_DELAYS_MS[Math.min(failedInARow, RETRY_DELAYS_MS.length - 1)];
  failedInARow++;
  retryTimer = setTimeout(retryNow, delay);
}

// The network is back: if the last reading failed, that is very likely why.
function onOnline(): void {
  if (failedInARow > 0) retryNow();
}

// Shown again — after a sleep, or from behind other windows. Reading the
// correction runs the checks it carries: a wall clock stepped while the page
// was hidden drops it here and measures again, before the first code is drawn.
function onVisible(): void {
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
  getTimeOffsetMs();
  if (failedInARow > 0) retryNow();
}

/**
 * Keep the clock measured for as long as this page is open, and hear about
 * every reading — the first included, whoever asked for it.
 *
 * Returns the function that stops watching.
 */
export function watchClock(onReading: (result: TimeSyncResult) => void): () => void {
  watchers.add(onReading);
  if (watchers.size === 1) {
    globalThis.addEventListener?.('online', onOnline);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
  }
  return () => {
    watchers.delete(onReading);
    if (watchers.size > 0) return;
    cancelRetry();
    failedInARow = 0;
    globalThis.removeEventListener?.('online', onOnline);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
  };
}
