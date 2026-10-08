// Right-click → insert the code for this site, without opening the popup.
//
// The whole flow is driven from here because the service worker is the only
// context that exists at the moment the menu item is clicked: the popup is not
// open, and there is no content script to talk to. What runs in the page is
// quick-fill-page.ts, injected for this one invocation under the `activeTab`
// grant that the click itself provides — no host permission is involved, and
// nothing of ours stays behind in the page afterwards.

import type { Account } from '@/types';
import { getAccounts } from '@/utils/storage';
import { VaultLockedError } from '@/utils/vault';
import { getFillCandidate, hostnameOf, recordAccountUsage } from '@/utils/suggestions';
import { loadTimeOffset, tryGenerateTOTP } from '@/utils/totp';
import { checkTimeSync } from '@/utils/time-sync';
import { isQuickFillEnabled, noteFillRequest, notePickPrompt } from '@/utils/quick-fill';
import { getOpenMode } from '@/utils/open-mode';
import { openAppFor, openSidePanelInGesture } from './open-mode';
import { detectLanguage, matchLanguage, type Language } from '@/utils/language';
import { executeFill, injectFill as inject, MIN_REMAINING_SEC } from './quick-fill-inject';
import { workerT, type WorkerKey } from './strings';
import { reportCodeUsed } from '@/billing/onboarding';

export const MENU_ID = 'quick-fill';
export const COMMAND_ID = 'quick-fill';

type Translate = (key: WorkerKey, ...args: (string | number)[]) => string;

/**
 * The language the user picked in the popup, not the browser's.
 *
 * Not `loadLanguage`: its dynamic import is refused in a service worker, and
 * that refusal was the whole story of why the menu item and the in-page notices
 * stayed English in every language. The worker's own strings are bundled with
 * it instead (see strings.ts).
 */
async function translator(): Promise<Translate> {
  let language: Language = detectLanguage();
  try {
    const stored = (await chrome.storage.local.get('language')).language;
    if (stored) language = matchLanguage(String(stored));
  } catch {
    // Preference unreadable — the detected language is still better than none.
  }
  return workerT(language);
}

/**
 * One sync at a time.
 *
 * Install fires onInstalled and, with the first settings written, a storage
 * change or two — each a sync of its own, and each a removeAll followed some
 * awaits later by a create. Interleaved they ran removeAll, removeAll, create,
 * create: the second create failed with a duplicate id, or, with the toggle
 * switched off in between, the item created by the older run was left in the
 * menu after the newer one had decided there should be none. The same chain
 * as `applying` in open-mode.ts: each run starts once the last has finished,
 * and reads the preference afresh when it does.
 */
let syncing: Promise<void> = Promise.resolve();

/**
 * Create, update or remove the menu item to match the current preference.
 *
 * `removeAll` first because this also runs when the language changes, and a
 * title is only settable on an item that exists. Menu items outlive the
 * service worker, so this is not on any hot path — it runs on install, on
 * browser start, and when one of the two things it depends on changes.
 */
export function syncContextMenu(): Promise<void> {
  const next = syncing.then(syncContextMenuNow, syncContextMenuNow);
  syncing = next.catch(() => {});
  return next;
}

async function syncContextMenuNow(): Promise<void> {
  try {
    await chrome.contextMenus.removeAll();
    if (!(await isQuickFillEnabled())) return;

    const t = await translator();
    chrome.contextMenus.create({
      id: MENU_ID,
      title: t('quickFill.menu'),
      contexts: ['editable'],
      // Nothing to fill on chrome:// pages, the Web Store, or a local file, and
      // an item that cannot work is worse than no item. Patterns on a menu
      // entry are a display filter — they grant no access of their own.
      documentUrlPatterns: ['http://*/*', 'https://*/*'],
    });
  } catch (error) {
    console.error('Could not set up the quick-fill menu item', error);
  }
}

interface Invocation {
  tabId: number;
  windowId?: number;
  /** The frame the user right-clicked in; absent for the keyboard shortcut. */
  frameId?: number;
  /**
   * The address of the top-level page, not of the frame.
   *
   * A code field often lives in a third-party iframe — an SSO widget, a
   * checkout — and the account belongs to the site the user believes they are
   * on. Matching on the page also keeps this keyed the same way as the popup's
   * suggestion, so the two share one learned history instead of two.
   */
  pageUrl?: string;
}

/**
 * What the two listeners call, synchronously, before anything is awaited.
 *
 * In side panel mode a question for the user can only be put in the panel,
 * and the panel only opens inside the user action — which ends at the first
 * await, long before runQuickFill knows whether it has a question. Opening it
 * up front every time is not the answer: on the common path the code goes
 * straight into the field and nothing needs asking, and a panel sliding open
 * beside the form on every fill is noise at best — and at worst takes the
 * window focus that the clipboard fallback and the shortcut's frame detection
 * (`document.hasFocus()`) depend on. So it is opened early only when the hand-over is
 * already certain: a page with no address we can match against (the shortcut
 * pressed on a new tab or a chrome:// page) can never produce a candidate.
 * Every other hand-over still tries the panel late, and when Chrome refuses,
 * says on the page where to click instead.
 */
export function startQuickFill(invocation: Invocation): Promise<void> {
  const panel = hostnameOf(invocation.pageUrl)
    ? null
    : openSidePanelInGesture({ windowId: invocation.windowId, tabId: invocation.tabId });
  return runQuickFill(invocation, panel);
}

/**
 * @param panel The side panel opened inside the user action, when it was: its
 *   answer, or null when nothing was tried.
 */
export async function runQuickFill(invocation: Invocation, panel: Promise<boolean> | null = null): Promise<void> {
  const t = await translator();

  let accounts: Account[];
  try {
    accounts = await getAccounts();
  } catch (error) {
    if (error instanceof VaultLockedError) {
      // Nothing is readable until the password is entered, and that has to
      // happen in our own window rather than in the page. The fill is not
      // dropped: the window finishes it once it is unlocked.
      await handOver(invocation, t, panel, true);
      return;
    }
    console.error('Quick fill could not read the accounts', error);
    await handOver(invocation, t, panel);
    return;
  }

  const hostname = hostnameOf(invocation.pageUrl);
  const candidate = hostname ? await getFillCandidate(hostname, accounts) : null;
  const account = candidate ? accounts.find(acc => acc.id === candidate.accountId) : undefined;

  if (!account) {
    await handOver(invocation, t, panel);
    return;
  }

  // The stored correction alone is not enough. Quick fill never opened the
  // popup, so nothing here ever measured the clock: a correction taken before
  // the OS fixed it was filled into sign-in forms, as a confidently wrong code,
  // for as long as the record lived. checkTimeSync answers from the cache while
  // a measurement is recent — the common case, and free — and otherwise
  // measures, costing at most its fetch timeout; a measurement that fails
  // leaves the local clock in charge rather than an unvouched-for correction.
  await loadTimeOffset();
  await checkTimeSync().catch(() => {});
  let totp = tryGenerateTOTP(account);
  if (totp && totp.remaining <= MIN_REMAINING_SEC) {
    await new Promise<void>(resolve => setTimeout(resolve, totp!.remaining * 1000 + 250));
    totp = tryGenerateTOTP(account);
  }

  if (!totp) {
    // An unusable secret. The popup says so per account and offers the fix;
    // a toast in the page could only repeat it with less context.
    await handOver(invocation, t, panel);
    return;
  }

  const outcome = await inject(invocation, {
    code: totp.code,
    requireFocus: invocation.frameId === undefined,
    mayGuess: true,
    copiedText: t('quickFill.copied'),
    manualText: t('quickFill.manual', totp.code),
    noticeText: t('quickFill.openApp'),
  });

  if (!outcome) {
    await handOver(invocation, t, panel);
    return;
  }

  // Evidence about the site, because that is what it is: this account was
  // asked for on this page. Recorded for 'copied' too — whether the field
  // accepted the code says nothing about whether the account was the right one.
  if (hostname && outcome !== 'skipped') {
    await recordAccountUsage(hostname, account.id, 'site').catch(() => {});
  }
  if (outcome === 'filled' || outcome === 'copied') void reportCodeUsed(outcome === 'filled' ? 'fill' : 'copy');
}

/**
 * Hand the decision back to the user, in our own window.
 *
 * Everything that reaches here is a case where guessing would be worse than
 * asking: no account matches this site, several do, the vault is locked. The
 * popup already opens with the account for the current site pinned to the top,
 * so this is one click away from the same result.
 */
async function handOver(
  invocation: Invocation,
  t: Translate,
  panel: Promise<boolean> | null,
  locked = false
): Promise<void> {
  // Leave the question where the popup can find it: an account picked in the
  // next couple of minutes is an answer about this site, not the incidental
  // copy an ordinary popup visit produces. And leave where the code was wanted,
  // so the answer — or the unlock — can put it there instead of on the
  // clipboard for the user to paste.
  const hostname = hostnameOf(invocation.pageUrl);
  if (hostname) {
    await notePickPrompt(hostname);
    await noteFillRequest({ hostname, tabId: invocation.tabId, frameId: invocation.frameId, locked });
  }

  // Already open, from inside the gesture — the only place Chrome allows it.
  // A refusal there needs no second try out here, where it is certain.
  if (panel) {
    if (await panel) return;
  } else {
    // Wherever the icon would have opened the app is where the question goes.
    // With the popup unset, openPopup below has nothing to open.
    const mode = await getOpenMode();
    if (mode !== 'popup' && (await openAppFor(mode, { url: invocation.pageUrl, windowId: invocation.windowId }))) {
      return;
    }
  }

  try {
    // Chrome 127 and later. Older versions throw, and so does a window that
    // cannot host the popup.
    await chrome.action.openPopup(
      invocation.windowId === undefined ? undefined : { windowId: invocation.windowId }
    );
    return;
  } catch {
    // Fall through to telling the user where to go.
  }

  await executeFill(
    invocation.frameId !== undefined
      ? { tabId: invocation.tabId, frameIds: [invocation.frameId] }
      : { tabId: invocation.tabId },
    {
      code: null,
      requireFocus: false,
      mayGuess: false,
      copiedText: t('quickFill.openApp'),
      manualText: t('quickFill.openApp'),
      noticeText: t('quickFill.openApp'),
    }
  ).catch(() => null);
}
