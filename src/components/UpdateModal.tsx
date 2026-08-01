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
      <div className="bg-white dark:bg-dark-800 rounded-lg border border-gray-200 dark:border-dark-600 max-w-sm w-full shadow-xl">
        <div className="p-5">
          <div className="flex items-center gap-2 mb-3">
            <Sparkles className="text-[#4285F4]" size={20} />
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{t('update.title')}</h2>
          </div>
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">v{version}</p>
          <ul className="space-y-2 mb-4">
            {highlights.map((key) => (
              <li key={key} className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
                <span className="text-[#4285F4] mt-1">&bull;</span>
                <span>{t(key)}</span>
              </li>
            ))}
          </ul>

          {showRatingPrompt && (
            <div className="border-t border-gray-100 dark:border-dark-700 pt-3 mb-4">
              {votedLow ? (
                <p className="text-xs text-gray-600 dark:text-gray-400">{t('review.thanksLow')}</p>
              ) : (
                <>
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{t('review.title')}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">{t('review.subtitle')}</p>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <button
                          key={n}
                          type="button"
                          onClick={() => handleStarClick(n)}
                          onMouseEnter={() => setHoverRating(n)}
                          onMouseLeave={() => setHoverRating(0)}
                          className="p-0.5"
                        >
                          <Star
                            size={20}
                            className={hoverRating >= n ? 'fill-yellow-400 text-yellow-400' : 'text-gray-300 dark:text-gray-600'}
                          />
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={() => setLaterClicked(true)}
                      className="text-xs text-gray-500 dark:text-gray-400 hover:underline"
                    >
                      {t('review.later')}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          <button
            onClick={onClose}
            className="w-full bg-[#4285F4] hover:bg-[#3367D6] text-white font-medium text-sm py-2.5 rounded-lg transition-colors"
          >
            {t('update.gotIt')}
          </button>
        </div>
      </div>
    </div>
  );
}
