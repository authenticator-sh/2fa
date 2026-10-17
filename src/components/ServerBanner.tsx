import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, ChevronRight, Cloud, Lock, Sparkles, X } from 'lucide-react';
import { createT, type Language } from '@/utils/i18n';
import { dismissBanner, pickBanner, readDismissedBanners } from '@/billing/banner';
import { openPaywall } from '@/billing/bridge';
import { track } from '@/billing/events';
import { readInstall, readPolicy } from '@/billing/state';
import { syncFromWorker } from '@/billing/sync';
import type { Banner } from '@/billing/types';
import { offersCloudBackup, useCloudBackupLocal, wishCloudBackupSetup } from '@/components/CloudBackupSettings';

/**
 * The banners the server sets (policy.banner): whether there are any, where
 * each stands — the top of Settings or above the accounts — what it says, and
 * what a click does (billing/banner.ts decides). Rendered in both places; each
 * shows the one banner that names it, so Settings and the list can carry
 * different banners at once.
 *
 * A vault banner opens the password setup through `onVault`; App decides
 * whether it is offered (`offersVault`), since only App knows the accounts on
 * screen and whether its own VaultPrompt is already asking.
 *
 * Closing hides that banner's id on this browser and nothing else, so the next
 * banner the server sets shows to people who closed this one. Every opening it
 * shows in sends one banner_view, every click one banner_click; a paywall it
 * opens carries its id in paywall_view and in the checkout that follows, so
 * the admin has its funnel through to the purchase.
 */
export function ServerBanner({
  language,
  place,
  offersVault = false,
  onVault,
}: {
  language: Language;
  place: Banner['place'];
  offersVault?: boolean;
  onVault?: () => void;
}) {
  const t = createT(language);
  const [local] = useCloudBackupLocal();
  const [banners, setBanners] = useState<Banner[] | undefined>(undefined);
  const [dismissed, setDismissed] = useState<string[] | null>(null);
  const tracked = useRef<string | null>(null);

  useEffect(() => {
    const load = () =>
      void readInstall()
        .then(install => (install ? readPolicy(install.id) : null))
        .then(policy => setBanners(policy?.banners ?? []))
        .catch(() => setBanners([]));
    load();
    void readDismissedBanners().then(setDismissed);
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && Object.keys(changes).some(k => k.startsWith('billing'))) load();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  const shown =
    banners === undefined || !local || !dismissed
      ? null
      : pickBanner(banners, {
          place,
          language,
          offersBackup: offersCloudBackup(local),
          canBuy: !local.hasPro && !local.pending && local.buyable,
          offersVault: offersVault && !!onVault,
          dismissed,
        });
  const props = shown ? { id: shown.id, action: shown.action, place: shown.place } : null;

  useEffect(() => {
    if (props && tracked.current !== props.id) {
      tracked.current = props.id;
      void track('banner_view', props);
    }
  }, [props?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!shown || !props) return null;

  const open = async () => {
    // On disk before anything opens: a popup is torn down as a tab takes focus.
    await track('banner_click', props);
    if (shown.action === 'url' && shown.url) {
      // Following the link is an answer too, as with the old promo card.
      await dismissBanner(shown.id);
      setDismissed(list => [...(list ?? []), shown.id]);
      await syncFromWorker();
      void chrome.tabs.create({ url: shown.url });
      return;
    }
    if (shown.action === 'vault') {
      onVault?.();
      return;
    }
    if (shown.action === 'backup') {
      void openPaywall({ trigger: 'backup_banner', banner: shown.id }).then(result => {
        if (result === 'activated' || result === 'checkout') wishCloudBackupSetup();
      });
      return;
    }
    void openPaywall({ trigger: 'banner', banner: shown.id });
  };

  const close = () => {
    setDismissed(list => [...(list ?? []), shown.id]);
    void track('banner_close', props);
    void dismissBanner(shown.id);
  };

  const Icon = shown.action === 'backup' ? Cloud : shown.action === 'paywall' ? Sparkles : shown.action === 'vault' ? Lock : ArrowUpRight;
  // The backup and vault banners without words of their own speak in the
  // shipped ones — the vault's are VaultPrompt's, already in every language.
  const shipped =
    shown.action === 'vault'
      ? { eyebrow: t('settings.sectionSecurity'), title: t('vault.prompt.title'), cta: t('vault.prompt.enable') }
      : { eyebrow: t('cloud.title'), title: t('paywall.backup.title'), cta: t('cloud.turnOn') };
  const eyebrow = shown.text ? shown.text.eyebrow : shipped.eyebrow;
  const title = shown.text ? shown.text.title : shipped.title;
  const cta = shown.text ? shown.text.cta : shipped.cta;

  return (
    <section
      aria-label={eyebrow ?? title}
      className={`relative overflow-hidden rounded-xl bg-gradient-to-br from-accent-600 to-accent-700 text-white shadow-sm${place === 'accounts' ? ' mx-3 mt-3 mb-1' : ''}`}
    >
      {/* The icon again, large and faint, bleeding off the corner. */}
      <Icon size={96} strokeWidth={1.25} aria-hidden className="pointer-events-none absolute -bottom-6 -end-4 text-white/10" />
      <button
        type="button"
        onClick={() => void open()}
        className="relative flex w-full items-center gap-3 p-3.5 pe-9 text-start focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-white"
      >
        <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-white/15 ring-1 ring-white/25">
          <Icon size={20} aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          {eyebrow && <span className="block text-[11px] font-medium uppercase tracking-wide text-white/75">{eyebrow}</span>}
          <span className={`block text-sm font-semibold leading-snug${eyebrow ? ' mt-0.5' : ''}`}>{title}</span>
          <span className="mt-2 inline-flex items-center gap-0.5 rounded-full bg-white px-3 py-1 text-xs font-semibold text-accent-700">
            {cta}
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
