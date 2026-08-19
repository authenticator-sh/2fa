import { useState } from 'react';
import { Star } from 'lucide-react';
import { createT, type Language } from '@/utils/i18n';

interface RatingStarsProps {
  language: Language;
  /** Every star does the same thing: open the store listing. */
  onRate: () => void;
}

/**
 * The five stars, in one place because the ask lives in two.
 *
 * The review card at the end of the account list and the "What's New" modal
 * each had their own copy of this block, and changing one of them left the
 * other showing the old design — which is exactly how a duplicate ends up
 * being found by a user rather than by us.
 *
 * The stars start empty and fill only under the pointer or the focus ring. An
 * earlier version deliberately shipped a plain button instead, on the grounds
 * that five filled stars beside the word "rate" name the answer we are hoping
 * for; outlines that fill as you reach for them ask without suggesting.
 *
 * Clicking any of them opens the same page. The Web Store's review form cannot
 * receive a rating from a link, and nothing here records or forwards the number
 * — collecting a score and passing on only the good ones is review gating, and
 * it is the reason the caller pairs this with a line saying where the click
 * leads.
 */
export function RatingStars({ language, onRate }: RatingStarsProps) {
  const t = createT(language);
  // Which star the pointer or the keyboard is on, 1-5. Zero means none.
  const [highlighted, setHighlighted] = useState(0);

  return (
    <div className="flex items-center justify-center gap-1" onMouseLeave={() => setHighlighted(0)}>
      {[1, 2, 3, 4, 5].map((value) => (
        <button
          key={value}
          type="button"
          onClick={onRate}
          onMouseEnter={() => setHighlighted(value)}
          onFocus={() => setHighlighted(value)}
          onBlur={() => setHighlighted(0)}
          aria-label={t('review.rateStars', value)}
          className="rounded p-1 text-[#F4B400] transition-transform hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        >
          {/* Filling every star up to the one under the pointer is what makes a
              row of outlines read as one rating control rather than as five
              separate buttons. */}
          <Star size={22} fill={value <= highlighted ? 'currentColor' : 'none'} strokeWidth={1.5} />
        </button>
      ))}
    </div>
  );
}
