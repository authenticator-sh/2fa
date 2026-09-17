import { useState } from 'react';
import { History, LifeBuoy, RotateCcw } from 'lucide-react';
import { restoreFromBackup, type BackupSummary } from '@/utils/auto-backup';
import { restoreFromSnapshot, type RestoreResult } from '@/utils/storage';
import { VaultLockedError } from '@/utils/vault';
import { ageOf } from '@/utils/clock';
import { confirmDialog, toast } from '@/utils/ui-feedback';
import { createT, type Language } from '@/utils/i18n';

const ONE_DAY = 24 * 60 * 60 * 1000;

/**
 * How old a snapshot is, in words.
 *
 * Days rather than a date, because a date has to be formatted for twenty
 * locales to be read correctly and "3 days ago" answers the only question being
 * asked here: is this copy from before or after whatever went wrong. A stamp we
 * cannot trust says so instead of being rendered as 1970 or as tomorrow.
 */
export function describeAge(timestamp: number, t: ReturnType<typeof createT>): string {
  const age = ageOf(timestamp);
  if (age === null) return t('restore.ageUnknown');
  const days = Math.floor(age / ONE_DAY);
  return days < 1 ? t('restore.ageToday') : t('restore.ageDays', days);
}

/** "3 restored", plus what the copy held that this device could not read. */
function resultMessage(result: RestoreResult, t: ReturnType<typeof createT>): string {
  const held = result.unreadable > 0 ? t('restore.held', result.unreadable) : '';

  // A copy whose every record belongs to another vault restored nothing and
  // duplicated nothing. "Everything in that copy is already here" would be a
  // flat lie to the one person most likely to be reading it closely.
  if (result.added === 0 && result.skipped === 0) {
    return held || t('restore.nothingNew');
  }

  const head = result.added > 0 ? t('restore.done', result.added) : t('restore.nothingNew');
  return held ? `${head} ${held}` : head;
}

/**
 * Put a snapshot back, having asked first.
 *
 * The confirmation is not there because restoring is dangerous — it only ever
 * adds — but because the person pressing it is usually in the middle of
 * something going wrong, and one screen that states plainly what is about to
 * happen is worth more than the click it costs.
 */
async function confirmAndRestore(
  backup: BackupSummary,
  language: Language,
  onRestored: () => void
): Promise<void> {
  const t = createT(language);

  const proceed = await confirmDialog({
    title: t('restore.confirmTitle', backup.accountCount),
    body: t('restore.confirmBody', describeAge(backup.timestamp, t)),
    confirmLabel: t('restore.action'),
    cancelLabel: t('common.cancel'),
  });
  if (!proceed) return;

  try {
    const records = await restoreFromBackup(backup.id);

    // Empty where the summary said otherwise: the snapshot was rotated out or
    // wiped while this screen was open — enabling password protection in
    // another window replaces all seven — or IndexedDB refused the read, which
    // it does in a private window and with site data blocked. Reporting
    // "nothing new" would say the copy was redundant when it is simply gone.
    if (records.length === 0) {
      toast('error', t('restore.gone'));
      return;
    }

    const result = await restoreFromSnapshot(records);
    toast(result.added > 0 ? 'success' : 'info', resultMessage(result, t));
    onRestored();
  } catch (error) {
    console.error('Restore from snapshot failed:', error);
    // A locked vault is the one failure with an obvious next step, and it is
    // reachable from the settings list: the panel stays open behind the lock
    // screen in the window and side-panel modes.
    toast('error', error instanceof VaultLockedError ? t('restore.locked') : t('restore.failed'));
  }
}

interface RestoreBackupsProps {
  backups: BackupSummary[];
  language: Language;
  /** Reload the account list — and the summaries, so counts stay honest. */
  onRestored: () => void;
}

/**
 * The automatic snapshots, listed in Settings.
 *
 * Always here, not only when something has gone wrong. The extension has kept
 * these copies since 1.10.0 and nothing has ever shown them, so the one honest
 * answer to "I updated and everything is gone" was "export more often" — while
 * seven daily copies sat in IndexedDB with no way to reach them. Somewhere
 * unremarkable is where people find a thing before they need it.
 */
export function RestoreBackups({ backups, language, onRestored }: RestoreBackupsProps) {
  const t = createT(language);
  const [busyId, setBusyId] = useState<string | null>(null);

  const run = async (backup: BackupSummary) => {
    setBusyId(backup.id);
    try {
      await confirmAndRestore(backup, language, onRestored);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mt-4">
      <div className="flex items-center gap-1.5">
        <History size={14} className="text-gray-400" />
        <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">
          {t('restore.title')}
        </h3>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">
        {t('restore.hint')}
      </p>

      {backups.length === 0 ? (
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{t('restore.none')}</p>
      ) : (
        <ul className="mt-2 divide-y divide-gray-200 dark:divide-dark-600 rounded-lg border border-gray-200 dark:border-dark-600 bg-white dark:bg-dark-700">
          {backups.map(backup => (
            <li key={backup.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <p className="text-xs font-medium text-gray-900 dark:text-gray-100">
                  {t('restore.count', backup.accountCount)}
                </p>
                <p className="text-[11px] text-gray-500 dark:text-gray-400">
                  {describeAge(backup.timestamp, t)}
                </p>
              </div>
              {/* A snapshot of an empty list is a record that the backup ran,
                  not something to put back — and "Restore 0 accounts?" is not a
                  question worth asking. */}
              {backup.accountCount > 0 && (
                <button
                  onClick={() => void run(backup)}
                  disabled={busyId !== null}
                  className="flex-shrink-0 rounded-md border border-gray-300 dark:border-dark-500 px-2.5 py-1 text-xs font-medium text-gray-700 dark:text-gray-300 transition-colors hover:bg-gray-50 dark:hover:bg-dark-600 disabled:opacity-50"
                >
                  {busyId === backup.id ? t('restore.busy') : t('restore.action')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface RestoreOfferProps {
  /** The newest snapshot that actually holds accounts. */
  backup: BackupSummary;
  language: Language;
  onRestored: () => void;
  /** Compact enough to sit inside the unavailable-accounts screen. */
  variant?: 'banner' | 'inline';
}

/**
 * "Your accounts are still here" — shown where an empty list is.
 *
 * Only ever rendered when a snapshot with accounts in it exists, which is
 * exactly the difference between someone who has lost a list and someone who
 * has not made one yet. A first run has no snapshots, so a new user never sees
 * this and the setup guide is left alone.
 */
export function RestoreOffer({ backup, language, onRestored, variant = 'banner' }: RestoreOfferProps) {
  const t = createT(language);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      await confirmAndRestore(backup, language, onRestored);
    } finally {
      setBusy(false);
    }
  };

  if (variant === 'inline') {
    return (
      <button
        onClick={() => void run()}
        disabled={busy}
        className="flex items-center justify-center gap-1.5 rounded-lg border border-gray-300 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50 dark:border-dark-500 dark:text-gray-300 dark:hover:bg-dark-700"
      >
        <RotateCcw size={14} />
        {busy ? t('restore.busy') : t('restore.offerAction', backup.accountCount)}
      </button>
    );
  }

  return (
    <div className="mx-4 mt-3 rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-900/50 dark:bg-blue-900/20">
      <div className="flex items-start gap-2">
        <LifeBuoy size={15} className="mt-0.5 flex-shrink-0 text-blue-600 dark:text-blue-400" />
        <div className="min-w-0">
          <p className="text-xs font-medium text-gray-900 dark:text-gray-100">
            {t('restore.offerTitle', backup.accountCount)}
          </p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-gray-600 dark:text-gray-300">
            {t('restore.offerBody', describeAge(backup.timestamp, t))}
          </p>
          <button
            onClick={() => void run()}
            disabled={busy}
            className="mt-2 rounded-md bg-[#4285F4] px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-[#3367D6] disabled:opacity-50"
          >
            {busy ? t('restore.busy') : t('restore.action')}
          </button>
        </div>
      </div>
    </div>
  );
}
