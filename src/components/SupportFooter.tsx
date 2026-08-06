import { LifeBuoy, Lightbulb } from 'lucide-react';
import { createT, type Language } from '@/utils/i18n';
import { FEATURE_REQUEST_URL } from '@/utils/links';

const SUPPORT_URL = 'https://authenticator.sh/support';

/**
 * Always-visible way out when someone is stuck, and a way to ask for what is
 * missing.
 *
 * Sits below the scroll area rather than inside it, so it is reachable from
 * every screen without the user having to scroll a list of codes to find it.
 *
 * The row wraps rather than clips: at the 320px popup size the longer
 * translations of the two labels do not fit side by side.
 */
export function SupportFooter({ language }: { language: Language }) {
  const t = createT(language);

  const linkClass =
    'flex items-center gap-1.5 whitespace-nowrap text-[11px] font-medium text-gray-500 transition-colors hover:text-[#4285F4] dark:text-gray-400 dark:hover:text-[#4285F4]';

  return (
    <div className="flex-shrink-0 flex flex-wrap items-center gap-x-4 gap-y-0.5 border-t border-gray-200 bg-white px-4 py-1.5 dark:border-dark-700 dark:bg-dark-900">
      <button onClick={() => chrome.tabs.create({ url: SUPPORT_URL })} className={linkClass}>
        <LifeBuoy size={12} />
        {t('common.support')}
      </button>
      <button onClick={() => chrome.tabs.create({ url: FEATURE_REQUEST_URL })} className={linkClass}>
        <Lightbulb size={12} />
        {t('common.requestFeature')}
      </button>
    </div>
  );
}
