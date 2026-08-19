// The passkey ceremony, in its own extension page opened as a small window.
//
// It is not a dialog inside the action popup for one hard reason: Chrome destroys
// that popup the instant it loses focus, and the platform authenticator prompt —
// Touch ID, Windows Hello, a phone over caBLE — takes focus by definition. The
// promise from navigator.credentials would die with the page every single time.
// The camera scanner in src/scan/ exists for the same reason, and uses a tab; a
// window is used here because confirming a passkey is one gesture, not a task.
//
// Two modes, both arriving as a query parameter:
//   ?mode=register — the vault is unlocked; link a new passkey to it.
//   ?mode=unlock   — the vault is locked; use the linked passkey to open it.
//
// Nothing here is a new permission. WebAuthn from an extension page may claim
// the extension's own origin as its relying party id; only claiming a website's
// id would need host permissions, and this page claims none.

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Check, Fingerprint, Lock } from 'lucide-react';
import { Logo } from '@/components/Logo';
import { SupportFooter } from '@/components/SupportFooter';
import { applyDocumentLanguage, createT, detectLanguage, loadLanguage, type Language } from '@/utils/i18n';
import {
  evaluatePrf,
  isPasskeyApiAvailable,
  newPrfSalt,
  PasskeyCancelledError,
  PasskeyNoPrfError,
  PasskeyUnsupportedError,
  registerPasskey,
} from '@/utils/passkey';
import {
  attachPasskey,
  consumeKeyHandoff,
  getMasterKeyBytes,
  getVaultPasskey,
  isVaultEnabled,
  stageKeyHandoff,
  unlockWithPasskey,
} from '@/utils/vault';

type Mode = 'register' | 'unlock';

type Status =
  | { kind: 'working' }
  | { kind: 'done' }
  | { kind: 'locked' }
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string };

function modeFromUrl(): Mode {
  return new URLSearchParams(window.location.search).get('mode') === 'register'
    ? 'register'
    : 'unlock';
}

export default function App() {
  const [language, setLanguage] = useState<Language>('en');
  const [status, setStatus] = useState<Status>({ kind: 'working' });
  const mode = modeFromUrl();
  const t = createT(language);

  useEffect(() => {
    (async () => {
      const detected = await detectLanguage();
      await loadLanguage(detected);
      applyDocumentLanguage(detected);
      setLanguage(detected);
    })();
  }, []);

  const run = useCallback(async () => {
    setStatus({ kind: 'working' });

    if (!isPasskeyApiAvailable()) {
      setStatus({ kind: 'unsupported' });
      return;
    }

    try {
      if (!(await isVaultEnabled())) {
        setStatus({ kind: 'error', message: t('vault.passkey.needsUnlock') });
        return;
      }

      if (mode === 'register') {
        // Registration needs the master key, which only exists while the vault
        // is unlocked. Sending the user back to the popup is the honest outcome:
        // there is nothing to wrap yet.
        // The popup stages the key before opening this window, because with
        // auto-lock on "every open" it lives in no store this context can read.
        // Falling back to the session covers every other mode and a reload of
        // this page after the staged copy was consumed.
        const masterKey = (await consumeKeyHandoff()) ?? (await getMasterKeyBytes());
        if (!masterKey) {
          setStatus({ kind: 'locked' });
          return;
        }

        const prfSalt = newPrfSalt();
        const label = t('vault.passkey.labelDefault');
        const { credentialId, prfOutput } = await registerPasskey(prfSalt, label);
        // attachPasskey verifies the wrapper round-trips before anything is
        // written, so a passkey that cannot reproduce its own PRF output never
        // becomes a stored wrapper that opens nothing.
        await attachPasskey(masterKey, credentialId, prfSalt, prfOutput, label);
        setStatus({ kind: 'done' });
        return;
      }

      const registered = await getVaultPasskey();
      if (!registered) {
        setStatus({ kind: 'error', message: t('vault.passkey.failed') });
        return;
      }

      const prfOutput = await evaluatePrf(registered.credentialId, registered.prfSalt);
      const masterKey = await unlockWithPasskey(prfOutput);
      // unlockWithPasskey wrote this context's session, which the popup cannot
      // see when auto-lock is "every open". Stage it so the next popup open
      // adopts it once — the biometric prompt was the authentication event.
      // Staging also fires a session change event, which is how a popup that is
      // still open leaves its lock screen without being reopened.
      await stageKeyHandoff(masterKey);
      setStatus({ kind: 'done' });

      // Best effort, in this order on purpose. openPopup lands the user straight
      // back where they were, but it needs a user gesture that may already have
      // expired during the biometric prompt, and it does not exist before Chrome
      // 127 — so it is allowed to fail silently. Closing this window is what
      // must always happen: leaving it open makes the user dismiss a window to
      // get back to the codes they just unlocked.
      try {
        await chrome.action?.openPopup?.();
      } catch {
        // No gesture, or too old a Chrome. The popup opens on the next click.
      }
      window.setTimeout(() => window.close(), 400);
    } catch (error) {
      console.error('Passkey ceremony failed:', error);
      if (error instanceof PasskeyCancelledError) {
        setStatus({ kind: 'error', message: t('vault.passkey.cancelled') });
        return;
      }
      if (error instanceof PasskeyUnsupportedError || error instanceof PasskeyNoPrfError) {
        setStatus({ kind: 'unsupported' });
        return;
      }
      setStatus({ kind: 'error', message: t('vault.passkey.failed') });
    }
  }, [mode, t]);

  // Deliberately not automatic. A WebAuthn call that fires on page load, before
  // the user has read what the page is for, reads as a prompt out of nowhere —
  // and browsers increasingly refuse ceremonies without a user gesture anyway.
  const heading =
    mode === 'register' ? t('vault.passkey.confirmRegister') : t('vault.passkey.confirmUnlock');

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-6 bg-gray-50 dark:bg-dark-900 p-6">
      <Logo />

      <div className="w-full max-w-sm bg-white dark:bg-dark-800 rounded-xl border border-gray-200 dark:border-dark-600 p-6 text-center">
        <div className="w-12 h-12 mx-auto rounded-full bg-gray-100 dark:bg-dark-700 flex items-center justify-center mb-4">
          {status.kind === 'done' ? (
            <Check className="text-green-600 dark:text-green-400" size={22} />
          ) : status.kind === 'unsupported' || status.kind === 'error' ? (
            <AlertTriangle className="text-amber-500" size={22} />
          ) : status.kind === 'locked' ? (
            <Lock className="text-gray-500 dark:text-gray-400" size={22} />
          ) : (
            <Fingerprint className="text-[#4285F4]" size={22} />
          )}
        </div>

        <h1 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">
          {t('vault.passkey.title')}
        </h1>

        {status.kind === 'done' ? (
          <p className="text-sm text-gray-600 dark:text-gray-300">{t('vault.passkey.done')}</p>
        ) : status.kind === 'unsupported' ? (
          <p className="text-sm text-gray-600 dark:text-gray-300">{t('vault.passkey.unsupported')}</p>
        ) : status.kind === 'locked' ? (
          <p className="text-sm text-gray-600 dark:text-gray-300">{t('vault.passkey.needsUnlock')}</p>
        ) : (
          <>
            <p className="text-sm text-gray-600 dark:text-gray-300 mb-5">{heading}</p>

            {status.kind === 'error' && (
              <p className="flex items-center justify-center gap-1.5 text-xs text-red-600 dark:text-red-400 mb-4">
                <AlertTriangle size={14} />
                {status.message}
              </p>
            )}

            <button
              onClick={run}
              className="w-full flex items-center justify-center gap-2 bg-[#4285F4] hover:bg-[#3367D6] text-white font-medium text-sm py-2.5 rounded-lg transition-colors"
            >
              <Fingerprint size={16} />
              {mode === 'register' ? t('vault.passkey.add') : t('vault.passkey.unlockButton')}
            </button>
          </>
        )}

        {status.kind === 'done' && (
          <button
            onClick={() => window.close()}
            className="mt-5 w-full text-xs text-gray-500 dark:text-gray-400 hover:underline py-1"
          >
            {t('common.ok')}
          </button>
        )}
      </div>

      <SupportFooter language={language} />
    </div>
  );
}
