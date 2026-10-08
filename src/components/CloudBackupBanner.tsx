import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Cloud, X } from 'lucide-react';
import { createT, type Language } from '@/utils/i18n';
import { openPaywall } from '@/billing/bridge';
import { track } from '@/billing/events';
import { offersCloudBackup, useCloudBackupLocal, wishCloudBackupSetup } from '@/components/CloudBackupSettings';

const DISMISSED_KEY = 'cloudBackupBannerDismissed';

/**
 * Cloud backup, offered at the top of Settings (owner, 2026-10-08) — to anyone
 * the row in Backup & Restore would offer it to (offersCloudBackup), until it
 * is closed. A click opens the paywall with the backup's own words, and a
 * purchase made from it opens the setup, as the row's "Turn on" does.
 *
 * Every Settings opening it shows in sends one backup_banner_view, so the
 * admin has both views and unique viewers (installs); its clicks are the
 * paywall_view events with trigger `backup_banner`.
 */
export function CloudBackupBanner({ language }: { language: Language }) {
  const t = createT(language);
  const [local] = useCloudBackupLocal();
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  const tracked = useRef(false);

  useEffect(() => {
    chrome.storage.local
      .get(DISMISSED_KEY)
      .then(stored => setDismissed(stored[DISMISSED_KEY] === true))
      .catch(() => setDismissed(false));
  }, []);

  const visible = dismissed === false && !!local && offersCloudBackup(local);

  useEffect(() => {
    if (visible && !tracked.current) {
      tracked.current = true;
      void track('backup_banner_view');
    }
  }, [visible]);

  if (!visible) return null;

  const open = () =>
    void openPaywall({ trigger: 'backup_banner' }).then(result => {
      if (result === 'activated' || result === 'checkout') wishCloudBackupSetup();
    });

  const close = () => {
    setDismissed(true);
    void track('backup_banner_close');
    void chrome.storage.local.set({ [DISMISSED_KEY]: true }).catch(() => {});
  };

  return (
    <section aria-label={t('cloud.title')} className="relative overflow-hidden rounded-xl bg-gradient-to-br from-accent-600 to-accent-700 text-white shadow-sm">
      {/* The cloud again, large and faint, bleeding off the corner. */}
      <Cloud
        size={96}
        strokeWidth={1.25}
        aria-hidden
        className="pointer-events-none absolute -bottom-6 -end-4 text-white/10"
      />
      <button
        type="button"
        onClick={open}
        className="relative flex w-full items-center gap-3 p-3.5 pe-9 text-start focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-white"
      >
        <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-white/15 ring-1 ring-white/25">
          <Cloud size={20} aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] font-medium uppercase tracking-wide text-white/75">{t('cloud.title')}</span>
          <span className="mt-0.5 block text-sm font-semibold leading-snug">{t('paywall.backup.title')}</span>
          <span className="mt-2 inline-flex items-center gap-0.5 rounded-full bg-white px-3 py-1 text-xs font-semibold text-accent-700">
            {t('cloud.turnOn')}
            <ChevronRight size={14} aria-hidden className="rtl:rotate-180" />
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={close}
        aria-label={t('common.close')}
        title={t('common.close')}
        className="absolute end-2 top-2 rounded-full p-1 text-white/70 transition-colors hover:bg-white/15 hover:text-white"
      >
        <X size={14} aria-hidden />
      </button>
    </section>
  );
}
