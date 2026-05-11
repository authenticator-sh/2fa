import type { Account } from '@/types';

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

// Dual storage: sync + local for redundancy
export async function getAccounts(): Promise<Account[]> {
  try {
    return await retryOperation(async () => {
      // Try sync storage first
      try {
        const syncResult = await chrome.storage.sync.get(STORAGE_KEY);
        if (syncResult[STORAGE_KEY]?.length > 0) {
          // Save a copy to local storage for backup
          await chrome.storage.local.set({ [STORAGE_KEY]: syncResult[STORAGE_KEY] }).catch(() => {});
          return syncResult[STORAGE_KEY];
        }
      } catch (syncError) {
        console.warn('Sync storage unavailable, falling back to local:', syncError);
      }

      // Fallback to local storage if sync is empty or failed
      const localResult = await chrome.storage.local.get(STORAGE_KEY);
      return localResult[STORAGE_KEY] || [];
    });
  } catch (error) {
    console.error('Error getting accounts:', error);
    return [];
  }
}

export async function saveAccounts(accounts: Account[]): Promise<void> {
  try {
    await retryOperation(async () => {
      // Save to both sync and local storage for redundancy
      const data = { [STORAGE_KEY]: accounts };

      try {
        // Try sync first
        await chrome.storage.sync.set(data);
      } catch (syncError) {
        console.warn('Sync storage failed, using local only:', syncError);
      }

      // Always save to local as backup
      await chrome.storage.local.set(data);
    });
  } catch (error) {
    console.error('Error saving accounts:', error);
    throw error;
  }
}

export async function addAccount(account: Account): Promise<void> {
  const accounts = await getAccounts();
  accounts.push(account);
  await saveAccounts(accounts);
}

export async function addMultipleAccounts(newAccounts: Account[]): Promise<void> {
  const accounts = await getAccounts();

  // Filter out duplicates based on secret (unique identifier for TOTP)
  const existingSecrets = new Set(accounts.map(acc => acc.secret));
  const uniqueAccounts = newAccounts.filter(acc => !existingSecrets.has(acc.secret));

  if (uniqueAccounts.length > 0) {
    accounts.push(...uniqueAccounts);
    await saveAccounts(accounts);
  }
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

    // Validate structure
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
  } catch (error) {
    console.error('Error importing accounts:', error);
    throw new Error('Failed to import accounts. Invalid format.');
  }
}
