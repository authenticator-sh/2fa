import { LifeBuoy } from 'lucide-react';
import { LanguageSelector } from '@/components/LanguageSelector';
import { createT, type Language } from '@/utils/i18n';

// www, not the apex — the apex only redirects here. See helpUrl in utils/links.
const SUPPORT_URL = 'https://www.authenticator.sh/support';

/**
 * Always-visible way out when someone is stuck.
 *
 * Sits below the scroll area rather than inside it, so it is reachable from
 * every screen without the user having to scroll a list of codes to find it.
 *
 * Help only. "Request a feature" used to sit beside it and is at the end of
 * Settings now.
 *
 * The row wraps rather than clips: at the 320px popup size a long translation
 * of the label and the language name do not always fit side by side.
 *
 * The language is here too, at the far end, on the pages that can change it.
 */
interface SupportFooterProps {
  language: Language;
  /** Given by the popup; the scanner and passkey pages follow its choice. */
  onLanguageChange?: (lang: Language) => void;
}

export function SupportFooter({ language, onLanguageChange }: SupportFooterProps) {
  const t = createT(language);

  const linkClass =
    'flex items-center gap-1.5 whitespace-nowrap text-[11px] font-medium text-gray-500 transition-colors hover:text-accent-600 dark:text-gray-400 dark:hover:text-accent-400';

  return (
    <div data-ui="footer" className="flex-shrink-0 flex flex-wrap items-center gap-x-4 gap-y-0.5 border-t border-gray-200 bg-white px-4 py-1.5 dark:border-dark-700 dark:bg-dark-900">
      <button onClick={() => chrome.tabs.create({ url: SUPPORT_URL })} className={linkClass}>
        <LifeBuoy size={12} />
        {t('common.support')}
      </button>
      {onLanguageChange && (
        <LanguageSelector language={language} onLanguageChange={onLanguageChange} className={linkClass} />
      )}
    </div>
  );
}
