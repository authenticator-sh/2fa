import { useState } from 'react';
import { AlertTriangle, Download, Eye, EyeOff, Lock } from 'lucide-react';
import { Logo } from '@/components/Logo';
import { createT, type Language } from '@/utils/i18n';
import { MIN_PASSWORD_LENGTH } from '@/utils/crypto';
import { resetPasswordWithRecoveryCode } from '@/utils/vault';
import { downloadBackupFile } from '@/utils/backup-file';
import { normalizeRecoveryCode } from '@/utils/crypto';

interface LockScreenProps {
  language: Language;
  onUnlock: (password: string) => Promise<void>;
  onRecovered: () => void;
}

export function LockScreen({ language, onUnlock, onRecovered }: LockScreenProps) {
  const t = createT(language);

  const [mode, setMode] = useState<'password' | 'recovery'>('password');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRecoveryCode, setNewRecoveryCode] = useState<string | null>(null);
  const [typedRecovery, setTypedRecovery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleUnlock = async () => {
    if (!password) return;
    setBusy(true);
    setError(null);
    try {
      await onUnlock(password);
    } catch {
      setError(t('vault.lock.wrong'));
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  const handleRecover = async () => {
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(t('vault.setup.tooShort'));
      return;
    }

    setBusy(true);
    setError(null);
    try {
      // Rotate the recovery code too: the old one has just been read off a
      // screen or out of a text file, so it must be treated as spent. This
      // also leaves the vault unlocked, so there is nothing else to do here —
      // re-using the old code afterwards would fail, it no longer unwraps.
      setNewRecoveryCode(await resetPasswordWithRecoveryCode(recoveryCode, newPassword));
    } catch (err) {
      console.error('Recovery failed:', err);
      setError(t('vault.recover.invalid'));
    } finally {
      setBusy(false);
    }
  };

  if (newRecoveryCode) {
    // The code the user just used is spent, and this replacement exists nowhere
    // else. A popup dies on any focus loss, so it cannot be dismissed with a
    // single click — it has to be typed back, same as during setup.
    const confirmed =
      normalizeRecoveryCode(typedRecovery) === normalizeRecoveryCode(newRecoveryCode);

    return (
      <div className="flex-1 flex flex-col justify-center p-6 bg-gray-50 dark:bg-dark-900">
        <div className="flex items-center gap-2 mb-3">
          <Logo size={26} />
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {t('vault.recovery.title')}
          </h2>
        </div>
        <p className="text-xs text-gray-600 dark:text-gray-400 mb-3">{t('vault.recover.rotated')}</p>

        <div className="w-full bg-gray-100 dark:bg-dark-800 border border-gray-200 dark:border-dark-600 rounded-lg p-3 mb-2">
          <code className="block text-center text-sm font-mono font-semibold tracking-wider text-gray-900 dark:text-gray-100 break-all">
            {newRecoveryCode}
          </code>
        </div>

        <button
          onClick={() =>
            downloadBackupFile(
              `${t('vault.recovery.title')}\n\n${newRecoveryCode}\n\n${t('vault.recovery.warning')}\n`,
              'authenticator-recovery-code.txt'
            )
          }
          className="w-full flex items-center justify-center gap-1.5 text-xs font-medium py-2 mb-3 rounded-lg border border-gray-300 dark:border-dark-500 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-dark-700 transition-colors"
        >
          <Download size={14} />
          {t('vault.recovery.download')}
        </button>

        <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
          {t('vault.recovery.confirm')}
        </label>
        <input
          type="text"
          value={typedRecovery}
          onChange={e => setTypedRecovery(e.target.value)}
          autoFocus
          spellCheck={false}
          className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-gray-300 dark:border-dark-500 bg-white dark:bg-dark-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-[#4285F4] mb-3"
        />

        <button
          onClick={onRecovered}
          disabled={!confirmed}
          className="w-full bg-[#4285F4] hover:bg-[#3367D6] text-white font-medium text-sm py-2.5 rounded-lg transition-colors disabled:opacity-50"
        >
          {t('vault.recovery.finish')}
        </button>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-6 bg-gray-50 dark:bg-dark-900">
      <div className="w-full max-w-xs">
        {mode === 'password' ? (
          <>
            <div className="flex flex-col items-center text-center mb-5">
              <div className="w-12 h-12 rounded-full bg-gray-200 dark:bg-dark-700 flex items-center justify-center mb-3">
                <Lock className="text-gray-600 dark:text-gray-300" size={22} />
              </div>
              <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                {t('vault.lock.title')}
              </h2>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{t('vault.lock.subtitle')}</p>
            </div>

            <div className="relative mb-3">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleUnlock()}
                placeholder={t('vault.lock.password')}
                autoFocus
                className="w-full px-3 py-2.5 pe-9 text-sm rounded-lg border border-gray-300 dark:border-dark-500 bg-white dark:bg-dark-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-[#4285F4]"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute end-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>

            {error && (
              <div className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400 mb-3">
                <AlertTriangle size={14} />
                {error}
              </div>
            )}

            <button
              onClick={handleUnlock}
              disabled={busy || !password}
              className="w-full bg-[#4285F4] hover:bg-[#3367D6] text-white font-medium text-sm py-2.5 rounded-lg transition-colors disabled:opacity-50 mb-3"
            >
              {t('vault.lock.unlock')}
            </button>

            <button
              onClick={() => {
                setMode('recovery');
                setError(null);
              }}
              className="w-full text-xs text-[#4285F4] hover:underline"
            >
              {t('vault.lock.forgot')}
            </button>
          </>
        ) : (
          <>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1">
              {t('vault.recover.title')}
            </h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">{t('vault.recover.text')}</p>

            <input
              type="text"
              value={recoveryCode}
              onChange={e => setRecoveryCode(e.target.value)}
              placeholder={t('vault.recover.placeholder')}
              autoFocus
              spellCheck={false}
              className="w-full px-3 py-2.5 text-sm font-mono rounded-lg border border-gray-300 dark:border-dark-500 bg-white dark:bg-dark-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-[#4285F4] mb-2"
            />
            <input
              type="password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleRecover()}
              placeholder={t('vault.recover.newPassword')}
              className="w-full px-3 py-2.5 text-sm rounded-lg border border-gray-300 dark:border-dark-500 bg-white dark:bg-dark-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-[#4285F4] mb-3"
            />

            {error && (
              <div className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400 mb-3">
                <AlertTriangle size={14} />
                {error}
              </div>
            )}

            <button
              onClick={handleRecover}
              disabled={busy || !recoveryCode || !newPassword}
              className="w-full bg-[#4285F4] hover:bg-[#3367D6] text-white font-medium text-sm py-2.5 rounded-lg transition-colors disabled:opacity-50 mb-3"
            >
              {t('vault.recover.submit')}
            </button>

            <button
              onClick={() => {
                setMode('password');
                setError(null);
              }}
              className="w-full text-xs text-gray-500 dark:text-gray-400 hover:underline"
            >
              {t('vault.recover.back')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
