import type { Account, EncryptedAccount, StoredAccount } from '@/types';
import { isEncryptedAccount } from '@/types';
import { decryptJson, encryptJson, fingerprintSecret } from './crypto';
import {
  clearVaultMeta,
  createVaultMeta,
  deriveKeys,
  getMasterKeyBytes,
  isVaultEnabled,
  lock,
  saveVaultMeta,
  unlockWithPassword,
  VaultLockedError,
  verifyPassword,
} from './vault';
import { saveBackup, wipeAllBackups } from './auto-backup';

const STORAGE_KEY = 'authenticator_accounts';

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

async function requireKeys() {
  const masterKeyBytes = await getMasterKeyBytes();
  if (!masterKeyBytes) throw new VaultLockedError();
  return deriveKeys(masterKeyBytes);
}

async function encodeAccounts(accounts: Account[]): Promise<StoredAccount[]> {
  if (!(await isVaultEnabled())) return accounts;

  const { dataKey, fingerprintKey } = await requireKeys();
  return Promise.all(
    accounts.map(async (account): Promise<EncryptedAccount> => {
      const { id, ...secretFields } = account;
      return {
        id,
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
  if (stored.length === 0) return [];
  if (!stored.some(isEncryptedAccount)) return dedupeBySecret(stored as Account[]);

  const { dataKey } = await requireKeys();
  const decoded: Account[] = [];

  for (const record of stored) {
    if (!isEncryptedAccount(record)) {
      decoded.push(record);
      continue;
    }
    try {
      const fields = await decryptJson<Omit<Account, 'id'>>(record.enc, dataKey);
      decoded.push({ id: record.id, ...fields });
    } catch (error) {
      // One corrupt record must not hide the other 40 accounts.
      console.error('Failed to decrypt account record', record.id, error);
    }
  }

  // The next save writes the deduplicated list back out encrypted.
  return dedupeBySecret(decoded);
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
      const syncResult = await chrome.storage.sync.get(STORAGE_KEY);
      syncAccounts = syncResult[STORAGE_KEY] || [];
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

export async function getAccounts(): Promise<Account[]> {
  try {
    return await decodeAccounts(await getStoredAccounts());
  } catch (error) {
    // A locked vault is a normal state the UI handles, not a storage failure —
    // swallowing it here would render an empty list and panic the user.
    if (error instanceof VaultLockedError) throw error;
    console.error('Error getting accounts:', error);
    return [];
  }
}

export async function saveAccounts(accounts: Account[]): Promise<void> {
  const data = { [STORAGE_KEY]: await encodeAccounts(accounts) };

  // Local is the source of truth — must succeed or we throw
  await retryOperation(() => chrome.storage.local.set(data));

  // Sync is best-effort: failures here (e.g. QUOTA_BYTES_PER_ITEM exceeded
  // with many accounts) must not block the save or be retried.
  chrome.storage.sync.set(data).catch(syncError => {
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
  const orderedAccounts = accountIds
    .map(id => accounts.find(acc => acc.id === id))
    .filter((acc): acc is Account => acc !== undefined);
  await saveAccounts(orderedAccounts);
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
  await saveAccounts(filtered);
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

/**
 * Turn the vault on: encrypt everything, prove it reads back, and only then
 * destroy the plaintext.
 *
 * Order is not negotiable. Every cleartext copy has to go — chrome.storage
 * local AND sync, plus the seven rolling IndexedDB snapshots — or the vault is
 * decorative: an attacker with the profile directory would simply read the
 * backup instead. Because of that the wipe is destructive, so it runs strictly
 * after a full decrypt-and-compare round trip.
 */
export async function enableVault(password: string): Promise<{ recoveryCode: string }> {
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

  if (JSON.stringify(verification) !== JSON.stringify(plaintextAccounts)) {
    throw new Error('Encryption verification failed — no changes were made');
  }

  await saveVaultMeta(meta);
  await retryOperation(() => chrome.storage.local.set({ [STORAGE_KEY]: encrypted }));

  // Best-effort for sync, but the cleartext removal must be attempted even if
  // the encrypted write is rejected for quota.
  chrome.storage.sync.set({ [STORAGE_KEY]: encrypted }).catch(async () => {
    await chrome.storage.sync.remove(STORAGE_KEY).catch(() => {});
  });

  await wipeAllBackups();
  await saveBackup(encrypted);

  // Leave the vault unlocked. Going through the real unlock path rather than
  // stashing the key we already hold also proves the password round-trips
  // through PBKDF2 and unwraps what we just wrote.
  await unlockWithPassword(password);

  return { recoveryCode };
}

/**
 * Turn the vault off. Requires the password even though the vault may already
 * be unlocked — this writes every secret back out in the clear, which should
 * never be one stray click away.
 */
export async function disableVault(password: string): Promise<void> {
  const masterKeyBytes = await verifyPassword(password);
  const { dataKey } = await deriveKeys(masterKeyBytes);

  const stored = await getStoredAccounts();
  const accounts: Account[] = [];
  for (const record of stored) {
    if (!isEncryptedAccount(record)) {
      accounts.push(record);
      continue;
    }
    const fields = await decryptJson<Omit<Account, 'id'>>(record.enc, dataKey);
    accounts.push({ id: record.id, ...fields });
  }

  // Deduplicate before writing: a cleartext duplicate that arrived from an
  // older device via sync would otherwise be baked into the cleartext store,
  // where nothing downstream re-checks it.
  const unique = dedupeBySecret(accounts);

  await retryOperation(() => chrome.storage.local.set({ [STORAGE_KEY]: unique }));
  chrome.storage.sync.set({ [STORAGE_KEY]: unique }).catch(() => {});

  // Existing snapshots are ciphertext that nothing will be able to open once
  // the metadata is gone, so replace them with a readable one.
  await wipeAllBackups();
  await saveBackup(unique);

  await clearVaultMeta();
  await lock();
}

export { VaultLockedError };
