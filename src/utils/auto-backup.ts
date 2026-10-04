import type { StoredAccount } from '@/types';
import { ageOf } from './clock';

const DB_NAME = 'AuthenticatorBackupDB';
const DB_VERSION = 1;
const STORE_NAME = 'backups';
const MAX_BACKUPS = 7; // Keep last 7 backups

// Snapshots hold records in whatever form storage.ts persists them: cleartext
// while the vault is off, ciphertext once it is on. Storing the already
// encrypted records means the backups inherit the vault's protection without a
// second crypto path to get wrong — and without them, seven readable copies of
// every secret would sit next to the encrypted store and defeat the point.
export interface Backup {
  id: string;
  timestamp: number;
  accounts: StoredAccount[];
  version: string;
  accountCount: number;
}

// Initialize IndexedDB
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };
  });
}

/**
 * A key no other snapshot has.
 *
 * `backup_<ms>` alone collided whenever two copies were taken in the same
 * millisecond — the popup and the side panel opening together, a vault switch
 * right after a daily copy — and IndexedDB refuses an `add` over an existing
 * key by aborting the whole transaction. The copy was simply not written, and
 * the failure was logged where nobody reads. Older rows keep their ids; nothing
 * parses them, the order comes from `timestamp`.
 */
function newBackupId(at: number): string {
  const random = crypto.getRandomValues(new Uint32Array(2));
  return `backup_${at}_${random[0].toString(36)}${random[1].toString(36)}`;
}

/**
 * Wait for a transaction to be durable.
 *
 * A request's `onsuccess` only says the request ran; the transaction can still
 * abort when it commits — a full disk, quota — and then nothing was written.
 * `oncomplete` is the one signal that the data is on disk.
 */
function committed(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('Backup transaction aborted'));
  });
}

/**
 * Save a snapshot. Rejects when it was not written, so the caller can tell a
 * copy that exists from one that was only attempted.
 */
export async function saveBackup(accounts: StoredAccount[]): Promise<void> {
  const db = await openDB();
  try {
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const at = Date.now();
    const backup: Backup = {
      id: newBackupId(at),
      timestamp: at,
      accounts,
      version: chrome.runtime.getManifest().version,
      accountCount: accounts.length
    };

    // Handlers attached before the request can run, so an abort is never missed.
    const done = committed(transaction);
    transaction.objectStore(STORE_NAME).add(backup);
    await done;
  } finally {
    db.close();
  }

  // Clean old backups — only once the new one is provably there, so a failed
  // write never costs the oldest copy as well.
  await cleanOldBackups();
}

/** A snapshot described without its records. */
export interface BackupSummary {
  id: string;
  timestamp: number;
  accountCount: number;
  version: string;
}

/**
 * List the snapshots without their contents.
 *
 * What the restore UI needs is dates and counts; the records themselves are
 * secrets, and holding seven copies of them in React state for as long as a
 * settings panel is open buys nothing. They are read once, by id, at the moment
 * a restore is actually confirmed.
 */
export async function listBackupSummaries(): Promise<BackupSummary[]> {
  const backups = await getAllBackups();
  return backups.map(({ id, timestamp, accountCount, accounts, version }) => ({
    id,
    timestamp,
    // The stored count, but measured from the records when it is missing or
    // nonsense. A copy described as holding zero accounts is one the UI offers
    // no way to restore, so getting this wrong hides a full snapshot from the
    // person who needs it.
    accountCount:
      typeof accountCount === 'number' && Number.isFinite(accountCount) && accountCount >= 0
        ? accountCount
        : Array.isArray(accounts)
          ? accounts.length
          : 0,
    version,
  }));
}

// Get all backups
export async function getAllBackups(): Promise<Backup[]> {
  try {
    const db = await openDB();
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);

    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => {
        const backups = request.result as Backup[];
        // Youngest first, with a stamp from the future sinking to the bottom
        // rather than becoming a permanent "latest" that freezes the daily
        // backup and pins recovery to a stale snapshot. MAX_SAFE_INTEGER rather
        // than Infinity because Infinity - Infinity is NaN, and a NaN
        // comparator silently leaves the array in insertion order — which put
        // the OLDEST row first exactly when every stamp was untrustworthy.
        const age = (stamp: number) => ageOf(stamp) ?? Number.MAX_SAFE_INTEGER;
        resolve(backups.sort((a, b) => age(a.timestamp) - age(b.timestamp)));
      };
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error('Failed to get backups:', error);
    return [];
  }
}

// Get latest backup
export async function getLatestBackup(): Promise<Backup | null> {
  const backups = await getAllBackups();
  return backups[0] || null;
}

// Clean old backups (keep only last MAX_BACKUPS)
async function cleanOldBackups(): Promise<void> {
  try {
    const backups = await getAllBackups();
    if (backups.length <= MAX_BACKUPS) return;

    const db = await openDB();
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    // Delete old backups. `committed` listens for an abort too: waiting on
    // oncomplete/onerror alone never settled when the commit itself failed,
    // and the auto-backup lock stayed held for the life of the page.
    const done = committed(transaction);
    const toDelete = backups.slice(MAX_BACKUPS);
    for (const backup of toDelete) {
      store.delete(backup.id);
    }

    try {
      await done;
    } finally {
      db.close();
    }
  } catch (error) {
    console.error('Failed to clean old backups:', error);
  }
}

/**
 * Replace every snapshot with a single new one, in one transaction.
 *
 * Used when the vault is switched on or off, where the existing snapshots are
 * in the wrong form: cleartext copies that would survive encryption, or
 * ciphertext nothing can open once the key metadata is gone. Doing the clear
 * and the write separately left a window with no backups at all, which is
 * precisely the wrong moment to be interrupted.
 */
export async function replaceAllBackups(accounts: StoredAccount[]): Promise<void> {
  const db = await openDB();
  const transaction = db.transaction([STORE_NAME], 'readwrite');
  const store = transaction.objectStore(STORE_NAME);

  const done = committed(transaction);
  const at = Date.now();
  store.clear();
  store.add({
    id: newBackupId(at),
    timestamp: at,
    accounts,
    version: chrome.runtime.getManifest().version,
    accountCount: accounts.length,
  } satisfies Backup);

  try {
    await done;
  } finally {
    db.close();
  }
}

/**
 * Delete every snapshot. Called when the vault is switched on or off, where
 * the existing snapshots are in the wrong form: cleartext copies that would
 * survive encryption, or ciphertext nothing can open once the key metadata is
 * gone. Callers must write a fresh snapshot immediately afterwards.
 */
export async function wipeAllBackups(): Promise<void> {
  try {
    const db = await openDB();
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const done = committed(transaction);
    transaction.objectStore(STORE_NAME).clear();

    try {
      await done;
    } finally {
      db.close();
    }
  } catch (error) {
    console.error('Failed to wipe backups:', error);
    throw error;
  }
}

// Auto backup function - should be called periodically
export async function autoBackup(accounts: StoredAccount[]): Promise<void> {
  // One window at a time, and a second one simply skips. Opening the popup and
  // the side panel together had each find yesterday's copy, each write today's,
  // and the extra same-day copy pushed the oldest day out of the seven kept.
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (!locks) return backupIfDue(accounts);
  await locks.request('authenticator-auto-backup', { ifAvailable: true }, async lock => {
    if (lock) await backupIfDue(accounts);
  });
}

async function backupIfDue(accounts: StoredAccount[]): Promise<void> {
  try {
    const latestBackup = await getLatestBackup();
    const ONE_DAY = 24 * 60 * 60 * 1000;

    // Create backup if no backup exists or the last one is older than 24 hours.
    // An unusable stamp counts as old: skipping a backup because of a clock
    // glitch is how a backup system dies quietly.
    if (!latestBackup || (ageOf(latestBackup.timestamp) ?? Infinity) > ONE_DAY) {
      await saveBackup(accounts);
      console.log('Auto backup created successfully');
    }
  } catch (error) {
    console.error('Auto backup failed:', error);
  }
}

// Restore from backup
export async function restoreFromBackup(backupId: string): Promise<StoredAccount[]> {
  try {
    const db = await openDB();
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);

    return new Promise((resolve, reject) => {
      const request = store.get(backupId);
      request.onsuccess = () => {
        const backup = request.result as Backup;
        resolve(backup?.accounts || []);
      };
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error('Failed to restore from backup:', error);
    return [];
  }
}

// Check backup health
export async function checkBackupHealth(): Promise<{
  hasBackups: boolean;
  lastBackupAge: number;
  backupCount: number;
}> {
  const backups = await getAllBackups();
  const latestBackup = backups[0];

  return {
    hasBackups: backups.length > 0,
    // Infinity, not a negative number, when the newest stamp cannot be trusted:
    // callers ask "how long since the last backup" to decide whether to nudge,
    // and a bare subtraction answers "less than none" on a clock that moved.
    lastBackupAge: latestBackup ? (ageOf(latestBackup.timestamp) ?? Infinity) : Infinity,
    backupCount: backups.length
  };
}
