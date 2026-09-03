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
