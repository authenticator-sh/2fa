// Export/import file formats.
//
// An encrypted export is deliberately NOT tied to the vault's master key: the
// file has to be openable on a machine that has no vault, years later, by
// someone restoring from a hard drive. So it carries its own salt and is
// derived straight from a password chosen at export time.

import type { Account } from '@/types';
import { buildOTPAuthURL } from './qr-parser';
import { isUsableSecret } from './totp';
import {
  decryptJson,
  deriveKeyFromPassword,
  encryptJson,
  fromBase64,
  newSalt,
  PBKDF2_ITERATIONS,
  toBase64,
} from './crypto';

const ENCRYPTED_FORMAT = 'authenticator-encrypted-backup';

interface EncryptedBackupFile {
  format: typeof ENCRYPTED_FORMAT;
  v: 1;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  exportDate: string;
  /** The extension version that wrote the file; absent before 1.14.0. */
  appVersion?: string;
  /** Written by an install that predates the paywall (BackupFileOptions). */
  legacy?: true;
  /** Everything sensitive, including how many accounts there are. */
  data: string;
}

/**
 * The iteration counts an encrypted export may ask for.
 *
 * The count comes from the file, and PBKDF2 runs on the popup's main thread:
 * a crafted .encrypted.json with `iterations: 1e10` froze the popup for hours
 * on the password prompt, with nothing the user could do but kill the browser.
 * Every version that wrote this format wrote PBKDF2_ITERATIONS, 600 000 — the
 * format arrived in 1.10.0 and the constant has not moved since — so the floor
 * sits well under it and the ceiling leaves room for a later raise — about
 * eight times today's cost, seconds rather than hours — while refusing
 * anything that would hang.
 */
export const MIN_BACKUP_ITERATIONS = 100_000;
export const MAX_BACKUP_ITERATIONS = 5_000_000;

/** The file is not one we wrote, or is from a build that writes more than we accept. */
export class DamagedBackupFileError extends Error {
  constructor(detail: string) {
    super(`This backup file cannot be opened: ${detail}`);
    this.name = 'DamagedBackupFileError';
  }
}

export class WrongExportPasswordError extends Error {
  constructor() {
    super('Incorrect password for this backup file');
    this.name = 'WrongExportPasswordError';
  }
}

/**
 * `legacy` marks a file written by an install that predates the paywall, so
 * restoring it on a new computer keeps the person's unlimited accounts
 * (billing/legacy.ts). Absent otherwise — older readers ignore the field.
 */
export interface BackupFileOptions {
  legacy?: boolean;
}

/**
 * The version of the extension writing the file. Files from before 1.14.0 do
 * not have it, which is how a restore tells a pre-paywall backup from a new one
 * whatever date it bears (billing/legacy.ts).
 */
function appVersion(): { appVersion?: string } {
  try {
    const version = chrome.runtime.getManifest().version;
    return typeof version === 'string' ? { appVersion: version } : {};
  } catch {
    return {};
  }
}

export function buildPlainBackupFile(accounts: Account[], options: BackupFileOptions = {}): string {
  return JSON.stringify(
    {
      version: '2.0',
      exportDate: new Date().toISOString(),
      ...appVersion(),
      accountCount: accounts.length,
      ...(options.legacy ? { legacy: true } : {}),
      accounts,
    },
    null,
    2
  );
}

export async function buildEncryptedBackupFile(
  accounts: Account[],
  password: string,
  options: BackupFileOptions = {}
): Promise<string> {
  const salt = newSalt();
  const key = await deriveKeyFromPassword(password, salt);

  const file: EncryptedBackupFile = {
    format: ENCRYPTED_FORMAT,
    v: 1,
    kdf: 'PBKDF2-SHA256',
    iterations: PBKDF2_ITERATIONS,
    salt: toBase64(salt),
    exportDate: new Date().toISOString(),
    ...appVersion(),
    ...(options.legacy ? { legacy: true } : {}),
    data: await encryptJson(accounts, key),
  };

  return JSON.stringify(file, null, 2);
}

export function isEncryptedBackupFile(text: string): boolean {
  try {
    return JSON.parse(text)?.format === ENCRYPTED_FORMAT;
  } catch {
    return false;
  }
}

export async function readEncryptedBackupFile(text: string, password: string): Promise<Account[]> {
  const file = JSON.parse(text) as EncryptedBackupFile;
  if (file.format !== ENCRYPTED_FORMAT) {
    throw new Error('Not an encrypted backup file');
  }

  // Checked before the derivation, which is where a hostile count does its
  // damage. Refused rather than clamped: a clamped count derives a different
  // key, which would come back as "wrong password" for the right one.
  const { iterations } = file;
  if (
    typeof iterations !== 'number' ||
    !Number.isInteger(iterations) ||
    iterations < MIN_BACKUP_ITERATIONS ||
    iterations > MAX_BACKUP_ITERATIONS
  ) {
    throw new DamagedBackupFileError(`unsupported iteration count ${String(iterations)}`);
  }
  if (typeof file.salt !== 'string' || typeof file.data !== 'string') {
    throw new DamagedBackupFileError('missing salt or data');
  }

  let salt: Uint8Array;
  try {
    salt = fromBase64(file.salt);
  } catch {
    throw new DamagedBackupFileError('salt is not base64');
  }

  const key = await deriveKeyFromPassword(password, salt, iterations);
  try {
    return await decryptJson<Account[]>(file.data, key);
  } catch {
    throw new WrongExportPasswordError();
  }
}

/**
 * Every account as a bare `otpauth://` URI, one per line.
 *
 * The plainest thing this app can emit, and the only export format other
 * authenticators can read without knowing anything about us. Nothing else goes
 * in the file — no header, no comment, no trailing metadata — because the
 * importers on the other side, ours included, read it line by line.
 *
 * Accounts whose secret cannot produce a code are left out rather than written
 * as a URI that silently fails wherever it lands; the count comes back so the
 * caller can say so out loud instead of reporting a clean export.
 */
export function buildURIBackupFile(accounts: Account[]): { text: string; skipped: number } {
  const usable = accounts.filter(account => isUsableSecret(account.secret));
  return {
    text: usable.length ? `${usable.map(buildOTPAuthURL).join('\n')}\n` : '',
    skipped: accounts.length - usable.length,
  };
}

export function uriBackupFileName(): string {
  return `authenticator-uris-${new Date().toISOString().slice(0, 10)}.txt`;
}

export function backupFileName(encrypted: boolean): string {
  const stamp = new Date().toISOString().slice(0, 10);
  return encrypted
    ? `authenticator-backup-${stamp}.encrypted.json`
    : `authenticator-backup-${stamp}.json`;
}

export function downloadBackupFile(contents: string, fileName: string, mime = 'application/json'): void {
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
