export interface Account {
  id: string;
  name: string;
  issuer: string;
  secret: string;
  algorithm: 'SHA1' | 'SHA256' | 'SHA512';
  /**
   * Almost always 6 or 8, but 7 is issued in the wild and otpauth generates it.
   * Narrowing the type to `6 | 8` forced the QR parser to round 7 down to 6,
   * which produces a confident, permanently wrong code rather than a visible
   * failure. Values are range-checked where they are read, not by the type.
   */
  digits: number;
  period: number;
  createdAt: number;
  /**
   * When this account was last changed on any device — added, renamed, moved,
   * pinned — as stampNow on the device that changed it. What cloud sync
   * compares (billing/cloud-merge.ts): the newer edit of one seed wins, and a
   * deletion wins over an edit older than itself. Absent on records written
   * before sync, which then count from `createdAt`.
   *
   * Set in one place, mutateAccounts in storage.ts, for every record a change
   * adds or alters; never by the screens. Reordering the list leaves it alone:
   * the order is this device's own.
   */
  updatedAt?: number;
  color?: string;
  /**
   * Optional group name, free text, one per account.
   *
   * Deliberately not a separate list of groups: derived from the accounts
   * themselves there is nothing to keep in sync, nothing to migrate, and no
   * orphan group left behind when its last account is deleted. Absent or blank
   * means ungrouped, which is what every account imported from anywhere else is.
   */
  group?: string;
  /**
   * Where the account's group stands among the chips, lowest first. A group's
   * place is the lowest rank among its accounts; groups no account ranks come
   * after the ranked ones, alphabetically. Kept on the accounts rather than in
   * a list of group names — see reorderGroups for why.
   */
  groupRank?: number;
  /** Kept at the top of the list, whatever the sort. */
  pinned?: boolean;
  /**
   * Websites the user tied this account to, as hostnames (`example.com`,
   * `sub.example.com`), www. dropped. Outranks every guess about which account
   * a page wants; see utils/account-sites.ts for how they match. Absent means
   * none, which is every account until someone sets one. Inside the vault's
   * ciphertext like everything else but `id` and `fp`.
   */
  sites?: string[];
  /**
   * Which code the secret produces. Absent means RFC 6238 TOTP, which is every
   * record written before Steam Guard support and still nearly all of them.
   *
   * `steam` is Steam Guard: the same HMAC-SHA1 over 30-second steps, printed
   * as five characters from Steam's own alphabet instead of digits. Stored as
   * `type` because that is the field every importer already reads — Aegis
   * writes `type: "steam"` — so a backup of ours read by a version that does
   * not know Steam is refused as unsupported instead of imported as a TOTP
   * account whose code is confidently wrong.
   */
  type?: 'steam';
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

/**
 * Safe on anything, not only on what the type promises: storage has held a
 * `null` in the account list, and asking it for `.enc` threw out of every read.
 */
export function isEncryptedAccount(record: StoredAccount): record is EncryptedAccount {
  return !!record && typeof record === 'object' && typeof (record as EncryptedAccount).enc === 'string';
}

export interface TOTPCode {
  code: string;
  remaining: number;
  period: number;
}

export type SortOrder = 'name-asc' | 'name-desc' | 'date-asc' | 'date-desc';
