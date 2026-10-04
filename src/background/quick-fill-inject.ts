// Running the page half of quick fill, from whichever of our contexts has the
// code.
//
// Usually that is the service worker, straight from the menu click. But a
// locked vault moves the fill to our own window — the password is typed there,
// and with "password every time" the key never leaves that page's memory — so
// the same injection runs from the popup or the side panel once it is unlocked.
// The `activeTab` grant the click gave belongs to the extension, not to the
// worker, and holds until the tab navigates.

import { quickFillInPage, type QuickFillOutcome, type QuickFillPageArgs } from './quick-fill-page';

/**
 * A code with less than this left is filled only after the next one arrives.
 *
 * Most servers accept the previous window, but not all do, and a form that
 * submits itself on the last digit gives the user no chance to notice. Waiting
 * out the last two seconds costs a pause; not waiting costs a rejected sign-in
 * that looks exactly like the extension generating wrong codes — the single
 * most common complaint about every authenticator there is.
 */
export const MIN_REMAINING_SEC = 2;

/** Where a fill was asked for: the tab, and the frame when the menu named one. */
export interface FillTarget {
  tabId: number;
  /** The frame the user right-clicked in; absent for the keyboard shortcut. */
  frameId?: number;
}

/** Runs the page half, returning null when the tab could not be reached. */
export async function injectFill(target: FillTarget, args: QuickFillPageArgs): Promise<QuickFillOutcome | null> {
  const where: chrome.scripting.InjectionTarget =
    target.frameId !== undefined
      ? { tabId: target.tabId, frameIds: [target.frameId] }
      : { tabId: target.tabId, allFrames: true };

  let outcome = await executeFill(where, args);

  // Two ways to end up with nothing. A frame we were not allowed into — the
  // `activeTab` grant does not reach every cross-origin frame — leaves an
  // error, and the top frame is the next best place to answer. All frames
  // reporting 'skipped' means the caret is not in the page at all (the
  // shortcut pressed from the address bar, say), and one of them should still
  // put the code on the clipboard.
  //
  // The top frame answers for the frame, not for itself: the user pointed at a
  // field it cannot see, and a code-looking field of its own — a second sign-in
  // form, a page-level "enter code" box — is precisely the wrong place. So it
  // may not guess; with its focus on the frame element, that leaves the
  // clipboard. Requiring focus instead would not do: the top document has it
  // whenever the caret is in a child frame, and stands aside for that frame,
  // which is the one we could not reach — nobody would answer at all.
  if (outcome === null && target.frameId !== undefined) {
    outcome = await executeFill({ tabId: target.tabId }, { ...args, mayGuess: false });
  } else if (outcome === 'skipped') {
    outcome = await executeFill({ tabId: target.tabId }, { ...args, requireFocus: false });
  }

  return outcome;
}

export async function executeFill(
  target: chrome.scripting.InjectionTarget,
  args: QuickFillPageArgs
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
