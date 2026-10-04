import { Search, X } from 'lucide-react';
import { forwardRef } from 'react';

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  placeholder?: string;
  /** Name of the ✕ button — read out by screen readers, which see no icon. */
  clearLabel?: string;
}

export const SearchBar = forwardRef<HTMLInputElement, SearchBarProps>(
  ({ value, onChange, className, placeholder = 'Search accounts...', clearLabel = 'Clear search' }, ref) => {
    return (
      <div className={`relative ${className}`}>
        <Search aria-hidden className="absolute start-3 top-1/2 -translate-y-1/2 text-gray-500 dark:text-gray-400" size={16} />
        <input
          ref={ref}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          className="w-full bg-gray-50 dark:bg-dark-800 text-gray-900 dark:text-gray-100 placeholder-gray-500 dark:placeholder-gray-400 text-sm rounded-lg ps-9 pe-9 py-2 border border-gray-200 dark:border-dark-600 focus:border-gray-300 dark:focus:border-dark-500 focus:ring-1 focus:ring-gray-200 dark:focus:ring-dark-600 outline-none transition-all"
        />
        {value && (
          <button
            type="button"
            onClick={() => onChange('')}
            aria-label={clearLabel}
            title={clearLabel}
            className="absolute end-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300 transition-colors"
          >
            <X size={16} aria-hidden />
          </button>
        )}
      </div>
    );
  }
);
