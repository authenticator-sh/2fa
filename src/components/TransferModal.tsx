import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Smartphone } from 'lucide-react';
import { ModalHeader } from './ModalHeader';
import type { Account } from '@/types';
import { accountLabel } from '@/utils/account-label';
import { createT, type Language } from '@/utils/i18n';
import { getAccounts } from '@/utils/storage';
import { buildTransferCodes, type TransferPlan } from '@/utils/transfer-qr';
import { drawQR, type QRDrawing } from '@/utils/qr-encode';
import { phoneAppUrl } from '@/utils/phone-app';

interface TransferModalProps {
  language: Language;
  onClose: () => void;
}

/**
 * Moving accounts to a phone: the accounts as QR codes, one after another.
 *
 * Two screens. The first picks the accounts (all of them, unless unticked) and
 * says plainly what the codes are: anyone who sees them has the accounts. The
 * second shows the codes one at a time, numbered, with the accounts each holds
 * named under it, so a person half-way through knows what the phone has and
 * what it still lacks. The codes are Google Authenticator's export format (see
 * utils/transfer-qr.ts), so the phone can run any authenticator, ours included.
 *
 * Nothing is written or sent anywhere: the codes exist only on this screen.
 */
export function TransferModal({ language, onClose }: TransferModalProps) {
  const t = createT(language);
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [plan, setPlan] = useState<TransferPlan | null>(null);
  const [index, setIndex] = useState(0);
  const [qr, setQr] = useState<QRDrawing | null>(null);
  const [failed, setFailed] = useState(false);
  /** After the last code: what to check on the phone, before the window closes. */
  const [finished, setFinished] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  // For a phone with no app yet: our address that sends it to the App Store.
  const [appQr, setAppQr] = useState<QRDrawing | null>(null);

  useEffect(() => {
    const url = phoneAppUrl();
    if (!url) return;
    let alive = true;
    drawQR(url)
      .then(drawing => alive && setAppQr(drawing))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    getAccounts()
      .then(list => {
        if (!alive) return;
        setAccounts(list);
        setChosen(new Set(list.map(a => a.id)));
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  const code = plan?.codes[index] ?? null;

  useEffect(() => {
    if (!code) return;
    let alive = true;
    setQr(null);
    drawQR(code.text, 'L')
      .then(drawing => alive && setQr(drawing))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [code]);

  const selected = useMemo(() => (accounts ?? []).filter(a => chosen.has(a.id)), [accounts, chosen]);

  const toggle = (id: string) =>
    setChosen(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const start = () => {
    setPlan(buildTransferCodes(selected));
    setIndex(0);
    setFinished(false);
  };

  const total = plan?.codes.length ?? 0;
  const last = index >= total - 1;
  const moved = plan ? plan.codes.reduce((sum, c) => sum + c.accounts.length, 0) : 0;

  // Every step opens at its top. Carried over from the list of accounts, the
  // scroll position cut the top off the first QR code — which a phone then
  // cannot read — and hid "Code 1 of 2".
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [plan, index, finished]);

  const choosing = !failed && accounts !== null && accounts.length > 0 && !plan;
  const showing = !failed && !!plan && total > 0 && !finished;

  const primary = 'flex flex-1 items-center justify-center gap-1 rounded-lg bg-accent-600 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-700 disabled:opacity-50';
  const secondary = 'flex flex-1 items-center justify-center gap-1 rounded-lg border border-gray-300 py-2.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-dark-500 dark:text-gray-300 dark:hover:bg-dark-700';

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-gray-50 dark:bg-dark-800 anim-sheet"
      role="dialog"
      aria-modal="true"
      aria-label={t('transfer.title')}
    >
      <ModalHeader
        title={t('transfer.title')}
        back={t('common.back')}
        // Back from the codes goes to the choice, not out: a person who
        // unticked the wrong account should not have to start over.
        onBack={
          finished
            ? () => setFinished(false)
            : plan
              ? () => {
                  setPlan(null);
                  setFinished(false);
                }
              : onClose
        }
      />

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-md p-4">
          {failed ? (
            <p className="text-sm text-red-600 dark:text-red-400">{t('transfer.failed')}</p>
          ) : accounts === null ? null : accounts.length === 0 ? (
            <p className="text-sm text-gray-600 dark:text-gray-400">{t('transfer.empty')}</p>
          ) : !plan ? (
            <div className="space-y-3">
              {/* With a phone app to offer: why move at all, then the two
                  steps by number — the app's QR code is step 1 and says what
                  it is, the accounts' codes are step 2. Unnumbered, the first
                  code on the screen was scanned as if it were the accounts. */}
              {appQr ? (
                <>
                  <div className="rounded-xl bg-gradient-to-br from-accent-600 to-accent-700 p-4 text-white">
                    <div className="flex items-center gap-3">
                      <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-white/15 ring-1 ring-white/25">
                        <Smartphone size={20} aria-hidden />
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold leading-snug">{t('transfer.heroTitle')}</p>
                        <p className="mt-0.5 text-xs leading-relaxed text-white/85">{t('transfer.heroText')}</p>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-dark-600 dark:bg-dark-900">
                    <p className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-gray-100">
                      <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-accent-600 text-[11px] font-semibold text-white">1</span>
                      {t('transfer.step1')}
                    </p>
                    <div className="mt-2.5 flex items-center gap-3">
                      <div className="w-[96px] flex-shrink-0 rounded-md bg-white p-1.5 ring-1 ring-gray-200">
                        <svg
                          viewBox={`0 0 ${appQr.size} ${appQr.size}`}
                          shapeRendering="crispEdges"
                          className="block h-auto w-full text-black"
                          role="img"
                          aria-label={t('transfer.step1Text')}
                        >
                          <path d={appQr.path} fill="currentColor" />
                        </svg>
                      </div>
                      <p className="text-xs leading-relaxed text-gray-600 dark:text-gray-400">{t('transfer.step1Text')}</p>
                    </div>
                  </div>

                  <p className="flex items-center gap-2 px-1 pt-1 text-sm font-medium text-gray-900 dark:text-gray-100">
                    <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-accent-600 text-[11px] font-semibold text-white">2</span>
                    {t('transfer.step2')}
                  </p>
                  <p className="px-1 text-xs leading-relaxed text-gray-600 dark:text-gray-400">{t('transfer.step2Text')}</p>
                </>
              ) : (
                <p className="text-xs leading-relaxed text-gray-600 dark:text-gray-400">{t('transfer.intro')}</p>
              )}

              <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-200">
                <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                <span>{t('transfer.caution')}</span>
              </div>

              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-gray-700 dark:text-gray-300">
                  {t('transfer.selected', selected.length, accounts.length)}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setChosen(selected.length === accounts.length ? new Set() : new Set(accounts.map(a => a.id)))
                  }
                  className="text-accent-600 hover:underline dark:text-accent-300"
                >
                  {selected.length === accounts.length ? t('transfer.none') : t('transfer.all')}
                </button>
              </div>

              {/* The whole list, in the page's own scroll: a list scrolling
                  inside a page that scrolls was two scrolls in a small window. */}
              <ul className="rounded-lg border border-gray-200 bg-white dark:border-dark-600 dark:bg-dark-900">
                {accounts.map(account => {
                  const on = chosen.has(account.id);
                  return (
                    <li key={account.id} className="border-t border-gray-100 first:border-t-0 dark:border-dark-700">
                      <label className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm text-gray-900 dark:text-gray-100">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => toggle(account.id)}
                          className="h-4 w-4 flex-shrink-0 accent-accent-600"
                        />
                        <span className="truncate">{accountLabel(account)}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : total === 0 ? (
            <p className="text-sm text-red-600 dark:text-red-400">{t('transfer.skipped', plan.skipped.length)}</p>
          ) : finished ? (
            <div className="flex flex-col items-center px-2 pt-8 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                <Check size={28} />
              </div>
              <h2 className="mt-4 text-base font-semibold text-gray-900 dark:text-gray-100">{t('transfer.checkTitle')}</h2>
              <p className="mt-2 text-sm leading-relaxed text-gray-600 dark:text-gray-400">{t('transfer.checkText', moved)}</p>
              {plan.skipped.length > 0 && (
                <p className="mt-3 text-xs text-amber-700 dark:text-amber-400">{t('transfer.skipped', plan.skipped.length)}</p>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-center text-sm font-medium text-gray-900 dark:text-gray-100">
                {total > 1 ? t('transfer.codeOf', index + 1, total) : t('transfer.scan')}
              </p>

              {/* A white field in both themes, as the share code: cameras read
                  an inverted code far less reliably. As wide as the window
                  lets it be — up to ten accounts make a dense code, and every
                  pixel a module gets is distance the phone can be held at. */}
              <div className="mx-auto w-full max-w-[340px] rounded-lg bg-white p-3">
                {qr ? (
                  <svg
                    viewBox={`0 0 ${qr.size} ${qr.size}`}
                    shapeRendering="crispEdges"
                    className="block h-auto w-full text-black"
                    role="img"
                    aria-label={t('transfer.codeOf', index + 1, total)}
                  >
                    <path d={qr.path} fill="currentColor" />
                  </svg>
                ) : (
                  <div className="aspect-square w-full" />
                )}
              </div>

              {total > 1 && <p className="text-center text-xs text-gray-500 dark:text-gray-400">{t('transfer.scan')}</p>}

              {/* Which accounts this code holds: for whoever wants to check,
                  not ten lines between the code and its button. */}
              {code && (
                <details className="rounded-lg border border-gray-200 bg-white text-xs dark:border-dark-600 dark:bg-dark-900">
                  <summary className="cursor-pointer list-none p-3 font-medium text-gray-700 dark:text-gray-300">
                    {t('transfer.inCode')} {code.accounts.length}
                  </summary>
                  <ul className="space-y-0.5 px-3 pb-3 text-gray-600 dark:text-gray-400">
                    {code.accounts.map(account => (
                      <li key={account.id} className="truncate">
                        {accountLabel(account)}
                      </li>
                    ))}
                  </ul>
                  {code.kind === 'single' && (
                    <p className="px-3 pb-3 text-gray-500 dark:text-gray-400">{t('transfer.single')}</p>
                  )}
                </details>
              )}
            </div>
          )}
        </div>
      </div>

      {/* The step's button, always in sight: under the list and under each
          code it was below the fold of a 600 px popup, every time. */}
      {(choosing || showing || (plan && finished)) && (
        <div className="flex-shrink-0 border-t border-gray-200 bg-white p-3 dark:border-dark-700 dark:bg-dark-900">
          <div className="mx-auto flex w-full max-w-md gap-2">
            {choosing && (
              <button type="button" onClick={start} disabled={selected.length === 0} className={primary}>
                {t('transfer.show')}
              </button>
            )}
            {showing && (
              <>
                {index > 0 && (
                  <button type="button" onClick={() => setIndex(index - 1)} className={secondary}>
                    <ChevronLeft size={16} className="rtl:rotate-180" />
                    {t('transfer.prev')}
                  </button>
                )}
                <button type="button" onClick={() => (last ? setFinished(true) : setIndex(index + 1))} className={primary}>
                  {last ? <Check size={16} /> : null}
                  {last ? t('transfer.done') : t('transfer.next')}
                  {last ? null : <ChevronRight size={16} className="rtl:rotate-180" />}
                </button>
              </>
            )}
            {plan && finished && (
              <button type="button" onClick={onClose} className={primary}>
                {t('common.close')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
