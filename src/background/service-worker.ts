// Background service worker for Authenticator extension
// Manifest V3 requires a service worker instead of background scripts

import { COMMAND_ID, MENU_ID, startQuickFill, syncContextMenu } from './quick-fill';
import { applyOpenMode, registerOpenMode } from './open-mode';
import { QUICK_FILL_ENABLED_KEY } from '@/utils/quick-fill';
import { restoreBadge, showUpdateBadge } from '@/utils/update-badge';
import {
  BILLING_SYNC_KEYS,
  ensureInstall,
  legacySourceOfMarker,
  markLegacy,
  syncedAccountsPredateBilling,
  touchesSyncedAccounts,
  type InstallHint,
} from '@/billing/state';
import { isSyncRequestMessage, syncBilling } from '@/billing/sync';
import { applyUninstallUrl, markInstalled, UNINSTALL_FEEDBACK_URL } from '@/billing/onboarding';
import type { LegacySource } from '@/billing/types';
import { isSyncEnabled } from '@/utils/sync-preference';

// Hosted rather than bundled so the copy can be updated without shipping a new
// extension version, and so the uninstall feedback survives the extension being
// gone by the time the page opens.
// www, not the apex: the apex only redirects here, and the uninstall URL in
// particular is handed to Chrome and opened after we are gone — a hop we do not
// need on the one page we get no second chance at.
const WELCOME_URL = 'https://www.authenticator.sh/welcome';

/**
 * Records the install — fresh, or updated from a version that predates
 * billing, which is what makes it legacy — and checks in with the server.
 * Nothing here can delay or block the extension itself.
 */
async function setUpBilling(hint: InstallHint): Promise<void> {
  try {
    const install = await ensureInstall(hint);
    // The install id rides on the uninstall address, so the survey answer can
    // be joined to the install it is about (MONETIZATION.md §3.8), and with it
    // how far the install got towards a first account (billing/onboarding.ts).
    // Set whenever the worker learns the id; Chrome keeps the last one given.
    if (hint.reason === 'install' && !install.legacy) await markInstalled();
    await applyUninstallUrl(install.id);
    await syncBilling({ force: hint.reason !== 'other' });
  } catch (error) {
    console.warn('billing: setup failed', error);
  }
}

/**
 * The welcome page, with the install id on it, so an install that came from
 * one of our ads is joined to that install (the site's /api/i → the API's
 * ad_installs) — and with it to whether it got going and what it paid. The
 * site forwards the id only for a browser that came through an ad link;
 * otherwise it goes nowhere. If the id cannot be had, the page opens without it.
 */
async function openWelcome(): Promise<void> {
  let url = WELCOME_URL;
  try {
    const install = await ensureInstall({ reason: 'install' });
    if (!install.legacy) url = `${WELCOME_URL}?iid=${encodeURIComponent(install.id)}`;
  } catch {}
  await chrome.tabs.create({ url }).catch(error => console.warn('could not open the welcome page', error));
}

chrome.runtime.onInstalled.addListener((details) => {
  chrome.runtime.setUninstallURL(UNINSTALL_FEEDBACK_URL);
  void setUpBilling({
    reason: details.reason === 'install' ? 'install' : details.reason === 'update' ? 'update' : 'other',
    previousVersion: details.previousVersion,
  });
  void syncContextMenu();
  void applyOpenMode();

  if (details.reason === 'install') {
    void openWelcome();
  } else if (details.reason === 'update') {
    // Unpacked extensions fire onInstalled('update') on every dev reload, even
    // without a version bump — only (re)arm the modal if this version hasn't
    // been acknowledged yet.
    const currentVersion = chrome.runtime.getManifest().version;
    chrome.storage.local.get('lastSeenWhatsNewVersion', (result) => {
      if (result.lastSeenWhatsNewVersion !== currentVersion) {
        chrome.storage.local.set({ pendingWhatsNew: currentVersion });
        showUpdateBadge(currentVersion).catch(() => {});
      }
    });
  }

});

// Menu items are stored by the browser and outlive the service worker, so this
// is not what keeps the item alive — it is what repairs it if the stored copy
// is ever lost, and what applies a language chosen on another device.
chrome.runtime.onStartup.addListener(() => {
  void syncContextMenu();
  void applyOpenMode();
  restoreBadge().catch(() => {});
  void setUpBilling({ reason: 'other' });
});

/**
 * A person who predates the paywall, arriving through Chrome sync from another
 * computer — often after this install already checked in as new: the marker
 * an updated install left there, or the accounts an old one that never got
 * 1.14 did (MONETIZATION.md §3.1). Legacy only turns on, and the server hears
 * of it at once. Only while sync is on here: with it off this install does not
 * act on what sync carries.
 */
async function adoptLegacyFromSync(marker: LegacySource | null): Promise<void> {
  if (!(await isSyncEnabled())) return;
  // Waits out an install record still being created by onInstalled, which may
  // have read sync a moment before the data arrived.
  const install = await ensureInstall();
  if (install.legacy) return;
  const source = marker ?? ((await syncedAccountsPredateBilling(install.createdAt)) ? 'sync-accounts' : null);
  if (!source) return;
  await markLegacy(source);
  await syncBilling({ force: true, urgent: true });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') {
    const marker = legacySourceOfMarker(changes[BILLING_SYNC_KEYS.legacy]?.newValue);
    if (marker || touchesSyncedAccounts(changes)) void adoptLegacyFromSync(marker).catch(() => {});
    return;
  }
  if (area !== 'local') return;
  if (QUICK_FILL_ENABLED_KEY in changes || 'language' in changes) void syncContextMenu();
  // Paywall text written on the server comes in one language; a switch asks for the new one.
  if ('language' in changes) void syncBilling({ force: true });
});

// A page about to be closed — the popup, as Checkout's tab takes focus — asks
// the worker to send the billing events of that visit (billing/sync.ts
// syncFromWorker). Only from the extension's own pages: a content script has
// no business starting a check-in.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isSyncRequestMessage(message)) return;
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return;
  sendResponse(true);
  // Urgent: the page asks at the paywall's open and again at Checkout, often
  // within seconds; the spacing between forced syncs would drop the second,
  // and with it the close and checkout events of the visit.
  void syncBilling({ force: true, urgent: true });
});

// The "Open as" setting: popup, floating window or side panel. Its listeners
// are registered at the top level like everything else here, so they survive
// the worker being evicted and restarted.
// On every worker start, not only on install and startup: disabling and
// re-enabling the extension resets the action to the manifest's popup and the
// panel behaviour to off, while storage still holds the chosen mode — and
// neither of those events fires, so the icon quietly went back to a popup
// until the next browser restart.
void applyOpenMode();
registerOpenMode();

// Both entry points grant `activeTab` for this one invocation, which is what
// makes reading the tab's address and injecting into it possible without any
// host permission. Both are synchronous up to startQuickFill: it may have to
// open the side panel, and Chrome only allows that before the first await.
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || tab?.id === undefined) return;
  void startQuickFill({
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
  //
  // Not gated on the "Right-click to insert a code" setting. That one promises
  // exactly what it says — an item in the right-click menu, described as such
  // in every language — and people switch it off to keep a crowded menu tidy,
  // not to lose a shortcut they pressed on purpose. The shortcut has its own
  // off switch, chrome://extensions/shortcuts, where Chrome lists it under the
  // extension's name.
  void startQuickFill({ tabId: tab.id, windowId: tab.windowId, pageUrl: tab.url });
});

export {};
