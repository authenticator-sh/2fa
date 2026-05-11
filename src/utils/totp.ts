import * as OTPAuth from 'otpauth';
import type { Account, TOTPCode } from '@/types';

export function generateTOTP(account: Account): TOTPCode {
  const totp = new OTPAuth.TOTP({
    issuer: account.issuer,
    label: account.name,
    algorithm: account.algorithm,
    digits: account.digits,
    period: account.period,
    secret: account.secret,
  });

  const code = totp.generate();
  const now = Math.floor(Date.now() / 1000);
  const remaining = account.period - (now % account.period);

  return {
    code,
    remaining,
    period: account.period,
  };
}

export function validateSecret(secret: string): boolean {
  try {
    // Base32 validation
    const base32Regex = /^[A-Z2-7]+=*$/;
    const cleanSecret = secret.replace(/\s/g, '').toUpperCase();
    return base32Regex.test(cleanSecret) && cleanSecret.length >= 16;
  } catch {
    return false;
  }
}

export function cleanSecret(secret: string): string {
  return secret.replace(/\s/g, '').toUpperCase();
}
