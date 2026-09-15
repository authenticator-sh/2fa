import { WHATS_NEW } from './update-notes';
import { productHuntDue } from './product-hunt';

// The dot on the toolbar icon: something is waiting behind it.
//
// Two things raise it — an update with "What's New" copy, and the Product Hunt
// launch window. Both promise that opening the extension shows something, which
// is why a release with no entry in WHATS_NEW gets no dot: it opens to the same
// screen as the day before.
//
// A single space rather than text: Chrome has no dot of its own, and a blank
// badge is drawn as a small coloured mark without putting a word or a number on
// somebody's toolbar.

const BADGE_COLOR = '#4285F4';

async function showDot(): Promise<void> {
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  await chrome.action.setBadgeText({ text: ' ' });
}

export async function showUpdateBadge(version: string): Promise<void> {
  if (WHATS_NEW[version]) await showDot();
}

/**
 * Raises the dot on browser start for whatever is still waiting.
 *
 * For an update this puts it back, so it does not depend on whether Chrome kept
 * a badge set from code across the restart. For the launch it is the only
 * moment the dot can go up at all: without an alarms permission nothing wakes
 * the worker when the window opens, and a morning browser start is when most
 * people would see it anyway.
 */
export async function restoreBadge(): Promise<void> {
  const { pendingWhatsNew } = await chrome.storage.local.get('pendingWhatsNew');
  if (typeof pendingWhatsNew === 'string' && WHATS_NEW[pendingWhatsNew]) return showDot();
  if (await productHuntDue()) await showDot();
}

/** Opening the extension is what the dot asked for, so the first open clears it. */
export async function clearUpdateBadge(): Promise<void> {
  await chrome.action.setBadgeText({ text: '' });
}
