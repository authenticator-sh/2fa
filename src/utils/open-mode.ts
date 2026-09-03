// Where the app opens when the toolbar icon is clicked, and where it is running now.
//
// The action popup is what everyone knows and stays the default, but it has one
// property nothing can change: Chrome dismisses it the instant focus leaves the
// browser. Someone typing a code into a desktop app, or reading it off one
// screen while the browser is on another, loses it the moment they look away.
// The two alternatives each survive that: a window of its own stays open until
// closed, and the side panel stays beside the page across tab switches.
//
// The same page runs in all three places. Which one it is in matters for a
// few things — how the root is sized, where the current site comes from — and
// is read off the file name rather than a query string, because the side
// panel's path is fixed in the manifest.

export type OpenMode = 'popup' | 'window' | 'sidepanel';

/** The page this bundle is running in. */
export type AppHost = OpenMode;

export const OPEN_MODE_KEY = 'openMode';
export const DEFAULT_OPEN_MODE: OpenMode = 'popup';

const MODES: readonly OpenMode[] = ['popup', 'window', 'sidepanel'];

/** The three copies of the same document the build writes to the package root. */
export const HOST_PAGES: Record<AppHost, string> = {
  popup: 'popup.html',
  window: 'window.html',
  sidepanel: 'sidepanel.html',
};

export function readOpenMode(value: unknown): OpenMode | null {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value) ? (value as OpenMode) : null;
}

export async function getOpenMode(): Promise<OpenMode> {
  try {
    const result = await chrome.storage.local.get(OPEN_MODE_KEY);
    return readOpenMode(result[OPEN_MODE_KEY]) ?? DEFAULT_OPEN_MODE;
  } catch {
    return DEFAULT_OPEN_MODE;
  }
}

/** The service worker watches this key and re-points the toolbar icon itself. */
export async function setOpenMode(mode: OpenMode): Promise<void> {
  await chrome.storage.local.set({ [OPEN_MODE_KEY]: mode });
}

export function detectHost(pathname: string = location.pathname): AppHost {
  const file = pathname.slice(pathname.lastIndexOf('/') + 1);
  for (const host of MODES) {
    if (HOST_PAGES[host] === file) return host;
  }
  return 'popup';
}

/**
 * Whether this browser has a side panel at all.
 *
 * Chrome 114 added it; the namespace is simply absent before that. The setting
 * hides the option rather than offering a mode that would leave the icon doing
 * nothing.
 */
export function sidePanelAvailable(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.sidePanel;
}

/**
 * Open the side panel right now, in a browser window that can host one.
 *
 * Only valid in response to a user action, and only from Chrome 116 — both are
 * reasons a caller must treat false as "it will open on the next icon click"
 * rather than as an error. The last focused normal window is asked for
 * explicitly because the caller may itself be the floating window, which is a
 * popup-type window and cannot carry a side panel.
 */
export async function openSidePanelNow(): Promise<boolean> {
  if (!chrome.sidePanel?.open) return false;
  try {
    const target = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (target.id === undefined) return false;
    await chrome.sidePanel.open({ windowId: target.id });
    return true;
  } catch {
    return false;
  }
}
