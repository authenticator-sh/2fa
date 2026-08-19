import type { Account, EncryptedAccount, StoredAccount } from '@/types';
import { isEncryptedAccount } from '@/types';
import { ageOf } from './clock';
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
import { replaceAllBackups, wipeAllBackups } from './auto-backup';
import { isSyncEnabled, setSyncPreference } from './sync-preference';
import { deletedHere, forgetDeleted, markDeleted } from './tombstones';

const STORAGE_KEY = 'authenticator_accounts';
const SYNC_OVERFLOW_KEY = 'syncOverflow';

// chrome.storage.sync caps a single key at 8 KB but allows 100 KB in total, so
// the accounts go across several keys rather than one. Writing them as one
// array silently stopped syncing at ~44 accounts — and at ~22 once password
// protection roughly doubles each record. Chunking raises that to a few
// hundred, which is past any realistic collection.
const SYNC_CHUNK_PREFIX = 'authenticator_accounts_';
const SYNC_CHUNK_BYTES = 7000; // real UTF-8 bytes; headroom under the 8192-per-item limit
const SYNC_MAX_CHUNKS = 12; // ~84 KB, leaving room for the vault metadata
/** Owned by suggestions.ts; named here only so the vault can scrub it. */
const USAGE_HISTORY_KEY = 'accountUsageByDomain';
/** Owned by active-group.ts; same reason — it holds a group name the user typed. */
const ACTIVE_GROUP_KEY = 'activeGroup';

// --- cross-device sync ------------------------------------------------------
// Local is always the primary store; sync is an additional copy that lets a
// second device pick the accounts up. It travels through the user's own Google
// account, so it is worth being able to switch off — and switching it off has
// to remove what is already up there, not merely stop adding to it.

export { isSyncEnabled };

export async function setSyncEnabled(enabled: boolean): Promise<void> {
  await setSyncPreference(enabled);

  if (enabled) {
    await pushToSync(await getStoredAccounts(), { force: true }).catch(() => {});

    // The metadata has to go back up as well, or a second device sees the
    // synced records and has no way to derive the key that opens them.
    const meta = await getVaultMeta();
    if (meta) await saveVaultMeta(meta);
    return;
  }

  // Purge both the accounts and the vault metadata: leaving the wrapped master
  // key behind would keep an offline brute-force target on Google's servers
  // after the user asked us to stop using them.
  await chrome.storage.sync.remove([...(await syncKeysInUse()), 'vault_meta']).catch(() => {});
}

// Chrome measures the quota in UTF-8 bytes, and `String.length` counts UTF-16
// code units — equal only for ASCII. A Cyrillic account name costs twice what
// the old arithmetic charged it and CJK three times, so chunks that measured
// ~7 KB were really over 8 KB and the whole write was rejected. Local kept the
// accounts, but sync stopped updating and said nothing.
const encoder = new TextEncoder();
function byteLength(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

/** Split records so that each chunk serialises below the per-key limit. */
function chunkForSync(records: StoredAccount[]): StoredAccount[][] {
  const chunks: StoredAccount[][] = [];
  let current: StoredAccount[] = [];
  let size = 2; // the enclosing []

  for (const record of records) {
    const cost = byteLength(record) + 1; // + the separating comma
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

// --- the download window ----------------------------------------------------
//
// Chrome populates chrome.storage.sync asynchronously after a profile signs in,
// and an area that has not arrived yet is indistinguishable from an area that is
// genuinely empty: both read as {}. A device that writes during that window
// wins the per-key conflict when the real data lands, so the cloud copy is
// replaced by whatever the new device happened to have.
//
// That is not an edge case — it is the restore path. Install on a new machine,
// open the popup, see no accounts, add one, and the old machine's 90 accounts
// are cut to whatever shares a chunk key with the new one.
//
// So: hold pushes back until sync has either produced content or had long enough
// that empty is credible. Local is unaffected — it is the primary store and is
// written either way — and a held-back push is retried on the next read.

/** Sync has produced content on this profile at least once. */
const SYNC_OBSERVED_KEY = 'syncObserved';
/** When this profile first read an empty sync area. */
const SYNC_FIRST_READ_KEY = 'syncFirstReadAt';
/** A push was held back and needs replaying once the area is trustworthy. */
const SYNC_PENDING_KEY = 'syncPushPending';

/**
 * How long an empty sync area stays untrustworthy.
 *
 * Long enough to cover the download, short enough that a genuinely first-ever
 * install starts syncing within one sitting. The cost of being wrong in this
 * direction is a delayed backup; in the other, it is deleted accounts.
 */
const SYNC_SETTLE_MS = 2 * 60 * 1000;

async function noteSyncRead(recordCount: number, localCount: number): Promise<void> {
  if (recordCount > 0) {
    await chrome.storage.local.set({ [SYNC_OBSERVED_KEY]: true }).catch(() => {});
    return;
  }

  const stored = await chrome.storage.local
    .get([SYNC_OBSERVED_KEY, SYNC_FIRST_READ_KEY])
    .catch(() => ({}) as never);

  // Sync has gone empty on a profile that used to have content up there, while
  // this device still holds records. Signing out of Chrome, switching Google
  // account, and a reset sync area all look exactly like this from here — and
  // the latch, once set, could never be cleared, so the next write replaced the
  // cloud copy with whatever this device happened to have. Re-arm the window
  // instead: the same two minutes a fresh install gets, then the push proceeds.
  // Only reachable once per transition, because it clears the latch it tests.
  if (stored?.[SYNC_OBSERVED_KEY] === true && localCount > 0) {
    await chrome.storage.local
      .set({ [SYNC_OBSERVED_KEY]: false, [SYNC_FIRST_READ_KEY]: Date.now() })
      .catch(() => {});
    console.warn('Sync read empty on a profile that had content — holding pushes until it settles');
    return;
  }
  // Re-stamp anything unusable, including a stamp in the future left by a fast
  // clock. Left alone it made the settle window unreachable forever, and a
  // profile that never pushes to sync has no offsite copy at all.
  if (ageOf(stored?.[SYNC_FIRST_READ_KEY]) === null) {
    await chrome.storage.local.set({ [SYNC_FIRST_READ_KEY]: Date.now() }).catch(() => {});
  }
}

async function isSyncTrustworthy(): Promise<boolean> {
  try {
    const stored = await chrome.storage.local.get([SYNC_OBSERVED_KEY, SYNC_FIRST_READ_KEY]);
    if (stored[SYNC_OBSERVED_KEY] === true) return true;
    const age = ageOf(stored[SYNC_FIRST_READ_KEY]);
    return age !== null && age >= SYNC_SETTLE_MS;
  } catch {
    // Cannot tell — treat as untrustworthy. Skipping a push is recoverable.
    return false;
  }
}

/**
 * Send up a push that was held back, once the area can be trusted.
 *
 * Called from the read path because that is the one thing guaranteed to happen
 * on every popup open. Without it, a user who adds a single account on a fresh
 * profile and never edits it again would keep that account out of sync forever.
 */
async function replayHeldSyncPush(records: StoredAccount[]): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(SYNC_PENDING_KEY);
    if (stored[SYNC_PENDING_KEY] !== true) return;
    if (!(await isSyncTrustworthy())) return;

    await chrome.storage.local.set({ [SYNC_PENDING_KEY]: false });
    await pushToSync(records, { force: true });
  } catch (error) {
    console.warn('Could not replay the held sync push:', error);
  }
}

interface PushOptions {
  /**
   * Bypass the download-window hold.
   *
   * For operations the user just asked for that must reach sync to be correct:
   * turning sync on, and enabling or disabling the vault, where leaving stale
   * cleartext or orphaned ciphertext up there is worse than the race.
   */
  force?: boolean;
}

/** Throws if the write is rejected, so callers can react to quota failures. */
async function pushToSync(records: StoredAccount[], options: PushOptions = {}): Promise<void> {
  const stale = await syncKeysInUse();

  if (!(await isSyncEnabled())) {
    if (stale.length) await chrome.storage.sync.remove(stale).catch(() => {});
    return;
  }

  if (!options.force && stale.length === 0 && !(await isSyncTrustworthy())) {
    // Nothing up there to read and no reason yet to believe that is real.
    await chrome.storage.local.set({ [SYNC_PENDING_KEY]: true }).catch(() => {});
    console.warn('Holding the sync push back until the sync area has settled');
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

  try {
    await chrome.storage.sync.set(payload);
  } catch (error) {
    // Every way this can fail — per-item quota, total quota, the write-rate
    // limit — leaves sync silently stale. The flag is the only thing that puts
    // it in front of the user, so it has to be set here too and not just on the
    // chunk-count check above.
    await chrome.storage.local.set({ [SYNC_OVERFLOW_KEY]: true });
    throw error;
  }

  await chrome.storage.local.set({ [SYNC_OVERFLOW_KEY]: false });

  // This device has now written content, so the area is real from here on and
  // no further push needs holding back.
  await chrome.storage.local
    .set({ [SYNC_OBSERVED_KEY]: true, [SYNC_PENDING_KEY]: false })
    .catch(() => {});

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
    let syncReadable = false;
    try {
      syncAccounts = await readSyncRecords();
      syncReadable = true;
    } catch (syncError) {
      console.warn('Sync storage unavailable:', syncError);
    }

    // Only a read that actually succeeded says anything about whether the area
    // is populated; a thrown read says nothing and must not start the clock.
    if (syncReadable) {
      await noteSyncRead(syncAccounts.length, localAccounts.length);
      await replayHeldSyncPush(localAccounts);
    }

    if (syncAccounts.length === 0) {
      return localAccounts;
    }

    const seen = new Set(localAccounts.map(identityOf));
    const candidates = syncAccounts.filter(acc => !seen.has(identityOf(acc)));

    if (candidates.length === 0) {
      return localAccounts;
    }

    // "In sync but not local" is usually another device's account — but it is
    // also exactly what a record this device just deleted looks like, until the
    // sync write catches up. Without this the reload after a delete put the
    // account straight back, and a second delete was needed to make it stick.
    const wasDeletedHere = await deletedHere();
    const additions: StoredAccount[] = [];
    for (const acc of candidates) {
      if (!(await wasDeletedHere(identityOf(acc)))) additions.push(acc);
    }

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
  /**
   * Wait for the sync copy to be rewritten before returning.
   *
   * Normally the push is fire-and-forget: a quota rejection must not fail a
   * save that already succeeded locally. Deleting is the exception — its caller
   * reloads immediately, and a read that races the push sees the record still
   * in sync and treats it as an account from another device.
   */
  awaitSync?: boolean;
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

  // An account that is present again is one the user wants back — a re-scanned
  // QR, a restored backup — so whatever marked it deleted has to go. Doing it
  // here covers add, import and restore in one place, instead of leaving each
  // path to remember.
  await forgetDeleted(records.map(identityOf)).catch(() => {});

  // Sync is best-effort: failures here (e.g. QUOTA_BYTES_PER_ITEM exceeded
  // with many accounts) must not block the save or be retried.
  const push = pushToSync(records).catch(syncError => {
    console.warn('Sync storage failed (local save succeeded):', syncError);
  });
  if (options.awaitSync) await push;
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
    const merged = { ...accounts[index], ...updates };

    // An explicit `undefined` means "clear this field" — clearing an account's
    // group, say. Spreading it leaves the key present with an undefined value,
    // which chrome.storage serialises as null, and `null.trim()` throws on the
    // next read. Drop the key instead.
    for (const key of Object.keys(updates) as (keyof Account)[]) {
      if (updates[key] === undefined) delete merged[key];
    }

    accounts[index] = merged;
    await saveAccounts(accounts);
  }
}

export async function deleteAccount(id: string): Promise<void> {
  // The identity is taken from the stored record rather than recomputed from
  // the decoded account, so it matches exactly what the merge will compare a
  // stale sync copy against — the fingerprint when a vault is on, the secret
  // when it is not.
  const stored = await getStoredAccounts();
  const removed = stored.filter(record => record.id === id).map(identityOf);

  const accounts = await decodeAccounts(stored);
  const filtered = accounts.filter(acc => acc.id !== id);

  await saveAccounts(filtered, { allowShrink: true, awaitSync: true });
  await markDeleted(removed).catch(() => {});
}

export async function exportAccounts(): Promise<string> {
  const accounts = await getAccounts();
  return JSON.stringify(accounts, null, 2);
}

export async function importAccounts(jsonData: string): Promise<ImportResult> {
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

    return await importAccountList(importedAccounts);
  } catch (error) {
    console.error('Error importing accounts:', error);
    if (error instanceof VaultLockedError) throw error;
    throw new Error('Failed to import accounts. Invalid format.');
  }
}

export interface ImportResult {
  /** Records actually written, after de-duplication against what is already here. */
  added: number;
  /**
   * Entries in the file that could not be used at all. Distinct from the
   * `skipped` in import-message.ts, which counts accounts the user already had.
   */
  unreadable: number;
}

/** Longest group name we will store. Display truncates anyway; this keeps a
 *  pathological name out of the sync chunk budget and off every record. */
const MAX_GROUP_LENGTH = 64;

/**
 * Coerce one entry from a file into an Account, or return null if it is beyond
 * saving.
 *
 * Only `secret` is irreplaceable — it is the account. A missing id or name can
 * be filled in, and rejecting the file over either is how one bad row used to
 * cost someone every other row in their only backup.
 *
 * Types are checked, not assumed: these values come from a file, and until 1.11
 * a `group` that was a number rather than a string sailed through and threw on
 * `.trim()` during the next render — a permanently blank popup with the data
 * still on disk and no way to reach the export button.
 */
function normalizeImported(entry: unknown, index: number): Account | null {
  if (!entry || typeof entry !== 'object') return null;
  const acc = entry as Record<string, unknown>;

  if (typeof acc.secret !== 'string' || !acc.secret.trim()) return null;

  const name = typeof acc.name === 'string' && acc.name.trim()
    ? acc.name
    : typeof acc.issuer === 'string' && acc.issuer.trim()
      ? acc.issuer
      : 'Unknown';

  const normalized: Account = {
    ...(acc as unknown as Account),
    id: typeof acc.id === 'string' && acc.id ? acc.id : `imported-${Date.now()}-${index}`,
    name,
    issuer: typeof acc.issuer === 'string' ? acc.issuer : '',
    secret: acc.secret,
  };

  if (typeof acc.group === 'string') {
    const group = acc.group.slice(0, MAX_GROUP_LENGTH);
    if (group.trim()) normalized.group = group;
    else delete normalized.group;
  } else {
    delete normalized.group;
  }

  return normalized;
}

/** Shared merge path for JSON, encrypted-file and QR imports. */
export async function importAccountList(importedAccounts: Account[]): Promise<ImportResult> {
  if (!Array.isArray(importedAccounts)) {
    throw new Error('Invalid format');
  }

  const usable: Account[] = [];
  for (const [index, entry] of importedAccounts.entries()) {
    const account = normalizeImported(entry, index);
    if (account) usable.push(account);
  }

  const unreadable = importedAccounts.length - usable.length;

  // A file with entries in it but nothing usable is a broken file, and saying so
  // is more honest than reporting that zero accounts were restored.
  if (importedAccounts.length > 0 && usable.length === 0) {
    throw new Error('Invalid account structure');
  }

  const existingAccounts = await getAccounts();
  const existingSecrets = new Set(existingAccounts.map(acc => acc.secret));

  // Merge: keep existing accounts and add only new ones (deduplicate by secret)
  const newAccounts = usable.filter(acc => !existingSecrets.has(acc.secret));
  const mergedAccounts = [...existingAccounts, ...newAccounts];

  await saveAccounts(mergedAccounts);

  return { added: newAccounts.length, unreadable };
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

  /** Encrypt a list and prove it decrypts back to exactly what went in. */
  const encryptVerified = async (accounts: Account[]): Promise<EncryptedAccount[]> => {
    const records: EncryptedAccount[] = await Promise.all(
      accounts.map(async account => {
        const { id, ...secretFields } = account;
        return {
          id,
          v: meta.vaultId,
          fp: await fingerprintSecret(fingerprintKey, account.secret),
          enc: await encryptJson(secretFields, dataKey),
        };
      })
    );

    const verification: Account[] = await Promise.all(
      records.map(async record => {
        const fields = await decryptJson<Omit<Account, 'id'>>(record.enc, dataKey);
        return { id: record.id, ...fields };
      })
    );

    if (!sameAccounts(verification, accounts)) {
      throw new Error('Encryption verification failed — no changes were made');
    }

    return records;
  };

  // Round trip before anything destructive happens, so a key that cannot
  // round-trip is discovered before the user is ever shown a recovery code.
  await encryptVerified(plaintextAccounts);

  const commit = async (): Promise<void> => {
    // Re-read rather than reuse the list captured by `prepare`.
    //
    // The gap between the two is not a race in the narrow sense — it is a screen
    // the user is expected to linger on, copying a recovery code onto paper —
    // and the scanner runs in its own tab the whole time. Encrypting the stale
    // snapshot silently dropped anything added in between.
    //
    // This must happen before the metadata is written: with vault_meta on disk
    // and no key unlocked yet, this same read throws VaultLockedError.
    const currentAccounts = await getAccounts();
    // Captured by the read above: ciphertext from another vault, or records that
    // failed to decrypt. Every other write path carries them through untouched
    // (see saveAccounts); this one used to be the sole exception and erased them.
    const held = [...quarantined];

    const encrypted = await encryptVerified(currentAccounts);
    const records: StoredAccount[] = [...encrypted, ...held];

    // The exact bytes currently on disk, captured before anything is
    // overwritten. Rolling back the metadata alone is not enough: once the
    // ciphertext has landed, the only key that opens it lives in vault_meta, so
    // deleting the metadata to "undo" the operation destroys every account
    // instead of restoring it.
    const previousRecords = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];

    const rollback = async (): Promise<void> => {
      if (previousRecords !== undefined) {
        // The metadata may only be cleared once the cleartext is provably back.
        // Clearing it unconditionally — which is what happened when this restore
        // was a bare `.catch(console.error)` — turns a failed write into
        // ciphertext on disk with its key deleted: zero accounts, nothing left
        // to open them, and no second copy for anyone who has sync switched off.
        try {
          await retryOperation(() => chrome.storage.local.set({ [STORAGE_KEY]: previousRecords }));
        } catch (err) {
          console.error(
            'Vault rollback could not restore local accounts; keeping vault_meta so the ' +
              'encrypted records stay openable:',
            err
          );
          return;
        }
        await pushToSync(previousRecords, { force: true }).catch(() => {});
      }
      await clearVaultMeta().catch(() => {});
    };

    // Metadata first, and roll it back on any failure below. The reverse order
    // is worse: ciphertext with no metadata is unopenable, whereas metadata with
    // cleartext still under it is readable the moment the user unlocks, and the
    // next save encrypts it.
    await saveVaultMeta(meta);

    try {
      await retryOperation(() => chrome.storage.local.set({ [STORAGE_KEY]: records }));

      // Awaited, unlike a plain best-effort push: if the encrypted copy cannot
      // reach sync we must remove the cleartext that is sitting there, or the
      // vault is decorative and a second device merges the cleartext straight
      // back into local.
      try {
        await pushToSync(records, { force: true });
      } catch {
        await chrome.storage.sync.remove(await syncKeysInUse()).catch(() => {});
      }

      // Going through the real unlock path rather than stashing the key we
      // already hold also proves the password round-trips through PBKDF2 and
      // unwraps what we just wrote. Done before the snapshots are replaced: a
      // failure here still has cleartext backups to fall back on.
      await unlockWithPassword(password);
    } catch (error) {
      await rollback();
      throw error;
    }

    // Past this point the vault is real and usable, so nothing below may undo
    // it — a rollback here would take the accounts with it.

    // Snapshots are replaced inside a single IndexedDB transaction so there is
    // never a moment with zero backups. IndexedDB can be unavailable for reasons
    // that have nothing to do with us (blocked site data, a corrupted profile,
    // a full disk); leaving cleartext snapshots behind is a real weakness, but
    // it is a far smaller one than tearing down a working vault over it.
    try {
      await replaceAllBackups(records);
    } catch (error) {
      console.error('Vault enabled, but the encrypted backup snapshots could not be written:', error);
      // The snapshots still hold cleartext copies of everything the vault was
      // just turned on to protect. If they cannot be replaced, try to remove
      // them — losing the automatic backups is recoverable (the user can export
      // at any time), leaving readable secrets on disk under a vault is not.
      await wipeAllBackups().catch(() => {});
    }

    // Metadata the vault does not cover but a stolen profile would expose:
    // which services the user holds, and which group they filed them under.
    await chrome.storage.local.remove([USAGE_HISTORY_KEY, ACTIVE_GROUP_KEY]).catch(() => {});
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
    await pushToSync(unique, { force: true });
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
