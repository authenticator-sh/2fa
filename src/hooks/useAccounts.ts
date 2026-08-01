import { useCallback, useEffect, useState } from 'react';
import type { Account } from '@/types';
import {
  getAccounts,
  getStoredAccounts,
  decodeAccounts,
  addAccount as addAccountToStorage,
  deleteAccount as deleteAccountFromStorage,
  updateAccount as updateAccountInStorage,
  reorderAccounts as reorderAccountsInStorage,
} from '@/utils/storage';
import { autoBackup, getLatestBackup } from '@/utils/auto-backup';
import { VaultLockedError } from '@/utils/vault';

export function useAccounts(vaultLocked: boolean) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadAccounts = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getAccounts();
      setAccounts(data);
      setError(null);

      // Trigger auto backup (non-blocking). The snapshot stores records in
      // their on-disk form, so an encrypted vault yields an encrypted backup.
      if (data.length > 0) {
        getStoredAccounts()
          .then(stored => autoBackup(stored))
          .catch(err => console.error('Auto backup failed:', err));
      }
    } catch (error) {
      if (error instanceof VaultLockedError) {
        // Not a failure — App renders the unlock screen and calls us again.
        setAccounts([]);
        setError(null);
        setLoading(false);
        return;
      }

      console.error('Failed to load accounts:', error);
      setError('Failed to load accounts. Attempting recovery...');

      // Try to recover from backup
      try {
        const backup = await getLatestBackup();
        if (backup && backup.accounts.length > 0) {
          const recovered = await decodeAccounts(backup.accounts);
          if (recovered.length > 0) {
            setAccounts(recovered);
            setError('Loaded from backup. Please export your accounts for safety.');
          } else {
            setError('Could not load accounts. Please import from backup if available.');
          }
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
  }, []);

  // Reload whenever the vault is unlocked or re-locked: locking must drop the
  // decrypted accounts out of React state, not just hide them behind a screen.
  useEffect(() => {
    if (vaultLocked) {
      setAccounts([]);
      setLoading(false);
      return;
    }
    loadAccounts();
  }, [vaultLocked, loadAccounts]);

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
