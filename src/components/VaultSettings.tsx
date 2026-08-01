import { useState } from 'react';
import { Lock, ShieldCheck, ShieldOff } from 'lucide-react';
import { createT, type Language } from '@/utils/i18n';
import { MIN_PASSWORD_LENGTH } from '@/utils/crypto';
import { AUTO_LOCK_OPTIONS, changePassword } from '@/utils/vault';
import { disableVault } from '@/utils/storage';
import { confirmDialog, promptDialog, toast } from '@/utils/ui-feedback';

interface VaultSettingsProps {
  language: Language;
  enabled: boolean;
  autoLockMinutes: number;
  onEnableClick: () => void;
  onChanged: () => void;
  onLock: () => void;
  onAutoLockChange: (minutes: number) => void;
}

export function VaultSettings({
  language,
  enabled,
  autoLockMinutes,
  onEnableClick,
  onChanged,
  onLock,
  onAutoLockChange,
}: VaultSettingsProps) {
  const t = createT(language);

  const [showChangeForm, setShowChangeForm] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const autoLockLabel = (minutes: number) => {
    if (minutes === 0) return t('vault.settings.autoLockEveryOpen');
    if (minutes < 0) return t('vault.settings.autoLockBrowser');
    return t('vault.settings.autoLockMins', minutes);
  };

  const handleChangePassword = async () => {
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setMessage({ text: t('vault.setup.tooShort'), ok: false });
      return;
    }

    setBusy(true);
    try {
      await changePassword(currentPassword, newPassword);
      toast('success', t('vault.settings.saved'));
      setMessage(null);
      setCurrentPassword('');
      setNewPassword('');
      setShowChangeForm(false);
      onChanged();
    } catch {
      setMessage({ text: t('vault.lock.wrong'), ok: false });
    } finally {
      setBusy(false);
    }
  };

  const handleDisable = async () => {
    const confirmed = await confirmDialog({
      title: t('vault.settings.disable'),
      body: t('vault.settings.disableConfirm'),
      confirmLabel: t('vault.settings.disable'),
      cancelLabel: t('common.cancel'),
      danger: true,
    });
    if (!confirmed) return;

    // The password is required even while unlocked: turning this off rewrites
    // every secret in the clear, which must never be one stray click away.
    const password = await promptDialog({
      title: t('vault.settings.disable'),
      body: t('vault.settings.currentPassword'),
      password: true,
      confirmLabel: t('common.confirm'),
      cancelLabel: t('common.cancel'),
    });
    if (!password) return;

    setBusy(true);
    try {
      await disableVault(password);
      setMessage(null);
      toast('success', t('vault.settings.saved'));
      onChanged();
    } catch {
      setMessage({ text: t('vault.lock.wrong'), ok: false });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 pt-4 border-t border-gray-200 dark:border-dark-600">
      <h3 className="text-gray-900 dark:text-gray-100 font-medium mb-2 text-sm flex items-center gap-1.5">
        {enabled ? (
          <ShieldCheck className="text-green-600 dark:text-green-400" size={15} />
        ) : (
          <ShieldOff className="text-gray-400" size={15} />
        )}
        {t('vault.settings.title')}
      </h3>

      <p className={`text-xs mb-3 ${enabled ? 'text-green-700 dark:text-green-400' : 'text-gray-500 dark:text-gray-400'}`}>
        {enabled ? t('vault.settings.on') : t('vault.settings.off')}
      </p>

      {!enabled ? (
        <button
          onClick={onEnableClick}
          className="w-full flex items-center justify-center gap-1.5 bg-[#4285F4] hover:bg-[#3367D6] text-white font-medium text-sm py-2 rounded-lg transition-colors"
        >
          <Lock size={15} />
          {t('vault.settings.enable')}
        </button>
      ) : (
        <>
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs text-gray-700 dark:text-gray-300">{t('vault.settings.autoLock')}</span>
            <select
              value={autoLockMinutes}
              onChange={e => onAutoLockChange(Number(e.target.value))}
              className="text-xs bg-white dark:bg-dark-700 border border-gray-300 dark:border-dark-500 rounded-md px-2 py-1 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-[#4285F4]"
            >
              {AUTO_LOCK_OPTIONS.map(minutes => (
                <option key={minutes} value={minutes}>
                  {autoLockLabel(minutes)}
                </option>
              ))}
            </select>
          </div>

          <div className="flex gap-2 mb-2">
            <button
              onClick={onLock}
              className="flex-1 flex items-center justify-center gap-1.5 text-xs font-medium py-2 rounded-lg border border-gray-300 dark:border-dark-500 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-dark-700 transition-colors"
            >
              <Lock size={14} />
              {t('vault.settings.lockNow')}
            </button>
            <button
              onClick={() => setShowChangeForm(!showChangeForm)}
              className="flex-1 text-xs font-medium py-2 rounded-lg border border-gray-300 dark:border-dark-500 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-dark-700 transition-colors"
            >
              {t('vault.settings.changePassword')}
            </button>
          </div>

          {showChangeForm && (
            <div className="bg-gray-100 dark:bg-dark-900 rounded-lg p-2.5 mb-2">
              <input
                type="password"
                value={currentPassword}
                onChange={e => setCurrentPassword(e.target.value)}
                placeholder={t('vault.settings.currentPassword')}
                className="w-full px-2.5 py-1.5 text-xs rounded-md border border-gray-300 dark:border-dark-500 bg-white dark:bg-dark-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-[#4285F4] mb-2"
              />
              <input
                type="password"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleChangePassword()}
                placeholder={t('vault.settings.newPassword')}
                className="w-full px-2.5 py-1.5 text-xs rounded-md border border-gray-300 dark:border-dark-500 bg-white dark:bg-dark-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-[#4285F4] mb-2"
              />
              <button
                onClick={handleChangePassword}
                disabled={busy || !currentPassword || !newPassword}
                className="w-full bg-[#4285F4] hover:bg-[#3367D6] text-white font-medium text-xs py-1.5 rounded-md transition-colors disabled:opacity-50"
              >
                {t('vault.settings.changePassword')}
              </button>
            </div>
          )}

          <button
            onClick={handleDisable}
            disabled={busy}
            className="w-full text-xs text-red-600 dark:text-red-400 hover:underline py-1 disabled:opacity-50"
          >
            {t('vault.settings.disable')}
          </button>
        </>
      )}

      {message && (
        <p
          className={`text-xs mt-2 ${
            message.ok ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
          }`}
        >
          {message.text}
        </p>
      )}
    </div>
  );
}
