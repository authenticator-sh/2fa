// Export/import file formats.
//
// An encrypted export is deliberately NOT tied to the vault's master key: the
// file has to be openable on a machine that has no vault, years later, by
// someone restoring from a hard drive. So it carries its own salt and is
// derived straight from a password chosen at export time.

import type { Account } from '@/types';
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
  /** Everything sensitive, including how many accounts there are. */
  data: string;
}

export class WrongExportPasswordError extends Error {
  constructor() {
    super('Incorrect password for this backup file');
    this.name = 'WrongExportPasswordError';
  }
}

export function buildPlainBackupFile(accounts: Account[]): string {
  return JSON.stringify(
    {
      version: '2.0',
      exportDate: new Date().toISOString(),
      accountCount: accounts.length,
      accounts,
    },
    null,
    2
  );
}

export async function buildEncryptedBackupFile(accounts: Account[], password: string): Promise<string> {
  const salt = newSalt();
  const key = await deriveKeyFromPassword(password, salt);

  const file: EncryptedBackupFile = {
    format: ENCRYPTED_FORMAT,
    v: 1,
    kdf: 'PBKDF2-SHA256',
    iterations: PBKDF2_ITERATIONS,
    salt: toBase64(salt),
    exportDate: new Date().toISOString(),
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

  const key = await deriveKeyFromPassword(password, fromBase64(file.salt), file.iterations);
  try {
    return await decryptJson<Account[]>(file.data, key);
  } catch {
    throw new WrongExportPasswordError();
  }
}

export function backupFileName(encrypted: boolean): string {
  const stamp = new Date().toISOString().slice(0, 10);
  return encrypted
    ? `authenticator-backup-${stamp}.encrypted.json`
    : `authenticator-backup-${stamp}.json`;
}

export function downloadBackupFile(contents: string, fileName: string): void {
  const blob = new Blob([contents], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
