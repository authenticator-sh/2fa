// The Product Hunt launch, announced in a banner above the codes.
//
// Dated into the build: a Web Store review takes days, so the build carrying
// this has to be out before launch day and switch itself on and off. Set
// PRODUCT_HUNT_LAUNCH and ship; left null, it ships nothing.
//
// Only to people who use the extension, for the one day the launch lasts, and
// until they answer — following the link or closing the banner retires it. A
// banner does not stand between someone and their code the way a modal does,
// so it can wait for an answer instead of spending itself on first sight.

/**
 * When the launch goes live, with the Pacific offset — Product Hunt days start
 * at 00:01 PT. An ISO string so the offset is part of the value, e.g.
 * '2026-10-06T00:01:00-07:00'. null: no launch.
 */
// The launch: 29 September 2026, 00:01 PT (14:01 in Bangkok). Pacific daylight
// time is still in force that day — it ends on 1 November — hence -07:00.
export const PRODUCT_HUNT_LAUNCH: string | null = '2026-09-29T00:01:00-07:00';

// One Product Hunt day. The banner says "today", and on a second day it would not be true.
const WINDOW_MS = 24 * 60 * 60 * 1000;
// Enough opens to tell someone using the extension from someone taking a first
// look. Far lower than the review ask's 15 on purpose: the launch lasts one day,
// so the banner has to reach whoever opens the popup that day, and a comment is
// a smaller favour than a review.
const MIN_OPENS = 3;
const DONE_KEY = 'productHuntDoneFor';

export function launchWindowOpen(launch: string | null = PRODUCT_HUNT_LAUNCH, now = Date.now()): boolean {
  if (!launch) return false;
  const start = Date.parse(launch);
  if (!Number.isFinite(start)) return false;
  return now >= start && now < start + WINDOW_MS;
}

/**
 * Whether this launch should still be announced here.
 *
 * Reads the open counter from storage rather than taking it as an argument, so
 * the service worker — which has no popup state — can ask the same question for
 * the toolbar dot. A rating counts on its own: rating freezes the counter, and
 * the people who rated are the last ones to leave out.
 */
export async function productHuntDue(
  launch: string | null = PRODUCT_HUNT_LAUNCH,
  now = Date.now()
): Promise<boolean> {
  if (!launchWindowOpen(launch, now)) return false;
  const stored = await chrome.storage.local.get([DONE_KEY, 'openCount', 'reviewDismissed']);
  if (stored[DONE_KEY] === launch) return false;
  const openCount = typeof stored.openCount === 'number' ? stored.openCount : 0;
  return Boolean(stored.reviewDismissed) || openCount >= MIN_OPENS;
}

/** Keyed by the launch date, so a later launch is a new question rather than one already answered. */
export async function dismissProductHunt(launch: string | null = PRODUCT_HUNT_LAUNCH): Promise<void> {
  if (launch) await chrome.storage.local.set({ [DONE_KEY]: launch });
}
