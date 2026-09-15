import { ArrowRight, Rocket, X } from 'lucide-react';
import { createT, type Language } from '@/utils/i18n';
import { PRODUCT_HUNT_URL } from '@/utils/links';
import { dismissProductHunt } from '@/utils/product-hunt';

interface ProductHuntBannerProps {
  language: Language;
  onDismiss: () => void;
}

/**
 * The launch-day banner above the codes.
 *
 * In Product Hunt's orange rather than our blue, on purpose: every other notice
 * up here is blue and about the user's own accounts, and this one is about
 * somewhere else entirely — it must not read as one more backup reminder to
 * close. The pulsing dot is the only moving thing in the popup, for one day.
 *
 * The button asks for a comment, never a vote. That is Product Hunt's one hard
 * rule for makers, and a launch caught asking can be removed.
 */
export function ProductHuntBanner({ language, onDismiss }: ProductHuntBannerProps) {
  const t = createT(language);

  const handleDismiss = async () => {
    await dismissProductHunt();
    onDismiss();
  };

  // Answered before the tab opens: opening a tab tears the popup down, and a
  // write still in flight goes with it — the banner would greet someone who had
  // already been. A failed write must not cost them the link, though.
  const handleVisit = async () => {
    await dismissProductHunt().catch(() => {});
    onDismiss();
    chrome.tabs.create({ url: PRODUCT_HUNT_URL });
  };

  return (
    // flex-shrink-0: the popup is a fixed-height column, and overflow-hidden (for
    // the glow) lets a flex item shrink below its content — without this the
    // list squeezed the card down to one clipped line and hid the button.
    <div className="relative mx-3 mt-3 mb-1 flex-shrink-0 overflow-hidden rounded-xl border border-orange-200/80 bg-gradient-to-br from-orange-50 via-white to-rose-50 p-3 shadow-sm dark:border-orange-900/50 dark:from-orange-950/50 dark:via-dark-800 dark:to-rose-950/30">
      {/* A soft glow in the corner, so the card has some depth without an image. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-12 -end-12 h-32 w-32 rounded-full bg-orange-400/20 blur-2xl dark:bg-orange-500/10"
      />

      {/* z-10: the content row below is `relative` (to sit above the glow) and
          comes later in the DOM, so without it that row painted over this
          button and took every click on it — its padding only moves the text,
          not the box. Verified in Chromium: a pointer on the × hit the text
          column, and the banner could not be closed. */}
      <button
        type="button"
        onClick={handleDismiss}
        aria-label={t('productHunt.notNow')}
        className="absolute top-2 end-2 z-10 rounded p-0.5 text-gray-400 transition-colors hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
      >
        <X size={13} />
      </button>

      <div className="relative flex gap-3">
        <div className="relative flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#FF6154] to-[#DA552F] shadow-md shadow-orange-500/30">
          <Rocket size={19} className="text-white" />
          <span className="absolute -top-1 -end-1 flex h-3 w-3">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-orange-400 opacity-75 motion-reduce:hidden" />
            <span className="relative inline-flex h-3 w-3 rounded-full border-2 border-white bg-[#FF6154] dark:border-dark-800" />
          </span>
        </div>

        <div className="min-w-0 flex-1 pe-4">
          <p className="text-xs leading-snug text-gray-700 dark:text-gray-300">{t('productHunt.body')}</p>
          <button
            type="button"
            onClick={handleVisit}
            className="group mt-2.5 inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-[#FF6154] to-[#DA552F] px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm shadow-orange-500/30 transition hover:shadow-md hover:brightness-105 active:scale-[0.98]"
          >
            {t('productHunt.visit')}
            <ArrowRight
              size={13}
              className="transition-transform group-hover:translate-x-0.5 rtl:rotate-180 rtl:group-hover:-translate-x-0.5"
            />
          </button>
        </div>
      </div>
    </div>
  );
}
