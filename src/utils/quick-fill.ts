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

// --- "put the code where it was asked for" ----------------------------------
//
// A quick fill that ends in our own window used to end there for good: the
// user unlocked the vault or picked the account, and the code went to the
// clipboard to be pasted into the field they had right-clicked a moment
// before. The window can do the last step itself — the `activeTab` grant from
// that click belongs to the extension, not to the service worker, and lasts
// until the tab navigates — so it is told where the code was wanted.
//
// Session storage for the same reason as the question above: a hostname and a
// tab are browsing metadata, and none of it is worth anything after a restart.

export interface FillRequest {
  /** The top-level page's hostname, as quick fill matched it. */
  hostname: string;
  tabId: number;
  /** The frame the user right-clicked in; absent for the keyboard shortcut. */
  frameId?: number;
  /**
   * Handed over because the vault was locked, not because the site was a
   * question. Unlocking then answers it on its own whenever the site names
   * one account — the same rule quick fill would have applied unlocked.
   */
  locked: boolean;
  at: number;
}

export const FILL_REQUEST_KEY = 'quickFillRequest';

/**
 * How long a request can be acted on: the unlock or the pick has to follow it.
 *
 * The same two minutes as the question. The tab is checked again before
 * anything goes into it, and a navigation revokes the grant anyway, so this is
 * not what keeps a code off the wrong page — it keeps a window opened much
 * later, for some other reason, from typing into a form the user has long
 * since dealt with by hand.
 */
const FILL_MAX_AGE_MS = PROMPT_MAX_AGE_MS;

function readRequest(value: unknown): FillRequest | null {
  const request = value as FillRequest | undefined;
  if (!request || typeof request.hostname !== 'string' || !Number.isInteger(request.tabId)) return null;
  const age = ageOf(request.at);
  // An unusable stamp fails closed, as above: typing into a page is the last
  // thing to do on evidence that cannot be dated.
  if (age === null || age > FILL_MAX_AGE_MS) return null;
  return request;
}

export async function noteFillRequest(request: Omit<FillRequest, 'at'>): Promise<void> {
  if (!request.hostname || !hasSessionStorage()) return;
  await chrome.storage.session
    .set({ [FILL_REQUEST_KEY]: { ...request, at: Date.now() } satisfies FillRequest })
    .catch(() => {});
}

/** The open request, without claiming it. */
export async function readFillRequest(): Promise<FillRequest | null> {
  if (!hasSessionStorage()) return null;
  try {
    return readRequest((await chrome.storage.session.get(FILL_REQUEST_KEY))[FILL_REQUEST_KEY]);
  } catch {
    return null;
  }
}

/**
 * Claim the open request: one request, one fill.
 *
 * Under a lock because more than one window can be holding the answer — a
 * popup and a side panel both unlocked — and each would otherwise read the
 * request before either removed it, and type the code into the page twice.
 * `expectedAt` lets a caller that decided on a request it only peeked at claim
 * that one and not a newer one that replaced it meanwhile.
 */
export async function takeFillRequest(expectedAt?: number): Promise<FillRequest | null> {
  if (!hasSessionStorage()) return null;

  const take = async (): Promise<FillRequest | null> => {
    try {
      const request = readRequest((await chrome.storage.session.get(FILL_REQUEST_KEY))[FILL_REQUEST_KEY]);
      if (!request || (expectedAt !== undefined && request.at !== expectedAt)) return null;
      await chrome.storage.session.remove(FILL_REQUEST_KEY);
      return request;
    } catch {
      return null;
    }
  };

  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  return locks ? locks.request('authenticator-quick-fill-request', take) : take();
}
