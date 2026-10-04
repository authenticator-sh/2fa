// One clock for every code on the page.
//
// Each card used to run its own setInterval(1000), started whenever that card
// happened to mount, and ran the HMAC on every one of them. So the codes on one
// screen changed up to a second apart, and any of them could go on showing the
// previous code for most of a second after its slot had ended — long enough to
// be read, typed and refused. A popup with a hundred accounts was also a
// hundred timers and a hundred HMACs a second to redraw a countdown.
//
// Now there is one timer per page, fired just after each second of corrected
// time begins, so every code turns over together and on time. What the cards
// do with the tick is advanceTOTP's business: the HMAC runs only when a slot
// changes.

import { correctedNow, subscribeTimeOffset } from './totp';

/**
 * How far past the second to fire. Timers run on a different clock from
 * Date.now() and can land a millisecond or two early by it; a tick that lands
 * just before the boundary would draw the old second, and the old code, for a
 * whole second more.
 */
const TICK_SLACK_MS = 15;

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let stopWatchingOffset: (() => void) | null = null;

/** Milliseconds from `correctedMs` to just past the start of the next second. */
export function msUntilNextSecond(correctedMs: number): number {
  const into = ((correctedMs % 1000) + 1000) % 1000;
  return 1000 - into + TICK_SLACK_MS;
}

function fire(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      console.error('A code display failed to update', error);
    }
  }
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  // Re-aligned on every tick rather than left to an interval: an interval
  // drifts, a page throttled in the background fires late, and a change of
  // correction moves where the second boundaries are.
  timer = setTimeout(() => {
    timer = null;
    fire();
    schedule();
  }, msUntilNextSecond(correctedNow()));
}

/** Tick now, out of turn, and line the next one up again. */
function tickNow(): void {
  fire();
  if (listeners.size > 0) schedule();
}

// A page coming back into view has been throttled or asleep, and its last tick
// may be long gone; the code on screen is then whatever was current when it
// was hidden. Redrawn at once, not at the next timer.
function onVisible(): void {
  if (document.visibilityState === 'visible') tickNow();
}

/**
 * Call `listener` at the start of every second of corrected time, and at once
 * whenever the correction changes or the page is shown again. Returns the
 * function that stops it.
 */
export function onEverySecond(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    schedule();
    stopWatchingOffset = subscribeTimeOffset(tickNow);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    if (timer) clearTimeout(timer);
    timer = null;
    stopWatchingOffset?.();
    stopWatchingOffset = null;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
  };
}
