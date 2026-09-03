// The floating window: one instance, remembered size and position.
//
// Opened from two places — the service worker when the toolbar icon is clicked
// in window mode, and the settings panel the moment the mode is switched — so
// the bookkeeping lives here rather than in either. Neither `chrome.windows`
// nor `chrome.tabs` needs a permission for any of this; see passkey.ts.

import { HOST_PAGES } from './open-mode';
import { getBaseDomain } from './suggestions';

/** Sent to an already-open window so it can suggest the account for the site the icon was clicked on. */
export const POPOUT_SITE_MESSAGE = 'popout-site';

export interface PopoutSiteMessage {
  type: typeof POPOUT_SITE_MESSAGE;
  site: string;
}

export function isPopoutSiteMessage(message: unknown): message is PopoutSiteMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as PopoutSiteMessage).type === POPOUT_SITE_MESSAGE &&
    typeof (message as PopoutSiteMessage).site === 'string'
  );
}

export interface PopoutBounds {
  width: number;
  height: number;
  left?: number;
  top?: number;
}

/** The medium popup plus a title bar; resizable and remembered from then on. */
export const DEFAULT_POPOUT_BOUNDS: PopoutBounds = { width: 400, height: 640 };

// Session storage for the id: a window id means nothing after the browser
// restarts, and session storage is cleared exactly then. Local for the bounds,
// which should survive.
const WINDOW_ID_KEY = 'popoutWindowId';
const BOUNDS_KEY = 'popoutBounds';

const MIN_WIDTH = 280;
const MIN_HEIGHT = 320;
const MAX_SIZE = 4000;

function isBoundsLike(value: unknown): value is PopoutBounds {
  if (typeof value !== 'object' || value === null) return false;
  const bounds = value as Record<string, unknown>;
  const size = (n: unknown, min: number) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= MAX_SIZE;
  const position = (n: unknown) => n === undefined || (typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= MAX_SIZE * 4);
  return size(bounds.width, MIN_WIDTH) && size(bounds.height, MIN_HEIGHT) && position(bounds.left) && position(bounds.top);
}

/** The stored bounds, or the defaults when there are none or they look corrupt. */
export function readPopoutBounds(value: unknown): PopoutBounds {
  if (!isBoundsLike(value)) return DEFAULT_POPOUT_BOUNDS;
  const bounds: PopoutBounds = { width: Math.round(value.width), height: Math.round(value.height) };
  if (typeof value.left === 'number') bounds.left = Math.round(value.left);
  if (typeof value.top === 'number') bounds.top = Math.round(value.top);
  return bounds;
}

export async function getPopoutBounds(): Promise<PopoutBounds> {
  try {
    return readPopoutBounds((await chrome.storage.local.get(BOUNDS_KEY))[BOUNDS_KEY]);
  } catch {
    return DEFAULT_POPOUT_BOUNDS;
  }
}

export async function savePopoutBounds(bounds: PopoutBounds): Promise<void> {
  if (!isBoundsLike(bounds)) return;
  await chrome.storage.local.set({ [BOUNDS_KEY]: readPopoutBounds(bounds) }).catch(() => {});
}

async function storedWindowId(): Promise<number | null> {
  try {
    const value = (await chrome.storage.session.get(WINDOW_ID_KEY))[WINDOW_ID_KEY];
    return typeof value === 'number' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Record that the window this page is running in is the floating window.
 *
 * Called by the window itself, on mount, because the opener cannot be trusted
 * to finish the job. `openPopoutWindow` writes the id after
 * `chrome.windows.create({focused: true})` resolves — and when the switch to
 * window mode is made from the action popup, creating a focused window is
 * exactly what destroys the popup, so that continuation never ran. The id was
 * never written, the next icon click found nothing to focus and created a
 * second window, and the first was orphaned: unfocusable, unforgettable,
 * unreachable. Every user who switched modes hit it on their first click.
 *
 * A page cannot be torn down before it has run, so this is the one context
 * where the write is guaranteed.
 */
export async function claimPopoutWindow(): Promise<void> {
  try {
    const self = await chrome.windows.getCurrent();
    if (self.id === undefined) return;
    await chrome.storage.session.set({ [WINDOW_ID_KEY]: self.id });
  } catch {
    // Session storage unavailable, or no window of our own. The worst case is
    // the behaviour that existed before this function.
  }
}

/** The open floating window, if there is one. */
export async function findPopoutWindow(): Promise<chrome.windows.Window | null> {
  const id = await storedWindowId();
  if (id === null) return null;
  try {
    return await chrome.windows.get(id);
  } catch {
    // Closed while the service worker was asleep, so onRemoved never ran.
    await chrome.storage.session.remove(WINDOW_ID_KEY).catch(() => {});
    return null;
  }
}

/** Called from windows.onRemoved: only our own window's id is dropped. */
export async function forgetPopoutWindow(windowId: number): Promise<void> {
  if ((await storedWindowId()) === windowId) {
    await chrome.storage.session.remove(WINDOW_ID_KEY).catch(() => {});
  }
}

/** Called from windows.onBoundsChanged: only our own window's bounds are kept. */
export async function rememberPopoutBounds(window: chrome.windows.Window): Promise<void> {
  if (window.id === undefined || window.id !== (await storedWindowId())) return;
  if (window.state && window.state !== 'normal') return;
  const { width, height, left, top } = window;
  if (width === undefined || height === undefined) return;
  await savePopoutBounds({ width, height, left, top });
}

/**
 * Open the floating window, or bring the existing one forward.
 *
 * `site` is the hostname of the page the icon was clicked on, when there was
 * one: a new window gets it in the URL, an existing one by message, and either
 * way the account for that site floats to the top — the same suggestion the
 * popup makes, which the window cannot make for itself because it has no
 * active tab of its own.
 */
/**
 * In flight, so two clicks make one window.
 *
 * Both calls used to find no window and both create one, and only the second
 * id was stored — the first window could then never be focused, never be
 * forgotten, and never be found again by the extension that opened it.
 */
let opening: Promise<void> | null = null;

export function openPopoutWindow(site?: string): Promise<void> {
  const run = (opening ?? Promise.resolve()).catch(() => {}).then(() => openPopoutWindowOnce(site));
  opening = run;
  // Cleared only if it is still the newest, so a later click keeps its place
  // in the queue.
  void run.finally(() => {
    if (opening === run) opening = null;
  });
  return run;
}

async function openPopoutWindowOnce(site?: string): Promise<void> {
  const existing = await findPopoutWindow();
  if (existing?.id !== undefined) {
    await chrome.windows
      .update(existing.id, existing.state === 'minimized' ? { focused: true, state: 'normal' } : { focused: true })
      .catch(() => {});
    if (site) {
      const message: PopoutSiteMessage = { type: POPOUT_SITE_MESSAGE, site };
      // Rejects when nothing is listening yet (the page is still loading); the
      // page then reads the site it was opened with, so nothing is lost.
      await chrome.runtime.sendMessage(message).catch(() => {});
    }
    return;
  }

  const page = HOST_PAGES.window;
  const url = chrome.runtime.getURL(site ? `${page}?site=${encodeURIComponent(site)}` : page);
  const bounds = await getPopoutBounds();
  const create = (b: PopoutBounds) => chrome.windows.create({ url, type: 'popup', focused: true, ...b });

  let created: chrome.windows.Window | undefined;
  try {
    created = await create(bounds);
  } catch {
    // Remembered bounds can point at a display that is no longer attached, and
    // some window managers refuse the geometry rather than fixing it up.
    created = await create(DEFAULT_POPOUT_BOUNDS);
  }
  if (created?.id !== undefined) {
    await chrome.storage.session.set({ [WINDOW_ID_KEY]: created.id }).catch(() => {});
  }
}

/** The site to suggest for, from a page address. */
export function siteOfUrl(pageUrl: string | undefined): string | undefined {
  if (!pageUrl) return undefined;
  try {
    const url = new URL(pageUrl);
    // A chrome:// or file:// tab has no site to suggest against.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return getBaseDomain(url.hostname) ? url.hostname : undefined;
  } catch {
    return undefined;
  }
}

/** The same, from the tab the action was clicked on. */
export function siteOfTab(tab: chrome.tabs.Tab | undefined): string | undefined {
  return siteOfUrl(tab?.url);
}
