import { useCallback, useEffect, useRef, useState } from 'react';
import {
  affectsVaultSession,
  consumeKeyHandoff,
  DEFAULT_AUTO_LOCK_MINUTES,
  enforceAutoLock,
  getAutoLockMinutes,
  getVaultMeta,
  isUnlocked,
  lock as lockVault,
  noteVaultActivity,
  setAutoLockMinutes as persistAutoLockMinutes,
  unlockWithPassword,
  unlockWithRecoveryCode,
} from '@/utils/vault';
import { detectHost } from '@/utils/open-mode';

/**
 * How often an open page checks the idle deadline, and how often at most it
 * reports the user's activity. Half a minute against deadlines measured in
 * minutes; a hidden window's timers are throttled to once a minute, which is
 * still fine.
 */
const IDLE_POLL_MS = 30_000;

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

  // The popup used to be the whole lifetime of a page, so checking the deadline
  // when the accounts loaded was checking it on every open. A floating window
  // or side panel stays open past any deadline, and without this the setting
  // "lock after 5 minutes" would quietly mean "never" there. Clicks and keys
  // count as activity; watching the codes tick does not.
  const lastActivityRef = useRef(0);
  useEffect(() => {
    if (state.enabled !== true || state.locked) return;

    const poll = window.setInterval(async () => {
      if (await enforceAutoLock()) refresh();
    }, IDLE_POLL_MS);

    const onActivity = () => {
      const now = Date.now();
      if (now - lastActivityRef.current < IDLE_POLL_MS) return;
      lastActivityRef.current = now;
      void noteVaultActivity();
    };
    document.addEventListener('pointerdown', onActivity, true);
    document.addEventListener('keydown', onActivity, true);

    return () => {
      window.clearInterval(poll);
      document.removeEventListener('pointerdown', onActivity, true);
      document.removeEventListener('keydown', onActivity, true);
    };
  }, [state.enabled, state.locked, refresh]);

  // "Every time" (0 minutes) was enforced by the popup being destroyed the
  // moment it lost focus — there was no timer because there was no page left.
  // A floating window and a side panel stay open for hours, and pastIdleDeadline
  // returns false for 0 exactly as it does for "until the browser closes", so
  // the strictest setting in the list became the weakest one there: unlock once
  // on Friday and the codes are still on screen on Monday.
  //
  // The page going away is the closest these surfaces have to the popup's own
  // lifetime, so that is what locks them. Deliberately not `blur`: reading a
  // code off a floating window while typing it into another window is the
  // reason that window exists, and blurring is what doing so looks like.
  useEffect(() => {
    if (state.enabled !== true || state.locked) return;
    if (state.autoLockMinutes !== 0) return;
    if (detectHost() === 'popup') return;

    const lockWhenHidden = () => {
      if (document.visibilityState === 'hidden') void lockVault().then(refresh);
    };
    document.addEventListener('visibilitychange', lockWhenHidden);
    return () => document.removeEventListener('visibilitychange', lockWhenHidden);
  }, [state.enabled, state.locked, state.autoLockMinutes, refresh]);

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
