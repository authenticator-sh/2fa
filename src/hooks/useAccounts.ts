import { useState, useEffect } from 'react';
import type { Account } from '@/types';
import { getAccounts, addAccount as addAccountToStorage, deleteAccount as deleteAccountFromStorage, updateAccount as updateAccountInStorage, reorderAccounts as reorderAccountsInStorage } from '@/utils/storage';
import { autoBackup, getLatestBackup } from '@/utils/auto-backup';

export function useAccounts() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadAccounts();
  }, []);

  const loadAccounts = async () => {
    setLoading(true);
    try {
      const data = await getAccounts();
      setAccounts(data);
      setError(null);

      // Trigger auto backup (non-blocking)
      if (data.length > 0) {
        autoBackup(data).catch(err => console.error('Auto backup failed:', err));
      }
    } catch (error) {
      console.error('Failed to load accounts:', error);
      setError('Failed to load accounts. Attempting recovery...');

      // Try to recover from backup
      try {
        const backup = await getLatestBackup();
        if (backup && backup.accounts.length > 0) {
          setAccounts(backup.accounts);
          setError('Loaded from backup. Please export your accounts for safety.');
        } else {
          setError('Could not load accounts. Please import from backup if available.');
        }
      } catch (backupError) {
        console.error('Backup recovery failed:', backupError);
        setError('Could not load accounts. Please import from backup.');
      }
    } finally {
      setLoading(false);
    }
  };

  const addAccount = async (account: Account) => {
    await addAccountToStorage(account);
    await loadAccounts();
  };

  const deleteAccount = async (id: string) => {
    await deleteAccountFromStorage(id);
    await loadAccounts();
  };

  const updateAccount = async (id: string, updates: Partial<Account>) => {
    await updateAccountInStorage(id, updates);
    await loadAccounts();
  };

  const reorderAccounts = async (accountIds: string[]) => {
    await reorderAccountsInStorage(accountIds);
    await loadAccounts();
  };

  return {
    accounts,
    loading,
    error,
    addAccount,
    deleteAccount,
    updateAccount,
    reorderAccounts,
    reload: loadAccounts,
  };
}
