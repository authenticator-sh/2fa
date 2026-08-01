import { useState } from 'react';
import { AlertTriangle, Check, Download, Eye, EyeOff, Lock, ShieldCheck } from 'lucide-react';
import { createT, type Language } from '@/utils/i18n';
import { assessPasswordStrength, MIN_PASSWORD_LENGTH, normalizeRecoveryCode } from '@/utils/crypto';
import { enableVault } from '@/utils/storage';
import { downloadBackupFile } from '@/utils/backup-file';

interface VaultSetupModalProps {
  language: Language;
  onClose: () => void;
  onEnabled: () => void;
}

type Step = 'password' | 'recovery' | 'done';

const STRENGTH_STYLE = {
  weak: { width: 'w-1/4', bar: 'bg-red-500', text: 'text-red-600 dark:text-red-400' },
  fair: { width: 'w-2/4', bar: 'bg-orange-500', text: 'text-orange-600 dark:text-orange-400' },
  good: { width: 'w-3/4', bar: 'bg-yellow-500', text: 'text-yellow-700 dark:text-yellow-400' },
  strong: { width: 'w-full', bar: 'bg-green-500', text: 'text-green-600 dark:text-green-400' },
} as const;

export function VaultSetupModal({ language, onClose, onEnabled }: VaultSetupModalProps) {
  const t = createT(language);

  const [step, setStep] = useState<Step>('password');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState('');
  const [typedRecovery, setTypedRecovery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const strength = assessPasswordStrength(password);
  const strengthStyle = STRENGTH_STYLE[strength];

  const handleCreate = async () => {
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(t('vault.setup.tooShort'));
      return;
    }
    if (password !== confirmPassword) {
      setError(t('vault.setup.mismatch'));
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const { recoveryCode: code } = await enableVault(password);
      setRecoveryCode(code);
      setStep('recovery');
    } catch (err) {
      console.error('Failed to enable vault:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmRecovery = () => {
    if (normalizeRecoveryCode(typedRecovery) !== normalizeRecoveryCode(recoveryCode)) {
      setError(t('vault.recovery.mismatch'));
      return;
    }
    setError(null);
    setStep('done');
  };

  const handleFinish = () => {
    onEnabled();
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-dark-800 rounded-lg border border-gray-200 dark:border-dark-600 max-w-sm w-full shadow-xl max-h-full overflow-y-auto">
        <div className="p-5">
          {step === 'password' && (
            <>
              <div className="flex items-center gap-2 mb-3">
                <Lock className="text-[#4285F4]" size={20} />
                <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                  {t('vault.setup.title')}
                </h2>
              </div>

              {/* Plain-language reasons. A non-technical user has to be able to
                  answer "why would I want this?" from these three lines alone. */}
              <ul className="space-y-2 mb-4">
                {(['vault.setup.why1', 'vault.setup.why2', 'vault.setup.why3'] as const).map(key => (
                  <li key={key} className="flex items-start gap-2 text-xs text-gray-700 dark:text-gray-300">
                    <Check className="text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" size={14} />
                    <span>{t(key)}</span>
                  </li>
                ))}
              </ul>

              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                {t('vault.setup.password')}
              </label>
              <div className="relative mb-2">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  autoFocus
                  className="w-full px-3 py-2 pr-9 text-sm rounded-lg border border-gray-300 dark:border-dark-500 bg-white dark:bg-dark-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-[#4285F4]"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>

              {password.length > 0 && (
                <div className="flex items-center gap-2 mb-3">
                  <div className="flex-1 h-1 bg-gray-200 dark:bg-dark-600 rounded-full overflow-hidden">
                    <div className={`h-full ${strengthStyle.bar} ${strengthStyle.width} transition-all`} />
                  </div>
                  <span className={`text-[11px] font-medium ${strengthStyle.text}`}>
                    {t(`vault.strength.${strength}`)}
                  </span>
                </div>
              )}

              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                {t('vault.setup.confirm')}
              </label>
              <input
                type={showPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleCreate()}
                className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-dark-500 bg-white dark:bg-dark-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-[#4285F4] mb-3"
              />

              <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-2.5 mb-3 flex items-start gap-2">
                <AlertTriangle className="text-yellow-600 dark:text-yellow-400 flex-shrink-0 mt-0.5" size={14} />
                <p className="text-[11px] text-yellow-800 dark:text-yellow-300">
                  {t('vault.setup.cannotRecover')}
                </p>
              </div>

              {error && <p className="text-xs text-red-600 dark:text-red-400 mb-3">{error}</p>}

              <div className="flex gap-2">
                <button
                  onClick={onClose}
                  disabled={busy}
                  className="flex-1 text-sm font-medium py-2.5 rounded-lg border border-gray-300 dark:border-dark-500 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-dark-700 transition-colors disabled:opacity-50"
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={handleCreate}
                  disabled={busy || !password || !confirmPassword}
                  className="flex-1 bg-[#4285F4] hover:bg-[#3367D6] text-white font-medium text-sm py-2.5 rounded-lg transition-colors disabled:opacity-50"
                >
                  {busy ? t('vault.setup.working') : t('vault.setup.continue')}
                </button>
              </div>
            </>
          )}

          {step === 'recovery' && (
            <>
              <div className="flex items-center gap-2 mb-3">
                <ShieldCheck className="text-[#4285F4]" size={20} />
                <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                  {t('vault.recovery.title')}
                </h2>
              </div>

              <p className="text-xs text-gray-600 dark:text-gray-400 mb-3">{t('vault.recovery.text')}</p>

              <div className="bg-gray-100 dark:bg-dark-900 border border-gray-200 dark:border-dark-600 rounded-lg p-3 mb-2">
                <code className="block text-center text-sm font-mono font-semibold tracking-wider text-gray-900 dark:text-gray-100 break-all">
                  {recoveryCode}
                </code>
              </div>

              <button
                onClick={() =>
                  downloadBackupFile(
                    `${t('vault.recovery.title')}\n\n${recoveryCode}\n\n${t('vault.recovery.warning')}\n`,
                    'authenticator-recovery-code.txt'
                  )
                }
                className="w-full flex items-center justify-center gap-1.5 text-xs font-medium py-2 mb-3 rounded-lg border border-gray-300 dark:border-dark-500 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-dark-700 transition-colors"
              >
                <Download size={14} />
                {t('vault.recovery.download')}
              </button>

              <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-2.5 mb-3 flex items-start gap-2">
                <AlertTriangle className="text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" size={14} />
                <p className="text-[11px] text-red-800 dark:text-red-300">{t('vault.recovery.warning')}</p>
              </div>

              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                {t('vault.recovery.confirm')}
              </label>
              <input
                type="text"
                value={typedRecovery}
                onChange={e => setTypedRecovery(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleConfirmRecovery()}
                autoFocus
                spellCheck={false}
                className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-gray-300 dark:border-dark-500 bg-white dark:bg-dark-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-[#4285F4] mb-3"
              />

              {error && <p className="text-xs text-red-600 dark:text-red-400 mb-3">{error}</p>}

              <button
                onClick={handleConfirmRecovery}
                disabled={!typedRecovery}
                className="w-full bg-[#4285F4] hover:bg-[#3367D6] text-white font-medium text-sm py-2.5 rounded-lg transition-colors disabled:opacity-50"
              >
                {t('vault.recovery.finish')}
              </button>
            </>
          )}

          {step === 'done' && (
            <>
              <div className="flex items-center gap-2 mb-3">
                <ShieldCheck className="text-green-600 dark:text-green-400" size={20} />
                <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                  {t('vault.done.title')}
                </h2>
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">{t('vault.done.text')}</p>
              <button
                onClick={handleFinish}
                className="w-full bg-[#4285F4] hover:bg-[#3367D6] text-white font-medium text-sm py-2.5 rounded-lg transition-colors"
              >
                {t('update.gotIt')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
