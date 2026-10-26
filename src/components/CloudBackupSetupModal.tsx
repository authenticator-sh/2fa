import { useEffect, useId, useState } from 'react';
import { AlertTriangle, Cloud, Download } from 'lucide-react';
import { useEscapeLayer, useReturnFocus } from '@/hooks/useLayer';
import { createT, type Language } from '@/utils/i18n';
import { normalizeRecoveryCode } from '@/utils/crypto';
import { downloadBackupFile } from '@/utils/backup-file';
import { dropPendingBackupCode, enableCloudBackup, pendingBackupCode, WrongBackupCodeError } from '@/billing/cloud-backup';
import { billingErrorMessage } from '@/billing/messages';
import { BillingApiError } from '@/billing/api';
import { VaultLockedError } from '@/utils/vault';

interface CloudBackupSetupModalProps {
  language: Language;
  onClose: () => void;
  onEnabled: () => void;
}

/**
 * Turning cloud backup on: the code, then proof it was kept.
 *
 * The same shape as the vault's recovery step, for the same reason: nothing is
 * stored until the person has typed the code back. A code they never wrote
 * down is a backup nobody can open — the one way this feature can fail them —
 * and the moment to catch that is before the first copy exists, not after the
 * laptop is gone. Only a license with no code gets here; one that has one
 * asks for it in Settings instead, and enableCloudBackup asks the server again
 * before taking this one.
 *
 * The code survives the popup closing (pendingBackupCode): the person is told
 * to keep it away from this computer, and switching to a notes app or a
 * password manager to do that closes the popup. Showing a different code on
 * the way back would make the one they saved open nothing.
 */
export function CloudBackupSetupModal({ language, onClose, onEnabled }: CloudBackupSetupModalProps) {
  const t = createT(language);
  const ids = useId();
  useReturnFocus();

  const [code, setCode] = useState<string | null>(null);
  useEffect(() => {
    void pendingBackupCode().then(setCode);
  }, []);
  const cancel = () => {
    void dropPendingBackupCode();
    onClose();
  };
  useEscapeLayer(() => {
    if (!busy) cancel();
  });
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    if (!code) return;
    if (normalizeRecoveryCode(typed) !== normalizeRecoveryCode(code)) {
      setError(t('cloud.setup.mismatch'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await enableCloudBackup(code);
      onEnabled();
      onClose();
    } catch (err) {
      console.error('Turning on cloud backup failed:', err);
      if (err instanceof WrongBackupCodeError) {
        // Another browser turned it on meanwhile: this code will never be its.
        await dropPendingBackupCode();
        setError(t('cloud.setup.taken'));
      } else if (err instanceof VaultLockedError) setError(t('restore.locked'));
      else if (err instanceof BillingApiError) setError(billingErrorMessage(err, t));
      else setError(t('cloud.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 anim-backdrop">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${ids}-title`}
        className="bg-white dark:bg-dark-800 rounded-lg border border-gray-200 dark:border-dark-600 max-w-sm w-full shadow-xl max-h-full overflow-y-auto anim-pop"
      >
        <div className="p-5">
          <div className="flex items-center gap-2 mb-3">
            <Cloud className="text-accent-500" size={20} aria-hidden />
            <h2 id={`${ids}-title`} className="text-base font-semibold text-gray-900 dark:text-gray-100">
              {t('cloud.setup.title')}
            </h2>
          </div>

          <p className="text-xs text-gray-600 dark:text-gray-400 mb-3">{t('cloud.setup.text')}</p>

          <div className="bg-gray-100 dark:bg-dark-900 border border-gray-200 dark:border-dark-600 rounded-lg p-3 mb-2">
            <code className="block text-center text-sm font-mono font-semibold tracking-wider text-gray-900 dark:text-gray-100 break-all">
              {code ?? '\u00a0'}
            </code>
          </div>

          <button
            type="button"
            disabled={!code}
            onClick={() =>
              downloadBackupFile(
                `${t('cloud.setup.title')}\n\n${code}\n\n${t('cloud.setup.warning')}\n`,
                'authenticator-cloud-backup-code.txt',
                'text/plain'
              )
            }
            className="w-full flex items-center justify-center gap-1.5 text-xs font-medium py-2 mb-3 rounded-lg border border-gray-300 dark:border-dark-500 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-dark-700 transition-colors"
          >
            <Download size={14} aria-hidden />
            {t('cloud.setup.download')}
          </button>

          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-2.5 mb-3 flex items-start gap-2">
            <AlertTriangle className="text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" size={14} aria-hidden />
            <p className="text-[11px] text-red-800 dark:text-red-300">{t('cloud.setup.warning')}</p>
          </div>

          <label htmlFor={`${ids}-code`} className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
            {t('cloud.setup.confirm')}
          </label>
          <input
            id={`${ids}-code`}
            type="text"
            value={typed}
            onChange={e => setTyped(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !busy && typed && void confirm()}
            disabled={!code}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-gray-300 dark:border-dark-500 bg-white dark:bg-dark-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-accent-500 mb-3"
          />

          {error && (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400 mb-3">
              {error}
            </p>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={cancel}
              disabled={busy}
              className="flex-1 text-sm font-medium py-2.5 rounded-lg border border-gray-300 dark:border-dark-500 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-dark-700 transition-colors disabled:opacity-50"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={() => void confirm()}
              disabled={busy || !typed || !code}
              className="flex-1 bg-accent-600 hover:bg-accent-700 text-white font-medium text-sm py-2.5 rounded-lg transition-colors disabled:opacity-50"
            >
              {busy ? t('cloud.setup.working') : t('cloud.setup.finish')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
