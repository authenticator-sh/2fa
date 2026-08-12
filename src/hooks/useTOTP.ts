import { useState, useEffect } from 'react';
import type { Account, TOTPCode } from '@/types';
import { tryGenerateTOTP } from '@/utils/totp';

/**
 * Returns null when the account's secret cannot produce a code.
 *
 * The generation happens in a `useState` initialiser — during render — so this
 * hook is the one place a throw is unrecoverable: React unwinds past every card
 * to the root boundary and the user loses sight of all their accounts, on every
 * open, until the offending record is removed by some other means. Reporting the
 * failure as a value keeps it contained to the row that owns it.
 */
export function useTOTP(account: Account): TOTPCode | null {
  const [totp, setTotp] = useState<TOTPCode | null>(() => tryGenerateTOTP(account));

  useEffect(() => {
    const updateCode = () => {
      setTotp(tryGenerateTOTP(account));
    };

    // Update immediately
    updateCode();

    // Update every second
    const interval = setInterval(updateCode, 1000);

    return () => clearInterval(interval);
  }, [account]);

  return totp;
}
