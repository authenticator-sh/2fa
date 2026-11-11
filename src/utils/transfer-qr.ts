// Moving accounts to a phone by QR code: the computer shows, the phone scans.
//
// The codes are Google Authenticator's own export format,
// otpauth-migration://offline?data=<MigrationPayload, protobuf, base64>, so
// the phone can be our iOS app, Google Authenticator, or nearly any other
// authenticator: they all read it, because it is how Google Authenticator moves
// accounts between phones. migration-parser.ts is the same format read from the
// other end, and the tests hold the two to `parse(build(a)) == a`.
//
// What the format cannot say goes in a code of its own, as an otpauth:// link:
// a period other than 30 seconds (the format has no field for it, and every
// reader assumes 30), a code length other than 6 or 8, and Steam Guard. Better
// one more code to scan than an account that arrives generating the wrong
// digits.
//
// Never log what this returns: every code carries secrets.

import * as OTPAuth from 'otpauth';
import type { Account } from '@/types';
import { buildOTPAuthURL, readAlgorithm } from './qr-parser';
import { cleanSecret, isSteamAccount, isUsableSecret, totpParams } from './totp';

/** Google Authenticator's own cap, and what readers expect a code to hold. */
export const MAX_ACCOUNTS_PER_CODE = 10;

/**
 * How long a code's text may grow before the next account starts a new code.
 *
 * Ten ordinary accounts (a 20-byte key, a name and an issuer) come to about
 * 850 characters, version 22–23 at level L: around 105 modules a side, which a
 * phone reads off a laptop screen at the size the window draws it. Ten with
 * long names come to well over a kilobyte, and a code that dense is where
 * scanning off a monitor starts to fail — so those are split earlier.
 */
export const MAX_CODE_TEXT = 900;

export interface TransferCode {
  /** What the QR code says. Carries secrets. */
  text: string;
  /** `migration`: the batch format; `single`: one account as an otpauth:// link. */
  kind: 'migration' | 'single';
  /** In the order they are in the code. */
  accounts: Account[];
}

export interface TransferPlan {
  codes: TransferCode[];
  /** Accounts whose secret cannot be read: left out, and said so on screen. */
  skipped: Account[];
}

const ALGORITHM_ENUM = { SHA1: 1, SHA256: 2, SHA512: 3 } as const;
const DIGITS_ENUM: Record<number, number> = { 6: 1, 8: 2 };
const TYPE_TOTP = 2;

/** Whether an account can go into a migration batch without losing anything. */
function fitsMigration(account: Account): boolean {
  if (isSteamAccount(account)) return false;
  const { period, digits } = totpParams(account);
  return period === 30 && digits in DIGITS_ENUM;
}

// ---- protobuf, the four wire shapes the format uses ------------------------

function varint(value: number): number[] {
  const out: number[] = [];
  let v = Math.floor(value);
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
  return out;
}

function tag(field: number, wireType: number): number[] {
  return varint(field * 8 + wireType);
}

function bytesField(field: number, data: Uint8Array): number[] {
  return [...tag(field, 2), ...varint(data.length), ...data];
}

function varintField(field: number, value: number): number[] {
  return [...tag(field, 0), ...varint(value)];
}

const utf8 = new TextEncoder();

/** One OtpParameters message. */
function otpParameters(account: Account): number[] {
  const issuer = String(account.issuer ?? '').trim();
  let name = String(account.name ?? '').trim();
  // Readers split a name with no issuer at its first colon (ours does, in
  // splitLabel): "a:b@x.com" with no issuer would come back as issuer "a". A
  // leading colon keeps the split where it belongs.
  if (!issuer && name.includes(':')) name = `:${name}`;
  const algorithm = readAlgorithm(account.algorithm) ?? 'SHA1';
  return [
    ...bytesField(1, OTPAuth.Secret.fromBase32(cleanSecret(account.secret)).bytes),
    ...bytesField(2, utf8.encode(name)),
    ...bytesField(3, utf8.encode(issuer)),
    ...varintField(4, ALGORITHM_ENUM[algorithm]),
    ...varintField(5, DIGITS_ENUM[totpParams(account).digits]),
    ...varintField(6, TYPE_TOTP),
  ];
}

function migrationText(entries: number[][], batchSize: number, batchIndex: number, batchId: number): string {
  const payload: number[] = [];
  for (const entry of entries) payload.push(...tag(1, 2), ...varint(entry.length), ...entry);
  payload.push(...varintField(2, 1)); // version
  payload.push(...varintField(3, batchSize));
  payload.push(...varintField(4, batchIndex));
  payload.push(...varintField(5, batchId));
  let binary = '';
  for (const byte of payload) binary += String.fromCharCode(byte);
  return `otpauth-migration://offline?data=${encodeURIComponent(btoa(binary))}`;
}

/**
 * The accounts as a run of QR codes, in the order given.
 *
 * Batches first, then the accounts that need a code of their own, so the long
 * run of scanning comes first and the odd ones are visibly the end of it.
 */
export function buildTransferCodes(accounts: Account[], batchId = randomBatchId()): TransferPlan {
  const skipped: Account[] = [];
  const batchable: { account: Account; entry: number[] }[] = [];
  const singles: Account[] = [];

  for (const account of accounts) {
    if (!isUsableSecret(account.secret)) {
      skipped.push(account);
    } else if (fitsMigration(account)) {
      batchable.push({ account, entry: otpParameters(account) });
    } else {
      singles.push(account);
    }
  }

  // Packed greedily by size: a code is closed when it holds ten accounts or
  // the next one would take its text past MAX_CODE_TEXT, measured on the text
  // itself (the batch fields are at their largest here, so the final text is
  // never longer). One account longer than that alone still gets its code; it
  // just is a dense one.
  const groups: { account: Account; entry: number[] }[][] = [];
  let current: typeof batchable = [];
  for (const item of batchable) {
    const candidate = [...current, item].map(g => g.entry);
    if (
      current.length > 0 &&
      (current.length >= MAX_ACCOUNTS_PER_CODE || migrationText(candidate, 99, 99, batchId).length > MAX_CODE_TEXT)
    ) {
      groups.push(current);
      current = [];
    }
    current.push(item);
  }
  if (current.length > 0) groups.push(current);

  const codes: TransferCode[] = groups.map((group, index) => ({
    kind: 'migration',
    text: migrationText(group.map(g => g.entry), groups.length, index, batchId),
    accounts: group.map(g => g.account),
  }));

  for (const account of singles) {
    const { period, digits } = totpParams(account);
    codes.push({
      kind: 'single',
      text: buildOTPAuthURL({
        name: account.name,
        issuer: account.issuer,
        secret: account.secret,
        algorithm: readAlgorithm(account.algorithm) ?? 'SHA1',
        digits,
        period,
        ...(isSteamAccount(account) ? { type: 'steam' as const } : {}),
      }),
      accounts: [account],
    });
  }

  return { codes, skipped };
}

/** Google Authenticator writes a random 32-bit id shared by every code of one export. */
function randomBatchId(): number {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0]! & 0x7fffffff;
}
