import { X, KeyRound } from 'lucide-react';
import { createT, type Language } from '@/utils/i18n';
import { PROMO_URL, dismissPromoBanner } from '@/utils/promo-banner';

interface PromoBannerProps {
  language: Language;
  onDismiss: () => void;
}

export function PromoBanner({ language, onDismiss }: PromoBannerProps) {
  const t = createT(language);

  const handleDismiss = async () => {
    await dismissPromoBanner();
    onDismiss();
  };

  return (
    <div className="mx-3 my-3 relative rounded-xl border border-blue-100 dark:border-dark-600 bg-gradient-to-br from-blue-50/80 to-indigo-50/50 dark:from-blue-900/15 dark:to-dark-800 p-3">
      <button
        onClick={handleDismiss}
        className="absolute top-2 end-2 p-0.5 rounded text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 transition-colors"
      >
        <X size={13} />
      </button>
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-white dark:bg-dark-700 border border-blue-100 dark:border-dark-600 shadow-sm flex items-center justify-center flex-shrink-0">
          <KeyRound size={17} className="text-[#4285F4]" />
        </div>
        <div className="flex-1 min-w-0 pe-3">
          <p className="text-xs font-medium text-gray-900 dark:text-gray-100 leading-snug">
            {t('promo.text')}
          </p>
          <a
            href={PROMO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-[#4285F4] hover:text-[#3367D6] font-medium hover:underline"
          >
            {t('promo.cta')}
          </a>
        </div>
      </div>
    </div>
  );
}
