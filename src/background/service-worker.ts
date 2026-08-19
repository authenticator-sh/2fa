// Background service worker for Authenticator extension
// Manifest V3 requires a service worker instead of background scripts

import { COMMAND_ID, MENU_ID, runQuickFill, syncContextMenu } from './quick-fill';
import { QUICK_FILL_ENABLED_KEY } from '@/utils/quick-fill';

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
  void syncContextMenu();

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

// Menu items are stored by the browser and outlive the service worker, so this
// is not what keeps the item alive — it is what repairs it if the stored copy
// is ever lost, and what applies a language chosen on another device.
chrome.runtime.onStartup.addListener(() => {
  void syncContextMenu();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (QUICK_FILL_ENABLED_KEY in changes || 'language' in changes) void syncContextMenu();
});

// Both entry points grant `activeTab` for this one invocation, which is what
// makes reading the tab's address and injecting into it possible without any
// host permission.
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || tab?.id === undefined) return;
  void runQuickFill({
    tabId: tab.id,
    windowId: tab.windowId,
    frameId: info.frameId,
    pageUrl: info.pageUrl || tab.url,
  });
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== COMMAND_ID || tab?.id === undefined) return;
  // No frame to aim at here: the shortcut says nothing about where the caret
  // is, so every frame is asked and only the focused one answers.
  void runQuickFill({ tabId: tab.id, windowId: tab.windowId, pageUrl: tab.url });
});

export {};
