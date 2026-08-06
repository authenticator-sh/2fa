// Decides when to ask for a Web Store review.
//
// The ask used to live only inside the "What's New" modal, which the service
// worker arms on `onInstalled` with reason 'update'. That has a hole big enough
// to explain our review count: a fresh install fires reason 'install', so
// nobody who arrives between two releases is ever asked. They would have to
// keep the extension until the next version that happens to have changelog copy
// — months, in practice.
//
// So the ask is tied to use instead of to the release calendar: enough opens to
// have formed an opinion, and at least one account, because someone who never
// finished setup has nothing to review. Asked once; "later" costs us another
// SNOOZE_OPENS before we bring it up again, and rating retires it for good via
// the same `reviewDismissed` flag the modal already sets.

const MIN_OPENS = 15;
const SNOOZE_OPENS = 50;
// After this many opens with the card on screen and no answer either way, treat
// the silence as an answer and snooze it. Someone who came for a code and left
// is not going to start rating on the twentieth showing, and a card that is
// simply always there is the shape of nagging users punish in the reviews we
// are asking for.
const MAX_SILENT_SHOWS = 3;

/**
 * Count this popup open and return the new total.
 *
 * Stops counting once the prompt is retired — nothing reads the number after
 * that, and a counter that climbs forever on 150k installs is just writes.
 */
export async function recordOpen(): Promise<number> {
  const stored = await chrome.storage.local.get(['openCount', 'reviewDismissed']);
  const current: number = stored.openCount || 0;
  if (stored.reviewDismissed) return current;

  const next = current + 1;
  await chrome.storage.local.set({ openCount: next });
  return next;
}

export async function shouldShowReviewPrompt(openCount: number, accountCount: number): Promise<boolean> {
  if (accountCount === 0 || openCount < MIN_OPENS) return false;

  const stored = await chrome.storage.local.get([
    'reviewDismissed',
    'reviewSnoozedUntilOpen',
    'reviewShownCount',
  ]);
  if (stored.reviewDismissed) return false;

  const snoozedUntil: unknown = stored.reviewSnoozedUntilOpen;
  if (typeof snoozedUntil === 'number' && openCount < snoozedUntil) return false;

  const shown: number = typeof stored.reviewShownCount === 'number' ? stored.reviewShownCount : 0;
  if (shown >= MAX_SILENT_SHOWS) {
    // Ignoring it counts as "later" — same cost, without making the user say so.
    await snoozeReviewPrompt(openCount);
    await chrome.storage.local.set({ reviewShownCount: 0 });
    return false;
  }

  await chrome.storage.local.set({ reviewShownCount: shown + 1 });
  return true;
}

/** "Maybe later" — measured in opens rather than days, so someone who barely uses the extension is not asked again on a timer. */
export async function snoozeReviewPrompt(openCount: number): Promise<void> {
  await chrome.storage.local.set({
    reviewSnoozedUntilOpen: openCount + SNOOZE_OPENS,
    reviewShownCount: 0,
  });
}
