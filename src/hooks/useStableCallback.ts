import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * A function whose identity never changes but which always runs the latest
 * version of `fn`.
 *
 * For handlers passed to a memoised row. The popup's handlers read state that
 * changes on every render — the account list, the language, the functions
 * useAccounts hands back fresh each time — so a plain useCallback with honest
 * dependencies would still produce a new function almost every render, and
 * every AccountCard would redraw on every keystroke in the search box.
 *
 * Only for event handlers: calling the result during render would run the
 * previous render's closure.
 */
export function useStableCallback<Args extends unknown[], Result>(
  fn: (...args: Args) => Result
): (...args: Args) => Result {
  const latest = useRef(fn);
  useLayoutEffect(() => {
    latest.current = fn;
  });
  return useCallback((...args: Args) => latest.current(...args), []);
}
