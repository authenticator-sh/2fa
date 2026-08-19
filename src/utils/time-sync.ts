import { ageOf } from './clock';
import { getTimeOffsetMs, persistTimeOffset, setTimeOffsetMs } from './totp';

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

async function readCache(): Promise<TimeSyncResult | null> {
  try {
    const stored = await chrome.storage.local.get(CACHE_KEY);
    const entry: TimeSyncCacheEntry | undefined = stored[CACHE_KEY];
    if (!entry) return null;
    // Only a confident, healthy reading earns the long TTL. An unmeasurable
    // one used to inherit it through `synced: true`, so a single failed check
    // (offline, blocked, captive portal) suppressed every retry for six hours.
    const ttl = entry.result.confident && entry.result.synced ? CACHE_TTL_OK_MS : CACHE_TTL_OFF_MS;
    // A stamp from the future means the clock moved backwards since we wrote
    // the entry — the exact failure this check exists to catch. Untrusted reads
    // as expired; the old bare subtraction read it as infinitely fresh and
    // turned the check off for good.
    const age = ageOf(entry.cachedAt) ?? Infinity;
    if (age < ttl) return entry.result;
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
 * group agreeing within tolerance, represented by its lowest-latency member.
 * Fewer than two agreeing samples is not an estimate, and returns null.
 */
function agreeingEstimate(samples: Sample[]): Sample | null {
  let best: { member: Sample; size: number } | null = null;

  for (const candidate of samples) {
    const group = samples.filter((s) => Math.abs(s.offset - candidate.offset) <= AGREE_TOLERANCE_MS);
    if (group.length < 2) continue;

    const member = group.reduce((a, b) => (a.rtt <= b.rtt ? a : b));
    const better =
      best === null || group.length > best.size || (group.length === best.size && member.rtt < best.member.rtt);
    if (better) best = { member, size: group.length };
  }

  return best?.member ?? null;
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

// Persist + apply the correction, but only when the reading is confident and
// within sane bounds. When confident-and-fine, clear any stale correction. When
// NOT confident, leave the existing correction untouched — a bad reading must
// never move code generation.
/**
 * Re-apply a correction we have already measured, without re-persisting it when
 * nothing has changed. Used on the cache-hit path, where the measurement is
 * trusted but the in-memory offset may have been reset since it was taken.
 */
async function reconcileCorrection(result: TimeSyncResult): Promise<void> {
  const abs = Math.abs(result.offsetMs);
  const wanted = abs >= CORRECT_DEADZONE_MS && abs <= CORRECT_CAP_MS ? result.offsetMs : 0;
  if (wanted === getTimeOffsetMs()) return;

  setTimeOffsetMs(wanted);
  await persistTimeOffset(wanted);
}

async function applyCorrection(result: TimeSyncResult): Promise<void> {
  if (!result.confident) return;

  const abs = Math.abs(result.offsetMs);
  const next = abs >= CORRECT_DEADZONE_MS && abs <= CORRECT_CAP_MS ? result.offsetMs : 0;
  setTimeOffsetMs(next);
  await persistTimeOffset(next);
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

function statusOf(result: TimeSyncResult): ClockStatus {
  if (!result.confident) return { state: 'unknown', offsetSeconds: 0, corrected: false };

  const abs = Math.abs(result.offsetMs);
  return {
    state: result.synced ? 'ok' : 'off',
    offsetSeconds: result.offsetSeconds,
    corrected: abs >= CORRECT_DEADZONE_MS && abs <= CORRECT_CAP_MS,
  };
}

/** The clock as last measured, for display. Cheap: shares the cache. */
export async function getClockStatus(): Promise<ClockStatus> {
  return statusOf(await checkTimeSync());
}

/** Measure again now, ignoring the cache — what the "check now" button does. */
export async function recheckClock(): Promise<ClockStatus> {
  await chrome.storage.local.remove(CACHE_KEY).catch(() => {});
  // Drop any measurement already in flight: it read the cache before we cleared
  // it, so handing the user its answer would make "check now" a button that
  // returns the very reading they pressed it to replace.
  inFlight = null;
  return statusOf(await checkTimeSync());
}

// One measurement per popup open, however many callers ask. The banner and the
// settings line both want the answer, and without this they race each other
// into two independent rounds of network requests on every open.
let inFlight: Promise<TimeSyncResult> | null = null;

export async function checkTimeSync(): Promise<TimeSyncResult> {
  if (inFlight) return inFlight;
  inFlight = measure().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function measure(): Promise<TimeSyncResult> {
  // On a cache hit we skip both the network AND re-applying the offset: the
  // authoritative correction is the one loadTimeOffset() restored at startup
  // (persisted by the last confident applyCorrection). Touching it here from a
  // possibly non-confident cached result could wipe a good correction.
  const cached = await readCache();
  if (cached) {
    // Keep what we report in step with what code generation actually does.
    // loadTimeOffset may have just discarded the stored correction — expired,
    // or written by a version that stored no timestamp — while this cached
    // measurement is recent enough to still be true. Without this, upgrading
    // from 1.11.0 with a clock 3-90s out silently dropped the correction and
    // then reported "your clock is fine" for six hours, which is the exact
    // combination that makes codes fail with nothing on screen to explain it.
    if (cached.confident) await reconcileCorrection(cached);
    return cached;
  }

  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const settled = await Promise.allSettled(SOURCES.map((source) => sample(source.fetchServerMs, signal)));
  const samples = settled
    .filter((s): s is PromiseFulfilledResult<Sample> => s.status === 'fulfilled' && s.value !== null)
    .map((s) => s.value);

  const agreed = agreeingEstimate(samples);

  let result: TimeSyncResult;
  if (agreed) {
    const offsetMs = agreed.offset;
    result = {
      synced: Math.abs(offsetMs) < WARN_THRESHOLD_MS,
      confident: true,
      offsetMs,
      offsetSeconds: Math.round(offsetMs / 1000),
    };
  } else {
    // Fewer than two agreeing samples → uncertain. Never alarm, never correct.
    result = { synced: true, confident: false, offsetMs: 0, offsetSeconds: 0 };
  }

  await writeCache(result);
  await applyCorrection(result);

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
  const result = await checkTimeSync();
  if (!result.confident || result.synced) return null;

  const offsetSeconds = Math.abs(result.offsetSeconds);
  const dismissed = await readDismissedOffset();
  if (dismissed !== null && Math.abs(dismissed - offsetSeconds) < 60) return null;

  return offsetSeconds;
}
