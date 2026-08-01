export interface Account {
  id: string;
  name: string;
  issuer: string;
  secret: string;
  algorithm: 'SHA1' | 'SHA256' | 'SHA512';
  digits: 6 | 8;
  period: number;
  createdAt: number;
  color?: string;
}

/**
 * An account as it sits on disk once the vault is enabled. Only `id` (needed
 * for ordering and deletion) and `fp` (needed to merge local with sync) stay
 * readable; everything else — including the service name — lives inside `enc`,
 * so a stolen profile leaks no metadata about which services the user has.
 */
export interface EncryptedAccount {
  id: string;
  fp: string;
  enc: string;
  /**
   * Id of the vault that produced this ciphertext.
   *
   * Without it there is no way to tell "wrong key" from "corrupt record", so a
   * record encrypted by a vault that no longer exists — one left behind in
   * chrome.storage.sync after the vault was disabled, say — looks like
   * corruption and gets dropped. Records whose vault id does not match the
   * active vault are quarantined instead of decrypted.
   */
  v?: string;
}

/** What getAccounts reads and saveAccounts writes: plaintext or encrypted. */
export type StoredAccount = Account | EncryptedAccount;

export function isEncryptedAccount(record: StoredAccount): record is EncryptedAccount {
  return typeof (record as EncryptedAccount).enc === 'string';
}

export interface TOTPCode {
  code: string;
  remaining: number;
  period: number;
}

export type SortOrder = 'name-asc' | 'name-desc' | 'date-asc' | 'date-desc';
