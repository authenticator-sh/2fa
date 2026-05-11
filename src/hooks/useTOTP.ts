import { useState, useEffect } from 'react';
import type { Account, TOTPCode } from '@/types';
import { generateTOTP } from '@/utils/totp';

export function useTOTP(account: Account) {
  const [totp, setTotp] = useState<TOTPCode>(() => generateTOTP(account));

  useEffect(() => {
    const updateCode = () => {
      setTotp(generateTOTP(account));
    };

    // Update immediately
    updateCode();

    // Update every second
    const interval = setInterval(updateCode, 1000);

    return () => clearInterval(interval);
  }, [account]);

  return totp;
}
