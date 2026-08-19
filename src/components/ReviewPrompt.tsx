import { createT, type Language } from '@/utils/i18n';
import { RatingStars } from './RatingStars';

interface ReviewPromptProps {
  language: Language;
  onRate: () => void;
  onSnooze: () => void;
}

/**
 * The review ask, as a card at the end of the account list rather than a modal.
 *
 * Someone opening the popup is almost always mid-login with a code to copy.
 * Blocking that on the fifteenth open to ask for a favour earns a one-star
 * review, not a five-star one — so this waits below the codes, where it is seen
 * on the way out instead of standing in the way.
 */
export function ReviewPrompt({ language, onRate, onSnooze }: ReviewPromptProps) {
  const t = createT(language);

  return (
    <div className="mx-3 my-3 rounded-xl border border-blue-100 bg-gradient-to-br from-blue-50/80 to-indigo-50/50 p-3 dark:border-dark-600 dark:from-blue-900/15 dark:to-dark-800">
      {/* No heading above this: the copy opens with its own hook ("If
          Authenticator has helped you…"), so a "Enjoying Authenticator?" line
          on top only asks the question the first clause already answers — and
          names the product twice in adjacent lines of a 320px card. */}
      <p className="text-xs leading-snug text-gray-600 dark:text-gray-400">{t('review.pitch')}</p>

      <div className="mt-2.5">
        <RatingStars language={language} onRate={onRate} />
      </div>

      <button
        type="button"
        onClick={onSnooze}
        className="mt-1.5 w-full text-center text-[11px] text-gray-500 hover:underline dark:text-gray-400"
      >
        {t('review.later')}
      </button>
    </div>
  );
}
