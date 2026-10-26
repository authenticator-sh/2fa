import { useState, useRef, useEffect, useId } from 'react';
import { useEscapeLayer } from '@/hooks/useLayer';
import { Globe } from 'lucide-react';
import { languages, createT, type Language } from '@/utils/i18n';

interface LanguageSelectorProps {
  language: Language;
  onLanguageChange: (lang: Language) => void;
  /** The footer's link style: the control sits in that row as one of its links. */
  className: string;
}

/**
 * The language, as a link in the footer rather than a globe in the header.
 *
 * It is chosen once, if ever, and the header is where the title has to fit.
 *
 * The link is the globe and the code, not the name: with "Русский" or
 * "Français" spelled out the footer broke onto a second row in four languages
 * at the default 400px popup, and with the code in none. The names are in the
 * list, each in its own language, which is where someone looking at the wrong
 * one needs to be able to read them.
 */
export function LanguageSelector({ language, onLanguageChange, className }: LanguageSelectorProps) {
  const t = createT(language);
  const current = languages.find(lang => lang.code === language);
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listId = useId();

  // Escape closes the list and nothing else, and puts focus back on the link:
  // the list is a layer over the footer like any dialog is over the page.
  useEscapeLayer(() => {
    setIsOpen(false);
    buttonRef.current?.focus();
  }, isOpen);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div className="relative ms-auto" ref={dropdownRef}>
      <button
        ref={buttonRef}
        onClick={() => setIsOpen(!isOpen)}
        aria-label={current ? `${t('header.language')}: ${current.label}` : t('header.language')}
        aria-expanded={isOpen}
        aria-controls={isOpen ? listId : undefined}
        className={className}
        title={t('header.language')}
      >
        <Globe aria-hidden size={12} />
        {language.toUpperCase()}
      </button>

      {/* Upwards, from the bottom edge of the window — and never taller than
          the window has room for above the footer at its smallest size. */}
      {isOpen && (
        <div id={listId} className="absolute end-0 bottom-full mb-1 bg-white dark:bg-dark-800 rounded-lg shadow-lg border border-gray-200 dark:border-dark-600 py-1 z-50 min-w-[140px] max-h-[min(300px,70vh)] overflow-y-auto anim-menu-up">
          {languages.map((lang) => (
            <button
              key={lang.code}
              lang={lang.code}
              aria-current={language === lang.code ? 'true' : undefined}
              onClick={() => {
                onLanguageChange(lang.code);
                setIsOpen(false);
                buttonRef.current?.focus();
              }}
              className={`w-full px-3 py-2 text-start text-sm flex items-center gap-2 hover:bg-gray-100 dark:hover:bg-dark-700 transition-colors ${
                language === lang.code ? 'bg-gray-50 dark:bg-dark-700 font-medium' : ''
              }`}
            >
              <span aria-hidden>{lang.flag}</span>
              <span className="dark:text-gray-200">{lang.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
