import { useState } from 'react';
import { Sparkles, Star } from 'lucide-react';
import { createT, type Language } from '@/utils/i18n';
import { WHATS_NEW } from '@/utils/update-notes';

interface UpdateModalProps {
  version: string;
  language: Language;
  onClose: () => void;
  reviewDismissed: boolean;
  onRate: (stars: number) => void;
}

export function UpdateModal({ version, language, onClose, reviewDismissed, onRate }: UpdateModalProps) {
  const t = createT(language);
  const highlights = WHATS_NEW[version] || [];
  const [hoverRating, setHoverRating] = useState(0);
  const [votedLow, setVotedLow] = useState(false);
  const [laterClicked, setLaterClicked] = useState(false);

  const handleStarClick = (stars: number) => {
    onRate(stars);
    if (stars < 4) setVotedLow(true);
  };

  // votedLow must win even after the parent flips reviewDismissed=true on rate,
  // otherwise the thank-you message never gets a chance to render.
  const showRatingPrompt = votedLow || (!reviewDismissed && !laterClicked);

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      {/* The changelog can run long, so it scrolls while the rating block and
          the dismiss button stay pinned — the rating is the whole reason this
          modal earns its interruption, and it must never be scrolled past. */}
      <div className="bg-white dark:bg-dark-800 rounded-lg border border-gray-200 dark:border-dark-600 max-w-sm w-full max-h-[92vh] shadow-xl flex flex-col overflow-hidden">
        <div className="px-5 pt-5 pb-2 flex-shrink-0">
          <div className="flex items-center gap-2">
            <Sparkles className="text-[#4285F4]" size={20} />
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{t('update.title')}</h2>
            <span className="ml-auto text-xs font-medium text-gray-400 dark:text-gray-500">v{version}</span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 min-h-0">
          <ul className="space-y-2 pb-3">
            {highlights.map((key) => (
              <li key={key} className="flex items-start gap-2 text-xs leading-relaxed text-gray-700 dark:text-gray-300">
                <span className="text-[#4285F4] mt-0.5">&bull;</span>
                <span>{t(key)}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex-shrink-0 px-5 pb-5 pt-3 border-t border-gray-100 dark:border-dark-700">
          {showRatingPrompt && (
            <div className="mb-3 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-900/40 p-3">
              {votedLow ? (
                <p className="text-xs text-gray-600 dark:text-gray-400">{t('review.thanksLow')}</p>
              ) : (
                <>
                  <p className="text-center text-sm font-semibold text-gray-900 dark:text-gray-100">
                    {t('review.title')}
                  </p>
                  <p className="mt-0.5 text-center text-xs text-gray-500 dark:text-gray-400">
                    {t('review.subtitle')}
                  </p>
                  <div className="mt-2 flex items-center justify-center gap-1">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => handleStarClick(n)}
                        onMouseEnter={() => setHoverRating(n)}
                        onMouseLeave={() => setHoverRating(0)}
                        className="p-1 transition-transform hover:scale-110"
                        aria-label={String(n)}
                      >
                        <Star
                          size={28}
                          className={
                            hoverRating >= n
                              ? 'fill-yellow-400 text-yellow-400'
                              : 'text-gray-300 dark:text-gray-600'
                          }
                        />
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => setLaterClicked(true)}
                    className="mt-1.5 w-full text-center text-[11px] text-gray-500 dark:text-gray-400 hover:underline"
                  >
                    {t('review.later')}
                  </button>
                </>
              )}
            </div>
          )}

          <button
            onClick={onClose}
            className={`w-full font-medium text-sm py-2.5 rounded-lg transition-colors ${
              showRatingPrompt && !votedLow
                ? 'border border-gray-300 dark:border-dark-500 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-dark-700'
                : 'bg-[#4285F4] hover:bg-[#3367D6] text-white'
            }`}
          >
            {t('update.gotIt')}
          </button>
        </div>
      </div>
    </div>
  );
}
