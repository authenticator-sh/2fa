/**
 * A picture of what the browser is showing right now.
 *
 * The window has to be named. `null` means "the current window", which is the
 * right answer from a popup and the wrong one from the floating window: that
 * is a window of its own, so the capture came back as a photograph of this
 * extension's own interface and the scan failed with a message blaming the
 * page. The last focused normal window is the one the user was looking at.
 */
export async function captureCurrentTab(): Promise<string> {
  let windowId: number | undefined;
  try {
    windowId = (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).id;
  } catch {
    // No normal window, or the API is unavailable here: fall back to the
    // current one, which is what this always used to do.
  }

  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(windowId as unknown as number, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!dataUrl) {
        reject(new Error('Failed to capture tab'));
        return;
      }
      resolve(dataUrl);
    });
  });
}

/** Our own site: none of its pages shows a QR code to set an account up with. */
export function isOwnSite(hostname: string): boolean {
  return /(^|\.)authenticator\.sh$/.test(hostname);
}

/**
 * Whether "Scan the QR code on this page" is worth offering for the tab at
 * this address, as the popup reads it.
 *
 * No address means the popup was not opened by a click on its icon — the
 * welcome page opens it by itself — so there is no activeTab grant and the
 * capture would be refused. A chrome:// page or the new tab page has no QR
 * code on it, and neither has authenticator.sh, which is exactly where every
 * new install first opens the extension: the welcome page. Offering the scan
 * there sent people to "No QR code on this page" as their first result.
 */
export function pageWorthScanning(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== 'http:' && protocol !== 'https:') return false;
    return !isOwnSite(hostname);
  } catch {
    return false;
  }
}
