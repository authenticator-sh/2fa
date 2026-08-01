import type { Account, EncryptedAccount, StoredAccount } from '@/types';
import { isEncryptedAccount } from '@/types';
import { decryptJson, encryptJson, fingerprintSecret } from './crypto';
import {
  clearVaultMeta,
  createVaultMeta,
  deriveKeys,
  getMasterKeyBytes,
  getVaultMeta,
  isVaultEnabled,
  lock,
  saveVaultMeta,
  unlockWithPassword,
  VaultLockedError,
  verifyPassword,
} from './vault';
import { replaceAllBackups } from './auto-backup';

const STORAGE_KEY = 'authenticator_accounts';
const SYNC_ENABLED_KEY = 'syncEnabled';
const SYNC_OVERFLOW_KEY = 'syncOverflow';

// chrome.storage.sync caps a single key at 8 KB but allows 100 KB in total, so
// the accounts go across several keys rather than one. Writing them as one
// array silently stopped syncing at ~44 accounts — and at ~22 once password
// protection roughly doubles each record. Chunking raises that to a few
// hundred, which is past any realistic collection.
const SYNC_CHUNK_PREFIX = 'authenticator_accounts_';
const SYNC_CHUNK_BYTES = 7000; // headroom under the 8192-per-item limit
const SYNC_MAX_CHUNKS = 12; // ~84 KB, leaving room for the vault metadata
/** Owned by suggestions.ts; named here only so the vault can scrub it. */
const USAGE_HISTORY_KEY = 'accountUsageByDomain';

// --- cross-device sync ------------------------------------------------------
// Local is always the primary store; sync is an additional copy that lets a
// second device pick the accounts up. It travels through the user's own Google
// account, so it is worth being able to switch off — and switching it off has
// to remove what is already up there, not merely stop adding to it.

export async function isSyncEnabled(): Promise<boolean> {
  const result = await chrome.storage.local.get(SYNC_ENABLED_KEY);
  return result[SYNC_ENABLED_KEY] !== false;
}

export async function setSyncEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [SYNC_ENABLED_KEY]: enabled });

  if (enabled) {
    await pushToSync(await getStoredAccounts()).catch(() => {});
    return;
  }

  // Purge both the accounts and the vault metadata: leaving the wrapped master
  // key behind would keep an offline brute-force target on Google's servers
  // after the user asked us to stop using them.
  await chrome.storage.sync.remove([...(await syncKeysInUse()), 'vault_meta']).catch(() => {});
}

/** Split records so that each chunk serialises below the per-key limit. */
function chunkForSync(records: StoredAccount[]): StoredAccount[][] {
  const chunks: StoredAccount[][] = [];
  let current: StoredAccount[] = [];
  let size = 2; // the enclosing []

  for (const record of records) {
    const cost = JSON.stringify(record).length + 1;
    if (current.length > 0 && size + cost > SYNC_CHUNK_BYTES) {
      chunks.push(current);
      current = [];
      size = 2;
    }
    current.push(record);
    size += cost;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

async function syncKeysInUse(): Promise<string[]> {
  const all = await chrome.storage.sync.get(null);
  return Object.keys(all).filter(key => key.startsWith(SYNC_CHUNK_PREFIX) || key === STORAGE_KEY);
}

/** Reads the accounts back out of however many keys they were spread across. */
async function readSyncRecords(): Promise<StoredAccount[]> {
  const all = await chrome.storage.sync.get(null);

  const chunkKeys = Object.keys(all)
    .filter(key => key.startsWith(SYNC_CHUNK_PREFIX))
    .sort((a, b) => Number(a.slice(SYNC_CHUNK_PREFIX.length)) - Number(b.slice(SYNC_CHUNK_PREFIX.length)));

  const records: StoredAccount[] = [];
  for (const key of chunkKeys) {
    if (Array.isArray(all[key])) records.push(...all[key]);
  }

  // Devices still running an older build write a single un-chunked key.
  if (Array.isArray(all[STORAGE_KEY])) records.push(...all[STORAGE_KEY]);

  return records;
}

/** True when the accounts are too large for sync even after chunking. */
export async function hasSyncOverflowed(): Promise<boolean> {
  const result = await chrome.storage.local.get(SYNC_OVERFLOW_KEY);
  return result[SYNC_OVERFLOW_KEY] === true;
}

/** Throws if the write is rejected, so callers can react to quota failures. */
async function pushToSync(records: StoredAccount[]): Promise<void> {
  const stale = await syncKeysInUse();

  if (!(await isSyncEnabled())) {
    if (stale.length) await chrome.storage.sync.remove(stale).catch(() => {});
    return;
  }

  const chunks = chunkForSync(records);

  if (chunks.length > SYNC_MAX_CHUNKS) {
    // Record it so the UI can say so; failing silently is what made the old
    // 8 KB ceiling invisible to everyone it affected.
    await chrome.storage.local.set({ [SYNC_OVERFLOW_KEY]: true });
    throw new Error(`Too many accounts to sync (${records.length})`);
  }

  const payload: Record<string, StoredAccount[]> = {};
  chunks.forEach((chunk, index) => {
    payload[`${SYNC_CHUNK_PREFIX}${index}`] = chunk;
  });

  await chrome.storage.sync.set(payload);
  await chrome.storage.local.set({ [SYNC_OVERFLOW_KEY]: false });

  // Drop the legacy single key and any chunk left over from a longer list.
  const obsolete = stale.filter(key => !(key in payload));
  if (obsolete.length) await chrome.storage.sync.remove(obsolete).catch(() => {});
}

/**
 * Whether a record was produced by the vault that is currently configured.
 *
 * Records written before this field existed carry no `v` and are given the
 * benefit of the doubt — they predate any second vault, so the active key is
 * the only one that could have made them.
 */
function belongsToVault(record: EncryptedAccount, vaultId: string | undefined): boolean {
  return record.v === undefined || record.v === vaultId;
}

// Retry mechanism for storage operations
async function retryOperation<T>(
  operation: () => Promise<T>,
  maxRetries = 3,
  delay = 1000
): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, delay * (i + 1)));
    }
  }
  throw new Error('Max retries exceeded');
}

// --- encryption layer -----------------------------------------------------
// When the vault is off these are pass-throughs and the on-disk format is
// byte-identical to what earlier versions wrote, so downgrading the extension
// never strands anyone's accounts.

/**
 * Records the last read could not turn into accounts: ciphertext from another
 * vault, or a record whose decryption failed. They are invisible to the UI but
 * are written back untouched on every save, so nothing is ever silently lost.
 */
let quarantined: StoredAccount[] = [];

export function quarantinedCount(): number {
  return quarantined.length;
}

/**
 * Drop the held records.
 *
 * The list is refreshed by every read, and every mutation path reads before it
 * writes, so in the extension it is always current. Tests reuse one module
 * instance across scenarios, where that invariant does not hold.
 */
export function resetQuarantine(): void {
  quarantined = [];
}

async function requireKeys() {
  const masterKeyBytes = await getMasterKeyBytes();
  if (!masterKeyBytes) throw new VaultLockedError();
  return deriveKeys(masterKeyBytes);
}

async function encodeAccounts(accounts: Account[]): Promise<StoredAccount[]> {
  const meta = await getVaultMeta();
  if (!meta) return accounts;

  const { dataKey, fingerprintKey } = await requireKeys();
  return Promise.all(
    accounts.map(async (account): Promise<EncryptedAccount> => {
      const { id, ...secretFields } = account;
      return {
        id,
        v: meta.vaultId,
        fp: await fingerprintSecret(fingerprintKey, account.secret),
        enc: await encryptJson(secretFields, dataKey),
      };
    })
  );
}

/**
 * Collapse accounts that share a secret.
 *
 * The local/sync merge can only compare like with like: an encrypted record's
 * fingerprint never equals a cleartext record's secret, so a device still
 * running an older build pushing cleartext into sync would otherwise show every
 * account twice. Once decrypted the secrets are directly comparable, so this is
 * the one place that can see the duplicates — and it has to run on the
 * cleartext path too, where the same sync merge produces the same duplicates.
 */
function dedupeBySecret(accounts: Account[]): Account[] {
  const seen = new Set<string>();
  return accounts.filter(account => {
    if (seen.has(account.secret)) return false;
    seen.add(account.secret);
    return true;
  });
}

/**
 * Turn on-disk records back into accounts.
 *
 * Plaintext records may legitimately appear alongside encrypted ones — a
 * second device that still runs an older build keeps pushing cleartext into
 * sync. We accept them here and let the next save re-encrypt them rather than
 * dropping the user's accounts on the floor.
 */
export async function decodeAccounts(stored: StoredAccount[]): Promise<Account[]> {
  const meta = await getVaultMeta();

  // The lock check is unconditional and independent of what the records look
  // like. Checking it only on the encrypted branch meant a vault that was
  // enabled but whose records happened to still be cleartext — the state left
  // behind by a half-finished migration, or by an older device pushing
  // cleartext into sync — served every secret while locked.
  if (meta) await requireKeys();

  if (stored.length === 0) {
    quarantined = [];
    return [];
  }

  if (!meta) {
    // No vault: any encrypted record here belongs to a vault that no longer
    // exists. It cannot be read, but it must not be deleted either — the user
    // may still be able to restore the vault on another device.
    const [encrypted, cleartext] = partition(stored, isEncryptedAccount);
    quarantined = encrypted;
    return dedupeBySecret(cleartext as Account[]);
  }

  const { dataKey } = await requireKeys();
  const decoded: Account[] = [];
  const held: StoredAccount[] = [];

  for (const record of stored) {
    if (!isEncryptedAccount(record)) {
      decoded.push(record);
      continue;
    }

    if (!belongsToVault(record, meta.vaultId)) {
      // Produced by a different vault — not corrupt, just unreadable here.
      held.push(record);
      continue;
    }

    try {
      const fields = await decryptJson<Omit<Account, 'id'>>(record.enc, dataKey);
      decoded.push({ id: record.id, ...fields });
    } catch (error) {
      // Quarantine rather than drop. Dropping was worse than it looked: the
      // truncated list is what the next save writes back, so a record that
      // failed to decrypt once — a transient WebCrypto failure, a key that will
      // be restored later — was permanently erased by the user's next click.
      console.error('Could not read an account record; keeping it untouched', record.id, error);
      held.push(record);
    }
  }

  quarantined = held;
  return dedupeBySecret(decoded);
}

function partition<T>(items: T[], predicate: (item: T) => boolean): [T[], T[]] {
  const yes: T[] = [];
  const no: T[] = [];
  for (const item of items) (predicate(item) ? yes : no).push(item);
  return [yes, no];
}

/**
 * Compare two account lists by value, ignoring property order.
 *
 * The round-trip check must not depend on key ordering: decryption rebuilds
 * every record as `{ id, ...rest }`, so `id` always lands first, while accounts
 * created by older versions or by the Google Authenticator migration import
 * carry it somewhere else entirely. A plain JSON.stringify comparison reports
 * those as corrupt and refuses to enable the vault at all.
 */
function sameAccounts(a: Account[], b: Account[]): boolean {
  const canonical = (accounts: Account[]) =>
    JSON.stringify(
      accounts.map(account =>
        Object.keys(account)
          .sort()
          .map(key => [key, (account as unknown as Record<string, unknown>)[key]])
      )
    );

  return canonical(a) === canonical(b);
}

/** Merge identity: the fingerprint when encrypted, the raw secret otherwise. */
function identityOf(record: StoredAccount): string {
  return isEncryptedAccount(record) ? record.fp : record.secret;
}

// Local is the primary store (10MB quota, fast, reliable).
// Sync is a best-effort secondary for cross-device backup — it has an 8KB/item
// limit and silently fails for users with many accounts, so we never let it
// overwrite local. Reads return the UNION (by fingerprint, or by secret while
// the vault is off) of local + sync so that
// 1) accounts in sync but not local (other device, fresh install) appear, and
// 2) accounts in local but not sync (sync write was dropped by quota) survive.
// Deletions don't propagate cross-device — acceptable for a 2FA app where
// keeping a stale code is far better than losing one.
export async function getStoredAccounts(): Promise<StoredAccount[]> {
  return retryOperation(async () => {
    const localResult = await chrome.storage.local.get(STORAGE_KEY);
    const localAccounts: StoredAccount[] = localResult[STORAGE_KEY] || [];

    let syncAccounts: StoredAccount[] = [];
    try {
      syncAccounts = await readSyncRecords();
    } catch (syncError) {
      console.warn('Sync storage unavailable:', syncError);
    }

    if (syncAccounts.length === 0) {
      return localAccounts;
    }

    const seen = new Set(localAccounts.map(identityOf));
    const additions = syncAccounts.filter(acc => !seen.has(identityOf(acc)));

    if (additions.length === 0) {
      return localAccounts;
    }

    const merged = [...localAccounts, ...additions];
    // Persist merge so subsequent reads are stable and the auto-backup
    // reflects the full set.
    await chrome.storage.local.set({ [STORAGE_KEY]: merged }).catch(() => {});
    return merged;
  });
}

/**
 * Never returns an empty list to signal failure.
 *
 * It used to: any storage error became `[]`, and since every mutation is a
 * read-modify-write over this result, the next delete or edit wrote that empty
 * list to both stores. One transient read failure plus one click destroyed
 * every account. Errors now propagate and the UI shows a failure state.
 */
export async function getAccounts(): Promise<Account[]> {
  return decodeAccounts(await getStoredAccounts());
}

export interface SaveOptions {
  /** Set by callers that legitimately remove accounts. */
  allowShrink?: boolean;
}

export async function saveAccounts(accounts: Account[], options: SaveOptions = {}): Promise<void> {
  const records = [...(await encodeAccounts(accounts)), ...quarantined];

  // Last line of defence against the whole class of bugs where a partial read
  // becomes a destructive write. Deleting is the only operation that may shrink
  // the store, and it says so explicitly.
  if (!options.allowShrink) {
    const existing = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
    const existingCount = Array.isArray(existing) ? existing.length : 0;
    if (records.length < existingCount) {
      throw new Error(
        `Refusing to save ${records.length} accounts over ${existingCount} already stored`
      );
    }
  }

  const data = { [STORAGE_KEY]: records };

  // Local is the source of truth — must succeed or we throw
  await retryOperation(() => chrome.storage.local.set(data));

  // Sync is best-effort: failures here (e.g. QUOTA_BYTES_PER_ITEM exceeded
  // with many accounts) must not block the save or be retried.
  pushToSync(records).catch(syncError => {
    console.warn('Sync storage failed (local save succeeded):', syncError);
  });
}

export async function addAccount(account: Account): Promise<void> {
  const accounts = await getAccounts();
  accounts.push(account);
  await saveAccounts(accounts);
}

export async function addMultipleAccounts(
  newAccounts: Account[]
): Promise<{ added: number; skipped: number; total: number }> {
  const accounts = await getAccounts();

  // Dedupe against existing accounts AND within the new batch itself
  const seenSecrets = new Set(accounts.map(acc => acc.secret));
  const uniqueAccounts: Account[] = [];
  for (const acc of newAccounts) {
    if (!seenSecrets.has(acc.secret)) {
      seenSecrets.add(acc.secret);
      uniqueAccounts.push(acc);
    }
  }

  if (uniqueAccounts.length > 0) {
    accounts.push(...uniqueAccounts);
    await saveAccounts(accounts);
  }

  return {
    added: uniqueAccounts.length,
    skipped: newAccounts.length - uniqueAccounts.length,
    total: newAccounts.length,
  };
}

export async function reorderAccounts(accountIds: string[]): Promise<void> {
  const accounts = await getAccounts();
  const ordered = accountIds
    .map(id => accounts.find(acc => acc.id === id))
    .filter((acc): acc is Account => acc !== undefined);

  // Anything the caller did not mention keeps its place at the end instead of
  // being deleted. The id list comes from React state, which goes stale the
  // moment the scanner tab adds an account — a drag must not cost the user that
  // account.
  const mentioned = new Set(ordered.map(acc => acc.id));
  const untouched = accounts.filter(acc => !mentioned.has(acc.id));

  await saveAccounts([...ordered, ...untouched]);
}

export async function updateAccount(id: string, updates: Partial<Account>): Promise<void> {
  const accounts = await getAccounts();
  const index = accounts.findIndex(acc => acc.id === id);
  if (index !== -1) {
    accounts[index] = { ...accounts[index], ...updates };
    await saveAccounts(accounts);
  }
}

export async function deleteAccount(id: string): Promise<void> {
  const accounts = await getAccounts();
  const filtered = accounts.filter(acc => acc.id !== id);
  await saveAccounts(filtered, { allowShrink: true });
}

export async function exportAccounts(): Promise<string> {
  const accounts = await getAccounts();
  return JSON.stringify(accounts, null, 2);
}

export async function importAccounts(jsonData: string): Promise<void> {
  try {
    const parsed = JSON.parse(jsonData);

    // Support both old format (array) and new format (object with metadata)
    let importedAccounts: Account[];

    if (Array.isArray(parsed)) {
      // Old format: direct array of accounts
      importedAccounts = parsed;
    } else if (parsed.accounts && Array.isArray(parsed.accounts)) {
      // New format: object with metadata
      importedAccounts = parsed.accounts;
      console.log(`Importing backup from ${parsed.exportDate || 'unknown date'}`);
    } else {
      throw new Error('Invalid format');
    }

    await importAccountList(importedAccounts);
  } catch (error) {
    console.error('Error importing accounts:', error);
    if (error instanceof VaultLockedError) throw error;
    throw new Error('Failed to import accounts. Invalid format.');
  }
}

/** Shared merge path for JSON, encrypted-file and QR imports. */
export async function importAccountList(importedAccounts: Account[]): Promise<void> {
  if (!Array.isArray(importedAccounts)) {
    throw new Error('Invalid format');
  }

  for (const acc of importedAccounts) {
    if (!acc.id || !acc.name || !acc.secret) {
      throw new Error('Invalid account structure');
    }
  }

  const existingAccounts = await getAccounts();
  const existingSecrets = new Set(existingAccounts.map(acc => acc.secret));

  // Merge: keep existing accounts and add only new ones (deduplicate by secret)
  const newAccounts = importedAccounts.filter(acc => !existingSecrets.has(acc.secret));
  const mergedAccounts = [...existingAccounts, ...newAccounts];

  await saveAccounts(mergedAccounts);
}

// --- vault migration ------------------------------------------------------

export interface PreparedVault {
  /** Show this to the user and get it confirmed BEFORE calling commit(). */
  recoveryCode: string;
  /**
   * Persists the vault. Nothing has touched disk until this resolves — the
   * whole point of the split.
   */
  commit: () => Promise<void>;
}

/**
 * Build a vault in memory and prove it round-trips, writing nothing.
 *
 * Split from the commit deliberately. The recovery code is the only way back in
 * after a forgotten password, and it exists nowhere but the return value of this
 * function — only its wrapped form is ever stored. A Chrome popup is destroyed
 * the instant it loses focus, so if the vault were committed first, one click on
 * the page behind the popup would leave the user encrypted, with their cleartext
 * backups already wiped, holding no recovery code and no way to obtain one.
 */
export async function prepareVault(password: string): Promise<PreparedVault> {
  if (await isVaultEnabled()) {
    throw new Error('Vault is already enabled');
  }

  const plaintextAccounts = await getAccounts();
  const { meta, masterKeyBytes, recoveryCode } = await createVaultMeta(password);
  const { dataKey, fingerprintKey } = await deriveKeys(masterKeyBytes);

  const encrypted: EncryptedAccount[] = await Promise.all(
    plaintextAccounts.map(async account => {
      const { id, ...secretFields } = account;
      return {
        id,
        v: meta.vaultId,
        fp: await fingerprintSecret(fingerprintKey, account.secret),
        enc: await encryptJson(secretFields, dataKey),
      };
    })
  );

  // Round trip before anything destructive happens.
  const verification: Account[] = await Promise.all(
    encrypted.map(async record => {
      const fields = await decryptJson<Omit<Account, 'id'>>(record.enc, dataKey);
      return { id: record.id, ...fields };
    })
  );

  if (!sameAccounts(verification, plaintextAccounts)) {
    throw new Error('Encryption verification failed — no changes were made');
  }

  const commit = async (): Promise<void> => {
    // Metadata first, and roll it back on any failure below. The reverse order
    // is worse: ciphertext with no metadata is unopenable, whereas metadata with
    // cleartext still under it is readable the moment the user unlocks, and the
    // next save encrypts it.
    await saveVaultMeta(meta);

    try {
      await retryOperation(() => chrome.storage.local.set({ [STORAGE_KEY]: encrypted }));

      // Awaited, unlike a plain best-effort push: if the encrypted copy cannot
      // reach sync we must remove the cleartext that is sitting there, or the
      // vault is decorative and a second device merges the cleartext straight
      // back into local.
      try {
        await pushToSync(encrypted);
      } catch {
        await chrome.storage.sync.remove(await syncKeysInUse()).catch(() => {});
      }

      // Snapshots are replaced inside a single IndexedDB transaction so there
      // is never a moment with zero backups.
      await replaceAllBackups(encrypted);

      // The per-site usage history is account metadata the vault does not cover;
      // leaving it behind would expose exactly which services the user holds.
      await chrome.storage.local.remove(USAGE_HISTORY_KEY).catch(() => {});

      // Going through the real unlock path rather than stashing the key we
      // already hold also proves the password round-trips through PBKDF2 and
      // unwraps what we just wrote.
      await unlockWithPassword(password);
    } catch (error) {
      await clearVaultMeta().catch(() => {});
      throw error;
    }
  };

  return { recoveryCode, commit };
}

/**
 * Turn the vault off. Requires the password even though the vault may already
 * be unlocked — this writes every secret back out in the clear, which should
 * never be one stray click away.
 */
export async function disableVault(password: string): Promise<void> {
  const masterKeyBytes = await verifyPassword(password);
  const { dataKey } = await deriveKeys(masterKeyBytes);
  const meta = await getVaultMeta();

  const stored = await getStoredAccounts();
  const accounts: Account[] = [];
  for (const record of stored) {
    if (!isEncryptedAccount(record)) {
      accounts.push(record);
      continue;
    }
    if (!belongsToVault(record, meta?.vaultId)) {
      // A record from some other vault cannot be decrypted with this key.
      // Aborting is the only safe answer: writing the rest out would silently
      // drop it, and this is the one operation that rewrites the whole store.
      throw new Error('Some records belong to a different vault — nothing was changed');
    }
    const fields = await decryptJson<Omit<Account, 'id'>>(record.enc, dataKey);
    accounts.push({ id: record.id, ...fields });
  }

  // Deduplicate before writing: a cleartext duplicate that arrived from an
  // older device via sync would otherwise be baked into the cleartext store,
  // where nothing downstream re-checks it.
  const unique = dedupeBySecret(accounts);

  await retryOperation(() => chrome.storage.local.set({ [STORAGE_KEY]: unique }));

  // Awaited: leftover ciphertext in sync would be merged back into local by the
  // next read and, with no vault left to open it, would brick every code path.
  try {
    await pushToSync(unique);
  } catch {
    await chrome.storage.sync.remove(await syncKeysInUse()).catch(() => {});
  }

  // Existing snapshots are ciphertext that nothing will be able to open once
  // the metadata is gone, so replace them with a readable one.
  await replaceAllBackups(unique);

  await clearVaultMeta();
  await lock();
}

export { VaultLockedError };
