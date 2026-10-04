import { useEffect, useRef, useState } from 'react';
import { pushEscapeLayer } from '@/utils/escape-layers';

/**
 * Escape closes this layer — and only this one, while it is the topmost.
 *
 * The layer takes its place when it opens and keeps it: the handler is read
 * through a ref, so a new closure on every render does not move it back to the
 * top of the stack over a dialog opened after it.
 */
export function useEscapeLayer(onEscape: () => void, active = true): void {
  const handler = useRef(onEscape);
  handler.current = onEscape;

  useEffect(() => {
    if (!active) return;
    return pushEscapeLayer(() => handler.current());
  }, [active]);
}

/**
 * Put focus back on whatever opened this view, once it closes.
 *
 * Without it, closing Add account, Edit or the export window dropped focus on
 * <body>: a keyboard user was sent back to the top of the page, and a screen
 * reader started reading the popup again from its title.
 *
 * The element is read while the view first renders — before the commit, where
 * an `autoFocus` inside the view would already have moved focus into it. It is
 * only refocused if it is still in the page — a delete button whose row went
 * with the account is not — and not while it sits under `inert`, which the
 * popup lifts in the same render that closes the view.
 */
export function useReturnFocus(): void {
  const [opener] = useState(() =>
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null)
  );

  useEffect(() => {
    return () => {
      if (!opener || opener === document.body) return;
      const restore = () => {
        if (opener.isConnected && !opener.closest('[inert]')) opener.focus();
      };
      if (opener.closest('[inert]')) setTimeout(restore, 0);
      else restore();
    };
  }, [opener]);
}
