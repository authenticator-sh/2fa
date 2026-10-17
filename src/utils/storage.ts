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
  type VaultMeta,
  verifyPassword,
} from './vault';
import { replaceAllBackups, wipeAllBackups } from './auto-backup';
import { isSyncEnabled, setSyncPreference } from './sync-preference';
import { deletedHere, forgetDeleted, markDeleted } from './tombstones';
import { cleanSecret } from './totp';
import {
  ImportRejectedError,
  normalizeEntry,
  planImport,
  readImportFile,
  type ImportFile,
  type ImportReport,
} from './import-formats';
import { withAccountsLock } from './write-lock';
import { admit, type AddOrigin } from '@/billing/gate';
import { reassertSyncedFacts } from '@/billing/state';
import { openCodeFromVault, sealCodeUnderVault } from '@/billing/cloud-backup-code';

const STORAGE_KEY = 'authenticator_accounts';
const SYNC_OVERFLOW_KEY = 'syncOverflow';
/** Owned by vault.ts; read here in the same get as the records a save replaces. */
const VAULT_META_KEY = 'vault_meta';

/**
 * Whether a storage change event means the account list on screen may be stale.
 *
 * Only the primary copy counts: a sync write is either our own push or another
 * device's, and the latter is merged on the next read anyway. The popup never
 * needed this — it reloaded by being reopened — but the floating window and
 * the side panel stay open while the scan page adds an account beside them.
 */
export function affectsStoredAccounts(areaName: string, changes: Record<string, unknown>): boolean {
  return areaName === 'local' && STORAGE_KEY in changes;
}

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
    await pushLatest({ force: true, merge: true }).catch(() => {});

    // The metadata has to go back up as well, or a second device sees the
    // synced records and has no way to derive the key that opens them.
    await withAccountsLock(async () => {
      const meta = await getVaultMeta();
      if (meta) await saveVaultMeta(meta);
    });
    // And the two billing facts turning sync off took with it.
    await reassertSyncedFacts();
    return;
  }

  // Purge both the accounts and the vault metadata: leaving the wrapped master
  // key behind would keep an offline brute-force target on Google's servers
  // after the user asked us to stop using them.
  //
  // This is the ONLY place a device with sync off touches the sync area, and
  // that is a decision, not an accident. The area is shared by every Chrome
  // signed in to the same Google account, so this also takes the copy another
  // machine put there — which is what the setting promises ("Turning this off
  // also removes them from Google's servers"). Those machines keep their local
  // copies and put theirs back on their next save. What must NOT happen is the
  // purge repeating on every later save here, as it used to: each time a
  // sync-on machine pushed, the next rename on this one wiped it again, so the
  // other machines effectively had no cloud copy at all.
  // The billing facts that ride along in sync (billing/state.ts) go too —
  // the cloud backup code among them: "removed from Google's servers" is about
  // everything we put there.
  await chrome.storage.sync
    .remove([...(await syncKeysInUse()), VAULT_META_KEY, 'billingLegacy', 'billingLicenseKey', 'cloudBackupCode'])
    .catch(() => {});
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
async function replayHeldSyncPush(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(SYNC_PENDING_KEY);
    if (stored[SYNC_PENDING_KEY] !== true) return;
    if (!(await isSyncTrustworthy())) return;

    await chrome.storage.local.set({ [SYNC_PENDING_KEY]: false });
    // The replay is a forced push that prunes every chunk beyond what it
    // writes, so it has to carry the merged list — which pushLatest reads, under
    // the lock, at the moment it pushes. Replaying local alone cut the cloud
    // copy to this device's accounts at the exact moment another device's
    // arrived: a fresh install with one new account, meeting thirty from the
    // old machine, left one in sync.
    await pushLatest({ force: true, merge: true });
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
  /**
   * Let cleartext go up while vault metadata still exists. Only for the two
   * writes that are, by definition, leaving the vault: turning it off, and
   * rolling back a vault that never finished turning on.
   */
  cleartextAllowed?: boolean;
}

/** Throws if the write is rejected, so callers can react to quota failures. */
async function pushToSync(records: StoredAccount[], options: PushOptions = {}): Promise<void> {
  // Sync off means this device leaves the area alone. It used to remove every
  // account key here instead — on every save — which deleted the copy each
  // sync-on machine on the same Google account had just put up. The purge the
  // setting promises happens once, in setSyncEnabled(false).
  if (!(await isSyncEnabled())) return;

  const stale = await syncKeysInUse();

  if (!options.cleartextAllowed && (await getVaultMeta())) {
    // A list encoded before the vault was switched on in another window, or a
    // cleartext record merged in from an older device while this one was
    // locked: either way, a secret in the clear on Google's servers under a
    // vault the user believes is protecting it. Local keeps such a record until
    // the next save encrypts it; sync only ever gets the ciphertext.
    const sealed = records.filter(isEncryptedAccount);
    if (sealed.length !== records.length) {
      const withheld = records.length - sealed.length;
      console.warn(`Keeping ${withheld} unencrypted record(s) out of sync under a vault`);
      records = sealed;
    }
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
 * Held records that are accounts under some other password.
 *
 * What the UI counts in "N more account(s) here can't be read with this
 * password". A `null` or a record with no secret is held too, so it is never
 * lost, but no password opens it — telling someone with protection off that
 * three stray entries need "a different password" sent them looking for one.
 */
export function lockedAwayCount(): number {
  return quarantined.filter(record => isEncryptedAccount(record)).length;
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

/** `meta` is passed by a save that must compare it with what it overwrites. */
async function encodeAccounts(accounts: Account[], meta?: VaultMeta | null): Promise<StoredAccount[]> {
  if (meta === undefined) meta = await getVaultMeta();
  if (!meta) return accounts;
  const vaultId = meta.vaultId;

  const { dataKey, fingerprintKey } = await requireKeys();
  return Promise.all(
    accounts.map(async (account): Promise<EncryptedAccount> => {
      const { id, ...secretFields } = account;
      return {
        id,
        v: vaultId,
        fp: await fingerprintSecret(fingerprintKey, account.secret),
        enc: await encryptJson(secretFields, dataKey),
      };
    })
  );
}

/**
 * Whether a record is something this module can reason about at all: an
 * account with a secret in it, or ciphertext with the fingerprint the merge
 * compares it by.
 *
 * Anything else — a `null`, a bare string, `{}`, a secret that is a number —
 * used to be taken at its word. A single `null` in local or in one sync chunk
 * made every read throw (the merge asked it for its secret), and after the
 * retries that is "Failed to load accounts" on every device sharing the sync
 * area, permanently, with the data still on disk. A string or an empty object
 * rendered as a card with no id, which no edit or delete could address.
 *
 * Such a record is quarantined, like ciphertext from another vault: never
 * shown, never counted as an account, and written back untouched by every
 * save, because "this cannot be read" is not the same as "this is worthless".
 */
/** As isUsableRecord for decrypted fields — a plain answer, not a type guard. */
function opensToAccount(fields: unknown): boolean {
  return isUsableRecord(fields) && !isEncryptedAccount(fields);
}

function isUsableRecord(record: unknown): record is StoredAccount {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  const fields = record as Record<string, unknown>;
  if (typeof fields.enc === 'string') return typeof fields.fp === 'string' && fields.fp !== '';
  return typeof fields.secret === 'string' && secretKey(fields.secret) !== '';
}

/**
 * Text fields as strings, whatever is on disk.
 *
 * `issuer: null` is in real stores — the .txt export already had to learn to
 * survive it (see buildOTPAuthURL) — and a backup is a file a person can edit.
 * Every surface that searches or matches calls `.toLowerCase()` on these: the
 * popup's search box, the site suggestion, quick fill. One such account made
 * typing a single letter blank the popup. Mending it here, once, on the way out
 * of storage, is what lets everything above treat Account as the type says.
 */
function withTextFields(account: Account): Account {
  const text = (value: unknown): string | null =>
    typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;

  const issuer = text(account.issuer) ?? '';
  const name = text(account.name) ?? issuer;
  const groupOk = account.group === undefined || typeof account.group === 'string';
  if (name === account.name && issuer === account.issuer && groupOk) return account;

  const mended: Account = { ...account, name, issuer };
  if (typeof mended.group !== 'string') delete mended.group;
  return mended;
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
/**
 * The key two records are the same account under.
 *
 * Raw string equality misses the spellings the same seed legitimately arrives
 * in. `JBSWY3DPEHPK3PXP`, `jbswy3dpehpk3pxp`, `JBSW-Y3DP-EHPK-3PXP` and a
 * padded `JBSWY3DPEHPK3PXP=` are one secret and generate one code; compared as
 * strings they are four, so a hand-edited backup or a file from another app
 * imported four copies of one account and the "N were already here" count was
 * wrong in both directions. cleanSecret is what every parser already applies on
 * the way in — this is the same normalisation, applied where the comparison
 * happens.
 */
function secretKey(secret: string): string {
  return cleanSecret(secret).replace(/=+$/, '');
}

function dedupeBySecret(accounts: Account[]): Account[] {
  const seen = new Set<string>();
  return accounts.filter(account => {
    const key = secretKey(account.secret);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Turn on-disk records back into accounts, without touching module state.
 *
 * Plaintext records may legitimately appear alongside encrypted ones — a
 * second device that still runs an older build keeps pushing cleartext into
 * sync. We accept them here and let the next save re-encrypt them rather than
 * dropping the user's accounts on the floor.
 *
 * Split from `decodeAccounts` for the restore path, which decodes a backup
 * snapshot: those records are not what is on disk, so they must not become the
 * quarantine list that the next save writes back.
 */
export async function decodeRecords(
  stored: StoredAccount[]
): Promise<{ accounts: Account[]; held: StoredAccount[] }> {
  const { accounts, held } = await decodeDetailed(stored);
  return { accounts, held };
}

interface Decoded {
  accounts: Account[];
  held: StoredAccount[];
  /**
   * The normalised seed behind each record that could be read — including the
   * ones dedupeBySecret folded away, which is how a delete finds the hidden
   * copies of the account it removes.
   */
  seedOf: (record: StoredAccount) => string | undefined;
}

async function decodeDetailed(input: StoredAccount[]): Promise<Decoded> {
  const [stored, junk] = partition(input as unknown[], isUsableRecord) as [StoredAccount[], StoredAccount[]];
  const seeds = new Map<StoredAccount, string>();
  const seedOf = (record: StoredAccount) => seeds.get(record);
  const finish = (decoded: Account[], held: StoredAccount[]): Decoded => ({
    accounts: dedupeBySecret(decoded).map(withTextFields),
    held: [...held, ...junk],
    seedOf,
  });

  const meta = await getVaultMeta();

  // The lock check is unconditional and independent of what the records look
  // like. Checking it only on the encrypted branch meant a vault that was
  // enabled but whose records happened to still be cleartext — the state left
  // behind by a half-finished migration, or by an older device pushing
  // cleartext into sync — served every secret while locked.
  if (meta) await requireKeys();

  if (stored.length === 0) {
    return finish([], []);
  }

  if (!meta) {
    // No vault: any encrypted record here belongs to a vault that no longer
    // exists. It cannot be read, but it must not be deleted either — the user
    // may still be able to restore the vault on another device.
    const [encrypted, cleartext] = partition(stored, isEncryptedAccount);
    for (const record of cleartext as Account[]) seeds.set(record, secretKey(record.secret));
    return finish(cleartext as Account[], encrypted);
  }

  const { dataKey } = await requireKeys();
  const decoded: Account[] = [];
  const held: StoredAccount[] = [];

  for (const record of stored) {
    if (!isEncryptedAccount(record)) {
      seeds.set(record, secretKey(record.secret));
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
      // Ciphertext that opens to something with no secret in it is as useless
      // to the list as a `null` would be, and as worth keeping.
      if (!opensToAccount(fields)) throw new Error('Decrypted record has no secret');
      seeds.set(record, secretKey(fields.secret));
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

  return finish(decoded, held);
}

/**
 * Decode what is on disk, remembering the records that could not be read.
 */
export async function decodeAccounts(stored: StoredAccount[]): Promise<Account[]> {
  return (await decodeHeld(stored)).accounts;
}

async function decodeHeld(stored: StoredAccount[]): Promise<Decoded> {
  const decoded = await decodeDetailed(stored);
  quarantined = decoded.held;
  return decoded;
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

/**
 * What the local/sync merge compares by.
 *
 * Not the raw secret: decodeRecords collapses duplicates by the normalised one.
 * A sync copy spelling a seed differently (lowercase, spaced, padded) passed
 * the merge as a new account, was persisted to local, then collapsed again on
 * decode — so the store held more records than the UI could see, and
 * saveAccounts' shrink guard refused every add from then on. Tombstones still
 * carry the raw spelling too; see tombstoneIdentities.
 *
 * A quarantined non-record is compared by its whole serialised self, so the
 * same `null` arriving from sync on every read is merged once, not every time.
 */
function mergeKey(record: StoredAccount): string {
  if (!isUsableRecord(record)) return `unusable:${JSON.stringify(record) ?? String(record)}`;
  return isEncryptedAccount(record) ? record.fp : secretKey(record.secret);
}

/**
 * Every identity a deletion is recorded under, and a re-add forgets.
 *
 * Both spellings of a cleartext seed. Markers written before 1.13.4 hash the
 * raw secret, so the raw one has to keep being checked; but the merge compares
 * normalised keys, and a sync copy spelling the deleted seed differently — an
 * older device's `jbsw y3dp…` for this one's `JBSWY3DP…` — matched no marker
 * and came straight back after every delete.
 */
function tombstoneIdentities(record: StoredAccount): string[] {
  if (!isUsableRecord(record)) return [];
  if (isEncryptedAccount(record)) return [record.fp];
  const normalised = secretKey(record.secret);
  return normalised === record.secret ? [record.secret] : [record.secret, normalised];
}

/**
 * Every form a seed's copies can take, in and out of the vault.
 *
 * tombstoneIdentities describes one record in the form it is stored in — the
 * secret for cleartext, the fingerprint for ciphertext — and the merge used to
 * compare an arriving copy only in ITS form. A seed deleted with protection
 * off was marked by its secret; switch protection on, and another device's
 * encrypted copy of it arrives as a fingerprint no marker names, and the
 * account is back. The other way round the same. So a deletion is recorded
 * under the secret in both spellings AND, while a vault is open, under the
 * fingerprint of each — and the merge checks an arriving copy in every form it
 * can compute (see syncAdditions).
 *
 * The marker hash itself is unchanged: markers already on disk hash exactly
 * these strings.
 */
async function seedIdentities(secrets: string[]): Promise<string[]> {
  const forms = new Set<string>();
  for (const secret of secrets) {
    forms.add(secret);
    forms.add(secretKey(secret));
  }
  const fingerprintKey = await openFingerprintKey();
  if (fingerprintKey) {
    for (const form of [...forms]) forms.add(await fingerprintSecret(fingerprintKey, form));
  }
  return [...forms];
}

/** The key fingerprints are made with, or null when there is no open vault. */
async function openFingerprintKey(): Promise<CryptoKey | null> {
  if (!(await getVaultMeta())) return null;
  const masterKeyBytes = await getMasterKeyBytes();
  if (!masterKeyBytes) return null;
  return (await deriveKeys(masterKeyBytes)).fingerprintKey;
}

/** What a change retires: the seed that leaves the list, in every form it was stored. */
interface Retired {
  /** Identities of the stored records, exactly as the merge compares them. */
  identities: string[];
  /** The seed itself, to be recorded in the forms it was NOT stored in as well. */
  secrets: string[];
}

/**
 * Every stored copy of the seed behind `id` — the record with that id, and the
 * hidden copies the list folded into its card, which carry their own spelling
 * or their own fingerprint. Taken from the stored records rather than
 * recomputed from the decoded account, so they match exactly what the merge
 * will compare a stale sync copy against.
 */
function retiredCopies(
  stored: StoredAccount[],
  seedOf: (record: StoredAccount) => string | undefined,
  id: string,
  seed: string | undefined
): Retired {
  const copies = stored
    .filter(isUsableRecord)
    .filter(record => record.id === id || (seed !== undefined && seedOf(record) === seed));
  const secrets = new Set<string>();
  for (const record of copies) {
    const opened = seedOf(record);
    if (opened !== undefined) secrets.add(opened);
    if (!isEncryptedAccount(record)) secrets.add(record.secret);
  }
  if (seed !== undefined) secrets.add(seed);
  return { identities: copies.flatMap(tombstoneIdentities), secrets: [...secrets] };
}

/** Record a retired seed as deleted here. Best-effort, like every marker write. */
async function markRetired(retired: Retired): Promise<void> {
  const identities = [...retired.identities, ...(await seedIdentities(retired.secrets).catch(() => retired.secrets))];
  await markDeleted([...new Set(identities)]).catch(() => {});
}

/**
 * Give every readable record an id of its own.
 *
 * `deleteAccount` filters by id and `reorderAccounts` looks accounts up by it,
 * so two records sharing one — a hand-edited backup, an older import, two
 * devices that each minted "imported-<same ms>-0" — meant deleting either card
 * deleted both, and a drag wrote one of them twice and lost the other. A record
 * with no id at all rendered as a card nothing could address. The first holder
 * of an id keeps it; the rest get a suffix, deterministic so that two contexts
 * repairing the same list agree on the result.
 */
function repairIds(records: StoredAccount[]): { records: StoredAccount[]; changed: boolean } {
  const idOf = (record: StoredAccount): unknown => (record as { id?: unknown }).id;
  const taken = new Set<string>();
  for (const record of records) {
    const id = record && typeof record === 'object' ? idOf(record) : undefined;
    if (typeof id === 'string') taken.add(id);
  }

  const seen = new Set<string>();
  let changed = false;
  const repaired = records.map(record => {
    if (!isUsableRecord(record)) return record;
    const id = idOf(record);
    if (typeof id === 'string' && id !== '' && !seen.has(id)) {
      seen.add(id);
      return record;
    }

    const base = typeof id === 'string' && id !== '' ? id : 'account';
    let candidate = `${base}-2`;
    for (let n = 3; taken.has(candidate) || seen.has(candidate); n++) candidate = `${base}-${n}`;
    seen.add(candidate);
    taken.add(candidate);
    changed = true;
    return { ...record, id: candidate };
  });

  return { records: repaired, changed };
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
//
// A device with sync switched off does not read the sync area at all. It used
// to merge it regardless, so the setting stopped this machine's accounts going
// up but went on pulling every other machine's down — and, since each read
// persisted what it merged, keeping them here for good.
export async function getStoredAccounts(): Promise<StoredAccount[]> {
  // Read without the lock: most reads find nothing to write, and every open
  // surface reloads on every storage event. Only a read that would change what
  // is on disk takes the lock, and then decides again from a fresh read.
  let read = await retryOperation(() => readStored(false));
  if (read.dirty) {
    read = await withAccountsLock(() => retryOperation(() => readStored(true)));
  }
  if (read.syncReadable) await replayHeldSyncPush();
  return read.records;
}

interface StoredRead {
  records: StoredAccount[];
  /** The stamp that describes `records` — after the merge's own write, if any. */
  revision: number;
  /** The read would change local: a merge to persist, ids to repair. */
  dirty: boolean;
  syncReadable: boolean;
}

/**
 * Local, merged with sync, with ids repaired.
 *
 * `persist` may only be true while holding the accounts lock: it writes the
 * merged list back, and an unlocked write here is exactly the lost update the
 * lock exists to prevent — a surface reloading on a storage event wrote its
 * merge over an account another surface had added a moment before.
 */
async function readStored(persist: boolean, options: { noteRead?: boolean } = {}): Promise<StoredRead> {
  const localResult = await chrome.storage.local.get([STORAGE_KEY, REVISION_KEY]);
  const rawLocal = localResult[STORAGE_KEY];
  // Something that is not a list is kept as one quarantined entry rather than
  // read as "no accounts" — which the next save would have written over.
  const localAccounts: StoredAccount[] =
    Array.isArray(rawLocal) ? rawLocal : rawLocal == null ? [] : [rawLocal];
  const revision = toRevision(localResult[REVISION_KEY]);

  let syncAccounts: StoredAccount[] = [];
  let syncReadable = false;
  if (await isSyncEnabled()) {
    try {
      syncAccounts = await readSyncRecords();
      syncReadable = true;
    } catch (syncError) {
      console.warn('Sync storage unavailable:', syncError);
    }
  }

  // Only a read that actually succeeded says anything about whether the area
  // is populated; a thrown read says nothing and must not start the clock.
  // Nor does the read a save's own push merges with: the popup's reads keep
  // the download-window latch, and a push re-arming it would hold back the
  // very write that makes the area real.
  if (syncReadable && options.noteRead !== false) {
    await noteSyncRead(syncAccounts.length, localAccounts.length);
  }

  const additions = await syncAdditions(localAccounts, syncAccounts);
  const preview = repairIds([...localAccounts, ...additions]);
  const dirty = additions.length > 0 || preview.changed;

  if (!dirty || !persist) {
    return { records: preview.records, revision, dirty, syncReadable };
  }

  // Cleartext arriving under a vault is sealed before it lands, or held back in
  // sync until this device is unlocked. Persisting it as it came meant a live
  // vault with readable secrets on disk beneath it — pushed back up to sync from
  // there on every save.
  const arriving = await sealArrivals(additions, localAccounts);
  const { records, changed } = repairIds([...localAccounts, ...arriving]);
  if (arriving.length === 0 && !changed) {
    return { records, revision, dirty: false, syncReadable };
  }

  // Persist merge so subsequent reads are stable and the auto-backup reflects
  // the full set — with the revision, in the same write, like every write.
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: records, [REVISION_KEY]: revision + 1 });
    return { records, revision: revision + 1, dirty: false, syncReadable };
  } catch {
    return { records, revision, dirty: false, syncReadable };
  }
}

/** The records in local now, exactly as they are. */
async function readLocalRecords(): Promise<StoredAccount[]> {
  const raw = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  return Array.isArray(raw) ? raw : raw == null ? [] : [raw];
}

/** What sync holds that local does not, minus what this device deleted. */
async function syncAdditions(
  localAccounts: StoredAccount[],
  syncAccounts: StoredAccount[]
): Promise<StoredAccount[]> {
  if (syncAccounts.length === 0) return [];

  const seen = new Set(localAccounts.map(mergeKey));
  const candidates: StoredAccount[] = [];
  for (const acc of syncAccounts) {
    const key = mergeKey(acc);
    if (seen.has(key)) continue;
    // Two chunks carrying one record — a push that died between writing the
    // new chunks and pruning the old ones — is one record, not two.
    seen.add(key);
    candidates.push(acc);
  }
  if (candidates.length === 0) return [];

  // "In sync but not local" is usually another device's account — but it is
  // also exactly what a record this device just deleted looks like, until the
  // sync write catches up. Without this the reload after a delete put the
  // account straight back, and a second delete was needed to make it stick.
  const wasDeletedHere = await deletedHere();
  const formsOf = await arrivalIdentities();
  const additions: StoredAccount[] = [];
  for (const acc of candidates) {
    const identities = await formsOf(acc);
    // Ciphertext of this vault while it is locked: which seed it holds cannot
    // be known, so neither can whether it was deleted here. It stays in sync
    // and is merged by the first read after the unlock — the same wait
    // sealArrivals gives cleartext, and nothing reads the list while locked.
    if (identities === null) continue;
    let deleted = false;
    for (const identity of identities) {
      if (await wasDeletedHere(identity)) deleted = true;
    }
    if (!deleted) additions.push(acc);
  }
  return additions;
}

/**
 * Every identity an arriving sync record could have been deleted under.
 *
 * Its own (tombstoneIdentities), plus the forms it would take on the other side
 * of the vault: a cleartext copy's fingerprints while a vault is open, and an
 * encrypted copy's secret once it is opened. A deletion made before the vault
 * was switched on — or after it was switched off — is recorded in the other
 * form, and checking only the arriving one let the account back in.
 *
 * `null` for ciphertext of the current vault while it is locked.
 */
async function arrivalIdentities(): Promise<(record: StoredAccount) => Promise<string[] | null>> {
  const meta = await getVaultMeta();
  const masterKeyBytes = meta ? await getMasterKeyBytes() : null;
  const keys = masterKeyBytes ? await deriveKeys(masterKeyBytes) : null;

  return async record => {
    const own = tombstoneIdentities(record);
    if (!isUsableRecord(record)) return own;

    if (!isEncryptedAccount(record)) {
      if (!keys) return own;
      const forms = new Set(own);
      for (const form of own) forms.add(await fingerprintSecret(keys.fingerprintKey, form));
      return [...forms];
    }

    // Another vault's record is held, never opened; its fingerprint is all
    // there is to compare, and all a deletion here could have recorded.
    if (!meta || !belongsToVault(record, meta.vaultId)) return own;
    if (!keys) return null;
    try {
      const fields = await decryptJson<Omit<Account, 'id'>>(record.enc, keys.dataKey);
      if (!opensToAccount(fields)) return own;
      return [...new Set([...own, fields.secret, secretKey(fields.secret)])];
    } catch {
      return own;
    }
  };
}

/**
 * Encrypt the cleartext accounts arriving from sync, if a vault is on.
 *
 * Locked, they are left out: they are still in sync, so the first read after
 * the unlock merges them again and seals them then. Only arrivals — this
 * device's own records are never dropped here, whatever shape they are in.
 */
async function sealArrivals(
  additions: StoredAccount[],
  localAccounts: StoredAccount[]
): Promise<StoredAccount[]> {
  const isCleartext = (record: StoredAccount) => isUsableRecord(record) && !isEncryptedAccount(record);
  if (!additions.some(isCleartext)) return additions;

  const meta = await getVaultMeta();
  if (!meta) return additions;
  if (!(await getMasterKeyBytes())) return additions.filter(record => !isCleartext(record));

  // Sealed in its cleaned spelling, and dropped when local already holds that
  // fingerprint. The cleartext copy stays in sync until some save pushes over
  // it, and the merge compares it by secret while the sealed copy in local is
  // compared by fingerprint — so without this every read took it for a new
  // arrival, sealed it again and appended it again. Each of those writes fired
  // onChanged, every open window reloaded, and the loop fed itself: hundreds of
  // records and storage events a second, from one old device pushing cleartext.
  const present = new Set(localAccounts.filter(isEncryptedAccount).map(record => record.fp));
  const sealed: StoredAccount[] = [];
  for (const record of additions) {
    if (!isCleartext(record)) {
      sealed.push(record);
      continue;
    }
    const account = withTextFields({ ...(record as Account), secret: cleanSecret((record as Account).secret) });
    const [encrypted] = await encodeAccounts([account], meta);
    if (present.has((encrypted as EncryptedAccount).fp)) continue;
    present.add((encrypted as EncryptedAccount).fp);
    sealed.push(encrypted);
  }
  return sealed;
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

/**
 * How many accounts this device holds, from local storage alone. For the
 * billing check-in: a full read merges sync and starts the sync download
 * window, and the service worker checks in at install time — before a new
 * computer has received its synced accounts. Started there, the window had
 * run out by the time they arrived, and the first account added by hand could
 * then overwrite the only cloud copy. Throws like getAccounts (locked vault).
 */
export async function countLocalAccounts(): Promise<number> {
  return (await decodeAccounts(await readLocalRecords())).length;
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

/**
 * How many records a read of `stored` yields: accounts plus quarantine.
 *
 * The shrink guard has to count what the caller could have seen, not raw
 * records. Duplicates of one seed collapse on decode, and a store that already
 * held some — merged in by an older build, or two encodings of one seed from
 * encrypted and cleartext devices — made every save "a shrink", so nothing
 * could be added ever again.
 */
async function visibleCount(stored: StoredAccount[]): Promise<number> {
  const { accounts, held } = await decodeRecords(stored);
  return accounts.length + held.length;
}

/** Another writer got in between this one's read and its write. */
class WriteConflict extends Error {
  constructor() {
    super('The account list changed while this change was being saved');
    this.name = 'WriteConflict';
  }
}

export async function saveAccounts(accounts: Account[], options: SaveOptions = {}): Promise<void> {
  await withAccountsLock(() => writeAccounts(accounts, options));
  await pushAfterSave(options);
}

/**
 * The write itself. Callers hold the accounts lock.
 *
 * Everything the write depends on is decided from ONE read taken after the
 * slow part: the records it replaces (for the shrink guard and for which
 * identities are new), the revision, and the vault metadata. Deciding from
 * values read before the encryption is how a save encoded as cleartext landed
 * on top of a vault switched on meanwhile, and how ciphertext landed after the
 * vault was switched off — with its key about to be deleted.
 */
async function writeAccounts(
  accounts: Account[],
  options: SaveOptions & { expectRevision?: number; held?: StoredAccount[] } = {}
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const meta = await getVaultMeta();
    const records = [...(await encodeAccounts(accounts, meta)), ...(options.held ?? quarantined)];

    const current = await chrome.storage.local.get([STORAGE_KEY, REVISION_KEY, VAULT_META_KEY]);
    const onDisk = (current[VAULT_META_KEY] as VaultMeta | undefined)?.vaultId ?? null;
    if (onDisk !== (meta?.vaultId ?? null)) {
      // Encode again against the vault that is actually there. If it is locked
      // that throws VaultLockedError — the right answer: nothing in the clear
      // goes under a vault, and nothing goes out under a key that is gone.
      if (attempt < 2) continue;
      throw new Error('Password protection changed while saving — nothing was written');
    }

    const revision = toRevision(current[REVISION_KEY]);
    if (options.expectRevision !== undefined && revision !== options.expectRevision) {
      throw new WriteConflict();
    }

    const existing: StoredAccount[] = Array.isArray(current[STORAGE_KEY]) ? current[STORAGE_KEY] : [];

    // Last line of defence against the whole class of bugs where a partial read
    // becomes a destructive write. Deleting is the only operation that may shrink
    // the store, and it says so explicitly.
    if (!options.allowShrink) {
      const existingCount = await visibleCount(existing);
      if (records.length < existingCount) {
        throw new Error(
          `Refusing to save ${records.length} accounts over ${existingCount} already stored`
        );
      }
    }

    // The revision moves with the records, in the same write, so a reader can
    // never see a list newer than the stamp that describes it.
    // Local is the source of truth — must succeed or we throw.
    await retryOperation(() =>
      chrome.storage.local.set({ [STORAGE_KEY]: records, [REVISION_KEY]: revision + 1 })
    );

    // An account that is present again is one the user wants back — a re-scanned
    // QR, a restored backup — so whatever marked it deleted has to go. Doing it
    // here covers add, import and restore in one place.
    //
    // Only for what this write ADDS. It used to forget every identity in the
    // list, and a writer that had read before another surface's delete wrote
    // the deleted record back AND wiped the marker that would have kept its sync
    // copy out: deleted, back, and staying back.
    //
    // In every form the seed could have been marked in, not only the one it is
    // written in now: a deletion recorded with the vault off is a marker on the
    // secret, and re-adding the account under a vault writes a fingerprint.
    // Forgetting only that left the old marker to hide the account's sync copy
    // on the day protection was switched off again.
    const before = new Set(existing.map(mergeKey));
    const arriving = records.filter(record => !before.has(mergeKey(record)));
    const arrivingSecrets = accounts
      .filter((_, index) => !before.has(mergeKey(records[index])))
      .map(account => account.secret);
    const forms = await seedIdentities(arrivingSecrets).catch(() => arrivingSecrets);
    await forgetDeleted([...arriving.flatMap(tombstoneIdentities), ...forms]).catch(() => {});
    return;
  }
}

/**
 * Bring sync up to date with local, from a read taken at the moment of pushing.
 *
 * Not from the list the save just wrote. Pushes are not awaited by most saves,
 * so two saves from two surfaces push in whatever order the browser finishes
 * them, and the older list landing last put a deleted account back in sync and
 * left a new one out. Under the lock, reading then, the last push to run always
 * carries the newest list.
 *
 * `merge` folds in what sync holds first — minus what this device deleted —
 * where sync may carry other devices' accounts that local has never seen, and
 * a push of local alone would prune them. Every push merges now, a save's own
 * included. It once did not, on the reasoning that merging would put back what
 * the save had just removed; but a delete marks the seed deleted before it
 * writes (and so does a secret replaced in an edit), so the merge leaves it
 * out, while an unmerged push overwrote the chunk that held an account another
 * device had written after this one's last read — gone from sync, and never
 * having reached local, gone for good once that device dropped it too.
 */
function pushLatest(options: PushOptions & { merge?: boolean; noteRead?: boolean } = {}): Promise<void> {
  return withAccountsLock(async () => {
    const records = options.merge
      ? (await readStored(true, { noteRead: options.noteRead })).records
      : await readLocalRecords();
    await pushToSync(records, options);
  });
}

function pushAfterSave(options: SaveOptions): Promise<void> {
  // Sync is best-effort: failures here (e.g. QUOTA_BYTES_PER_ITEM exceeded
  // with many accounts) must not block the save or be retried.
  const push = pushLatest({ merge: true, noteRead: false }).catch(syncError => {
    console.warn('Sync storage failed (local save succeeded):', syncError);
  });
  return options.awaitSync ? push : Promise.resolve();
}

/**
 * Where the account list is edited.
 *
 * Every mutation here is a read-modify-write over one array, and until 1.13.0
 * there was only ever one surface open to do it from: an action popup dies the
 * moment it loses focus. That release added a floating window and a side panel
 * that stay open for hours, alongside the scanner tab and the passkey page — so
 * two contexts reading the same list, each adding one account, each writing
 * what it computed, became an ordinary sequence rather than a thought
 * experiment. The later write wins and the earlier account is gone, with a
 * cheerful "Account added" on both screens. The length guard in saveAccounts
 * does not catch it: eleven accounts written over eleven is not a shrink.
 *
 * 1.13.0 answered with a per-context queue plus a revision stamp compared
 * before the save. That narrowed the window without closing it: between the
 * comparison and the write sat the encryption, the shrink guard's read and the
 * revision's own read, and with real storage latency another surface's write
 * landed there constantly — a delete racing an add resurrected the deleted
 * account 48 times in 50.
 *
 * Now the whole read-decide-write runs under the cross-context accounts lock
 * (write-lock.ts). The revision stays, checked in the write's own read, for the
 * one case the lock cannot cover: a browser without Web Locks, where the
 * fallback only serialises this context.
 *
 * The counter lives under its own key. 1.12.0 ignores keys it does not know, so
 * a browser rollback reads the account list exactly as before.
 */
const REVISION_KEY = 'authenticator_accounts_rev';

function toRevision(value: unknown): number {
  // A revision we cannot read is one we cannot compare. Zero means the check
  // never fires, which is never worse than before the counter existed.
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

type Apply<T> = (
  accounts: Account[],
  stored: StoredAccount[],
  seedOf: (record: StoredAccount) => string | undefined
) => {
  /** `null` when there is nothing to change, so nothing is written. */
  accounts: Account[] | null;
  result: T;
};

/**
 * Run `apply` against the current account list and save what it returns.
 *
 * `apply` must be re-runnable: without Web Locks it is called again, on a
 * freshly read list, if another context wrote while this one was deciding.
 */
async function mutateAccounts<T>(
  apply: Apply<T>,
  options: SaveOptions & { beforeSave?: (result: T) => Promise<void> } = {}
): Promise<T> {
  let wrote = false;
  const outcome = await withAccountsLock(async () => {
    // Three attempts, not one: two is enough for a single competing writer, and
    // the third is for the case where the retry itself is raced. Past that the
    // contention is not something more attempts will fix.
    for (let attempt = 0; ; attempt++) {
      // Both shapes come out of one read. Deleting needs the stored record to
      // work out the identity a stale sync copy will be compared against, and
      // reading that separately would put the race back where it started.
      const { records: stored, revision } = await retryOperation(() => readStored(true));
      const decoded = await decodeHeld(stored);
      const { accounts, result } = apply(decoded.accounts, stored, decoded.seedOf);
      if (accounts === null) return result;

      await options.beforeSave?.(result);
      try {
        // The held records from THIS read, not the module-wide list: a reload
        // in this same page, running outside the lock, decodes whatever it read
        // and replaces that list — possibly with an older one missing a record
        // this read has just merged in from sync.
        await writeAccounts(accounts, { ...options, expectRevision: revision, held: decoded.held });
      } catch (error) {
        if (error instanceof WriteConflict && attempt < 2) continue;
        throw error;
      }
      wrote = true;
      return result;
    }
  });

  if (wrote) await pushAfterSave(options);
  return outcome;
}

/**
 * False when the seed was already here, so nothing was written.
 *
 * `origin` is required: an account added by the person counts against the
 * free limit (billing/gate.ts), an undone delete does not. The check runs here,
 * inside the lock that every window shares, so two windows cannot both take
 * the last free slot. It throws AccountLimitError before anything is written.
 */
export async function addAccount(account: Account, origin: AddOrigin): Promise<boolean> {
  return mutateAccounts(accounts => {
    // Deduplicated like every other way in, which this one was not.
    //
    // getAccounts collapses records that share a secret, so a second record
    // with the same seed was written to disk and then hidden from every view.
    // From there on the store and the list disagreed: a rename or a drag
    // computed eleven accounts over the twelve on disk and was refused by the
    // shrink guard — a Save button that simply stopped working — and the next
    // import wrote the collapsed list back, deleting the hidden record for
    // good under a cheerful "Account added".
    //
    // Unless it is the Steam Guard account the list holds as plain TOTP: then
    // the card is switched to Steam codes in place, and that is reported as
    // done — the account is now as the user just scanned it.
    const key = secretKey(account.secret);
    const at = accounts.findIndex(existing => secretKey(existing.secret) === key);
    if (at !== -1) {
      if (!becomesSteam(accounts[at], account)) return { accounts: null, result: false };
      const next = [...accounts];
      next[at] = asSteam(accounts[at], account);
      return { accounts: next, result: true };
    }
    admit(origin, accounts.length, 1);
    // At the top: the account just added is the one the person is about to
    // type a code from, and at the bottom of a long list it was out of sight.
    return { accounts: [account, ...accounts], result: true };
  });
}

export async function addMultipleAccounts(
  newAccounts: Account[],
  origin: AddOrigin,
  options: { continuesBatch?: boolean } = {}
): Promise<{ added: number; skipped: number; total: number; updated: number; leftOut: number }> {
  return mutateAccounts((accounts, stored) => {
    const merged = mergeIncoming(newAccounts, accounts, stored, 'added');
    const limited = withinLimit(merged, accounts.length, origin);
    const admitted = options.continuesBatch
      ? { ...limited, accounts: belowRecent(limited.accounts, limited.added, accounts) }
      : limited;
    const result = {
      added: admitted.added,
      skipped: newAccounts.length - merged.added - merged.updated,
      total: newAccounts.length,
      updated: merged.updated,
      leftOut: merged.added - admitted.added,
    };
    return { accounts: admitted.accounts, result };
  });
}

/**
 * The second and later codes of one Google Authenticator export.
 *
 * New accounts go to the top, so each code of a split export landed above the
 * one before it: three codes came out as 21–30, 11–20, 1–10. A code with a
 * batch index past 1 goes below the accounts added just before it instead —
 * the earlier codes of the same export, scanned a minute ago — and above the
 * rest, so the export reads in its own order. "Just before" is the run at the
 * top created in the last quarter of an hour: the export's own codes carry no
 * shared id the list keeps.
 */
const BATCH_WINDOW_MS = 15 * 60_000;

function belowRecent(merged: Account[], added: number, before: Account[]): Account[] {
  if (added === 0) return merged;
  const since = Date.now() - BATCH_WINDOW_MS;
  let at = 0;
  while (at < before.length && (before[at].createdAt ?? 0) >= since) at++;
  if (at === 0) return merged;
  const fresh = merged.slice(0, added);
  const rest = merged.slice(added);
  return [...rest.slice(0, at), ...fresh, ...rest.slice(at)];
}

/**
 * The merged list cut to what the limit admits. New accounts are the head of
 * the merged list (mergeIncoming puts them first, in order), so keeping the
 * first `n` of them is keeping the first `n` the person brought — the order of
 * the file, or of the export QR. Upgrades of accounts already here are not new
 * accounts and always stay.
 */
function withinLimit(merged: Merged, count: number, origin: AddOrigin): { accounts: Account[]; added: number } {
  const keep = admit(origin, count, merged.added, merged.updated);
  if (keep >= merged.added) return { accounts: merged.accounts, added: merged.added };
  return { accounts: [...merged.accounts.slice(0, keep), ...merged.accounts.slice(merged.added)], added: keep };
}

export async function reorderAccounts(accountIds: string[]): Promise<void> {
  await mutateAccounts(accounts => {
    // Picked by object, never twice. Looking each id up with `find` wrote the
    // first holder of a shared id once per mention and dropped the other
    // holder: ['c', 'dup', 'dup'] saved one account twice and lost one. Ids are
    // repaired on read now, but a stale list from React can still name one
    // twice, and the list must come out a permutation whatever it is told.
    const picked = new Set<Account>();
    const ordered: Account[] = [];
    for (const id of accountIds) {
      const account = accounts.find(acc => acc.id === id && !picked.has(acc));
      if (!account) continue;
      picked.add(account);
      ordered.push(account);
    }

    // Anything the caller did not mention keeps its place at the end instead of
    // being deleted. The id list comes from React state, which goes stale the
    // moment the scanner tab adds an account — a drag must not cost the user that
    // account.
    const untouched = accounts.filter(acc => !picked.has(acc));

    return { accounts: [...ordered, ...untouched], result: undefined };
  });
}

/**
 * False when no account has this id — deleted in another window while the
 * edit form was open — so nothing was saved and the caller can say so rather
 * than report a change that went nowhere.
 */
export async function updateAccount(id: string, updates: Partial<Account>): Promise<boolean> {
  const outcome = await mutateAccounts<{ found: boolean; retired: Retired | null }>(
    (accounts, stored, seedOf) => {
      const index = accounts.findIndex(acc => acc.id === id);
      if (index === -1) return { accounts: null, result: { found: false, retired: null } };

      const merged = { ...accounts[index], ...updates };

      // An explicit `undefined` means "clear this field" — clearing an account's
      // group, say. Spreading it leaves the key present with an undefined value,
      // which chrome.storage serialises as null, and `null.trim()` throws on the
      // next read. Drop the key instead.
      for (const key of Object.keys(updates) as (keyof Account)[]) {
        if (updates[key] === undefined) delete merged[key];
      }

      const next = [...accounts];
      next[index] = merged;

      // A new secret retires the old one exactly as a delete does. Replacing an
      // "Invalid key" is the usual case: the old seed's sync copy is still up
      // there, and with no marker the next read took it for another device's
      // account and put it back beside the fixed one — the broken card the user
      // had just repaired, returning as a duplicate.
      const oldSeed = secretKey(accounts[index].secret);
      const replaced = typeof merged.secret === 'string' && secretKey(merged.secret) !== oldSeed;
      return {
        accounts: next,
        result: { found: true, retired: replaced ? retiredCopies(stored, seedOf, id, oldSeed) : null },
      };
    },
    // Before the write, as for a delete: the write fires onChanged, and the
    // reload it triggers must already find the marker.
    { beforeSave: ({ retired }) => (retired ? markRetired(retired) : Promise.resolve()) }
  );
  return outcome.found;
}

export async function deleteAccount(id: string): Promise<void> {
  // Deleting is the one operation allowed to shrink the store, so the length
  // guard steps aside for it — which is precisely when an account added in
  // another surface has nothing standing between it and being written over.
  // The lock is what replaces the guard here.
  await mutateAccounts(
    (accounts, stored, seedOf) => {
      const target = accounts.find(acc => acc.id === id);
      const seed = target ? secretKey(target.secret) : undefined;
      if (!target && !stored.some(record => isUsableRecord(record) && record.id === id)) {
        // Already gone — deleted in another window. Nothing to write.
        return { accounts: null, result: { identities: [], secrets: [] } };
      }
      return {
        accounts: accounts.filter(acc => acc.id !== id),
        // Every record of the same seed, not only the one with this id. The
        // list folds duplicates into one card, so deleting that card drops the
        // hidden copies from local too — and their sync copies, carrying their
        // own spelling or their own fingerprint, matched no marker and put the
        // account straight back. And in every form, not only the stored one:
        // see seedIdentities.
        result: retiredCopies(stored, seedOf, id, seed),
      };
    },
    {
      allowShrink: true,
      awaitSync: true,
      // Before the write, not after it. The local write fires onChanged, and
      // since 1.13.0 every open surface reloads on it — a read that sees the
      // stale sync copy and no tombstone yet merges the account straight back.
      // saveAccounts only forgets identities it adds, so an early marker
      // survives the save it precedes.
      beforeSave: markRetired,
    }
  );
}

export async function exportAccounts(): Promise<string> {
  const accounts = await getAccounts();
  return JSON.stringify(accounts, null, 2);
}

export async function importAccounts(jsonData: string, origin: AddOrigin): Promise<ImportReport & { leftOut: number }> {
  let file: ImportFile;
  try {
    // Our own plain export, a bare array from before 1.2, or another
    // authenticator's JSON — readImportFile tells them apart.
    file = readImportFile(JSON.parse(jsonData));
  } catch (error) {
    // Not JSON at all is the likeliest shape of another app's sealed backup
    // (Alibaba Cloud's, for one). Said as such rather than as "invalid format",
    // which reads as "your backup is damaged" to someone whose backup is fine
    // and simply not ours to open.
    if (error instanceof ImportRejectedError) throw error;
    console.error('Error importing accounts: not a JSON document');
    throw new ImportRejectedError('unknown-format');
  }

  return await importAccountList(file.entries, origin, file);
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

/**
 * Coerce one entry from a file into an Account, or return null if it is beyond
 * saving. The rules live in import-formats.ts, where every importer shares
 * them; this is the shape restoreFromSnapshot wants.
 */
function normalizeImported(entry: unknown, index: number): Account | null {
  const result = normalizeEntry(entry, index);
  return 'account' in result ? result.account : null;
}

/**
 * Shared merge path for JSON, encrypted-file, CXF and other apps' files.
 *
 * `from` carries what the file reader already refused, so the report counts
 * every entry in the file rather than only the ones that reached this list.
 * Throws ImportRejectedError when entries arrived and none can be stored.
 */
export async function importAccountList(
  importedAccounts: unknown[],
  origin: AddOrigin,
  from: Partial<Omit<ImportFile, 'entries'>> = {}
): Promise<ImportReport & { updated: number; leftOut: number }> {
  if (!Array.isArray(importedAccounts)) {
    throw new Error('Invalid format');
  }

  const { usable, unreadable, unsupported } = planImport({
    entries: importedAccounts,
    unreadable: from.unreadable ?? 0,
    unsupported: from.unsupported ?? 0,
    recognised: from.recognised ?? true,
  });

  if (usable.length === 0) {
    // An empty file. Nothing to write, and saving the list over itself would
    // cost a sync push for nothing.
    return { added: 0, updated: 0, alreadyHere: 0, unreadable, unsupported, leftOut: 0 };
  }

  // De-duplicated within the file too, and ids that collide reassigned: see
  // mergeIncoming.
  return mutateAccounts((existingAccounts, stored) => {
    const merged = mergeIncoming(usable, existingAccounts, stored, 'imported');
    const admitted = withinLimit(merged, existingAccounts.length, origin);
    const result = {
      added: admitted.added,
      updated: merged.updated,
      alreadyHere: usable.length - merged.added - merged.updated,
      unreadable,
      unsupported,
      leftOut: merged.added - admitted.added,
    };
    return { accounts: admitted.accounts, result };
  });
}

export interface RestoreResult {
  /** Accounts written that were not already here. */
  added: number;
  /** Accounts in the snapshot the user still has, so nothing was written. */
  skipped: number;
  /** Records in the snapshot this device cannot read — another vault's, or damaged. */
  unreadable: number;
}

/**
 * Merge an automatic snapshot back into the store.
 *
 * Merge, never replace: the snapshot is up to a day old, and someone restoring
 * it is usually someone who has already re-added one or two accounts by hand.
 * Anything already here keeps its place, its name and its group; only accounts
 * whose secret is absent are appended. That also makes restoring twice
 * harmless, which matters when the button is pressed by someone who is not sure
 * the first press worked.
 *
 * The snapshot holds records in their on-disk form, so one taken while the
 * vault was on is ciphertext. Decoding it here means a snapshot from the vault
 * currently configured opens, one from a vault that is gone is counted rather
 * than written as junk, and cleartext from before the vault existed is
 * re-encrypted by the save.
 */
export async function restoreFromSnapshot(records: StoredAccount[]): Promise<RestoreResult> {
  // Decoded before the mutation opens, deliberately. `decodeAccounts` keeps the
  // unreadable records of the LIVE store in module state and every save writes
  // them back; decoding a snapshot through it would replace that list with the
  // snapshot's and delete the records it displaced.
  const { accounts: recovered, held } = await decodeRecords(records);

  const usable: Account[] = [];
  for (const [index, entry] of recovered.entries()) {
    const account = normalizeImported(entry, index);
    if (account) usable.push(account);
  }

  // Beyond saving after decryption — a record with no secret left in it.
  const damaged = recovered.length - usable.length;

  // Nothing to add means nothing to write. Saving the list back over itself
  // would cost a sync push and a storage event that reloads every open surface,
  // to arrive at the list they are already showing.
  if (usable.length === 0) {
    return { added: 0, skipped: 0, unreadable: held.length + damaged };
  }

  return mutateAccounts((existingAccounts, stored) => {
    // Only additions: a restore puts back what is missing and changes nothing
    // that is here, a Steam type included — the copy is up to a day older than
    // the list, and whatever it holds, the list is what the user has since
    // made of it.
    const merged = mergeIncoming(usable, existingAccounts, stored, 'restored');
    const additions = merged.accounts.slice(0, merged.added);
    return {
      accounts: [...additions, ...existingAccounts],
      result: {
        added: additions.length,
        skipped: usable.length - additions.length,
        unreadable: held.length + damaged,
      },
    };
  });
}

/**
 * Whether `incoming` is a Steam Guard account the list holds as plain TOTP.
 *
 * The same secret drives both — Steam Guard is HMAC-SHA1 over 30-second steps
 * too — so dedupe by secret alone called the Steam entry "already here" and
 * kept the record that prints six digits Steam never accepts. That record is
 * what every build before Steam support made of a Steam secret, so it is the
 * shape a user fixing their list by importing a maFile or an Aegis backup
 * actually has. The other way round is not an upgrade: a TOTP entry for a
 * seed held as Steam is the older build's reading, and must not flatten it.
 */
function becomesSteam(existing: Account, incoming: Account): boolean {
  return incoming.type === 'steam' && existing.type !== 'steam';
}

/** The existing account, now producing Steam codes; its name, group and place kept. */
function asSteam(existing: Account, incoming: Account): Account {
  return {
    ...existing,
    type: 'steam',
    algorithm: incoming.algorithm,
    digits: incoming.digits,
    period: incoming.period,
  };
}

interface Merged {
  /** The new accounts, in the order they came, then the existing list, upgraded where it needed to be. */
  accounts: Account[];
  /** New accounts, at the head of `accounts`. */
  added: number;
  /** Accounts already here that the incoming list changed — Steam over TOTP. */
  updated: number;
}

/**
 * Fold `incoming` into the list: new seeds appended, known ones left alone.
 *
 * Deduplicated against the store AND against each other: a file can carry one
 * seed twice — a password manager export with the same TOTP on two items, or
 * one secret in two spellings. Appending both stored a record the list folds
 * away, and the count said two were added where one appeared.
 *
 * The one change made to an account that is already here is its type, when a
 * Steam entry arrives for a seed held as TOTP (see becomesSteam).
 */
function mergeIncoming(
  incoming: Account[],
  existingAccounts: Account[],
  stored: StoredAccount[],
  idSuffix: string
): Merged {
  const list = [...existingAccounts];
  /** Accounts not here before, in the order they came; they go above the existing ones. */
  const fresh: Account[] = [];
  /** Where each seed already in the list sits in `list`, or — from list.length on — in `fresh`. */
  const known = new Map(list.map((acc, index) => [secretKey(acc.secret), index]));
  // Ids from the stored records too, not only the decoded ones: a record this
  // device cannot read still occupies its id, and it is invisible to the list
  // the caller sees.
  const usedIds = new Set([
    ...existingAccounts.map(acc => acc.id),
    ...stored.filter(isUsableRecord).map(record => record.id),
  ]);
  let added = 0;
  const updated = new Set<number>();

  for (const account of incoming) {
    const key = secretKey(account.secret);
    const at = known.get(key);
    if (at !== undefined) {
      // An account that was here before this import; one the same file
      // added a line earlier is a duplicate inside the file, not an update.
      if (at < list.length) {
        if (becomesSteam(list[at], account)) {
          list[at] = asSteam(list[at], account);
          updated.add(at);
        }
      } else if (becomesSteam(fresh[at - list.length], account)) {
        fresh[at - list.length] = asSteam(fresh[at - list.length], account);
      }
      continue;
    }
    known.set(key, list.length + fresh.length);
    added++;

    // Same id, different secret: two accounts, one identity. `deleteAccount`
    // filters the list by id, so deleting either would have deleted both.
    // Ids survive an export and an import, so a hand-edited backup or a file
    // restored twice under different secrets is all it takes.
    if (usedIds.has(account.id)) {
      let candidate = `${account.id}-${idSuffix}`;
      for (let n = 2; usedIds.has(candidate); n++) candidate = `${account.id}-${idSuffix}-${n}`;
      fresh.push({ ...account, id: candidate });
      usedIds.add(candidate);
      continue;
    }

    usedIds.add(account.id);
    fresh.push(account);
  }

  return { accounts: [...fresh, ...list], added, updated: updated.size };
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

  const commitLocked = async (): Promise<void> => {
    // Asked again, not only in `prepare`.
    //
    // The check up there runs before a screen the user is expected to linger
    // on, copying a recovery code onto paper — and 1.13.0 lets them open
    // Settings in the floating window and the side panel at once. Both could
    // pass the prepare-time check and both commit: the second overwrites the
    // first's metadata, so the recovery code already written down opens
    // nothing, and if the second commit then fails its rollback restores the
    // FIRST vault's ciphertext and deletes the metadata that was its only key.
    // That is a vault no password on earth opens.
    if (await isVaultEnabled()) {
      throw new Error('Password protection was switched on somewhere else — nothing was changed');
    }

    // Re-read rather than reuse the list captured by `prepare`.
    //
    // The gap between the two is not a race in the narrow sense — it is a screen
    // the user is expected to linger on, copying a recovery code onto paper —
    // and the scanner runs in its own tab the whole time. Encrypting the stale
    // snapshot silently dropped anything added in between.
    //
    // This must happen before the metadata is written: with vault_meta on disk
    // and no key unlocked yet, this same read throws VaultLockedError.
    const decodedNow = await decodeHeld((await readStored(true)).records);
    const currentAccounts = decodedNow.accounts;
    // Captured by the read above: ciphertext from another vault, or records that
    // failed to decrypt. Every other write path carries them through untouched
    // (see saveAccounts); this one used to be the sole exception and erased them.
    const held = [...decodedNow.held];

    const encrypted = await encryptVerified(currentAccounts);
    const records: StoredAccount[] = [...encrypted, ...held];

    // The exact bytes currently on disk, captured before anything is
    // overwritten. Rolling back the metadata alone is not enough: once the
    // ciphertext has landed, the only key that opens it lives in vault_meta, so
    // deleting the metadata to "undo" the operation destroys every account
    // instead of restoring it.
    const previousRecords = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];

    const rollback = async (): Promise<void> => {
      // Ciphertext that was already on disk before this operation belongs to a
      // vault whose key is in the metadata. Restoring those bytes and then
      // clearing the metadata — which is what the unconditional path below
      // does, on the assumption that what came before was cleartext — leaves
      // records nothing can open. Keep the metadata and let the existing
      // password go on working.
      const restoringCiphertext =
        Array.isArray(previousRecords) && previousRecords.some(record => isEncryptedAccount(record));

      if (previousRecords !== undefined) {
        // The metadata may only be cleared once the cleartext is provably back.
        // Clearing it unconditionally — which is what happened when this restore
        // was a bare `.catch(console.error)` — turns a failed write into
        // ciphertext on disk with its key deleted: zero accounts, nothing left
        // to open them, and no second copy for anyone who has sync switched off.
        try {
          await retryOperation(() => writeStamped(previousRecords));
        } catch (err) {
          console.error(
            'Vault rollback could not restore local accounts; keeping vault_meta so the ' +
              'encrypted records stay openable:',
            err
          );
          return;
        }
        await pushToSync(previousRecords, { force: true, cleartextAllowed: true }).catch(() => {});
      }
      if (restoringCiphertext) {
        console.error(
          'Vault rollback restored encrypted records; keeping vault_meta so they stay openable'
        );
        return;
      }
      await clearVaultMeta().catch(() => {});
    };

    // Metadata first, and roll it back on any failure below. The reverse order
    // is worse: ciphertext with no metadata is unopenable, whereas metadata with
    // cleartext still under it is readable the moment the user unlocks, and the
    // next save encrypts it.
    await saveVaultMeta(meta);

    try {
      await retryOperation(() => writeStamped(records));

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

    // And cloud backup's code: with it and this install's id, the copies on our
    // server open without the password. Sealed now, while the key is in hand —
    // not later, when something happens to read it.
    await sealCodeUnderVault(masterKeyBytes, meta.vaultId);
  };

  // The whole commit under the accounts lock. Unlocked, an add in the scanner
  // tab read the list before the ciphertext landed and wrote its cleartext
  // version after it: a live vault with every secret readable beneath it, and
  // pushed to sync from there.
  const commit = (): Promise<void> => withAccountsLock(commitLocked);

  return { recoveryCode, commit };
}

/** Replace local's records, moving the revision in the same write. Lock held. */
async function writeStamped(records: unknown): Promise<void> {
  const revision = toRevision((await chrome.storage.local.get(REVISION_KEY))[REVISION_KEY]);
  await chrome.storage.local.set({ [STORAGE_KEY]: records, [REVISION_KEY]: revision + 1 });
}

/**
 * Turn the vault off. Requires the password even though the vault may already
 * be unlocked — this writes every secret back out in the clear, which should
 * never be one stray click away.
 */
export async function disableVault(password: string): Promise<void> {
  const verifiedAgainst = await getVaultMeta();
  const masterKeyBytes = await verifyPassword(password);
  const { dataKey } = await deriveKeys(masterKeyBytes);

  /** Every record in the clear, or a throw with nothing written. */
  const openAll = async (records: StoredAccount[], vaultId: string): Promise<StoredAccount[]> => {
    const accounts: Account[] = [];
    const unusable: StoredAccount[] = [];
    for (const record of records) {
      if (!isUsableRecord(record)) {
        // Quarantined junk is not ciphertext of this vault; it goes through
        // as it is, like every other write carries it.
        unusable.push(record);
        continue;
      }
      if (!isEncryptedAccount(record)) {
        accounts.push(record);
        continue;
      }
      if (!belongsToVault(record, vaultId)) {
        // A record from some other vault cannot be decrypted with this key.
        // Aborting is the only safe answer: writing the rest out would silently
        // drop it, and this is the one operation that rewrites the whole store.
        throw new Error('Some records belong to a different vault — nothing was changed');
      }
      const fields = await decryptJson<Omit<Account, 'id'>>(record.enc, dataKey);
      if (!opensToAccount(fields)) throw new Error('A record could not be opened — nothing was changed');
      accounts.push({ id: record.id, ...fields });
    }

    // Deduplicate before writing: a cleartext duplicate that arrived from an
    // older device via sync would otherwise be baked into the cleartext store,
    // where nothing downstream re-checks it.
    return [...dedupeBySecret(accounts), ...unusable];
  };

  // Under the accounts lock, start to finish. Unlocked, an add in another
  // window encoded its list while vault_meta still existed, wrote that
  // ciphertext after this function's cleartext, and then clearVaultMeta below
  // deleted the only key it could be opened with: every account unreadable by
  // the password and by the recovery code alike.
  await withAccountsLock(async () => {
    const meta = await getVaultMeta();
    // Switched off in another window while the password was being checked:
    // what this call was asked to do is done.
    if (!meta) return;
    if (meta.vaultId !== verifiedAgainst?.vaultId) {
      throw new Error('Password protection was changed somewhere else — nothing was changed');
    }

    const unique = await openAll((await readStored(true)).records, meta.vaultId);
    await retryOperation(() => writeStamped(unique));

    // Awaited: leftover ciphertext in sync would be merged back into local by
    // the next read and, with no vault left to open it, would brick every code
    // path.
    try {
      await pushToSync(unique, { force: true, cleartextAllowed: true });
    } catch {
      await chrome.storage.sync.remove(await syncKeysInUse()).catch(() => {});
    }

    // Existing snapshots are ciphertext that nothing will be able to open once
    // the metadata is gone, so replace them with a readable one.
    //
    // Best-effort, and that matters: IndexedDB is unavailable on a profile with
    // site data blocked, in some incognito configurations, and on a corrupt or
    // full profile. Letting it throw here skipped the lines below, so the
    // secrets had already been written to local AND force-pushed to sync in the
    // clear while vault_meta survived — the app still showed the lock screen,
    // the caller reported "Incorrect password", and the user retried believing
    // nothing had happened. Stale snapshots are a far smaller problem than that,
    // and the next successful save replaces them anyway.
    await replaceAllBackups(unique).catch(error => {
      console.error('Could not replace the encrypted snapshots while turning the vault off:', error);
    });

    // The metadata is the only key this vault's ciphertext will ever have, so
    // it goes only once local provably holds none. Every writer in this
    // extension waits for the lock, but a record written by anything that does
    // not — an older build mid-update, a browser without Web Locks — would be
    // bricked by the line below, and checking costs one read.
    for (let pass = 0; ; pass++) {
      const now = await readLocalRecords();
      const stragglers = now.some(
        record => isUsableRecord(record) && isEncryptedAccount(record) && belongsToVault(record, meta.vaultId)
      );
      if (!stragglers) break;
      if (pass === 2) throw new Error('Accounts kept arriving encrypted — password protection stays on');
      const opened = await openAll(now, meta.vaultId);
      await retryOperation(() => writeStamped(opened));
    }

    // Cloud backup's code was sealed under this vault; once its metadata is
    // gone nothing could open it, and backups would stop without a word.
    await openCodeFromVault(masterKeyBytes, meta.vaultId);

    await clearVaultMeta();
  });

  await lock();
}
export { VaultLockedError };
