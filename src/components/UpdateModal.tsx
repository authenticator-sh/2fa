import { useState } from 'react';
import { Sparkles, ExternalLink, Lightbulb } from 'lucide-react';
import { createT, type Language } from '@/utils/i18n';
import { WHATS_NEW } from '@/utils/update-notes';
import { FEATURE_REQUEST_URL } from '@/utils/links';

interface UpdateModalProps {
  version: string;
  language: Language;
  onClose: () => void;
  reviewDismissed: boolean;
  onRate: () => void;
  /** Records the snooze, so declining here also stands down the standalone card. */
  onSnoozeReview: () => void;
}

export function UpdateModal({ version, language, onClose, reviewDismissed, onRate, onSnoozeReview }: UpdateModalProps) {
  const t = createT(language);
  const highlights = WHATS_NEW[version] || [];
  const [laterClicked, setLaterClicked] = useState(false);

  const showRatingPrompt = !reviewDismissed && !laterClicked;

  /**
   * Anything that navigates away closes the popup, and the modal is re-armed
   * from storage on the next open. Without recording the dismissal first, taking
   * either of the links below means the changelog is waiting again the next time
   * the user comes for a code — and again after that, until they happen to press
   * "Got it".
   */
  const openAndClose = (url: string) => {
    onClose();
    chrome.tabs.create({ url });
  };

  const handleLater = () => {
    setLaterClicked(true);
    onSnoozeReview();
  };

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
            <span className="ms-auto text-xs font-medium text-gray-400 dark:text-gray-500">v{version}</span>
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

          {/* Reading what just shipped is when someone is most likely to think
              "and what about…". Kept inside the scroll area so it can never
              push the rating block out of view. */}
          <button
            type="button"
            onClick={() => openAndClose(FEATURE_REQUEST_URL)}
            className="mb-3 flex items-center gap-1.5 text-xs font-medium text-[#4285F4] hover:underline"
          >
            <Lightbulb size={13} />
            {t('common.requestFeature')}
          </button>
        </div>

        <div className="flex-shrink-0 px-5 pb-5 pt-3 border-t border-gray-100 dark:border-dark-700">
          {showRatingPrompt && (
            <div className="mb-3 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-900/40 p-3">
              {/* Left-aligned and headingless, same as the standalone card:
                  the copy carries its own opening, and centring a paragraph
                  this long just makes it harder to read. */}
              <p className="text-xs leading-snug text-gray-600 dark:text-gray-400">
                {t('review.pitch')}
              </p>
              {/* One button, one destination, and no stars on it: collecting a
                  score here and forwarding only the high ones would be review
                  gating, and a row of filled stars next to "rate" names the
                  answer we want. The label says where the click leads. */}
              <button
                type="button"
                onClick={onRate}
                className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-lg border border-blue-200 bg-white py-2 text-xs font-medium text-[#4285F4] transition-colors hover:bg-blue-50 dark:border-blue-900/40 dark:bg-dark-800 dark:hover:bg-dark-700"
              >
                {t('review.cta')}
                <ExternalLink size={13} />
              </button>
              <button
                type="button"
                onClick={handleLater}
                className="mt-1.5 w-full text-center text-[11px] text-gray-500 dark:text-gray-400 hover:underline"
              >
                {t('review.later')}
              </button>
            </div>
          )}

          <button
            onClick={onClose}
            className={`w-full font-medium text-sm py-2.5 rounded-lg transition-colors ${
              showRatingPrompt
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
