// Background service worker for Authenticator extension
// Manifest V3 requires a service worker instead of background scripts

// Hosted rather than bundled so the copy can be updated without shipping a new
// extension version, and so the uninstall feedback survives the extension being
// gone by the time the page opens.
// www, not the apex: the apex only redirects here, and the uninstall URL in
// particular is handed to Chrome and opened after we are gone — a hop we do not
// need on the one page we get no second chance at.
const WELCOME_URL = 'https://www.authenticator.sh/welcome';
const UNINSTALL_FEEDBACK_URL = 'https://www.authenticator.sh/uninstall';

chrome.runtime.onInstalled.addListener((details) => {
  chrome.runtime.setUninstallURL(UNINSTALL_FEEDBACK_URL);

  if (details.reason === 'install') {
    chrome.tabs.create({ url: WELCOME_URL });
  } else if (details.reason === 'update') {
    // Unpacked extensions fire onInstalled('update') on every dev reload, even
    // without a version bump — only (re)arm the modal if this version hasn't
    // been acknowledged yet.
    const currentVersion = chrome.runtime.getManifest().version;
    chrome.storage.local.get('lastSeenWhatsNewVersion', (result) => {
      if (result.lastSeenWhatsNewVersion !== currentVersion) {
        chrome.storage.local.set({ pendingWhatsNew: currentVersion });
      }
    });
  }
});

export {};
