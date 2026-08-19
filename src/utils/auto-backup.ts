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
interface Backup {
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

// Save backup to IndexedDB
export async function saveBackup(accounts: StoredAccount[]): Promise<void> {
  try {
    const db = await openDB();
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    const at = Date.now();
    const backup: Backup = {
      id: `backup_${at}`,
      timestamp: at,
      accounts,
      version: chrome.runtime.getManifest().version,
      accountCount: accounts.length
    };

    await new Promise<void>((resolve, reject) => {
      const request = store.add(backup);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });

    db.close();

    // Clean old backups
    await cleanOldBackups();
  } catch (error) {
    console.error('Failed to save backup:', error);
  }
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

    // Delete old backups
    const toDelete = backups.slice(MAX_BACKUPS);
    for (const backup of toDelete) {
      store.delete(backup.id);
    }

    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });

    db.close();
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

  store.clear();
  store.add({
    id: `backup_${Date.now()}`,
    timestamp: Date.now(),
    accounts,
    version: chrome.runtime.getManifest().version,
    accountCount: accounts.length,
  } satisfies Backup);

  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });

  db.close();
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
    transaction.objectStore(STORE_NAME).clear();

    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });

    db.close();
  } catch (error) {
    console.error('Failed to wipe backups:', error);
    throw error;
  }
}

// Auto backup function - should be called periodically
export async function autoBackup(accounts: StoredAccount[]): Promise<void> {
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
