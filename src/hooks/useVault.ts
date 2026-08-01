import { useCallback, useEffect, useState } from 'react';
import {
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
    setState({
      enabled: true,
      locked: !(await isUnlocked()),
      autoLockMinutes: await getAutoLockMinutes(),
    });
  }, []);

  useEffect(() => {
    refresh();
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
