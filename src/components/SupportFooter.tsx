import { LifeBuoy } from 'lucide-react';
import { createT, type Language } from '@/utils/i18n';

const SUPPORT_URL = 'https://authenticator.sh/support';

/**
 * Always-visible way out when someone is stuck.
 *
 * Sits below the scroll area rather than inside it, so it is reachable from
 * every screen without the user having to scroll a list of codes to find it.
 */
export function SupportFooter({ language }: { language: Language }) {
  const t = createT(language);

  return (
    <div className="flex-shrink-0 border-t border-gray-200 bg-white px-4 py-1.5 dark:border-dark-700 dark:bg-dark-900">
      <button
        onClick={() => chrome.tabs.create({ url: SUPPORT_URL })}
        className="flex items-center gap-1.5 text-[11px] font-medium text-gray-500 transition-colors hover:text-[#4285F4] dark:text-gray-400 dark:hover:text-[#4285F4]"
      >
        <LifeBuoy size={12} />
        {t('common.support')}
      </button>
    </div>
  );
}
