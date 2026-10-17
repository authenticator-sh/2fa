import { useEffect, useMemo, useRef, useState } from 'react';
import { Cloud, Infinity as InfinityIcon, KeyRound, Loader2, Lock, Mail, MailCheck, X } from 'lucide-react';
import { Logo } from '@/components/Logo';
import { useEscapeLayer, useReturnFocus } from '@/hooks/useLayer';
import { createT, type Language, type TranslationKey } from '@/utils/i18n';
import { toast } from '@/utils/ui-feedback';
import { activateLicenseKey, recoverLicense, startCheckout } from '@/billing/actions';
import { BillingApiError } from '@/billing/api';
import type { PaywallRequest, PaywallResult, PaywallTrigger } from '@/billing/bridge';
import { track } from '@/billing/events';
import { formatMoney, formatPrice, monthlyEquivalent, yearlySaving } from '@/billing/format';
import { billingErrorMessage } from '@/billing/messages';
import { BILLING_KEYS, readEntitlement, readInstall, readPolicy } from '@/billing/state';
import { syncBilling, syncFromWorker } from '@/billing/sync';
import type { DisplayPrice, Policy } from '@/billing/types';

/**
 * The paywall. It takes the whole screen, like Add account: in a 400px popup
 * there is no room for a dialog floating over the list, and this is a
 * decision worth the whole screen.
 *
 * Unlike Add account it has no header bar. A bar with a back arrow says "a
 * place in the app", and spent the top of the screen on the word "Pro"; this
 * is an offer, so it opens on the offer and is dismissed with a cross in its
 * corner. What ModalHeader did for the other screens is done here by hand:
 * Escape leaves, focus starts on the way out and returns to what opened it.
 *
 * The button that pays stays in view however little room the window has (the
 * small popup is 320x480): it sticks to the bottom edge until the plans have
 * scrolled past. Right under it is the promise people worry about in a paid
 * authenticator: every account already here keeps working. The limit only
 * ever stops adding.
 */

interface PaywallProps {
  language: Language;
  request: PaywallRequest;
}

/**
 * Copy variants the server may pick; anything else falls back to the default.
 * A new text reaches people only with a release, so every variant the server
 * might test has to ship here first. Exported for the locale check in tests.
 */
export const COPY: Record<string, { title: TranslationKey; body: TranslationKey }> = {
  default: { title: 'paywall.default.title', body: 'paywall.default.body' },
  support: { title: 'paywall.support.title', body: 'paywall.support.body' },
  private: { title: 'paywall.private.title', body: 'paywall.private.body' },
  everything: { title: 'paywall.everything.title', body: 'paywall.everything.body' },
};

/**
 * Opened from cloud backup's "Turn on": the person asked for a backup, not for
 * room — most who see this have no limit at all (installs from before the
 * paywall) — so the server's copy, written about the limit, would answer a
 * question nobody asked. This text wins over it and over custom text.
 */
export const BACKUP_COPY: { title: TranslationKey; body: TranslationKey } = { title: 'paywall.backup.title', body: 'paywall.backup.body' };

/** Opened to sell the backup: its "Turn on" or the banner over Settings. */
const isBackupTrigger = (trigger: PaywallTrigger): boolean => trigger === 'backup' || trigger === 'backup_banner';

// What Pro gives, in the buyer's terms (2026-10-04): room for every account,
// one key across browsers, and an encrypted copy in the cloud. "Codes keep
// working if Pro ends" was true but read as an invitation to cancel (owner,
// 2026-10-04).
//
// The cloud copy (2026-10-07) took quick fill's place: quick fill was never
// Pro's own — every plan has it — and the copy is the one thing here that
// answers "what if I lose this computer". Still three: the columns are 88px.
//
// "One key for up to 5 browsers" gave way to "we can't see your keys"
// (2026-10-08): a seat count reads as a limit at the moment of paying, and a
// buyer who needs more seats gets them from support. The trust line under the
// button ("secret keys never leave your browser · open source") went the same
// day: it repeated this, and with the cloud backup it was no longer true.
const BENEFITS = [
  { key: 'paywall.benefitUnlimited', Icon: InfinityIcon },
  { key: 'paywall.benefitPrivate', Icon: Lock },
  { key: 'paywall.benefitBackup', Icon: Cloud },
] as const;

type Failure = { at: 'checkout' | 'key' | 'restore'; text: string };

/** The key and email fields. */
const FIELD =
  'h-9 min-w-0 flex-1 rounded-md border border-neutral-200 bg-white px-3 text-sm text-neutral-900 placeholder:text-neutral-400 transition-shadow focus:border-accent-600 focus:outline-none focus:ring-[3px] focus:ring-accent-600/15 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-100 dark:focus:border-accent-300 dark:focus:ring-accent-300/20';

function planLabel(price: DisplayPrice): TranslationKey {
  if (price.kind === 'life') return 'paywall.planLife';
  if (price.kind === 'pass') return 'paywall.planPass';
  return price.interval === 'month' ? 'paywall.planMonth' : 'paywall.planYear';
}

export default function Paywall({ language, request }: PaywallProps) {
  const t = createT(language);
  const locale = language;
  const [policy, setPolicy] = useState<Policy | null | 'loading'>('loading');
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState<'checkout' | 'key' | 'restore' | null>(null);
  // Shown where it happened: a refused key under the key field, not under a
  // pay button that may be a screen away from it.
  const [error, setError] = useState<Failure | null>(null);
  const [panel, setPanel] = useState<'none' | 'key' | 'restore'>('none');
  const [key, setKey] = useState('');
  const [email, setEmail] = useState('');
  // The address a key was just mailed to; while set, it stands where the form was.
  const [sentTo, setSentTo] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const openedAt = useRef(Date.now());
  const viewed = useRef(false);
  const settled = useRef(false);
  const closeRecorded = useRef(false);

  const load = async (allowSync: boolean) => {
    setPolicy('loading');
    const install = await readInstall();
    let current = install ? await readPolicy(install.id) : null;
    if ((!current || current.paywall.plans.length === 0) && allowSync) {
      await syncBilling({ force: true });
      const again = await readInstall();
      current = again ? await readPolicy(again.id) : null;
    }
    setPolicy(current && current.paywall.plans.some(id => current!.prices[id]) ? current : null);
  };

  useEffect(() => {
    void load(true);
    // Read by the review prompt: nobody is asked for a rating right after a paywall.
    void chrome.storage.local.set({ [BILLING_KEYS.paywallSeenAt]: Date.now() }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const plans = useMemo(
    () => (policy && policy !== 'loading' ? policy.paywall.plans.filter(id => policy.prices[id]) : []),
    [policy],
  );

  useEffect(() => {
    if (!policy || policy === 'loading') return;
    if (!selected || !plans.includes(selected)) {
      setSelected(plans.includes(policy.paywall.default_plan) ? policy.paywall.default_plan : plans[0] ?? '');
    }
    if (!viewed.current) {
      viewed.current = true;
      // Handed to the worker at once, with the limit_blocked before it: a popup
      // closed by clicking away never gets to its close (nothing after that
      // runs), and those who leave right after the wall are the ones the
      // experiments' uninstall check is about.
      void track('paywall_view', {
        trigger: request.trigger,
        copy: bannerPaywallText(policy) ? 'banner' : isBackupTrigger(request.trigger) ? 'backup' : policy.paywall.text?.lang === language ? 'custom' : policy.paywall.copy,
        plans: plans.join(','),
        ...(request.banner ? { banner: request.banner } : {}),
      }).then(() => syncFromWorker());
    }
  }, [policy, plans, selected, request.trigger]);

  /**
   * The close, recorded once. For Checkout that happens before its tab opens
   * (see checkout below): in the popup nothing after that moment runs.
   */
  const recordClose = (result: PaywallResult): Promise<void> => {
    if (closeRecorded.current) return Promise.resolve();
    closeRecorded.current = true;
    return track('paywall_close', {
      trigger: request.trigger,
      result,
      seconds_open: Math.round((Date.now() - openedAt.current) / 1000),
    });
  };

  const finish = (result: PaywallResult) => {
    if (settled.current) return;
    settled.current = true;
    // Closed only once the event is on disk: a popup shut right after would
    // otherwise take it along, and the funnel would show a paywall nobody left.
    // track() never throws, so this always resolves — a few milliseconds late.
    void recordClose(result).finally(() => {
      request.resolve(result);
      // This visit's events go out now, not with tomorrow's check-in. Spaced
      // and locked like any forced sync, and silent when it fails. After
      // Checkout the service worker was asked already: a popup does not live
      // to hear the answer.
      // Urgent: the open already checked in seconds ago (the view and the block), and the close must not wait a day.
      if (result !== 'checkout') void syncBilling({ force: true, urgent: true });
    });
  };

  /** Pro reached this install while the paywall stood open: nothing is left to buy. */
  const proOn = () => {
    if (settled.current) return;
    toast('success', t('billing.activated'));
    finish('activated');
  };

  /** The paywall words of the banner or notification that opened this paywall, in the language on screen. */
  function bannerPaywallText(current: Policy): { title: string; body: string } | null {
    const banner = current.banners.find(b => b.id === request.banner) ?? current.notices.find(n => n.id === request.banner);
    if (!banner || banner.text?.lang !== language) return null;
    return banner.text.paywall_title && banner.text.paywall_body ? { title: banner.text.paywall_title, body: banner.text.paywall_body } : null;
  }

  const holdsPro = async () => {
    const install = await readInstall();
    return !!install && !!(await readEntitlement(install.id));
  };

  // A license can land while the paywall is open — a key typed on another of
  // the person's browsers comes through Chrome sync, a purchase finishes in
  // another tab. Left open, the paywall sold Pro to someone who had it
  // (2026-10-08: a checkout 42 s after the license arrived).
  useEffect(() => {
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local' || !changes[BILLING_KEYS.entitlement]?.newValue) return;
      void holdsPro().then(on => {
        if (on) proOn();
      });
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fromBackup = isBackupTrigger(request.trigger);
  // Words the banner that opened this paywall brought with it: they win over
  // the backup's and the server's paywall text alike, being about the very
  // thing the person clicked.
  const fromBanner = policy && policy !== 'loading' ? bannerPaywallText(policy) : null;
  const copy = fromBackup ? BACKUP_COPY : (COPY[policy && policy !== 'loading' ? policy.paywall.copy : 'default'] ?? COPY.default!);
  // Text the server wrote, when it is in the language on screen. After a
  // language switch the last policy still carries the old language until the
  // next check-in; the shipped text covers that gap rather than a mixed screen.
  const custom = fromBanner ?? (!fromBackup && policy && policy !== 'loading' && policy.paywall.text?.lang === language ? policy.paywall.text : null);
  const prices = policy && policy !== 'loading' ? policy.prices : {};
  const monthly = Object.values(prices).find(p => p.kind === 'sub' && p.interval === 'month');
  const selectedPrice = prices[selected];

  // What the header bar does on the other full-screen flows (see ModalHeader).
  // In the popup an unhandled Escape closes the whole window.
  useEscapeLayer(() => finish('closed'));
  useReturnFocus();
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  // The key and email forms open below the fold of a short window; without
  // this the link that opened one appeared to do nothing.
  useEffect(() => {
    if (panel !== 'none' && error?.at !== 'checkout') panelRef.current?.scrollIntoView({ block: 'nearest' });
  }, [panel, sentTo, error]);

  const showPanel = (next: 'key' | 'restore') => {
    setPanel(panel === next ? 'none' : next);
    setError(null);
    setSentTo(null);
  };

  const checkout = async () => {
    if (!selected || busy) return;
    setBusy('checkout');
    setError(null);
    void track('plan_select', { plan: selected, trigger: request.trigger });
    try {
      await startCheckout(selected, request.trigger, {
        shown: selectedPrice ? { amount: selectedPrice.amount, currency: selectedPrice.currency, approx: selectedPrice.approx } : undefined,
        banner: request.banner,
        // The last moment a popup is alive: the close goes on disk, the
        // blocked account is kept for when Pro arrives, and the worker —
        // which outlives the popup — sends this visit's events.
        beforeOpen: async () => {
          await recordClose('checkout');
          await request.beforeCheckout?.();
          await syncFromWorker();
        },
      });
      // A popup is closed by the browser as the tab opens; in the side panel
      // or the floating window this is what the person sees.
      toast('info', t('paywall.checkoutOpened'));
      finish('checkout');
    } catch (e) {
      if (e instanceof BillingApiError && e.code === 'price_changed') {
        // What Checkout would charge is not what is on screen. Never charged
        // silently, never retried behind the person's back: the new prices
        // come from a fresh policy, and they decide again.
        await syncBilling({ force: true, urgent: true });
        await load(false);
        setError({ at: 'checkout', text: t('paywall.priceChanged') });
      } else if (e instanceof BillingApiError && e.code === 'already_pro') {
        // The server knows of a license here that this install has not heard
        // of yet: fetch it, and the paywall has nothing more to do.
        await syncBilling({ force: true, urgent: true });
        if (await holdsPro()) {
          proOn();
          return;
        }
        setError({ at: 'checkout', text: billingErrorMessage(e, t) });
      } else {
        setError({ at: 'checkout', text: billingErrorMessage(e, t) });
      }
      setBusy(null);
    }
  };

  const activate = async () => {
    if (!key.trim() || busy) return;
    setBusy('key');
    setError(null);
    try {
      await activateLicenseKey(key);
      proOn();
    } catch (e) {
      setError({ at: 'key', text: billingErrorMessage(e, t) });
      setBusy(null);
    }
  };

  const restore = async () => {
    // The same test the browser applies to the field (which stops the form on
    // anything worse, with its own message); the server has the last word.
    if (!/^[^\s@]+@[^\s@]+$/.test(email.trim()) || busy) return;
    setBusy('restore');
    setError(null);
    try {
      await recoverLicense(email.trim());
      // The answer takes the form's place. Printed elsewhere on the screen it
      // went unseen, the button looked as if it had done nothing, and it was
      // pressed again — into the server's limit of three letters an hour.
      setSentTo(email.trim());
    } catch (e) {
      setError({ at: 'restore', text: billingErrorMessage(e, t) });
    } finally {
      setBusy(null);
    }
  };

  // Only for an import, where it explains the "add N free" button. A single
  // blocked add gets no line: "the free plan holds 6, and you have 7" only
  // counted at the person (owner, 2026-10-04).
  const limitLine = (() => {
    const l = request.limit;
    if (!l) return null;
    if (l.wouldAdd > 1 || request.trigger === 'file' || request.trigger === 'migration' || request.trigger === 'uri') {
      return l.remaining > 0 ? t('paywall.importOver', l.wouldAdd, l.remaining) : t('paywall.importNoRoom', l.wouldAdd);
    }
    return null;
  })();

  const priceLine = (price: DisplayPrice): string => {
    const amount = formatPrice(price, locale);
    if (price.kind === 'sub') return t(price.interval === 'month' ? 'paywall.perMonth' : 'paywall.perYear', amount);
    return t('paywall.once', amount);
  };

  const noteLine = (price: DisplayPrice): string => {
    if (price.kind === 'life') return t('paywall.lifeNote');
    if (price.kind === 'pass') return t('paywall.passNote');
    if (price.interval === 'year') return t('paywall.yearNote', monthlyEquivalent(price, locale));
    return t('paywall.monthNote');
  };

  const trialDays = policy && policy !== 'loading' ? policy.paywall.trial_days : 0;

  const failure = (at: Failure['at']) =>
    error?.at === at && (
      <p role="alert" className="mt-2 text-center text-sm text-red-600 dark:text-red-400">
        {error.text}
      </p>
    );

  // The Vercel look in the app's own blue: one surface, neutral greys, hairline
  // borders, and blue only where something is chosen or done — the selected
  // plan, the button that pays, the marks. No other colour but red for errors.
  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-white dark:bg-neutral-950" role="dialog" aria-modal="true" aria-labelledby="paywall-title">
      <button
        ref={closeRef}
        type="button"
        onClick={() => finish('closed')}
        aria-label={t('common.close')}
        title={t('common.close')}
        className="absolute end-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
      >
        <X size={18} aria-hidden />
      </button>

      <div className="min-h-0 flex-1 overflow-y-auto motion-safe:animate-[toastIn_0.2s_ease-out]">
        <div className="relative px-5 pb-3 pt-6 text-center">
          {/* A dot grid that fades out under the title: texture, not colour. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle,rgba(0,0,0,0.08)_1px,transparent_1px)] [background-size:14px_14px] [mask-image:linear-gradient(to_bottom,black,transparent_85%)] dark:bg-[radial-gradient(circle,rgba(255,255,255,0.09)_1px,transparent_1px)]"
          />
          {/* The small popup is 480px tall; there the mark gives its place to the plans. */}
          {/* The disc alone: on white the logo's white tile only drew an outline of nothing. */}
          <div className="relative mx-auto mb-3 w-fit rounded-full ring-[6px] ring-accent-500/10 dark:ring-accent-500/20 [@media(max-height:520px)]:hidden" aria-hidden>
            <Logo bare size={40} className="block" />
          </div>
          {/* Room for the cross: a long title must wrap before it reaches the corner. */}
          <h2
            id="paywall-title"
            className="relative mx-auto max-w-sm text-balance px-6 text-[22px] font-semibold leading-[1.15] tracking-[-0.025em] text-neutral-900 dark:text-neutral-50"
          >
            {custom ? custom.title : t(copy.title)}
          </h2>
          <p className="relative mx-auto mt-2 max-w-sm text-balance text-sm leading-relaxed text-neutral-500 dark:text-neutral-400">
            {custom ? custom.body : t(copy.body)}
          </p>
          {limitLine && (
            <p className="relative mx-auto mt-2.5 inline-flex max-w-sm items-center gap-2 rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs leading-snug text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
              <span aria-hidden className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-accent-600 dark:bg-accent-300" />
              <span>{limitLine}</span>
            </p>
          )}
        </div>

        {/* A column, not the width of the window: the scan page is a whole tab,
            and the side panel can be dragged as wide as one. */}
        <div className="mx-auto max-w-md px-4 pb-4">
          {/* Three across, each under its own mark. No rules: framed above,
              below and between, three short lines read as a table, with the
              plan cards' borders right under it (owner, 2026-10-04); the marks
              and the gaps separate them. The columns are 88px in the small
              popup, and one word can be wider than that ("Неограниченное"),
              so long words are hyphenated, or broken where no dictionary has
              the language. Only long ones: left to itself the browser also
              split "чис-ло" to even out a line. */}
          <ul className="mb-4 mt-1 grid grid-cols-3 gap-x-3">
            {BENEFITS.map(({ key: k, Icon }) => (
              <li key={k} className="flex min-w-0 flex-col items-center gap-1.5 text-center text-xs leading-snug text-neutral-600 dark:text-neutral-400">
                <Icon size={16} strokeWidth={1.75} className="flex-shrink-0 text-accent-600 dark:text-accent-300" aria-hidden />
                <span className="max-w-full hyphens-auto text-balance [hyphenate-limit-chars:13_5_5] [overflow-wrap:anywhere]">{t(k)}</span>
              </li>
            ))}
          </ul>

          {policy === 'loading' && (
            <div className="flex justify-center py-6 text-neutral-400" aria-busy="true">
              <Loader2 size={20} className="animate-spin" />
            </div>
          )}

          {policy === null && (
            <div className="rounded-lg border border-neutral-200 p-3 text-center text-sm text-neutral-600 dark:border-neutral-800 dark:text-neutral-300">
              <p>{t('paywall.unavailable')}</p>
              <button
                type="button"
                onClick={() => void load(true)}
                className="mt-2 text-sm font-medium text-accent-700 underline-offset-4 hover:underline dark:text-accent-300"
              >
                {t('paywall.retry')}
              </button>
            </div>
          )}

          {policy && policy !== 'loading' && (
            <div role="radiogroup" aria-labelledby="paywall-title" className="space-y-2">
              {plans.map(id => {
                const price = prices[id]!;
                const active = id === selected;
                const saving = price.kind === 'sub' && price.interval === 'year' ? yearlySaving(price, monthly) : null;
                return (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setSelected(id)}
                    className={`flex w-full items-center gap-3 rounded-lg border bg-white px-3.5 py-2 text-start transition-[border-color,box-shadow] dark:bg-neutral-950 ${
                      active
                        ? 'border-accent-600 shadow-[0_0_0_1px_#1a73e8] dark:border-accent-300 dark:shadow-[0_0_0_1px_#8AB4F8]'
                        : 'border-neutral-200 hover:border-neutral-400 dark:border-neutral-800 dark:hover:border-neutral-600'
                    }`}
                  >
                    <span
                      aria-hidden
                      className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border transition-colors ${
                        active ? 'border-accent-600 bg-accent-600 dark:border-accent-300 dark:bg-accent-300' : 'border-neutral-300 dark:border-neutral-700'
                      }`}
                    >
                      {active && <span className="h-1.5 w-1.5 rounded-full bg-white dark:bg-neutral-950" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{t(planLabel(price))}</span>
                        {saving !== null && (
                          <span className="rounded-full bg-accent-50 px-1.5 py-px text-[10px] font-medium text-accent-700 dark:bg-accent-700/25 dark:text-accent-300">
                            {t('paywall.save', saving)}
                          </span>
                        )}
                      </span>
                      <span className="block text-xs text-neutral-500 dark:text-neutral-400">
                        {price.kind === 'sub' && trialDays > 0 ? t('paywall.trial', trialDays, priceLine(price)) : noteLine(price)}
                      </span>
                    </span>
                    <span className="flex flex-shrink-0 flex-col items-end tabular-nums">
                      {/* What twelve monthly payments come to — the same sum the badge is worked out from. */}
                      {saving !== null && monthly && (
                        <span aria-hidden className="text-[11px] leading-tight text-neutral-400 line-through dark:text-neutral-500">
                          {formatMoney(monthly.amount * 12, monthly.currency, monthly.exp, locale)}
                        </span>
                      )}
                      <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{priceLine(price)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          <div className="sticky bottom-0 -mx-4 bg-gradient-to-t from-white from-85% to-white/0 px-4 pb-3 pt-3.5 dark:from-neutral-950 dark:to-neutral-950/0">
            {policy && policy !== 'loading' && (
              <button
                type="button"
                onClick={() => void checkout()}
                disabled={!selected || busy !== null}
                className="flex min-h-[44px] w-full flex-wrap items-center justify-center gap-x-2 rounded-lg bg-accent-600 px-4 py-2.5 text-[15px] font-medium text-white transition-colors hover:bg-accent-700 disabled:opacity-60"
              >
                {busy === 'checkout' && <Loader2 size={16} className="animate-spin" aria-hidden />}
                {busy === 'checkout' ? t('paywall.opening') : t('paywall.continue')}
                {/* The button can be on screen while the plans are not, so it names
                    what it charges. Not with a trial: nothing is charged today, and
                    the plan row is where that is spelled out. */}
                {busy !== 'checkout' && selectedPrice && !(selectedPrice.kind === 'sub' && trialDays > 0) && (
                  <span className="font-normal tabular-nums text-white/75">
                    <span aria-hidden>· </span>
                    {priceLine(selectedPrice)}
                  </span>
                )}
              </button>
            )}

            {request.allowPartial && request.limit && request.limit.remaining > 0 && (
              <button
                type="button"
                onClick={() => finish('partial')}
                disabled={busy !== null}
                className="mt-2 min-h-[40px] w-full rounded-lg border border-neutral-200 bg-white px-4 py-2 text-sm font-medium text-neutral-900 transition-colors hover:bg-neutral-50 disabled:opacity-60 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-100 dark:hover:bg-neutral-900"
              >
                {t('paywall.addFree', request.limit.remaining)}
              </button>
            )}

            {failure('checkout')}

          </div>

          <div className="mt-1 flex flex-wrap items-center justify-center gap-x-5 gap-y-1 text-[13px]">
            <button
              type="button"
              onClick={() => showPanel('key')}
              className="flex items-center gap-1.5 text-neutral-500 transition-colors hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
              aria-expanded={panel === 'key'}
            >
              <KeyRound size={14} aria-hidden />
              {t('paywall.haveKey')}
            </button>
            <button
              type="button"
              onClick={() => showPanel('restore')}
              className="flex items-center gap-1.5 text-neutral-500 transition-colors hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
              aria-expanded={panel === 'restore'}
            >
              <Mail size={14} aria-hidden />
              {t('paywall.restore')}
            </button>
          </div>

          <div ref={panelRef}>
            {panel === 'key' && (
              <>
                <form
                  className="mt-3 flex gap-2"
                  onSubmit={e => {
                    e.preventDefault();
                    void activate();
                  }}
                >
                  <input
                    value={key}
                    onChange={e => setKey(e.target.value)}
                    placeholder={t('paywall.keyPlaceholder')}
                    autoComplete="off"
                    spellCheck={false}
                    aria-label={t('paywall.haveKey')}
                    className={`${FIELD} font-mono uppercase placeholder:font-sans placeholder:normal-case`}
                  />
                  <button
                    type="submit"
                    disabled={!key.trim() || busy !== null}
                    className="h-9 flex-shrink-0 rounded-md bg-accent-600 px-3 text-sm font-medium text-white transition-colors hover:bg-accent-700 disabled:opacity-60"
                  >
                    {busy === 'key' ? <Loader2 size={16} className="animate-spin" aria-hidden /> : t('paywall.activate')}
                  </button>
                </form>
                {failure('key')}
              </>
            )}

            {panel === 'restore' && sentTo && (
              <div
                role="status"
                className="mt-3 flex items-start gap-2 rounded-lg border border-neutral-200 px-3 py-2.5 text-sm leading-snug text-neutral-700 dark:border-neutral-800 dark:text-neutral-300"
              >
                <MailCheck size={16} className="mt-0.5 flex-shrink-0 text-accent-600 dark:text-accent-300" aria-hidden />
                <span className="min-w-0">
                  {t('paywall.restoreSent')}
                  <span className="mt-0.5 block break-all font-medium text-neutral-900 dark:text-neutral-100" dir="ltr">
                    {sentTo}
                  </span>
                </span>
              </div>
            )}

            {panel === 'restore' && !sentTo && (
              <form
                className="mt-3"
                onSubmit={e => {
                  e.preventDefault();
                  void restore();
                }}
              >
                <p className="mb-2 text-xs text-neutral-500 dark:text-neutral-400">{t('paywall.restoreHint')}</p>
                <div className="flex gap-2">
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder={t('paywall.emailPlaceholder')}
                    aria-label={t('paywall.restore')}
                    className={FIELD}
                  />
                  <button
                    type="submit"
                    disabled={busy !== null}
                    className="h-9 flex-shrink-0 rounded-md border border-neutral-200 bg-white px-3 text-sm font-medium text-neutral-900 transition-colors hover:bg-neutral-50 disabled:opacity-60 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-100 dark:hover:bg-neutral-900"
                  >
                    {busy === 'restore' ? <Loader2 size={16} className="animate-spin" aria-hidden /> : t('paywall.send')}
                  </button>
                </div>
                {failure('restore')}
              </form>
            )}
          </div>

          <p className="mt-5 text-center text-[11px] leading-relaxed text-neutral-400 dark:text-neutral-500">{t('paywall.legal')}</p>
        </div>
      </div>
    </div>
  );
}
