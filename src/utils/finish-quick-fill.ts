// The last step of a quick fill that had to go through our own window.
//
// Quick fill hands over to the popup (or the side panel, or the floating
// window) when it cannot act alone: the vault is locked, or the site does not
// name exactly one account. The user then unlocks or picks — and used to be
// left to copy the code and paste it into the field they had right-clicked a
// moment earlier. The service worker left a note of where that field was
// (FillRequest); this finishes the job from the window, which is the context
// that now holds the accounts, and with "password every time" the only one
// holding the key at all.

import type { Account } from '@/types';
import { injectFill, MIN_REMAINING_SEC } from '@/background/quick-fill-inject';
import type { QuickFillOutcome } from '@/background/quick-fill-page';
import { readFillRequest, takeFillRequest, type FillRequest } from './quick-fill';
import { getFillCandidate, hostnameOf, recordAccountUsage } from './suggestions';
import { tryGenerateTOTP, whenTimeOffsetSettled } from './totp';

type FillKey = 'quickFill.copied' | 'quickFill.manual' | 'quickFill.openApp';
export type FillTranslate = (key: FillKey, ...args: (string | number)[]) => string;

/**
 * Is the tab still showing the site the fill was asked for?
 *
 * Checked here and not left to the grant alone. A navigation revokes
 * `activeTab`, but a single-page app can move from its sign-in form to anything
 * else without one, and a code typed into whatever field has the caret by then
 * is a code in the wrong place. A tab we can no longer read — closed, or its
 * grant gone — counts as moved on.
 */
async function stillOnSite(request: FillRequest): Promise<boolean> {
  try {
    const tab = await chrome.tabs.get(request.tabId);
    return hostnameOf(tab.url) === request.hostname;
  } catch {
    return false;
  }
}

/**
 * Put this account's current code where the request says.
 *
 * Null when nothing was attempted: the tab is gone or elsewhere, or the secret
 * cannot produce a code. 'missed' when the page had no field to take it — the
 * caller copies it instead, which this window, unlike the page, has the focus
 * to do.
 */
export async function fillRequested(
  request: FillRequest,
  account: Account,
  t: FillTranslate
): Promise<QuickFillOutcome | null> {
  if (!(await stillOnSite(request))) return null;

  // Not the stored correction as-is: an unlock can come minutes after the page
  // opened, and a code from a clock still being measured is the confidently
  // wrong kind (see whenTimeOffsetSettled).
  await whenTimeOffsetSettled();
  let totp = tryGenerateTOTP(account);
  if (totp && totp.remaining <= MIN_REMAINING_SEC) {
    const remaining = totp.remaining;
    await new Promise<void>(resolve => setTimeout(resolve, remaining * 1000 + 250));
    totp = tryGenerateTOTP(account);
  }
  if (!totp) return null;

  return injectFill(
    { tabId: request.tabId, frameId: request.frameId },
    {
      code: totp.code,
      requireFocus: request.frameId === undefined,
      caretOnly: true,
      mayGuess: true,
      clipboard: false,
      copiedText: t('quickFill.copied'),
      manualText: t('quickFill.manual', totp.code),
      noticeText: t('quickFill.openApp'),
    }
  );
}

export interface FinishedFill {
  account: Account;
  outcome: QuickFillOutcome | null;
}

/**
 * After an unlock: finish the fill the lock interrupted.
 *
 * Only when the site names one account — the rule quick fill applies when the
 * vault is open, so unlocking first changes nothing about which code goes in.
 * Anything less certain is left open for the user's pick, which
 * `finishPickedFill` then completes.
 */
export async function finishLockedFill(accounts: Account[], t: FillTranslate): Promise<FinishedFill | null> {
  const pending = await readFillRequest();
  if (!pending?.locked) return null;

  const candidate = await getFillCandidate(pending.hostname, accounts);
  const account = candidate ? accounts.find(acc => acc.id === candidate.accountId) : undefined;
  if (!account) return null;

  // Claimed only now that there is something to do with it, and only the one
  // decided on: another window may have taken it, or quick fill replaced it.
  const request = await takeFillRequest(pending.at);
  if (!request) return null;

  const outcome = await fillRequested(request, account, t);
  if (outcome === 'filled') {
    await recordAccountUsage(request.hostname, account.id, 'site').catch(() => {});
  }
  return { account, outcome };
}

/**
 * After a pick: put the picked account's code where quick fill wanted it.
 *
 * Called once the code is already on the clipboard, so a miss costs nothing —
 * the user pastes, exactly as before. The usage record is the copy handler's,
 * which already credits a pick that answered quick fill's question.
 */
export async function finishPickedFill(account: Account, t: FillTranslate): Promise<QuickFillOutcome | null> {
  const request = await takeFillRequest();
  if (!request) return null;
  return fillRequested(request, account, t);
}
