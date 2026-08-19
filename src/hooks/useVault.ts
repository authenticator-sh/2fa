import { useCallback, useEffect, useState } from 'react';
import {
  affectsVaultSession,
  consumeKeyHandoff,
  DEFAULT_AUTO_LOCK_MINUTES,
  getAutoLockMinutes,
  getVaultMeta,
  isUnlocked,
  lock as lockVault,
  setAutoLockMinutes as persistAutoLockMinutes,
  unlockWithPassword,
  unlockWithRecoveryCode,
} from '@/utils/vault';

export interface VaultState {
  /** null while we are still reading storage — the UI must not flash a lock screen. */
  enabled: boolean | null;
  locked: boolean;
  autoLockMinutes: number;
}

export function useVault() {
  const [state, setState] = useState<VaultState>({
    enabled: null,
    locked: false,
    autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES,
  });

  const refresh = useCallback(async () => {
    const meta = await getVaultMeta();
    if (!meta) {
      setState({ enabled: false, locked: false, autoLockMinutes: await getAutoLockMinutes() });
      return;
    }
    // A passkey ceremony runs in a window of its own and cannot write this
    // context's session directly. If it left a key staged, adopt it here —
    // once — before deciding whether to show the lock screen. This is the only
    // place that consumes a hand-off, deliberately: getMasterKeyBytes enforces
    // auto-lock and must not grow a second way to say "unlocked".
    await consumeKeyHandoff();

    setState({
      enabled: true,
      locked: !(await isUnlocked()),
      autoLockMinutes: await getAutoLockMinutes(),
    });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // The passkey ceremony unlocks the vault from a window of its own. Without
  // this the popup only learned about it by being closed and reopened — it sat
  // on the lock screen with the vault already open behind it.
  useEffect(() => {
    if (!chrome.storage?.onChanged?.addListener) return;

    const onChanged = (changes: Record<string, unknown>, areaName: string) => {
      if (affectsVaultSession(areaName, changes)) refresh();
    };

    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [refresh]);

  const unlock = useCallback(
    async (password: string) => {
      await unlockWithPassword(password);
      await refresh();
    },
    [refresh]
  );

  const unlockWithRecovery = useCallback(
    async (code: string) => {
      await unlockWithRecoveryCode(code);
      await refresh();
    },
    [refresh]
  );

  const lock = useCallback(async () => {
    await lockVault();
    await refresh();
  }, [refresh]);

  const setAutoLockMinutes = useCallback(
    async (minutes: number) => {
      await persistAutoLockMinutes(minutes);
      setState(previous => ({ ...previous, autoLockMinutes: minutes }));
    },
    []
  );

  return { ...state, refresh, unlock, unlockWithRecovery, lock, setAutoLockMinutes };
}
