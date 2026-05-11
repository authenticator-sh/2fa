import { useState } from 'react';
import { X, Star } from 'lucide-react';
import { createT, type Language } from '@/utils/i18n';

const CHROME_STORE_REVIEW_URL = 'https://chromewebstore.google.com/detail/2fa/ebhcbenbgjmaebpgbldimndmfomjmphd/reviews';
const FEEDBACK_URL = 'https://authenticator.sh/rate';

interface ReviewPromptProps {
  onClose: () => void;
  language: Language;
}

export function ReviewPrompt({ onClose, language }: ReviewPromptProps) {
  const [hoveredStar, setHoveredStar] = useState(0);
  const [selectedStar, setSelectedStar] = useState(0);
  const t = createT(language);

  const handleRate = (rating: number) => {
    setSelectedStar(rating);

    // Mark as reviewed so we don't ask again
    chrome.storage.local.set({ reviewDismissed: true });

    setTimeout(() => {
      if (rating >= 4) {
        chrome.tabs.create({ url: CHROME_STORE_REVIEW_URL });
      } else {
        chrome.tabs.create({ url: FEEDBACK_URL });
      }
      onClose();
    }, 300);
  };

  const handleDismiss = () => {
    chrome.storage.local.set({ reviewDismissed: true });
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-white dark:bg-dark-800 rounded-2xl shadow-xl w-[320px] p-6 relative">
        <button
          onClick={handleDismiss}
          className="absolute top-3 right-3 p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-dark-700 transition-colors"
        >
          <X className="text-gray-400 dark:text-gray-500" size={16} />
        </button>

        <div className="text-center">
          <div className="text-3xl mb-3">⭐</div>
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1">
            {t('review.title')}
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
            {t('review.subtitle')}
          </p>

          <div className="flex items-center justify-center gap-1.5 mb-4">
            {[1, 2, 3, 4, 5].map((star) => (
              <button
                key={star}
                onMouseEnter={() => setHoveredStar(star)}
                onMouseLeave={() => setHoveredStar(0)}
                onClick={() => handleRate(star)}
                className="p-1 transition-transform hover:scale-110"
              >
                <Star
                  size={32}
                  className={`transition-colors ${
                    star <= (hoveredStar || selectedStar)
                      ? 'text-yellow-400 fill-yellow-400'
                      : 'text-gray-300 dark:text-dark-500'
                  }`}
                />
              </button>
            ))}
          </div>

          <button
            onClick={handleDismiss}
            className="text-xs text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 transition-colors"
          >
            {t('review.later')}
          </button>
        </div>
      </div>
    </div>
  );
}
