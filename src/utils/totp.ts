import * as OTPAuth from 'otpauth';
import type { Account, TOTPCode } from '@/types';

const OFFSET_STORAGE_KEY = 'timeOffsetMs';

// Signed correction (ms) between the device clock and true UTC. Applied to code
// generation so codes stay valid even when the system clock drifts. It is only
// ever set from a HIGH-CONFIDENCE time-sync measurement (see time-sync.ts).
// When we're not sure, it stays 0 — meaning "trust the local clock", which is
// the safe default and matches the historical behavior.
let timeOffsetMs = 0;

export function setTimeOffsetMs(ms: number): void {
  timeOffsetMs = Number.isFinite(ms) ? ms : 0;
}

export function getTimeOffsetMs(): number {
  return timeOffsetMs;
}

// Load a persisted correction so codes are already adjusted on the very first
// render, before the async network re-check finishes.
export async function loadTimeOffset(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(OFFSET_STORAGE_KEY);
    const ms = stored[OFFSET_STORAGE_KEY];
    if (typeof ms === 'number' && Number.isFinite(ms)) {
      timeOffsetMs = ms;
    }
  } catch {
    // best-effort — fall back to the local clock
  }
}

export function generateTOTP(account: Account): TOTPCode {
  const totp = new OTPAuth.TOTP({
    issuer: account.issuer,
    label: account.name,
    algorithm: account.algorithm,
    digits: account.digits,
    period: account.period,
    secret: account.secret,
  });

  const correctedMs = Date.now() + timeOffsetMs;
  const code = totp.generate({ timestamp: correctedMs });
  const nowSec = Math.floor(correctedMs / 1000);
  const remaining = account.period - (nowSec % account.period);

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
