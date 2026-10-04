import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import { SettingRow, SettingsSection, settingsButton, settingsInput, settingsWell } from '@/components/SettingsSection';
import { createT, type Language } from '@/utils/i18n';
import { confirmDialog, toast } from '@/utils/ui-feedback';
import { activateLicenseKey, deactivateLicense, openBillingPortal } from '@/billing/actions';
import { openPaywall } from '@/billing/bridge';
import { track } from '@/billing/events';
import { readEntitlement, readInstall, readPolicy } from '@/billing/state';
import { hasPendingCheckout, syncBilling } from '@/billing/sync';
import type { Entitlement, Policy } from '@/billing/types';
import { billingErrorMessage } from '@/billing/messages';

interface ProSettingsProps {
  language: Language;
}

interface ProState {
  policy: Policy | null;
  entitlement: Entitlement | null;
  pending: boolean;
}

const PENDING_LINE_MS = 2 * 3_600_000;

async function readState(): Promise<ProState> {
  const install = await readInstall();
  if (!install) return { policy: null, entitlement: null, pending: false };
  const [policy, entitlement, pending] = await Promise.all([
    readPolicy(install.id),
    readEntitlement(install.id),
    // Opening checkout is not buying: after a couple of hours an abandoned tab
    // is the likelier story, and "confirming your purchase" would be untrue.
    hasPendingCheckout(Date.now(), PENDING_LINE_MS),
  ]);
  return { policy, entitlement, pending };
}

/**
 * Pro in Settings: what this install has, and the ways to change it.
 *
 * Shown only when there is something to say — a limit, a license, or a
 * policy that invites support. An install the server has never answered sees
 * nothing here, as it sees no limit anywhere else.
 */
export function ProSettings({ language }: ProSettingsProps) {
  const t = createT(language);
  const [state, setState] = useState<ProState | null>(null);
  const [busy, setBusy] = useState<'key' | 'portal' | 'remove' | 'check' | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const tracked = useRef(false);

  const refresh = useCallback(() => {
    void readState().then(setState);
  }, []);

  useEffect(() => {
    refresh();
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && Object.keys(changes).some(k => k.startsWith('billing'))) refresh();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [refresh]);

  const visible =
    !!state && (!!state.entitlement || state.pending || (!!state.policy && (state.policy.free_limit !== null || state.policy.ui.pro_in_settings)));

  useEffect(() => {
    if (visible && !tracked.current) {
      tracked.current = true;
      void track('pro_settings_view', { entitled: !!state?.entitlement });
    }
  }, [visible, state]);

  if (!state || !visible) return null;

  const { policy, entitlement, pending } = state;
  const dateText = (ms: number | null) =>
    ms ? new Intl.DateTimeFormat(language, { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(ms)) : '';

  const status = (() => {
    if (entitlement) {
      if (entitlement.kind === 'life') return t('pro.statusLife');
      if (entitlement.kind === 'sub') return t('pro.statusSub', dateText(entitlement.until));
      if (entitlement.kind === 'pass') return t('pro.statusPass', dateText(entitlement.until));
      return entitlement.until ? t('pro.statusPass', dateText(entitlement.until)) : t('pro.statusComp');
    }
    // No "N of M": nothing shows the limit before it is met (and after a free import N can exceed M).
    if (policy && policy.free_limit !== null) return t('pro.statusFree');
    return t('pro.statusUnlimitedFree');
  })();

  const run = async (kind: NonNullable<typeof busy>, fn: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(billingErrorMessage(e, t));
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const unlimitedFree = !entitlement && (!policy || policy.free_limit === null);

  const failure = error && (
    <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
      {error}
    </p>
  );

  // With Pro on, the section is built the way Security is: what is on, then a
  // quiet last row for the one thing that undoes it. No line on what Pro gives
  // under the status: the buyer knows, and it read as a sales pitch (owner,
  // 2026-10-04). The way
  // out used to be the only control in the card, in red, directly under the
  // status — the first thing the eye met in a section with nothing to decide.
  //
  // No title over the card: every status here begins with "Pro", and the
  // caption above it was the same word twice.
  if (entitlement) {
    return (
      <SettingsSection title={t('pro.title')} hideTitle>
        <SettingRow
          label={status}
          control={
            entitlement.kind === 'sub' ? (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void run('portal', openBillingPortal)}
                className={settingsButton.secondary}
              >
                {t('pro.manage')}
              </button>
            ) : undefined
          }
        />
        <div className="px-3 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
            <span className="text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">
              {entitlement.key_hint ? t('pro.keyHint', entitlement.key_hint) : ''}
            </span>
            <button
              type="button"
              disabled={busy !== null}
              onClick={async () => {
                const ok = await confirmDialog({
                  title: t('pro.removeConfirmTitle'),
                  body: t('pro.removeConfirmBody'),
                  confirmLabel: t('pro.removeConfirm'),
                  cancelLabel: t('paywall.back'),
                  danger: true,
                });
                if (!ok) return;
                await run('remove', async () => {
                  await deactivateLicense();
                  toast('info', t('pro.removed'));
                });
              }}
              className={settingsButton.danger}
            >
              {t('pro.removeHere')}
            </button>
          </div>
          {failure}
        </div>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title={t('pro.title')}>
      <SettingRow label={status} hint={unlimitedFree ? t('pro.supportHint') : undefined}>
        {pending && (
          <div className="mt-2 flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
            <Loader2 size={14} className="animate-spin" aria-hidden />
            <span>{t('pro.pending')}</span>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void run('check', async () => void (await syncBilling({ force: true })))}
              className={settingsButton.link}
            >
              {t('pro.checkNow')}
            </button>
          </div>
        )}

        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void openPaywall({ trigger: 'settings' })}
            className={settingsButton.primary}
          >
            {unlimitedFree ? t('pro.support') : t('pro.get')}
          </button>
          <button
            type="button"
            onClick={() => setShowKey(!showKey)}
            aria-expanded={showKey}
            className={settingsButton.secondary}
          >
            <KeyRound size={13} aria-hidden />
            {t('paywall.haveKey')}
          </button>
        </div>

        {showKey && (
          <form
            className={`${settingsWell} flex gap-2 p-2.5`}
            onSubmit={e => {
              e.preventDefault();
              if (!key.trim()) return;
              void run('key', async () => {
                await activateLicenseKey(key);
                setKey('');
                setShowKey(false);
                toast('success', t('billing.activated'));
              });
            }}
          >
            <input
              value={key}
              onChange={e => setKey(e.target.value)}
              placeholder={t('paywall.keyPlaceholder')}
              autoComplete="off"
              spellCheck={false}
              aria-label={t('paywall.haveKey')}
              className={`${settingsInput} min-w-0 flex-1 font-mono uppercase placeholder:normal-case placeholder:text-gray-400`}
            />
            <button
              type="submit"
              disabled={!key.trim() || busy !== null}
              className={settingsButton.primary}
            >
              {busy === 'key' ? <Loader2 size={14} className="animate-spin" aria-hidden /> : t('paywall.activate')}
            </button>
          </form>
        )}

        {failure}
      </SettingRow>
    </SettingsSection>
  );
}
