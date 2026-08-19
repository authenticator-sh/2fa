// Whether the right-click entry point is offered at all.
//
// Its own preference rather than a corner of the suggestion setting: that one
// is a privacy choice about a history being kept, this one is about an item
// appearing in a menu the browser and every other extension also write into.

import { ageOf } from './clock';

const ENABLED_KEY = 'quickFillEnabled';
const PROMPT_KEY = 'quickFillAsked';

/** Watched by the service worker so the menu follows the toggle immediately. */
export const QUICK_FILL_ENABLED_KEY = ENABLED_KEY;

/** On by default — an entry point nobody discovers is not worth shipping. */
export async function isQuickFillEnabled(): Promise<boolean> {
  try {
    const result = await chrome.storage.local.get(ENABLED_KEY);
    return result[ENABLED_KEY] !== false;
  } catch {
    return true;
  }
}

export async function setQuickFillEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [ENABLED_KEY]: enabled });
}

// --- "which account for this site?" -----------------------------------------
//
// When quick fill cannot tell which account a site wants, it opens the popup
// and the user picks one. That pick is the best evidence there is about the
// site — far better than an ordinary copy, which carries the hostname of
// whatever tab was open and frequently means nothing by it. The two are
// indistinguishable inside the popup, so the question has to be left where the
// answer can find it.
//
// Session storage, never local: this is a hostname, which is exactly the
// metadata the vault promises a stolen profile will not give up. It is also
// short-lived by nature, and a marker that outlived the browser would credit
// an unrelated copy days later.

interface PickPrompt {
  hostname: string;
  at: number;
}

/**
 * How long an unanswered question stays open.
 *
 * Long enough to unlock a vault and find the account, short enough that the
 * popup opened for one site cannot lend its weight to a copy made for another
 * once the user has moved on.
 */
const PROMPT_MAX_AGE_MS = 2 * 60 * 1000;

function hasSessionStorage(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.storage && !!chrome.storage.session;
}

/** Record that the popup is being opened to ask about this site. */
export async function notePickPrompt(hostname: string): Promise<void> {
  if (!hostname || !hasSessionStorage()) return;
  await chrome.storage.session
    .set({ [PROMPT_KEY]: { hostname, at: Date.now() } satisfies PickPrompt })
    .catch(() => {});
}

/**
 * Was the account about to be copied an answer to that question?
 *
 * Consumed on read: one question earns one answer. A second copy in the same
 * popup is the user helping themselves to another code, not telling us
 * anything more about the site.
 */
export async function takePickPrompt(hostname: string): Promise<boolean> {
  if (!hostname || !hasSessionStorage()) return false;
  try {
    const stored = (await chrome.storage.session.get(PROMPT_KEY))[PROMPT_KEY] as PickPrompt | undefined;
    if (!stored) return false;

    await chrome.storage.session.remove(PROMPT_KEY).catch(() => {});

    // An unusable stamp — a clock wound back between the two — fails closed:
    // an unearned boost is exactly what this whole mechanism exists to avoid.
    const age = ageOf(stored.at);
    return stored.hostname === hostname && age !== null && age <= PROMPT_MAX_AGE_MS;
  } catch {
    return false;
  }
}
