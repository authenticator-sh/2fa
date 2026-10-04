import { useEffect, useRef } from 'react';
import type { Account } from '@/types';
import { FILL_REQUEST_KEY } from '@/utils/quick-fill';
import { finishLockedFill, type FillTranslate } from '@/utils/finish-quick-fill';
import { detectHost } from '@/utils/open-mode';
import { tryGenerateTOTP } from '@/utils/totp';
import { toast } from '@/utils/ui-feedback';

type Translate = FillTranslate & ((key: 'quickFill.inserted' | 'accounts.copyFailed') => string);

/**
 * Say the code went in, and get out of the way.
 *
 * The popup closes: it was opened for this one code, and the user's next move
 * is on the page — submitting the form it just filled. The side panel and the
 * floating window stay; they were open before this and are meant to be.
 */
export function announceFilled(t: Translate): void {
  toast('success', t('quickFill.inserted'));
  if (detectHost() === 'popup') setTimeout(() => window.close(), 900);
}

/**
 * The page had no field to take the code. This window has the focus the page
 * lacked, so the code goes on the clipboard from here — the same result the
 * user had before this existed, minus the click.
 */
async function copyInstead(account: Account, t: Translate): Promise<void> {
  const totp = tryGenerateTOTP(account);
  if (!totp) return;
  try {
    await navigator.clipboard.writeText(totp.code);
    toast('success', t('quickFill.copied'));
  } catch {
    toast('error', t('accounts.copyFailed'));
  }
}

/**
 * Finish a quick fill that stopped at the lock screen.
 *
 * Runs when the list becomes readable — the unlock the user came here for —
 * and again whenever quick fill leaves a new request while this window is
 * already unlocked. That second case is "password every time" with the side
 * panel open: the key lives only in the panel, so the service worker still
 * sees a locked vault and hands the fill over to a window that could have done
 * it on the spot. Now it does.
 */
export function useFinishQuickFill(accounts: Account[], ready: boolean, t: Translate): void {
  const accountsRef = useRef(accounts);
  accountsRef.current = accounts;
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    if (!ready) return;
    let running = false;

    const attempt = async () => {
      // One at a time within this window; takeFillRequest keeps windows apart.
      if (running) return;
      running = true;
      try {
        const result = await finishLockedFill(accountsRef.current, tRef.current);
        if (!result) return;
        if (result.outcome === 'filled') announceFilled(tRef.current);
        else if (result.outcome === 'missed') await copyInstead(result.account, tRef.current);
      } catch (error) {
        console.warn('Could not finish the quick fill', error);
      } finally {
        running = false;
      }
    };

    void attempt();

    if (!chrome.storage?.onChanged?.addListener) return;
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session' && changes[FILL_REQUEST_KEY]?.newValue) void attempt();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [ready]);
}
