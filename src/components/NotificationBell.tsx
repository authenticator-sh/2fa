import { useEffect, useId, useRef, useState } from 'react';
import { ArrowUpRight, Bell, ChevronRight, Cloud, Info, Lock, Sparkles, X } from 'lucide-react';
import { createT, type Language } from '@/utils/i18n';
import { useEscapeLayer } from '@/hooks/useLayer';
import { dismissNotice, markNoticesRead, NOTICE_KEYS, noticesToShow, readDismissedNotices, readReadNotices, unreadNotices } from '@/billing/notices';
import { openPaywall } from '@/billing/bridge';
import { track } from '@/billing/events';
import { readInstall, readPolicy } from '@/billing/state';
import { syncFromWorker } from '@/billing/sync';
import type { Notice } from '@/billing/types';
import { offersCloudBackup, useCloudBackupLocal, wishCloudBackupSetup } from '@/components/CloudBackupSettings';

const ICONS = { backup: Cloud, paywall: Sparkles, vault: Lock, url: ArrowUpRight, none: Info } as const;

/**
 * The bell in the header and the notifications the server sets behind it
 * (policy.notices). The server decides who gets which; the bell is there only
 * while at least one is shown here (billing/notices.ts holds back those whose
 * button cannot work right now), and carries a red dot while any of those has
 * never been in an opened bell.
 *
 * Opening it reads every notification in the list: the dot goes out at once,
 * on this and every other popup of the browser, and the ones that were new keep
 * their own dot until the bell closes, so it is clear which they were. It
 * sends one bell_open and, for each notification listed, a banner_view with
 * place 'bell' — the banners' funnel (/admin/banners) counts them by id, and a
 * paywall one opens carries its id as a banner's would.
 *
 * A vault notification opens the password setup through `onVault`; App says
 * whether one can be set (`offersVault`: no password yet).
 */
export function NotificationBell({ language, offersVault, onVault }: { language: Language; offersVault: boolean; onVault: () => void }) {
  const t = createT(language);
  const [local] = useCloudBackupLocal();
  const [notices, setNotices] = useState<Notice[] | undefined>(undefined);
  const [read, setRead] = useState<string[] | null>(null);
  const [dismissed, setDismissed] = useState<string[] | null>(null);
  const [open, setOpen] = useState(false);
  /** Unread as the bell opened: marked as new until it closes. */
  const [fresh, setFresh] = useState<string[]>([]);
  const [top, setTop] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    const loadPolicy = () =>
      void readInstall()
        .then(install => (install ? readPolicy(install.id) : null))
        .then(policy => setNotices(policy?.notices ?? []))
        .catch(() => setNotices([]));
    const loadMarks = () => {
      void readReadNotices().then(setRead);
      void readDismissedNotices().then(setDismissed);
    };
    loadPolicy();
    loadMarks();
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      const keys = Object.keys(changes);
      if (keys.some(k => k.startsWith('billing'))) loadPolicy();
      if (keys.some(k => (NOTICE_KEYS as readonly string[]).includes(k))) loadMarks();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  const close = (refocus: boolean) => {
    setOpen(false);
    setFresh([]);
    if (refocus) buttonRef.current?.focus();
  };

  useEscapeLayer(() => close(true), open);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) close(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const shown =
    notices === undefined || !local || !read || !dismissed
      ? []
      : noticesToShow(notices, {
          language,
          offersBackup: offersCloudBackup(local),
          canBuy: !local.hasPro && !local.pending && local.buyable,
          offersVault,
          dismissed,
        });
  const unread = read ? unreadNotices(shown, read) : [];

  // Kept while open, so closing the last one leaves the panel saying so.
  if (shown.length === 0 && !open) return null;

  const toggle = () => {
    if (open) {
      close(false);
      return;
    }
    // Under the header row, across the popup: the bell sits too far right for
    // a panel hung from it to fit at the 320px size.
    setTop((buttonRef.current?.getBoundingClientRect().bottom ?? 48) + 8);
    setFresh(unread.map(n => n.id));
    setOpen(true);
    void track('bell_open', { total: shown.length, unread: unread.length });
    for (const n of shown) void track('banner_view', { id: n.id, action: n.action, place: 'bell' });
    if (unread.length) {
      setRead(list => [...(list ?? []), ...unread.map(n => n.id)]);
      void markNoticesRead(unread.map(n => n.id));
    }
  };

  const act = async (notice: Notice) => {
    const props = { id: notice.id, action: notice.action, place: 'bell' };
    // On disk before anything opens: a popup is torn down as a tab takes focus.
    await track('banner_click', props);
    close(false);
    if (notice.action === 'url' && notice.url) {
      await syncFromWorker();
      void chrome.tabs.create({ url: notice.url });
      return;
    }
    if (notice.action === 'vault') {
      onVault();
      return;
    }
    if (notice.action === 'backup') {
      void openPaywall({ trigger: 'backup_banner', banner: notice.id }).then(result => {
        if (result === 'activated' || result === 'checkout') wishCloudBackupSetup();
      });
      return;
    }
    if (notice.action === 'paywall') void openPaywall({ trigger: 'banner', banner: notice.id });
  };

  const remove = (notice: Notice) => {
    setDismissed(list => [...(list ?? []), notice.id]);
    void track('banner_close', { id: notice.id, action: notice.action, place: 'bell' });
    void dismissNotice(notice.id);
  };

  /** The backup and vault notifications without words of their own speak in the shipped ones. */
  const wordsOf = (n: Notice): { title: string; body: string; cta: string | null } => {
    if (n.text) return n.text;
    if (n.action === 'vault') return { title: t('vault.prompt.title'), body: t('vault.prompt.text'), cta: t('vault.prompt.enable') };
    return { title: t('cloud.title'), body: t('paywall.backup.title'), cta: t('cloud.turnOn') };
  };

  const label = unread.length ? `${t('notices.title')} (${t('notices.new')}: ${unread.length})` : t('notices.title');

  return (
    <div ref={wrapRef}>
      <button
        ref={buttonRef}
        onClick={toggle}
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className={`relative p-1.5 rounded-lg transition-colors ${open ? 'bg-gray-200 dark:bg-dark-600' : 'hover:bg-gray-100 dark:hover:bg-dark-700'}`}
      >
        <Bell className="text-gray-600 dark:text-gray-400" size={18} aria-hidden />
        {unread.length > 0 && (
          <span aria-hidden className="absolute end-1 top-1 h-2 w-2 rounded-full bg-red-500 ring-2 ring-white dark:ring-dark-900" />
        )}
      </button>

      {open && (
        <div
          id={panelId}
          role="region"
          aria-label={t('notices.title')}
          style={{ top }}
          className="fixed inset-x-3 z-50 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg dark:border-dark-600 dark:bg-dark-800"
        >
          <div className="border-b border-gray-100 px-3.5 py-2.5 text-sm font-semibold text-gray-900 dark:border-dark-700 dark:text-gray-100">
            {t('notices.title')}
          </div>
          {shown.length === 0 ? (
            <p className="px-3.5 py-6 text-center text-sm text-gray-500 dark:text-gray-400">{t('notices.empty')}</p>
          ) : (
            <ul className="max-h-[min(360px,65vh)] overflow-y-auto">
              {shown.map(n => {
                const Icon = ICONS[n.action];
                const words = wordsOf(n);
                const isNew = fresh.includes(n.id);
                return (
                  <li
                    key={n.id}
                    className={`relative flex gap-3 border-b border-gray-100 p-3.5 pe-9 last:border-b-0 dark:border-dark-700 ${
                      isNew ? 'bg-accent-50/60 dark:bg-accent-500/10' : ''
                    }`}
                  >
                    <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-accent-50 text-accent-600 dark:bg-accent-500/15 dark:text-accent-300">
                      <Icon size={16} aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold leading-snug text-gray-900 dark:text-gray-100">
                        {isNew && (
                          <span className="me-1.5 inline-block h-2 w-2 rounded-full bg-red-500 align-middle" role="img" aria-label={t('notices.new')} />
                        )}
                        {words.title}
                      </p>
                      <p className="mt-0.5 text-xs leading-relaxed text-gray-600 dark:text-gray-400">{words.body}</p>
                      {words.cta && n.action !== 'none' && (
                        <button
                          type="button"
                          onClick={() => void act(n)}
                          className="mt-2 inline-flex items-center gap-0.5 rounded-full bg-accent-600 px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-accent-700"
                        >
                          {words.cta}
                          <ChevronRight size={14} aria-hidden className="rtl:rotate-180" />
                        </button>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => remove(n)}
                      aria-label={t('common.close')}
                      title={t('common.close')}
                      className="absolute end-2 top-2.5 rounded-full p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-dark-700 dark:hover:text-gray-200"
                    >
                      <X size={14} aria-hidden />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
