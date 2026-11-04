// Wall-clock arithmetic that survives a wrong clock.
//
// Every "has enough time passed?" in this codebase was once a bare subtraction,
// and each one had the same hole: a device clock that moves BACKWARDS — a dead
// CMOS battery, a dual-boot machine writing local time to the RTC, a VM resume,
// someone changing the date by hand — makes the difference negative, and a
// negative number is smaller than every threshold. The deadline then never
// arrives, and the feature waits forever without a single sign of trouble.
//
// That is not hypothetical: it is how the clock check cached "your clock is
// fine" indefinitely, how one snapshot written from a fast clock could stop the
// daily backup for good, and how the vault's auto-lock could be turned off by
// nothing more than winding the clock back.
//
// The rule here is that a stamp we cannot trust yields `null`, so every caller
// has to say out loud which way it fails — and the safe direction differs: the
// vault must lock, a backup must be taken, a reminder must be shown.

/**
 * How long ago `stamp` was, or null when it is not a usable measurement:
 * missing, malformed, or in the future.
 *
 * Callers spell the failure direction with `??`: `ageOf(x) ?? Infinity` treats
 * an untrustworthy stamp as ancient (act now), `?? 0` treats it as brand new
 * (hold off).
 */
export function ageOf(stamp: unknown): number | null {
  if (typeof stamp !== 'number' || !Number.isFinite(stamp)) return null;
  const age = Date.now() - stamp;
  return age >= 0 ? age : null;
}

/**
 * Is a deadline still in force?
 *
 * `maxMs` is what the deadline was set for — a snooze of seven days, say. A
 * deadline further out than that was written by a clock that was wrong at the
 * time, so it is treated as already passed rather than honoured for years. The
 * cost of being wrong here is showing a reminder one time too many; the cost of
 * trusting it is a reminder that never comes back.
 */
export function deadlinePending(deadline: unknown, maxMs: number): boolean {
  if (typeof deadline !== 'number' || !Number.isFinite(deadline)) return false;
  const remaining = deadline - Date.now();
  return remaining > 0 && remaining <= maxMs;
}

/** The highest stamp this profile has ever issued. */
const HIGH_WATER_KEY = 'clockHighWater';

/**
 * An anchor further ahead than this was itself written on a broken clock.
 * Honouring it would drag every future stamp behind it for a month or a decade,
 * so past that point the anchor is abandoned rather than obeyed.
 */
const MAX_ANCHOR_LEAD_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * "Now", for anything we write down and read back later.
 *
 * `Date.now()` is not usable for that on its own: a machine whose clock reads
 * 2015 stamps a deletion as eleven years old, and the moment the clock is fixed
 * that record looks ancient and gets swept away — taking the deletion with it
 * and putting the account back. The same clock read forwards poisons a record
 * the other way, freezing whatever it was compared against.
 *
 * So stamps only ever move forwards: the greater of the real clock and the last
 * stamp this profile issued. Wrong by a few minutes beats wrong by a decade,
 * and out-of-order is what actually breaks the logic downstream.
 *
 * For records that are only ever asked "is this still recent?" — snapshots,
 * reminders — this is the wrong tool and `Date.now()` with an `ageOf(...) ??
 * Infinity` default is the right one: a monotonic stamp that sits ahead of the
 * real clock reads as zero seconds old for as long as the jump lasted, which
 * freezes the very check it was meant to protect. Use it where an ordering has
 * to survive a wrong clock and nothing measures the age, which today means the
 * deletion markers.
 */
export async function stampNow(): Promise<number> {
  const now = Date.now();
  try {
    const stored = (await chrome.storage.local.get(HIGH_WATER_KEY))[HIGH_WATER_KEY];
    const anchor = typeof stored === 'number' && Number.isFinite(stored) ? stored : 0;
    const usable = anchor - now <= MAX_ANCHOR_LEAD_MS ? anchor : 0;
    const stamp = Math.max(now, usable + 1);
    await chrome.storage.local.set({ [HIGH_WATER_KEY]: stamp }).catch(() => {});
    return stamp;
  } catch {
    // Storage unavailable — the real clock is still better than nothing.
    return now;
  }
}

/**
 * Move this profile's stamps past `stamp` — one another device issued, read
 * from its cloud copy. Cloud sync orders edits and deletions by these stamps
 * across devices, and a device whose clock runs behind would otherwise stamp
 * its next deletion "before" the version it deletes, and lose to it. Like a
 * Lamport clock: whatever this device does next is later than anything it has
 * seen. A stamp further ahead than MAX_ANCHOR_LEAD_MS is a broken clock
 * elsewhere and is not followed.
 */
export async function raiseClock(stamp: number): Promise<void> {
  if (!Number.isFinite(stamp) || stamp - Date.now() > MAX_ANCHOR_LEAD_MS) return;
  try {
    const stored = (await chrome.storage.local.get(HIGH_WATER_KEY))[HIGH_WATER_KEY];
    const anchor = typeof stored === 'number' && Number.isFinite(stored) ? stored : 0;
    if (stamp > anchor) await chrome.storage.local.set({ [HIGH_WATER_KEY]: stamp }).catch(() => {});
  } catch {
    // Storage unavailable: stamps fall back to the real clock.
  }
}

/**
 * A moment recorded twice: on the wall clock, and on the monotonic clock that
 * nothing outside this page can move.
 *
 * `ageOf` catches a clock that moved backwards, because the stamp ends up in
 * the future. It cannot catch one that moved FORWARDS — the stamp just looks
 * old, or, for a jump smaller than whatever the caller waits for, perfectly
 * current. That is the ordinary way a slow clock gets fixed: the user sees our
 * warning, the OS syncs, and the wall clock steps ahead by exactly the drift we
 * measured. Only a second clock that did not step can tell.
 *
 * The monotonic half means nothing outside the page that took it, so it is
 * never stored; a stamp rebuilt from a stored wall time can only catch jumps
 * that happen after it was rebuilt.
 */
export interface SteadyStamp {
  wall: number;
  mono: number | null;
}

function monotonicNow(): number | null {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : null;
}

/**
 * Stamp "now" — or, given `ageMs`, a moment that long ago, for a measurement
 * whose wall time was read back from storage.
 */
export function steadyStamp(ageMs = 0): SteadyStamp {
  const mono = monotonicNow();
  return { wall: Date.now() - ageMs, mono: mono === null ? null : mono - ageMs };
}

/**
 * How long ago `stamp` was, or null when the wall clock has jumped since —
 * either way, by more than `toleranceMs`.
 *
 * A laptop that slept reads as a jump too wherever the monotonic clock stops
 * during sleep (it does on macOS). That is the direction to be wrong in: the
 * caller throws away a measurement it could have kept, and takes a new one.
 */
export function steadyAgeOf(stamp: SteadyStamp, toleranceMs: number): number | null {
  const age = ageOf(stamp.wall);
  if (age === null) return null;
  const mono = monotonicNow();
  if (stamp.mono === null || mono === null) return age;
  return Math.abs(age - (mono - stamp.mono)) <= toleranceMs ? age : null;
}
