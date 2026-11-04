import { useEffect, useState } from 'react';
import { CLOUD_SYNC_STATUS_KEYS, onCloudSyncActivity, readCloudSyncStatus, type CloudSyncStatus } from '@/billing/cloud-backup';
import { createT, type Language } from '@/utils/i18n';

/** Cloud sync's state, kept current — the header's cloud and the Settings line read the same. */
export function useCloudSyncStatus(): CloudSyncStatus {
  const [status, setStatus] = useState<CloudSyncStatus>({ state: 'off' });
  useEffect(() => {
    let alive = true;
    let generation = 0;
    const refresh = () => {
      const mine = ++generation;
      void readCloudSyncStatus().then(next => {
        if (alive && mine === generation) setStatus(next);
      });
    };
    refresh();
    const stopActivity = onCloudSyncActivity(refresh);
    const onChanged = (changes: Record<string, unknown>, area: string) => {
      if ((area === 'local' || area === 'sync') && CLOUD_SYNC_STATUS_KEYS.some(key => key in changes)) refresh();
    };
    chrome.storage?.onChanged?.addListener(onChanged);
    return () => {
      alive = false;
      stopActivity();
      chrome.storage?.onChanged?.removeListener(onChanged);
    };
  }, []);
  return status;
}

/**
 * The cloud in the header: there only while cloud backup is on here, the way
 * Google Authenticator shows its synced cloud. A tick when this device and the
 * other devices agree, a pulse while it is reading or sending, an exclamation
 * mark when the last attempt failed or the code has to be typed again. A click
 * opens Settings at cloud backup, where the reason and "Sync now" are.
 *
 * Read again on every change of what it depends on (CLOUD_SYNC_STATUS_KEYS)
 * and when a sync starts or ends in this page; nothing on a timer.
 */
export function CloudSyncIndicator({ language, onOpen }: { language: Language; onOpen: () => void }) {
  const t = createT(language);
  const status = useCloudSyncStatus();
  if (status.state === 'off') return null;

  let label: string;
  if (status.state === 'syncing') label = t('cloudSync.syncing');
  else if (status.state === 'error') label = t('cloudSync.problem');
  else if (status.at === null) label = t('cloudSync.synced');
  else {
    const old = Date.now() - status.at > 86_400_000;
    const time = new Intl.DateTimeFormat(language, old ? { dateStyle: 'medium', timeStyle: 'short' } : { timeStyle: 'short' }).format(new Date(status.at));
    label = `${t('cloudSync.synced')} · ${time}`;
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      className="p-1.5 rounded-lg transition-colors hover:bg-gray-100 dark:hover:bg-dark-700"
      title={label}
      aria-label={label}
      data-sync-state={status.state}
    >
      <CloudMark state={status.state} />
    </button>
  );
}

/** Lucide's cloud, drawn with what it says inside — this lucide has no cloud-check. */
function CloudMark({ state }: { state: 'ok' | 'syncing' | 'error' }) {
  const tone =
    state === 'error'
      ? 'text-amber-500 dark:text-amber-400'
      : state === 'syncing'
        ? 'text-gray-500 dark:text-gray-400 animate-pulse'
        : 'text-gray-600 dark:text-gray-400';
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={tone}
      aria-hidden="true"
    >
      <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
      {state === 'ok' && <path d="m8.5 13 2.5 2.5 4.5-4.5" />}
      {state === 'error' && (
        <>
          <path d="M12 9.5v3" />
          <path d="M12 15.5h.01" />
        </>
      )}
      {state === 'syncing' && (
        <>
          <path d="M12 16v-5.5" />
          <path d="m9.5 13 2.5-2.5 2.5 2.5" />
        </>
      )}
    </svg>
  );
}
