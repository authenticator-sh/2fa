import { useState, useRef, useEffect } from 'react';
import { Globe } from 'lucide-react';
import { languages, createT, type Language } from '@/utils/i18n';

interface LanguageSelectorProps {
  language: Language;
  onLanguageChange: (lang: Language) => void;
}

export function LanguageSelector({ language, onLanguageChange }: LanguageSelectorProps) {
  const t = createT(language);
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

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
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`p-1.5 rounded-lg transition-colors ${
          isOpen ? 'bg-gray-200 dark:bg-dark-600' : 'hover:bg-gray-100 dark:hover:bg-dark-700'
        }`}
        title={t('header.language')}
      >
        <Globe className="text-gray-600 dark:text-gray-400" size={18} />
      </button>

      {isOpen && (
        <div className="absolute end-0 top-full mt-1 bg-white dark:bg-dark-800 rounded-lg shadow-lg border border-gray-200 dark:border-dark-600 py-1 z-50 min-w-[140px] max-h-[300px] overflow-y-auto">
          {languages.map((lang) => (
            <button
              key={lang.code}
              onClick={() => {
                onLanguageChange(lang.code);
                setIsOpen(false);
              }}
              className={`w-full px-3 py-2 text-start text-sm flex items-center gap-2 hover:bg-gray-100 dark:hover:bg-dark-700 transition-colors ${
                language === lang.code ? 'bg-gray-50 dark:bg-dark-700 font-medium' : ''
              }`}
            >
              <span>{lang.flag}</span>
              <span className="dark:text-gray-200">{lang.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
