import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';
import { SettingRow, settingsButton, settingsInput, settingsWell } from '@/components/SettingsSection';
import { CloudBackupSetupModal } from '@/components/CloudBackupSetupModal';
import { describeAge, resultMessage, startOfLine } from '@/components/RestoreBackups';
import { createT, type Language } from '@/utils/i18n';
import { confirmDialog, toast } from '@/utils/ui-feedback';
import { VaultLockedError } from '@/utils/vault';
import { activateLicenseKey } from '@/billing/actions';
import { BillingApiError } from '@/billing/api';
import { openPaywall } from '@/billing/bridge';
import {
  adoptBackupCode,
  backupNow,
  cloudBackupEntitlement,
  CLOUD_BACKUP_CODE_KEY,
  DamagedCloudBackupError,
  deriveBackupKeys,
  disableCloudBackup,
  listCloudBackups,
  reconcileCloudBackupCode,
  NothingToBackUpError,
  readCode,
  readUploadState,
  resetCloudBackup,
  restoreCloudBackup,
  WrongBackupCodeError,
  type CloudBackupSummary,
  type CodeState,
} from '@/billing/cloud-backup';
import { billingErrorMessage } from '@/billing/messages';
import { readEntitlement, readInstall, readPolicy } from '@/billing/state';
import { hasPendingCheckout, syncBilling } from '@/billing/sync';
import type { Entitlement } from '@/billing/types';

interface CloudBackupSettingsProps {
  language: Language;
  /** Reload the account list after a restore. */
  onRestored: () => void;
}

interface LocalState {
  entitlement: Entitlement | null;
  /**
   * Any Pro at all — also a license signed before cloud backup existed, which
   * lacks the feature until its next check-in. Such a buyer is not offered Pro.
   */
  hasPro: boolean;
  code: CodeState;
  lastUploadAt: number | null;
  failedAt: number | null;
  /**
   * There is something to buy here: the server's last policy offers plans.
   * It offers none where paying is impossible (server NO_PAYMENT_COUNTRIES),
   * and an install it has never answered has no policy — a "Turn on" there
   * would open a paywall with no way through.
   */
  buyable: boolean;
  /** A purchase was opened and is not confirmed yet: no second offer meanwhile. */
  pending: boolean;
}

type Server =
  | { status: 'idle' | 'loading' | 'error' | 'nolicense' }
  | { status: 'ok'; copies: CloudBackupSummary[]; kid: string | null };

type RestoreOptions = { typed?: string; licenseKey?: string };

async function readLocal(): Promise<LocalState> {
  const install = await readInstall();
  const policy = install ? await readPolicy(install.id) : null;
  const [entitlement, anyPro, code, upload, pending] = await Promise.all([
    cloudBackupEntitlement(),
    install ? readEntitlement(install.id) : null,
    readCode(),
    readUploadState(),
    hasPendingCheckout(),
  ]);
  return {
    entitlement,
    hasPro: !!anyPro,
    code,
    lastUploadAt: upload.at,
    failedAt: upload.failedAt,
    buyable: !!policy && policy.paywall.plans.length > 0,
    pending,
  };
}

/**
 * This install's side of cloud backup, kept current as billing or the backup
 * changes. Shared with the banner over Settings, so the two decide alike.
 */
export function useCloudBackupLocal(): [LocalState | null, () => void] {
  const [local, setLocal] = useState<LocalState | null>(null);
  const refreshLocal = useCallback(() => {
    void readLocal().then(setLocal);
  }, []);
  useEffect(() => {
    refreshLocal();
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      const keys = Object.keys(changes);
      if (area === 'local' && keys.some(k => k.startsWith('billing') || k.startsWith('cloudBackup'))) refreshLocal();
      // A code another profile turned on, or took away.
      if (area === 'sync' && keys.includes(CLOUD_BACKUP_CODE_KEY)) refreshLocal();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [refreshLocal]);
  return [local, refreshLocal];
}

/** A license with the backup, or a code kept here: there is more to show than an offer. */
const isInvolved = (local: LocalState): boolean => !!local.entitlement || local.code.kind !== 'none';

/**
 * Whether to offer cloud backup for sale — the "Turn on" in its row and the
 * banner over Settings. Only where it can lead somewhere: not while a purchase
 * is being confirmed or a license's check-in is bringing the feature, and not
 * where nothing can be bought.
 */
export function offersCloudBackup(local: LocalState): boolean {
  return !isInvolved(local) && !local.pending && !local.hasPro && local.buyable;
}

/**
 * Pro was just bought or activated from a backup paywall — the row's "Turn
 * on" or the banner: once it is in, the setup opens by itself. Module-wide
 * rather than the row's own, because the banner is not inside the row.
 */
let wantSetup = false;
export function wishCloudBackupSetup(): void {
  wantSetup = true;
}

/**
 * A stamp from the server's clock read on this one: a copy made a moment ago
 * on a server a few seconds ahead must say "today", not "date unknown".
 */
function age(timestamp: number, t: ReturnType<typeof createT>): string {
  const now = Date.now();
  return describeAge(timestamp > now && timestamp - now < 86_400_000 ? now : timestamp, t);
}

/** "Today, 10:42" — a busy day makes several copies, and they must be told apart. */
function when(timestamp: number, t: ReturnType<typeof createT>, language: Language): string {
  const text = startOfLine(age(timestamp, t), language);
  if (Date.now() - timestamp > 86_400_000) return text;
  const time = new Intl.DateTimeFormat(language, { hour: 'numeric', minute: '2-digit' }).format(new Date(timestamp));
  return `${text}, ${time}`;
}

/**
 * Cloud backup, in Settings → Backup & Restore, under the automatic copies.
 *
 * The automatic copies live on this device and go with it; this is the one
 * that survives the device. Every state is decided with the server's answer in
 * hand — which copies the license has and which code is its current one — and
 * a question it did not answer is shown as such, never as "no copies": a
 * "Turn on" drawn from a failed request is how a license would get a second
 * code.
 *
 * Without Pro, the same "Turn on", for every install (legacy ones included,
 * owner 2026-10-07), opens the paywall with the backup's own words; and a
 * license that ended can still be restored on a new browser with its key.
 */
export function CloudBackupSettings({ language, onRestored }: CloudBackupSettingsProps) {
  const t = createT(language);
  const [local, refreshLocal] = useCloudBackupLocal();
  const [server, setServer] = useState<Server>({ status: 'idle' });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [setup, setSetup] = useState(false);
  const [showOlder, setShowOlder] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetKey, setResetKey] = useState('');
  const [byKey, setByKey] = useState(false);
  const askedSync = useRef(false);

  const refreshServer = useCallback(() => {
    setServer(s => (s.status === 'ok' ? s : { status: 'loading' }));
    listCloudBackups()
      .then(list => setServer({ status: 'ok', ...list }))
      .catch(err => {
        if (err instanceof BillingApiError && err.code === 'no_license') setServer({ status: 'nolicense' });
        else {
          console.warn('cloud backup: list failed', err);
          setServer({ status: 'error' });
        }
      });
  }, []);

  const involved = !!local && isInvolved(local);
  const codeKid = local?.code.kind === 'ready' ? local.code.kid : null;
  const lid = local?.entitlement?.lid ?? null;
  useEffect(() => {
    if (involved) refreshServer();
    else setServer({ status: 'idle' });
  }, [involved, codeKid, lid, refreshServer]);

  // A license signed before cloud backup existed lacks it until its next
  // check-in; ask for that check-in now rather than showing nothing for a day.
  useEffect(() => {
    if (local && local.hasPro && !local.entitlement && !askedSync.current) {
      askedSync.current = true;
      void syncBilling({ force: true });
    }
  }, [local]);

  // The license's code is not the one kept here: turned off from another
  // browser (no code), or started over there with a new one. The kept code
  // opens nothing on the server any more — forget it, and ask for the current.
  useEffect(() => {
    if (server.status !== 'ok' || !local || local.code.kind !== 'ready') return;
    if (server.kid !== local.code.kid) {
      void reconcileCloudBackupCode()
        .catch(err => console.warn('cloud backup: could not check the code', err))
        .then(() => {
          refreshLocal();
          refreshServer();
        });
    }
  }, [server, local, refreshLocal, refreshServer]);

  // Bought from the backup's paywall: once Pro is in and the license has no
  // code, the setup opens by itself — what the person pressed "Turn on" for.
  useEffect(() => {
    if (!wantSetup || server.status !== 'ok') return;
    // A license that already has a code (a key typed in, its copies made
    // elsewhere): there is nothing to set up, and the wish must not linger to
    // open the setup by itself after a later "Turn off".
    if (server.kid !== null) wantSetup = false;
    else if (local?.entitlement) {
      wantSetup = false;
      setSetup(true);
    }
  }, [local, server]);

  if (!local) return null;

  const explain = (err: unknown): string => {
    if (err instanceof WrongBackupCodeError) return t('cloud.wrongCode');
    if (err instanceof DamagedCloudBackupError) return t('cloud.damaged');
    if (err instanceof NothingToBackUpError) return t('cloud.nothing');
    if (err instanceof VaultLockedError) return t('restore.locked');
    if (err instanceof BillingApiError && err.code === 'backup_wrong_code') return t('cloud.wrongCode');
    if (err instanceof BillingApiError) return billingErrorMessage(err, t);
    return t('cloud.failed');
  };

  const run = async (kind: string, fn: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (err) {
      console.error('Cloud backup:', err);
      setError(explain(err));
    } finally {
      setBusy(null);
      refreshLocal();
      if (involved) refreshServer();
    }
  };

  const failure = error && (
    <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
      {error}
    </p>
  );

  const modal = setup && (
    <CloudBackupSetupModal
      language={language}
      onClose={() => {
        setSetup(false);
        // Turned on meanwhile from another browser, or a claim that landed
        // before its answer was lost: what the license has now decides the row.
        refreshServer();
      }}
      onEnabled={() => {
        toast('success', t('cloud.setup.done'));
        refreshLocal();
        refreshServer();
      }}
    />
  );

  const restoreCopy = async (copy: CloudBackupSummary, options: RestoreOptions) => {
    const ok = await confirmDialog({
      title: t('cloud.restoreConfirmTitle'),
      body: t('cloud.restoreConfirmBody', age(copy.createdAt, t)),
      confirmLabel: t('restore.action'),
      cancelLabel: t('common.cancel'),
    });
    if (!ok) return;
    await run(copy.id, async () => {
      const result = await restoreCloudBackup(copy.id, options);
      toast(result.added > 0 ? 'success' : 'info', resultMessage(result, t));
      onRestored();
      if (options.licenseKey && !local.hasPro) await takeLicenseAlong(options.licenseKey, options.typed);
    });
  };

  /**
   * Restored with the license key on a browser without Pro — a new Chrome
   * profile, a new computer: the person typed their own key, so this browser
   * takes the license too, and the code, so its later changes are backed up as
   * well. A license that has ended, or one already on all its browsers, only
   * restores; the second is said, the first needs no words.
   */
  const takeLicenseAlong = async (licenseKey: string, typed?: string) => {
    try {
      await activateLicenseKey(licenseKey);
    } catch (err) {
      if (err instanceof BillingApiError && err.code === 'device_limit') toast('info', billingErrorMessage(err, t));
      else console.warn('cloud backup: the license did not come along', err);
      return;
    }
    toast('success', t('billing.activated'));
    if (typed) await adoptBackupCode(typed).catch(err => console.warn('cloud backup: could not keep the code', err));
  };

  const copyList = (copies: CloudBackupSummary[], options: RestoreOptions = {}) => {
    const [newest, ...older] = copies;
    const shown = showOlder ? copies : newest ? [newest] : [];
    return (
      <ul className={`${settingsWell} divide-y divide-gray-200 dark:divide-dark-700`}>
        {shown.map(copy => (
          <li key={copy.id} className="flex items-center justify-between gap-3 px-2.5 py-1.5">
            <p className="min-w-0 truncate text-xs text-gray-700 dark:text-gray-300">
              <span className="font-medium text-gray-900 dark:text-gray-100">{when(copy.createdAt, t, language)}</span>
              {' · '}
              {copy.thisDevice ? t('cloud.thisBrowser') : t('cloud.otherBrowser')}
            </p>
            <button
              type="button"
              onClick={() => void restoreCopy(copy, options)}
              disabled={busy !== null}
              className={`${settingsButton.secondary} bg-white dark:bg-dark-700`}
            >
              {busy === copy.id ? t('restore.busy') : t('restore.action')}
            </button>
          </li>
        ))}
        {older.length > 0 && (
          <li>
            <button
              type="button"
              onClick={() => setShowOlder(open => !open)}
              aria-expanded={showOlder}
              className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-xs text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200"
            >
              {t('restore.older', older.length)}
              <ChevronDown size={14} className={`flex-shrink-0 transition-transform ${showOlder ? 'rotate-180' : ''}`} />
            </button>
          </li>
        )}
      </ul>
    );
  };

  // ─── Without Pro and nothing turned on here ─────────────────────────────
  if (!involved) {
    // "Turn on" only where it can lead somewhere (offersCloudBackup). Restoring
    // with the license key is always here — getting old copies back never
    // depends on what can be bought today.
    const offer = offersCloudBackup(local);
    return (
      <SettingRow
        label={t('cloud.title')}
        hint={offer ? t('cloud.teaser') : undefined}
        control={
          offer ? (
            <button
              type="button"
              onClick={() =>
                void openPaywall({ trigger: 'backup' }).then(result => {
                  // A key typed in, or a purchase in a Checkout tab while this
                  // panel stays open: once Pro is in, the setup opens by itself.
                  if (result === 'activated' || result === 'checkout') wishCloudBackupSetup();
                })
              }
              aria-label={t('cloud.setup.finish')}
              className={settingsButton.secondary}
            >
              {t('cloud.turnOn')}
            </button>
          ) : undefined
        }
      >
        <button type="button" onClick={() => setByKey(open => !open)} aria-expanded={byKey} className={`${settingsButton.link} mt-2`}>
          {t('cloud.keyRestoreLink')}
        </button>
        {byKey && <RestoreWithKey language={language} copyList={copyList} />}
      </SettingRow>
    );
  }

  // ─── Asking the server ──────────────────────────────────────────────────
  if (server.status === 'idle' || server.status === 'loading') {
    return (
      <SettingRow label={t('cloud.title')}>
        <p role="status" className="mt-1 flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
          <Loader2 size={14} className="animate-spin" aria-hidden />
          {t('cloud.loading')}
        </p>
      </SettingRow>
    );
  }

  if (server.status === 'error') {
    return (
      <SettingRow
        label={t('cloud.title')}
        hint={t('cloud.listFailed')}
        tone="warn"
        control={
          <button type="button" onClick={refreshServer} className={settingsButton.secondary}>
            {t('paywall.retry')}
          </button>
        }
      />
    );
  }

  // A code is kept here but this browser holds no license (removed here, or
  // never activated): the copies are reachable only with the license key.
  if (server.status === 'nolicense') {
    return (
      <SettingRow label={t('cloud.title')} hint={t('cloud.noLicenseHere')}>
        <RestoreWithKey language={language} copyList={copyList} />
      </SettingRow>
    );
  }

  if (local.code.kind === 'locked') {
    return <SettingRow label={t('cloud.title')} hint={t('restore.locked')} />;
  }

  // Pro without cloud backup in its license yet — signed before the feature,
  // its check-in asked for above. Not "Pro has ended": it has not.
  if (local.hasPro && !local.entitlement) {
    return (
      <SettingRow label={t('cloud.title')}>
        <p role="status" className="mt-1 flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
          <Loader2 size={14} className="animate-spin" aria-hidden />
          {t('cloud.loading')}
        </p>
      </SettingRow>
    );
  }

  if (server.status !== 'ok') return null;
  const { copies, kid } = server;

  // ─── Off for the license ────────────────────────────────────────────────
  if (kid === null) {
    if (!local.entitlement) return null;
    return (
      <>
        <SettingRow
          label={t('cloud.title')}
          hint={t('cloud.hintOff')}
          control={
            <button
              type="button"
              onClick={() => setSetup(true)}
              aria-label={t('cloud.setup.finish')}
              className={settingsButton.secondary}
            >
              {t('cloud.turnOn')}
            </button>
          }
        >
          {failure}
          {/* Copies made under an earlier license — Pro bought again on a new
              browser is a new license, with none of its own: the old key still
              finds them. A purchase from the browser that held the old one
              takes its backup along on the server (backup.ts carryBackupToLicense). */}
          <button type="button" onClick={() => setByKey(open => !open)} aria-expanded={byKey} className={`${settingsButton.link} mt-2`}>
            {t('cloud.keyRestoreLink')}
          </button>
          {byKey && <RestoreWithKey language={language} copyList={copyList} />}
        </SettingRow>
        {modal}
      </>
    );
  }

  // ─── On for the license, but this browser lacks its code ────────────────
  if (local.code.kind !== 'ready' || local.code.kid !== kid) {
    return (
      <>
        <SettingRow label={t('cloud.title')} hint={t('cloud.needCode')}>
          <form
            className={`${settingsWell} flex gap-2 p-2.5`}
            onSubmit={e => {
              e.preventDefault();
              if (!typed.trim()) return;
              void run('code', async () => {
                const merged = await adoptBackupCode(typed);
                setTyped('');
                if (merged) {
                  toast(merged.added > 0 ? 'success' : 'info', resultMessage(merged, t));
                  if (merged.added > 0) onRestored();
                }
              });
            }}
          >
            <input
              value={typed}
              onChange={e => setTyped(e.target.value)}
              placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
              autoComplete="off"
              spellCheck={false}
              aria-label={t('cloud.codeLabel')}
              className={`${settingsInput} min-w-0 flex-1 font-mono uppercase placeholder:normal-case placeholder:text-gray-400`}
            />
            <button type="submit" disabled={!typed.trim() || busy !== null} className={settingsButton.primary}>
              {busy === 'code' ? <Loader2 size={14} className="animate-spin" aria-hidden /> : t('cloud.continue')}
            </button>
          </form>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => setResetting(open => !open)}
            aria-expanded={resetting}
            className={`${settingsButton.link} mt-2`}
          >
            {t('cloud.lostCode')}
          </button>
          {resetting && (
            <form
              className={`${settingsWell} p-2.5`}
              onSubmit={async e => {
                e.preventDefault();
                if (!resetKey.trim()) return;
                const ok = await confirmDialog({
                  title: t('cloud.startOverTitle'),
                  body: t('cloud.startOverBody'),
                  confirmLabel: t('cloud.startOverConfirm'),
                  cancelLabel: t('common.cancel'),
                  danger: true,
                });
                if (!ok) return;
                await run('reset', async () => {
                  await resetCloudBackup(resetKey.trim());
                  setResetKey('');
                  setResetting(false);
                  if (local.entitlement) setSetup(true);
                });
              }}
            >
              <p className="mb-2 text-[11px] leading-relaxed text-gray-600 dark:text-gray-400">{t('cloud.resetHint')}</p>
              <div className="flex gap-2">
                <input
                  value={resetKey}
                  onChange={e => setResetKey(e.target.value)}
                  placeholder={t('paywall.keyPlaceholder')}
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={t('paywall.haveKey')}
                  className={`${settingsInput} min-w-0 flex-1 font-mono uppercase placeholder:normal-case placeholder:text-gray-400`}
                />
                <button type="submit" disabled={!resetKey.trim() || busy !== null} className={settingsButton.danger}>
                  {busy === 'reset' ? <Loader2 size={14} className="animate-spin" aria-hidden /> : t('cloud.startOverConfirm')}
                </button>
              </div>
            </form>
          )}
          {failure}
        </SettingRow>
        {modal}
      </>
    );
  }

  // ─── On ─────────────────────────────────────────────────────────────────
  const code = local.code.code;
  const failedLast = local.failedAt !== null && (local.lastUploadAt === null || local.failedAt > local.lastUploadAt);
  const status = !local.entitlement
    ? t('cloud.lapsed')
    : failedLast
      ? t('cloud.lastFailed')
      : local.lastUploadAt !== null
        ? t('cloud.onLast', age(local.lastUploadAt, t))
        : t('cloud.onNoCopy');

  const turnOff = async () => {
    const ok = await confirmDialog({
      title: t('cloud.turnOffTitle'),
      body: t('cloud.turnOffBody'),
      confirmLabel: t('cloud.turnOffConfirm'),
      cancelLabel: t('common.cancel'),
      danger: true,
    });
    if (!ok) return;
    await run('off', async () => {
      const deleted = await disableCloudBackup();
      toast('info', t('cloud.turnedOff', deleted));
    });
  };

  return (
    <SettingRow
      label={t('cloud.title')}
      hint={status}
      tone={local.entitlement && !failedLast ? 'ok' : 'warn'}
      control={
        local.entitlement ? (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() =>
              void run('now', async () => {
                await backupNow();
                toast('success', t('cloud.backedUp'));
              })
            }
            className={settingsButton.secondary}
          >
            {busy === 'now' ? t('cloud.backingUp') : t('cloud.backupNow')}
          </button>
        ) : undefined
      }
    >
      {copies.length > 0 && copyList(copies)}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <button type="button" onClick={() => setShowCode(open => !open)} aria-expanded={showCode} className={settingsButton.link}>
          {showCode ? t('cloud.hideCode') : t('cloud.showCode')}
        </button>
        <button type="button" disabled={busy !== null} onClick={() => void turnOff()} className={settingsButton.danger}>
          {t('cloud.turnOff')}
        </button>
      </div>
      {showCode && (
        <code
          className={`${settingsWell} block select-all px-2.5 py-2 text-center font-mono text-xs font-semibold tracking-wider text-gray-900 dark:text-gray-100`}
        >
          {code.match(/.{1,5}/g)!.join('-')}
        </code>
      )}
      {failure}
    </SettingRow>
  );
}

interface RestoreWithKeyProps {
  language: Language;
  copyList: (copies: CloudBackupSummary[], options: RestoreOptions) => ReactNode;
}

/**
 * The way back for a license that ended, on a browser that never held it: the
 * license key finds the copies, the backup code opens them. Pro ending stops
 * new copies; it never stops getting the old ones back.
 */
function RestoreWithKey({ language, copyList }: RestoreWithKeyProps) {
  const t = createT(language);
  const [key, setKey] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<{ copies: CloudBackupSummary[]; key: string; code: string } | null>(null);

  const find = async () => {
    setBusy(true);
    setError(null);
    setFound(null);
    try {
      const licenseKey = key.trim();
      const list = await listCloudBackups(licenseKey);
      if (list.kid === null || list.copies.length === 0) setError(t('cloud.noCopies'));
      else if ((await deriveBackupKeys(code)).kid !== list.kid) setError(t('cloud.wrongCode'));
      else setFound({ copies: list.copies, key: licenseKey, code });
    } catch (err) {
      setError(err instanceof BillingApiError ? billingErrorMessage(err, t) : t('cloud.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`${settingsWell} space-y-2 p-2.5`}>
      <input
        value={key}
        onChange={e => setKey(e.target.value)}
        placeholder={t('paywall.keyPlaceholder')}
        autoComplete="off"
        spellCheck={false}
        aria-label={t('paywall.haveKey')}
        className={`${settingsInput} font-mono uppercase placeholder:normal-case placeholder:text-gray-400`}
      />
      <input
        value={code}
        onChange={e => setCode(e.target.value)}
        placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
        autoComplete="off"
        spellCheck={false}
        aria-label={t('cloud.codeLabel')}
        className={`${settingsInput} font-mono uppercase placeholder:normal-case placeholder:text-gray-400`}
      />
      <button
        type="button"
        disabled={busy || !key.trim() || !code.trim()}
        onClick={() => void find()}
        className={settingsButton.secondary}
      >
        {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : t('cloud.find')}
      </button>
      {error && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {found && copyList(found.copies, { typed: found.code, licenseKey: found.key })}
    </div>
  );
}
