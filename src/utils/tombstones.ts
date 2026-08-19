// A record of what this device deleted, so the sync copy cannot put it back.
//
// Reads take the union of local and sync (see getStoredAccounts) because a
// record present in sync but not local usually means another device added it —
// and on a 2FA app, a stale code you have to delete twice beats a code that
// silently disappears. But that rule cannot tell "another device added this"
// apart from "this device just deleted it", and the sync write that removes a
// deleted record is deliberately not awaited, so the reload that follows a
// delete saw the account still in sync and wrote it straight back to local. The
// account came back, on disk, and only a second delete stuck.
//
// It is worse than a one-off annoyance for anyone whose sync writes are failing
// — over quota, rate-limited — because for them the stale copy never goes away
// and deleting never works at all.
//
// So a deletion leaves a marker, and the merge honours it. The marker is local
// only: another device still keeps its copy, which is the existing, deliberate
// behaviour of deletions not propagating.

import { ageOf, stampNow } from './clock';
import { toBase64 } from './crypto';

const KEY = 'deletedIdentities';

/** Old enough that any pending sync write has long since resolved or failed. */
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/** Bounds the key's size on an account someone churns through repeatedly. */
const MAX_ENTRIES = 200;

/** identity hash -> when it was deleted. */
type Tombstones = Record<string, number>;

/**
 * Hashed, never stored raw.
 *
 * The identity of an unencrypted record is its TOTP secret. Writing those to a
 * second storage key — one nothing else guards, and which the vault does not
 * cover — would put a copy of every deleted seed on disk in the clear. SHA-256
 * of a high-entropy base32 secret is not reversible, and the merge only ever
 * needs to compare.
 */
async function hashIdentity(identity: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  return toBase64(digest);
}

async function read(): Promise<Tombstones> {
  const stored = (await chrome.storage.local.get(KEY))[KEY];
  return stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Tombstones) : {};
}

async function write(tombstones: Tombstones): Promise<void> {
  const entries = Object.entries(tombstones);
  if (entries.length === 0) {
    await chrome.storage.local.remove(KEY).catch(() => {});
    return;
  }

  // Age used to evict on its own, which made it a correctness hazard rather
  // than housekeeping: a deletion recorded while the clock was years behind
  // ages out the moment the clock is fixed, and the account comes straight back
  // from sync. MAX_ENTRIES already bounds this key, so age only gets a vote
  // once the cap is reached — and never over a stamp we cannot trust.
  const byNewest = entries.sort(([, a], [, b]) => b - a);

  let kept = byNewest;
  if (byNewest.length > MAX_ENTRIES) {
    const fresh = byNewest.filter(([, at]) => (ageOf(at) ?? 0) <= MAX_AGE_MS);
    kept = (fresh.length > 0 ? fresh : byNewest).slice(0, MAX_ENTRIES);
  }

  await chrome.storage.local.set({ [KEY]: Object.fromEntries(kept) }).catch(() => {});
}

/** Remember that these identities were deleted here. */
export async function markDeleted(identities: string[]): Promise<void> {
  if (identities.length === 0) return;

  const tombstones = await read();
  // A monotonic stamp, not the raw clock: a deletion recorded on a machine that
  // thinks it is 2015 must not read as eleven years old the moment the clock is
  // fixed, or the sweep below drops it and the account comes back.
  const now = await stampNow();
  for (const identity of identities) {
    tombstones[await hashIdentity(identity)] = now;
  }
  await write(tombstones);
}

/**
 * Forget any marker for an identity that is present again.
 *
 * Adding an account back — re-scanning the QR, restoring a backup — has to
 * work, and it is the only signal that says so. Called from saveAccounts, so
 * every path that writes accounts is covered by one line rather than each
 * remembering to do it.
 */
export async function forgetDeleted(identities: string[]): Promise<void> {
  const tombstones = await read();
  if (Object.keys(tombstones).length === 0) return;

  let changed = false;
  for (const identity of identities) {
    const hash = await hashIdentity(identity);
    if (hash in tombstones) {
      delete tombstones[hash];
      changed = true;
    }
  }
  if (changed) await write(tombstones);
}

/**
 * A test for whether an identity was deleted here.
 *
 * Returns a predicate rather than taking one identity at a time so the caller
 * reads storage once per merge instead of once per record.
 */
export async function deletedHere(): Promise<(identity: string) => Promise<boolean>> {
  const tombstones = await read();
  const empty = Object.keys(tombstones).length === 0;

  // Deliberately ageless: a marker suppresses until the identity is present
  // again (forgetDeleted) or the key hits capacity. Expiring here by wall-clock
  // age was considered and rejected — on a machine whose clock was wrong when
  // the deletion happened, every marker reads as ancient the moment the clock
  // is fixed, and accounts the user deleted come back from sync. The cost is
  // that an account deleted here and re-added on ANOTHER device stays hidden
  // here until it is added on this one too; that is the older, known trade-off
  // and it is not made worse by anything above.
  return async (identity: string) => {
    if (empty) return false;
    return (await hashIdentity(identity)) in tombstones;
  };
}
