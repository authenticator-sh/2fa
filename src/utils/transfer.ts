// Moving accounts to another authenticator by QR.

import type { Account } from '../types';
import { parseAlgorithm } from './qr-parser';
import { isSteamAccount, totpParams } from './totp';

export type NonStandardParam =
  | { kind: 'period'; value: number }
  | { kind: 'digits'; value: number }
  | { kind: 'algorithm'; value: string };

/**
 * The settings other apps may ignore (Google Authenticator shows wrong codes
 * rather than refusing). Read through totpParams so a damaged record counts as
 * the defaults it is actually generated with. Steam is its own scheme, not a
 * deviation.
 */
export function nonStandardParams(account: Account): NonStandardParam[] {
  if (isSteamAccount(account)) return [];
  const { period, digits } = totpParams(account);
  const out: NonStandardParam[] = [];
  if (period !== 30) out.push({ kind: 'period', value: period });
  if (digits !== 6) out.push({ kind: 'digits', value: digits });
  // The way the QR spells it, so a missing or odd-cased value is not a false alarm.
  const algorithm = parseAlgorithm(account.algorithm ?? null);
  if (algorithm !== 'SHA1') out.push({ kind: 'algorithm', value: algorithm });
  return out;
}
