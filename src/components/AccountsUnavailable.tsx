import { AlertTriangle, Download, RefreshCw, Upload } from 'lucide-react';
import { createT, type Language } from '@/utils/i18n';

interface AccountsUnavailableProps {
  /** Records on disk this device cannot decrypt. */
  heldCount: number;
  /** Set when the read itself failed. */
  failed: boolean;
  language: Language;
  onRetry: () => void;
  onImport: () => void;
}

/**
 * What the list area shows when there is nothing readable to list, but the user
 * is not a new user.
 *
 * The screen this replaces was the first-run guide — "add your first account" —
 * which is what the popup rendered whenever the readable-account count hit zero,
 * regardless of why. For someone whose records are sitting on disk unreadable,
 * that is the app telling them their accounts are gone. They are not: storage
 * keeps every record it cannot read and writes it back untouched on every save.
 *
 * So this says which of the two situations it is, and offers the two actions
 * that are actually useful in both.
 */
export function AccountsUnavailable({
  heldCount,
  failed,
  language,
  onRetry,
  onImport,
}: AccountsUnavailableProps) {
  const t = createT(language);

  /**
   * Dumps what is on disk without decoding it.
   *
   * Deliberately not the normal export: that one decrypts every record first,
   * and in both of these situations decrypting is precisely what is not working.
   * The raw form is what the import side reads back, and for encrypted records
   * it is the only copy that can be moved to another machine and opened there.
   */
  const handleSaveCopy = async () => {
    try {
      const stored = await chrome.storage.local.get('authenticator_accounts');
      const blob = new Blob([JSON.stringify(stored.authenticator_accounts ?? [], null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `authenticator-recovery-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Recovery export failed:', error);
    }
  };

  return (
    <div className="flex h-[340px] flex-col items-center justify-center p-6 text-center">
      <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/30">
        <AlertTriangle className="text-amber-600 dark:text-amber-400" size={20} />
      </div>

      <h2 className="mb-1.5 text-base font-medium text-gray-900 dark:text-gray-100">
        {failed ? t('recovery.title') : t('held.title')}
      </h2>

      <p className="mb-5 max-w-[280px] text-xs leading-relaxed text-gray-500 dark:text-gray-400">
        {failed ? t('recovery.body') : t('held.body', heldCount)}
      </p>

      <div className="flex w-full max-w-[220px] flex-col gap-2">
        <button
          onClick={onRetry}
          className="flex items-center justify-center gap-1.5 rounded-lg bg-[#4285F4] py-2 text-sm font-medium text-white transition-colors hover:bg-[#3367D6]"
        >
          <RefreshCw size={14} />
          {t('recovery.retry')}
        </button>
        <button
          onClick={handleSaveCopy}
          className="flex items-center justify-center gap-1.5 rounded-lg border border-gray-300 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-dark-500 dark:text-gray-300 dark:hover:bg-dark-700"
        >
          <Download size={14} />
          {t('recovery.saveCopy')}
        </button>
        <button
          onClick={onImport}
          className="flex items-center justify-center gap-1.5 text-xs font-medium text-[#4285F4] hover:underline"
        >
          <Upload size={13} />
          {t('accounts.importFromBackup')}
        </button>
      </div>
    </div>
  );
}
