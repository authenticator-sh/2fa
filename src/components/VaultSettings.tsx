import { useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import { SettingRow, SettingsSection, settingsButton, settingsInput, settingsWell } from '@/components/SettingsSection';
import { createT, type Language } from '@/utils/i18n';
import { MIN_PASSWORD_LENGTH } from '@/utils/crypto';
import {
  AUTO_LOCK_OPTIONS,
  changePassword,
  detachPasskey,
  getVaultPasskey,
  stagePasskeyRegistration,
  WrongPasswordError,
  type VaultPasskey,
} from '@/utils/vault';
import { isPasskeyApiAvailable, openPasskeyCeremony } from '@/utils/passkey';
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
  const [passkey, setPasskey] = useState<VaultPasskey | null>(null);

  // Read on every mount rather than held in the parent: the registration
  // ceremony happens in a separate tab, so the popup that opened it is long
  // gone by the time a passkey exists.
  useEffect(() => {
    let cancelled = false;

    const read = async () => {
      const registered = enabled ? await getVaultPasskey() : null;
      if (!cancelled) setPasskey(registered);
    };
    read();

    // The wrapper is written to vault_meta by a ceremony in another window, so
    // without this the panel kept saying "add a passkey" after one was added,
    // until the popup was closed and reopened.
    if (!chrome.storage?.onChanged?.addListener) {
      return () => {
        cancelled = true;
      };
    }
    const onChanged = (changes: Record<string, unknown>, areaName: string) => {
      if (areaName === 'local' && 'vault_meta' in changes) read();
    };
    chrome.storage.onChanged.addListener(onChanged);

    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, [enabled]);

  const handleAddPasskey = async () => {
    // The password is required even while unlocked, as for turning protection
    // off: a passkey is a new, lasting way in, and linking one must not be
    // something anyone at an unattended, unlocked browser can do in a click.
    const password = await promptDialog({
      title: t('vault.passkey.add'),
      body: t('vault.settings.currentPassword'),
      password: true,
      confirmLabel: t('common.confirm'),
      cancelLabel: t('common.cancel'),
    });
    if (!password) return;

    // The ceremony page needs the master key to wrap it, and it is a separate
    // context that cannot read this one's memory — on auto-lock "every open"
    // the key is in no store at all. So it is handed over explicitly, unwrapped
    // from the password just typed and staged for registration only.
    //
    // Only a wrong password is called one. Every failure used to be: a storage
    // write refused while staging the key told the user their correct password
    // was wrong, and sent them round again for nothing.
    try {
      await stagePasskeyRegistration(password);
    } catch (error) {
      if (error instanceof WrongPasswordError) {
        toast('error', t('vault.lock.wrong'));
      } else {
        console.error('Could not prepare the passkey registration:', error);
        toast('error', t('settings.saveFailed'));
      }
      return;
    }

    // Its own window, not this popup: the authenticator prompt takes focus and
    // Chrome destroys the popup the moment that happens.
    try {
      openPasskeyCeremony('register');
    } catch (error) {
      console.error('Could not open the passkey window:', error);
      toast('error', t('settings.saveFailed'));
    }
  };

  const handleRemovePasskey = async () => {
    const confirmed = await confirmDialog({
      title: t('vault.passkey.remove'),
      body: t('vault.passkey.hint'),
      confirmLabel: t('vault.passkey.remove'),
      cancelLabel: t('common.cancel'),
      danger: true,
    });
    if (!confirmed) return;

    // No password needed, and deliberately so: this removes a convenience, not
    // a way in. The password and recovery wrappers are untouched.
    try {
      await detachPasskey();
    } catch (error) {
      // Unhandled, this was a rejection nobody saw and a panel left as it was
      // with no word of why. What is stored decides what the panel shows, so
      // it is read back rather than assumed either way.
      console.error('Could not remove the passkey:', error);
      toast('error', t('settings.saveFailed'));
      setPasskey(await getVaultPasskey().catch(() => passkey));
      return;
    }
    setPasskey(null);
    toast('success', t('vault.settings.saved'));
    onChanged();
  };

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
    <SettingsSection title={t('settings.sectionSecurity')}>
      <SettingRow
        label={t('vault.settings.title')}
        hint={enabled ? t('vault.settings.on') : t('vault.settings.off')}
        tone={enabled ? 'ok' : undefined}
        control={
          enabled ? (
            <button onClick={onLock} className={settingsButton.secondary}>
              <Lock size={13} />
              {t('vault.settings.lockNow')}
            </button>
          ) : (
            <button onClick={onEnableClick} className={settingsButton.primary}>
              <Lock size={13} />
              {t('vault.settings.enable')}
            </button>
          )
        }
      />

      {enabled && (
        <>
          <SettingRow
            label={t('vault.settings.autoLock')}
            htmlFor="vault-auto-lock"
            control={
              <select
                id="vault-auto-lock"
                value={autoLockMinutes}
                onChange={e => onAutoLockChange(Number(e.target.value))}
                className="text-xs bg-white dark:bg-dark-800 border border-gray-300 dark:border-dark-500 rounded-md px-2 py-1 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-accent-500"
              >
                {AUTO_LOCK_OPTIONS.map(minutes => (
                  <option key={minutes} value={minutes}>
                    {autoLockLabel(minutes)}
                  </option>
                ))}
              </select>
            }
          />

          {isPasskeyApiAvailable() && (
            <SettingRow
              label={t('vault.passkey.title')}
              hint={passkey ? t('vault.passkey.on', passkey.label) : t('vault.passkey.hint')}
              tone={passkey ? 'ok' : undefined}
              control={
                <button
                  onClick={passkey ? handleRemovePasskey : handleAddPasskey}
                  className={settingsButton.secondary}
                >
                  {passkey ? t('vault.passkey.remove') : t('vault.passkey.add')}
                </button>
              }
            />
          )}

          {/* The two things that need the password typed again, side by side
              and both quiet: neither is a setting, and neither is pressed twice. */}
          <div className="px-3 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
              <button
                onClick={() => setShowChangeForm(!showChangeForm)}
                aria-expanded={showChangeForm}
                className={settingsButton.link}
              >
                {t('vault.settings.changePassword')}
              </button>
              <button onClick={handleDisable} disabled={busy} className={settingsButton.danger}>
                {t('vault.settings.disable')}
              </button>
            </div>

            {showChangeForm && (
              <div className={`${settingsWell} space-y-2 p-2.5`}>
                <input
                  type="password"
                  value={currentPassword}
                  onChange={e => setCurrentPassword(e.target.value)}
                  placeholder={t('vault.settings.currentPassword')}
                  aria-label={t('vault.settings.currentPassword')}
                  className={settingsInput}
                />
                <input
                  type="password"
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleChangePassword()}
                  placeholder={t('vault.settings.newPassword')}
                  aria-label={t('vault.settings.newPassword')}
                  className={settingsInput}
                />
                <button
                  onClick={handleChangePassword}
                  disabled={busy || !currentPassword || !newPassword}
                  className={`${settingsButton.primary} w-full`}
                >
                  {t('vault.settings.changePassword')}
                </button>
              </div>
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
        </>
      )}
    </SettingsSection>
  );
}
