import { useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { createT, type Language } from '@/utils/i18n';

interface GroupInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Existing group names — the field stays free text, these are only shortcuts. */
  groups?: string[];
  language: Language;
  /** id/list wiring differs per modal so two of these can coexist on a page. */
  inputId?: string;
}

/**
 * The group field, shared by the add and edit modals.
 *
 * The suggestions are a hand-rolled dropdown rather than a `<datalist>`: Chrome
 * only opens a datalist on some interactions, gives no way to show it on focus,
 * and renders it in a popup-sized window as a scrollbar-less sliver. Since
 * picking an existing group instead of retyping it is the entire point — one
 * typo makes a second group that looks identical in the filter strip — the list
 * has to be reliably clickable.
 */
export function GroupInput({ value, onChange, groups = [], language, inputId = 'group' }: GroupInputProps) {
  const listId = `${inputId}-options`;
  const t = createT(language);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * Empties the field in one click.
   *
   * Focus goes back to the input rather than nowhere — the button unmounts as
   * soon as the value is empty, and losing focus to the body mid-form is
   * disorienting on the keyboard. `focus()` fires the focus handler, which opens
   * the suggestion list, so the close runs after it: someone clearing the group
   * is taking the account out of one, not shopping for another.
   */
  const clear = () => {
    onChange('');
    setHighlight(-1);
    inputRef.current?.focus();
    setOpen(false);
  };

  const suggestions = useMemo(() => {
    const typed = value.trim();
    const query = typed.toLowerCase();
    const matches = query
      ? groups.filter(name => name.toLowerCase().includes(query))
      : groups;
    // Only a character-for-character match is a dead row. Comparing case-folded
    // hid "Work" the moment someone typed "work" — precisely the keystroke that
    // was about to create a second group indistinguishable from the first in the
    // filter strip, which is the thing this list exists to prevent.
    return matches.filter(name => name !== typed).slice(0, 6);
  }, [groups, value]);

  const showList = open && suggestions.length > 0;

  const pick = (name: string) => {
    onChange(name);
    setOpen(false);
    setHighlight(-1);
    inputRef.current?.focus();
  };

  /**
   * On the way out, snap a case variant onto the group it plainly means.
   *
   * "work" and "Work" are two groups as far as storage is concerned, and in the
   * filter strip they are two chips with the same word on them and the accounts
   * split between them. The suggestion list offers the existing spelling, but
   * only to someone who looks at it; this catches the rest.
   */
  const handleBlur = () => {
    setOpen(false);
    setHighlight(-1);

    const typed = value.trim();
    if (!typed) return;
    const existing = groups.find(name => name.toLowerCase() === typed.toLowerCase());
    if (existing && existing !== typed) onChange(existing);
    else if (typed !== value) onChange(typed);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape' && open) {
      // Close the list without letting the modal itself close on the same key.
      e.stopPropagation();
      setOpen(false);
      setHighlight(-1);
      return;
    }
    if (!showList) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight(i => (i + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight(i => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (e.key === 'Enter' && highlight >= 0) {
      // Only swallowed when a row is actually highlighted, so Enter still
      // submits the form for anyone typing a brand-new group name.
      e.preventDefault();
      pick(suggestions[highlight]);
    }
  };

  return (
    <div>
      <label
        htmlFor={inputId}
        className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5"
      >
        {t('groups.field')}
        <span className="ms-1.5 font-normal text-xs text-gray-400 dark:text-gray-500">
          {t('groups.optional')}
        </span>
      </label>

      <div className="relative">
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
            setHighlight(-1);
          }}
          onFocus={() => setOpen(true)}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          placeholder={t('groups.placeholder')}
          autoComplete="off"
          role="combobox"
          aria-expanded={showList}
          aria-autocomplete="list"
          aria-controls={listId}
          aria-activedescendant={highlight >= 0 ? `${listId}-${highlight}` : undefined}
          // Matches the clamp the import path applies; display truncates either
          // way, and a name nobody can read is not worth the sync budget.
          maxLength={64}
          className={`w-full bg-white dark:bg-dark-900 text-gray-900 dark:text-gray-100 text-sm rounded-lg py-2 ps-3 ${
            value ? 'pe-9' : 'pe-3'
          } border border-gray-300 dark:border-dark-600 focus:border-[#4285F4] focus:ring-2 focus:ring-[#4285F4]/20 outline-none transition-all placeholder-gray-400 dark:placeholder-gray-500`}
        />

        {/* Only once there is something to clear. Taking an account out of a
            group is otherwise a held backspace, and the field is free text, so
            there is no "none" option in the list to pick instead. */}
        {value && (
          <button
            type="button"
            // Same reason as the list: without this the input blurs first, and
            // the blur handler would snap the value the user is in the middle of
            // clearing back onto an existing group.
            onMouseDown={(e) => e.preventDefault()}
            onClick={clear}
            aria-label={t('groups.clear')}
            title={t('groups.clear')}
            className="absolute end-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 transition-colors hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
          >
            <X size={14} />
          </button>
        )}

        {showList && (
          <ul
            id={listId}
            role="listbox"
            // Preventing the default on mousedown stops the input from losing
            // focus at all, so the list is still mounted when the click lands.
            // The flag this replaces was cleared by a mouseup on the list, which
            // never arrived if the pointer was released off it — leaving the list
            // stuck open over the form with nothing focused to close it.
            onMouseDown={(e) => e.preventDefault()}
            className="absolute z-10 inset-x-0 mt-1 max-h-40 overflow-y-auto bg-white dark:bg-dark-800 border border-gray-200 dark:border-dark-600 rounded-lg shadow-lg py-1"
          >
            {suggestions.map((name, i) => (
              <li key={name}>
                <button
                  type="button"
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === highlight}
                  onClick={() => pick(name)}
                  onMouseEnter={() => setHighlight(i)}
                  className={`w-full text-start text-sm px-3 py-1.5 truncate transition-colors ${
                    i === highlight
                      ? 'bg-gray-100 dark:bg-dark-700 text-gray-900 dark:text-gray-100'
                      : 'text-gray-700 dark:text-gray-300'
                  }`}
                >
                  {name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
        {t('groups.hint')}
      </p>
    </div>
  );
}
