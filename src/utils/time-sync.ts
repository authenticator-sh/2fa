import { setTimeOffsetMs } from './totp';

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
const OFFSET_KEY = 'timeOffsetMs';
const DISMISS_KEY = 'timeNoticeDismissedOffset'; // offsetSeconds at last dismissal

// Asymmetric TTLs: a confidently-synced clock stays valid for hours; an
// out-of-sync reading is rechecked soon so a fixed clock clears quickly.
const CACHE_TTL_OK_MS = 6 * 60 * 60 * 1000;
const CACHE_TTL_OFF_MS = 5 * 60 * 1000;

const FETCH_TIMEOUT_MS = 3000;
// Reject samples whose round-trip is high: the midpoint estimate degrades and a
// laggy/overloaded time API is the classic source of phantom "minutes off".
const MAX_RTT_MS = 1500;
// Two sources must agree within this to be trusted.
const AGREE_TOLERANCE_MS = 10_000;
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
    const ttl = entry.result.synced ? CACHE_TTL_OK_MS : CACHE_TTL_OFF_MS;
    if (Date.now() - entry.cachedAt < ttl) return entry.result;
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

async function fetchWorldTimeApi(signal: AbortSignal): Promise<number> {
  const response = await fetch('https://worldtimeapi.org/api/timezone/Etc/UTC', {
    cache: 'no-store',
    signal,
  });
  if (!response.ok) throw new Error(`worldtimeapi.org ${response.status}`);
  const data = await response.json();
  // `datetime` carries an explicit offset, so Date parses it as UTC correctly.
  const ms = new Date(data.datetime).getTime();
  if (!Number.isFinite(ms)) throw new Error('worldtimeapi.org bad datetime');
  return ms;
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
async function applyCorrection(result: TimeSyncResult): Promise<void> {
  if (!result.confident) return;

  const abs = Math.abs(result.offsetMs);
  const next = abs >= CORRECT_DEADZONE_MS && abs <= CORRECT_CAP_MS ? result.offsetMs : 0;
  setTimeOffsetMs(next);
  try {
    await chrome.storage.local.set({ [OFFSET_KEY]: next });
  } catch {
    // best-effort
  }
}

export async function checkTimeSync(): Promise<TimeSyncResult> {
  // On a cache hit we skip both the network AND re-applying the offset: the
  // authoritative correction is the one loadTimeOffset() restored at startup
  // (persisted by the last confident applyCorrection). Touching it here from a
  // possibly non-confident cached result could wipe a good correction.
  const cached = await readCache();
  if (cached) return cached;

  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const settled = await Promise.allSettled([
    sample(fetchWorldTimeApi, signal),
    sample(fetchTimeApiIo, signal),
  ]);
  const samples = settled
    .filter((s): s is PromiseFulfilledResult<Sample> => s.status === 'fulfilled' && s.value !== null)
    .map((s) => s.value);

  let result: TimeSyncResult;
  if (samples.length >= 2 && Math.abs(samples[0].offset - samples[1].offset) <= AGREE_TOLERANCE_MS) {
    // Confident: trust the lower-latency sample as the estimate.
    const best = samples.reduce((a, b) => (a.rtt <= b.rtt ? a : b));
    const offsetMs = best.offset;
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
