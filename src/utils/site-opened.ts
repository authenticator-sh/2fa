// Whether this page was opened by the welcome page (background/site-open.ts)
// rather than by the person.
//
// The welcome page opens the popup by itself as it loads. That is not someone
// finding the extension — counted as a first open it would hide exactly what
// it is there to change (half of installs never opening it), and the uninstall
// stage would say "opened" for everyone it worked for. Nor can such a popup
// capture the tab: activeTab comes from a click on the icon, not from
// chrome.action.openPopup. So the worker leaves a mark just before it opens,
// and the page it opened takes it.

const KEY = 'siteOpenedAt';
/** A mark older than this was left by an open that never happened. */
const FRESH_MS = 10_000;

export async function markSiteOpened(): Promise<void> {
  try {
    await chrome.storage.session.set({ [KEY]: Date.now() });
  } catch {}
}

export async function clearSiteOpened(): Promise<void> {
  try {
    await chrome.storage.session.remove(KEY);
  } catch {}
}

async function takeSiteOpened(): Promise<boolean> {
  try {
    const at = (await chrome.storage.session.get(KEY))[KEY];
    await chrome.storage.session.remove(KEY);
    const now = Date.now();
    return typeof at === 'number' && at <= now && now - at < FRESH_MS;
  } catch {
    return false;
  }
}

let taken: Promise<boolean> | null = null;

/** Whether the page this runs in was opened by the welcome page. Asked once per page. */
export function openedBySite(): Promise<boolean> {
  return (taken ??= takeSiteOpened());
}
