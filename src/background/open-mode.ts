// What the toolbar icon does, applied from the "Open as" setting.
//
// The manifest names a popup, and a popup wins over everything else: while one
// is set, neither action.onClicked nor the side panel's click behaviour ever
// fires. So the mode is applied by re-pointing the action — a popup, nothing
// (the click then reaches onClicked and opens the floating window), or the
// side panel's own click-to-toggle. Applied on install and startup rather than
// trusted to persist, and again whenever the setting changes.

import { DEFAULT_OPEN_MODE, getOpenMode, HOST_PAGES, OPEN_MODE_KEY, readOpenMode, type OpenMode } from '@/utils/open-mode';
import {
  forgetPopoutWindow,
  openPopoutWindow,
  rememberPopoutBounds,
  siteOfTab,
  siteOfUrl,
} from '@/utils/popout';

/**
 * The mode as last seen, for the listeners that cannot wait to read it.
 *
 * `chrome.sidePanel.open` is honoured only "in response to a user action", and
 * in a service worker that means during the listener's own synchronous run:
 * the first `await` ends it. Every path that opened the panel used to read the
 * mode from storage first, so the open was always refused — silently, since
 * the refusal was caught as "older Chrome". The mode is therefore kept here,
 * read once when the worker starts and followed through storage.onChanged.
 *
 * Null until that first read lands. A worker woken by the very click it is
 * about to handle usually has not got it yet — the event is dispatched as soon
 * as the script has run, ahead of the storage reply — and those clicks take
 * the old route, which can still end somewhere useful.
 */
let knownMode: OpenMode | null = null;

/** The mode, if it is already known without waiting. */
export function openModeNow(): OpenMode | null {
  return knownMode;
}

/**
 * Open the side panel from inside the user action that asked for it.
 *
 * Must be called before the listener's first `await` — anywhere later and
 * Chrome refuses. Returns null when nothing was attempted (another mode, or the
 * mode not known yet, or no panel API), otherwise whether it opened.
 */
export function openSidePanelInGesture(target: { windowId?: number; tabId?: number }): Promise<boolean> | null {
  if (knownMode !== 'sidepanel' || !chrome.sidePanel?.open) return null;
  // A window is what the icon's own toggle opens the panel in; a tab is only
  // the fallback for an event that did not say which window it came from.
  const options =
    target.windowId !== undefined
      ? { windowId: target.windowId }
      : target.tabId !== undefined
        ? { tabId: target.tabId }
        : null;
  if (!options) return null;
  try {
    return chrome.sidePanel.open(options).then(
      () => true,
      () => false
    );
  } catch {
    return Promise.resolve(false);
  }
}

/**
 * One apply at a time.
 *
 * applyOpenMode is fired from four places that know nothing about each other —
 * onInstalled, onStartup, every cold start of the worker, and every change to
 * the stored mode — and each one re-reads the setting and then issues two
 * independent writes to browser state. Two overlapping runs can therefore land
 * as setPopup(A), setPopup(B), panel(B), panel(A): the stored mode says side
 * panel, the action has no popup, and the toggle that would open the panel is
 * off. That combination is a toolbar icon that does nothing at all, and
 * Settings — the only way to change the mode back — is reachable only through
 * that icon. Two taps in the mode picker is all it takes.
 */
let applying: Promise<void> = Promise.resolve();

export function applyOpenMode(mode?: OpenMode): Promise<void> {
  const next = applying.then(
    () => applyOpenModeNow(mode),
    () => applyOpenModeNow(mode)
  );
  applying = next.catch(() => {});
  return next;
}

async function applyOpenModeNow(mode?: OpenMode): Promise<void> {
  let current = mode ?? (await getOpenMode());

  // A stored mode this browser cannot honour is repaired rather than applied.
  // Otherwise the popup is cleared for a side panel that does not exist, the
  // click handler steps aside for a toggle that never runs, and the icon does
  // nothing at all — with Settings, the only way to change the mode back,
  // reachable only through that icon. Reachable by an enterprise rollback
  // below Chrome 114 or a Chromium build without the panel.
  if (current === 'sidepanel' && !chrome.sidePanel?.setPanelBehavior) {
    current = 'window';
    await chrome.storage.local.set({ [OPEN_MODE_KEY]: current }).catch(() => {});
  }

  await chrome.action.setPopup({ popup: current === 'popup' ? HOST_PAGES.popup : '' }).catch((error) => {
    console.error('Could not point the toolbar icon', error);
  });

  // Absent before Chrome 114; the setting never offers the mode there.
  if (chrome.sidePanel?.setPanelBehavior) {
    await chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: current === 'sidepanel' })
      .catch((error) => console.error('Could not set the side panel behaviour', error));
  }
}

/**
 * Open the app wherever the icon would have opened it, for a mode that is not
 * the popup. True when something was actually opened.
 *
 * Quick fill calls this when it has to ask the user a question: with the popup
 * unset, `chrome.action.openPopup` has nothing to open, and the question would
 * otherwise be answered by a notice on the page telling them to open an app
 * that the click was already trying to open.
 */
export async function openAppFor(
  mode: OpenMode,
  context: { url?: string; windowId?: number } = {}
): Promise<boolean> {
  if (mode === 'window') {
    try {
      await openPopoutWindow(siteOfUrl(context.url));
      return true;
    } catch (error) {
      // Reported false so the caller still shows its notice on the page: a
      // window that failed to open is not an app the user can reach.
      console.error('Could not open the floating window', error);
      return false;
    }
  }

  if (mode === 'sidepanel' && chrome.sidePanel?.open) {
    try {
      // Chrome 116+, and only in response to a user action. By the time a
      // caller has awaited anything that action is over and Chrome refuses —
      // which is why the listeners open the panel themselves, up front, with
      // openSidePanelInGesture, whenever they can tell in time.
      // A side panel hangs off a normal window; the last focused one can be
      // our own floating window or a site popup, neither of which can host it.
      const windowId =
        context.windowId ?? (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).id;
      if (windowId === undefined) return false;
      await chrome.sidePanel.open({ windowId });
      return true;
    } catch {
      // Older Chrome, or a window that cannot host a panel. The caller falls
      // back to openPopup and then to a notice on the page.
      return false;
    }
  }

  return false;
}

/**
 * Fires only when no popup is set — window mode, or side panel mode on a Chrome without one.
 *
 * Deliberately not async: the side panel has to be asked for before anything
 * is awaited, or the click no longer counts as the user's.
 */
function handleActionClick(tab: chrome.tabs.Tab): void {
  const opening = openSidePanelInGesture({ windowId: tab.windowId, tabId: tab.id });
  void finishActionClick(tab, opening);
}

async function finishActionClick(tab: chrome.tabs.Tab, opening: Promise<boolean> | null): Promise<void> {
  if (opening && (await opening)) {
    // Open — but getting here at all means the icon's own toggle is off (see
    // below), so put it back for the next click.
    await applyOpenMode();
    return;
  }

  const mode = await getOpenMode();
  if (mode === 'window') {
    // `activeTab` is granted by this click, which is what makes the tab's URL
    // readable here without the `tabs` permission.
    await openPopoutWindow(siteOfTab(tab));
    return;
  }
  if (mode === 'sidepanel') {
    // Getting here at all is proof that the icon just did nothing.
    //
    // action.onClicked is dispatched only when the action has no popup AND
    // openPanelOnActionClick is false — so if Chrome were going to open the
    // panel on this click, this listener would never have run. The old guard
    // asked whether the side-panel API exists, which on any modern Chrome is
    // yes, and then returned: the click was swallowed, and so was every one
    // after it, because the only route to Settings is the icon that no longer
    // works. Reachable whenever setPanelBehavior was rejected or two applies
    // interleaved.
    //
    // So: repair the browser state, then open something. There is no
    // double-open to fear — the toggle that would have opened the panel is
    // demonstrably off.
    await applyOpenMode();
    const settled = await getOpenMode();
    if (settled === 'sidepanel' && (await openAppFor('sidepanel', { windowId: tab.windowId }))) {
      return;
    }
    await openPopoutWindow(siteOfTab(tab));
    return;
  }
  // 'popup' with no popup set: the stored action state and the setting have
  // drifted. Repair and let the next click behave.
  await applyOpenMode(mode);
}

export function registerOpenMode(): void {
  chrome.action.onClicked.addListener(handleActionClick);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(OPEN_MODE_KEY in changes)) return;
    knownMode = readOpenMode(changes[OPEN_MODE_KEY].newValue) ?? DEFAULT_OPEN_MODE;
    void applyOpenMode();
  });

  // Only if nothing newer has arrived meanwhile: a change event carries the
  // value as written, and this read may have been answered before it.
  void getOpenMode().then((mode) => {
    if (knownMode === null) knownMode = mode;
  });

  chrome.windows.onRemoved.addListener((windowId) => {
    void forgetPopoutWindow(windowId);
  });

  // Chrome 86+, and only committed bounds — not every pixel of a drag.
  chrome.windows.onBoundsChanged?.addListener((window) => {
    void rememberPopoutBounds(window);
  });
}
