import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AddOrigin } from '@/billing/gate';
import type { Account } from '@/types';
import {
  affectsStoredAccounts,
  getAccounts,
  getStoredAccounts,
  decodeAccounts,
  addAccount as addAccountToStorage,
  deleteAccount as deleteAccountFromStorage,
  updateAccount as updateAccountInStorage,
  reorderAccounts as reorderAccountsInStorage,
  lockedAwayCount,
} from '@/utils/storage';
import { autoBackup, getLatestBackup } from '@/utils/auto-backup';
import { VaultLockedError } from '@/utils/vault';

/**
 * i18n keys, not sentences: this hook has no language, and English written here
 * was what every locale saw.
 */
export type LoadError = 'load.recovering' | 'load.fromBackup' | 'load.failed';

/** What a load decides about the screen; the hook turns each field into state. */
export interface AccountsState {
  accounts: Account[];
  loading: boolean;
  error: LoadError | null;
  heldCount: number;
}

export interface AccountsLoader {
  /**
   * Read the list and publish it.
   *
   * `quiet` keeps the list on screen while the read runs. Resolves once this
   * read has been applied — or dropped, because a later one was started.
   */
  load(options?: { quiet?: boolean }): Promise<void>;
  /**
   * A reload the caller asked for: quiet once a list has been shown, so an
   * import or a restore does not replace forty live codes with a spinner.
   */
  reload(): Promise<void>;
  /**
   * The vault locked: forget the list, and make sure no read already in flight
   * publishes decrypted accounts after it.
   */
  clear(): void;
}

/**
 * The account list's loading rules, apart from React so they can be tested.
 *
 * Every open surface reloads on every storage event, and reads do not finish in
 * the order they started: one that has to wait for the accounts lock — to
 * replay a held sync push, to persist a merge — finishes after a read that
 * began later and saw a newer list. Applied as they arrived, the older list
 * landed last and the screen showed an account that had just been deleted, or
 * lost one that had just been added, until the next storage event happened to
 * come along. Each load takes a generation number, and only the latest one
 * started may touch the screen.
 */
export function createAccountsLoader(publish: (patch: Partial<AccountsState>) => void): AccountsLoader {
  let generation = 0;
  /** A list has been read and put on screen since the last lock. */
  let shown = false;

  const load = async (options: { quiet?: boolean } = {}): Promise<void> => {
    const mine = ++generation;
    const current = () => mine === generation;

    // A reload prompted by storage changing underneath us swaps the list in
    // place: putting a spinner over forty live codes because the scan page
    // added a forty-first would be the change announcing itself too loudly. The
    // spinner also unmounted every card, so the list jumped back to the top.
    if (!options.quiet) publish({ loading: true });
    try {
      const data = await getAccounts();
      if (!current()) return;
      // Sampled right after the read that set it, before anything can await.
      publish({ accounts: data, error: null, heldCount: lockedAwayCount() });
      shown = true;

      // Trigger auto backup (non-blocking). The snapshot stores records in
      // their on-disk form, so an encrypted vault yields an encrypted backup.
      //
      // Never of an empty list. Seven copies are kept, one a day, so a week of
      // opening the popup on a store that read as empty — a sync area not yet
      // downloaded, a profile mid-restore — would rotate every copy that still
      // held the accounts out of existence.
      if (data.length > 0) {
        getStoredAccounts()
          .then(stored => autoBackup(stored))
          .catch(err => console.error('Auto backup failed:', err));
      }
    } catch (error) {
      if (!current()) return;
      if (error instanceof VaultLockedError) {
        // Not a failure — App renders the unlock screen and calls us again.
        shown = false;
        publish({ accounts: [], heldCount: 0, error: null });
        return;
      }

      console.error('Failed to load accounts:', error);
      publish({ error: 'load.recovering' });

      // Try to recover from backup
      try {
        const backup = await getLatestBackup();
        const recovered = backup && backup.accounts.length > 0 ? await decodeAccounts(backup.accounts) : [];
        if (!current()) return;
        if (recovered.length > 0) {
          publish({ accounts: recovered, error: 'load.fromBackup' });
        } else {
          publish({ error: 'load.failed' });
        }
      } catch (backupError) {
        console.error('Backup recovery failed:', backupError);
        if (current()) publish({ error: 'load.failed' });
      }
    } finally {
      // Only the latest read ends the spinner; an older one finishing late
      // would otherwise take it down over a list that is still being read.
      if (current()) publish({ loading: false });
    }
  };

  return {
    load,
    reload: () => load({ quiet: shown }),
    clear() {
      generation++;
      shown = false;
      publish({ accounts: [], heldCount: 0, loading: false });
    },
  };
}

export function useAccounts(vaultLocked: boolean) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  /** Why the list could not be loaded normally; App words it in the user's language. */
  const [error, setError] = useState<LoadError | null>(null);
  /**
   * Records on disk that this device cannot read — ciphertext from another
   * vault, or a record whose decryption failed.
   *
   * Storage has always kept them safe, but nothing ever told the user they
   * existed: the popup counted the readable accounts, found none, and rendered
   * the first-run guide. "Set up your first account" is indistinguishable from
   * "your accounts are gone", which is the worst thing a 2FA app can say to
   * someone whose data is in fact intact.
   */
  const [heldCount, setHeldCount] = useState(0);

  // One loader for the life of the page: the generation count only protects
  // anything if every read goes through the same one.
  const loader = useMemo(
    () =>
      createAccountsLoader(patch => {
        if (patch.accounts !== undefined) setAccounts(patch.accounts);
        if (patch.loading !== undefined) setLoading(patch.loading);
        if (patch.error !== undefined) setError(patch.error);
        if (patch.heldCount !== undefined) setHeldCount(patch.heldCount);
      }),
    []
  );

  // Reload whenever the vault is unlocked or re-locked: locking must drop the
  // decrypted accounts out of React state, not just hide them behind a screen.
  // Unlocking is the one reload that shows the spinner — there is no list yet.
  useEffect(() => {
    if (vaultLocked) {
      loader.clear();
      return;
    }
    void loader.load();
  }, [vaultLocked, loader]);

  // Follow the store while the page is open. Our own writes fire this too,
  // which costs one extra read after each — the merge on read is idempotent,
  // so it cannot cascade.
  useEffect(() => {
    if (vaultLocked || !chrome.storage?.onChanged?.addListener) return;

    const onChanged = (changes: Record<string, unknown>, areaName: string) => {
      if (affectsStoredAccounts(areaName, changes)) void loader.load({ quiet: true });
    };

    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [vaultLocked, loader]);

  // After the user's own change the list is already on screen and only one
  // row differs, so it is swapped in place like any other storage event.
  const addAccount = async (account: Account, origin: AddOrigin): Promise<boolean> => {
    const added = await addAccountToStorage(account, origin);
    await loader.load({ quiet: true });
    return added;
  };

  const deleteAccount = async (id: string) => {
    await deleteAccountFromStorage(id);
    await loader.load({ quiet: true });
  };

  /** `false` when the account was no longer there to update — deleted in another window. */
  const updateAccount = async (id: string, updates: Partial<Account>): Promise<boolean> => {
    const found = await updateAccountInStorage(id, updates);
    await loader.load({ quiet: true });
    return found;
  };

  const reorderAccounts = async (accountIds: string[]) => {
    await reorderAccountsInStorage(accountIds);
    await loader.load({ quiet: true });
  };

  const reload = useCallback(() => loader.reload(), [loader]);

  return {
    accounts,
    loading,
    error,
    heldCount,
    addAccount,
    deleteAccount,
    updateAccount,
    reorderAccounts,
    reload,
  };
}
