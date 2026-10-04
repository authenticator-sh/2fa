import { useState, useEffect } from 'react';
import type { Account, TOTPCode } from '@/types';
import { advanceTOTP, isTimeOffsetPending, subscribeTimeOffset, type LiveTOTP } from '@/utils/totp';
import { onEverySecond } from '@/utils/ticker';

/**
 * Returns null when the account's secret cannot produce a code.
 *
 * The generation happens in a `useState` initialiser — during render — so this
 * hook is the one place a throw is unrecoverable: React unwinds past every card
 * to the root boundary and the user loses sight of all their accounts, on every
 * open, until the offending record is removed by some other means. Reporting the
 * failure as a value keeps it contained to the row that owns it.
 *
 * Driven by the page's one shared tick (see ticker.ts), and cheap on all but
 * one tick in thirty: advanceTOTP hands back the same state when only the
 * countdown moved, and runs the HMAC only when the slot changes.
 */
export function useTOTP(account: Account): TOTPCode | null {
  const [live, setLive] = useState<LiveTOTP>(() => advanceTOTP(account, null));

  useEffect(() => {
    const update = () => setLive((previous) => advanceTOTP(account, previous));
    // At once, not at the next tick: the account may have been edited since
    // the state above was made for it.
    update();
    return onEverySecond(update);
  }, [account]);

  // An edit lands here one render before the effect above catches up. The code
  // on screen in that render must be the new account's, not the old one's.
  return live.account === account ? live.totp : advanceTOTP(account, live).totp;
}

/**
 * Whether a lapsed clock correction is being measured again right now — the
 * second or so in which codes are shown as "checking" rather than drawn from a
 * clock that needed correcting a few minutes ago. See isTimeOffsetPending.
 */
export function useCheckingTime(): boolean {
  const [checking, setChecking] = useState(isTimeOffsetPending);

  useEffect(() => {
    setChecking(isTimeOffsetPending());
    return subscribeTimeOffset(() => setChecking(isTimeOffsetPending()));
  }, []);

  return checking;
}
