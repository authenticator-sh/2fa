import { WHATS_NEW } from './update-notes';

// The dot on the toolbar icon: something is waiting behind it.
//
// An update with "What's New" copy raises it. It promises that opening the
// extension shows something, which is why a release with no entry in WHATS_NEW
// gets no dot: it opens to the same screen as the day before.
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
 * Puts the dot back on browser start, so it does not depend on whether Chrome
 * kept a badge set from code across the restart.
 */
export async function restoreBadge(): Promise<void> {
  const { pendingWhatsNew } = await chrome.storage.local.get('pendingWhatsNew');
  if (typeof pendingWhatsNew === 'string' && WHATS_NEW[pendingWhatsNew]) await showDot();
}

/** Opening the extension is what the dot asked for, so the first open clears it. */
export async function clearUpdateBadge(): Promise<void> {
  await chrome.action.setBadgeText({ text: '' });
}
