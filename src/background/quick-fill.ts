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
import { getFillCandidate, recordAccountUsage } from '@/utils/suggestions';
import { loadTimeOffset, tryGenerateTOTP } from '@/utils/totp';
import { isQuickFillEnabled, notePickPrompt } from '@/utils/quick-fill';
import {
  createT,
  detectLanguage,
  loadLanguage,
  matchLanguage,
  type Language,
  type TranslationKey,
} from '@/utils/i18n';
import { quickFillInPage, type QuickFillOutcome } from './quick-fill-page';

export const MENU_ID = 'quick-fill';
export const COMMAND_ID = 'quick-fill';

/**
 * A code with less than this left is filled only after the next one arrives.
 *
 * Most servers accept the previous window, but not all do, and a form that
 * submits itself on the last digit gives the user no chance to notice. Waiting
 * out the last two seconds costs a pause; not waiting costs a rejected sign-in
 * that looks exactly like the extension generating wrong codes — the single
 * most common complaint about every authenticator there is.
 */
const MIN_REMAINING_SEC = 2;

type Translate = (key: TranslationKey, ...args: (string | number)[]) => string;

/**
 * The language the user picked in the popup, not the browser's.
 *
 * `loadLanguage` pulls its table in with a dynamic import, which is how the
 * popup avoids parsing twenty languages to show one. If that import is ever
 * refused in a service worker, it fails soft: the English table is compiled in
 * statically and stays active, so the worst outcome is an English menu item,
 * never a missing one.
 */
async function translator(): Promise<Translate> {
  let language: Language = detectLanguage();
  try {
    const stored = (await chrome.storage.local.get('language')).language;
    if (stored) language = matchLanguage(String(stored));
  } catch {
    // Preference unreadable — the detected language is still better than none.
  }
  await loadLanguage(language);
  return createT(language);
}

/**
 * Create, update or remove the menu item to match the current preference.
 *
 * `removeAll` first because this also runs when the language changes, and a
 * title is only settable on an item that exists. Menu items outlive the
 * service worker, so this is not on any hot path — it runs on install, on
 * browser start, and when one of the two things it depends on changes.
 */
export async function syncContextMenu(): Promise<void> {
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

export async function runQuickFill(invocation: Invocation): Promise<void> {
  const t = await translator();

  let accounts: Account[];
  try {
    accounts = await getAccounts();
  } catch (error) {
    if (error instanceof VaultLockedError) {
      // Nothing is readable until the password is entered, and that has to
      // happen in our own window rather than in the page.
      await handOver(invocation, t);
      return;
    }
    console.error('Quick fill could not read the accounts', error);
    await handOver(invocation, t);
    return;
  }

  const hostname = hostnameOf(invocation.pageUrl);
  const candidate = hostname ? await getFillCandidate(hostname, accounts) : null;
  const account = candidate ? accounts.find(acc => acc.id === candidate.accountId) : undefined;

  if (!account) {
    await handOver(invocation, t);
    return;
  }

  await loadTimeOffset();
  let totp = tryGenerateTOTP(account);
  if (totp && totp.remaining <= MIN_REMAINING_SEC) {
    await new Promise<void>(resolve => setTimeout(resolve, totp!.remaining * 1000 + 250));
    totp = tryGenerateTOTP(account);
  }

  if (!totp) {
    // An unusable secret. The popup says so per account and offers the fix;
    // a toast in the page could only repeat it with less context.
    await handOver(invocation, t);
    return;
  }

  const outcome = await inject(invocation, {
    code: totp.code,
    requireFocus: invocation.frameId === undefined,
    copiedText: t('quickFill.copied'),
    manualText: t('quickFill.manual', totp.code),
    noticeText: t('quickFill.openApp'),
  });

  if (!outcome) {
    await handOver(invocation, t);
    return;
  }

  // Evidence about the site, because that is what it is: this account was
  // asked for on this page. Recorded for 'copied' too — whether the field
  // accepted the code says nothing about whether the account was the right one.
  if (hostname && outcome !== 'skipped') {
    await recordAccountUsage(hostname, account.id, 'site').catch(() => {});
  }
}

/** Runs the page half, returning null when the tab could not be reached. */
async function inject(
  invocation: Invocation,
  args: Parameters<typeof quickFillInPage>[0]
): Promise<QuickFillOutcome | null> {
  const target: chrome.scripting.InjectionTarget =
    invocation.frameId !== undefined
      ? { tabId: invocation.tabId, frameIds: [invocation.frameId] }
      : { tabId: invocation.tabId, allFrames: true };

  let outcome = await execute(target, args);

  // Two ways to end up with nothing. A frame we were not allowed into — the
  // `activeTab` grant does not reach every cross-origin frame — leaves an
  // error, and the top frame is the next best place to answer. All frames
  // reporting 'skipped' means the caret is not in the page at all (the
  // shortcut pressed from the address bar, say), and one of them should still
  // put the code on the clipboard.
  if (outcome === null && invocation.frameId !== undefined) {
    outcome = await execute({ tabId: invocation.tabId }, args);
  } else if (outcome === 'skipped') {
    outcome = await execute({ tabId: invocation.tabId }, { ...args, requireFocus: false });
  }

  return outcome;
}

async function execute(
  target: chrome.scripting.InjectionTarget,
  args: Parameters<typeof quickFillInPage>[0]
): Promise<QuickFillOutcome | null> {
  try {
    const results = await chrome.scripting.executeScript({
      target,
      func: quickFillInPage,
      args: [args],
    });

    const answers = results
      .map(result => result.result as QuickFillOutcome | undefined)
      .filter((value): value is QuickFillOutcome => !!value);

    // With allFrames every frame answers; the one that acted is the only one
    // that did not skip.
    return answers.find(value => value !== 'skipped') ?? answers[0] ?? null;
  } catch (error) {
    console.warn('Quick fill could not run in the page', error);
    return null;
  }
}

/**
 * Hand the decision back to the user, in our own window.
 *
 * Everything that reaches here is a case where guessing would be worse than
 * asking: no account matches this site, several do, the vault is locked. The
 * popup already opens with the account for the current site pinned to the top,
 * so this is one click away from the same result.
 */
async function handOver(invocation: Invocation, t: Translate): Promise<void> {
  // Leave the question where the popup can find it: an account picked in the
  // next couple of minutes is an answer about this site, not the incidental
  // copy an ordinary popup visit produces.
  const hostname = hostnameOf(invocation.pageUrl);
  if (hostname) await notePickPrompt(hostname);

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

  await execute(
    invocation.frameId !== undefined
      ? { tabId: invocation.tabId, frameIds: [invocation.frameId] }
      : { tabId: invocation.tabId },
    {
      code: null,
      requireFocus: false,
      copiedText: t('quickFill.openApp'),
      manualText: t('quickFill.openApp'),
      noticeText: t('quickFill.openApp'),
    }
  ).catch(() => null);
}

function hostnameOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.hostname : null;
  } catch {
    return null;
  }
}
