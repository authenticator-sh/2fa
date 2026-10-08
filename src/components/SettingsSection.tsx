import { useId, type ReactNode } from 'react';

/**
 * The parts the Settings screen is built from.
 *
 * It used to be one column that every release appended to: three kinds of
 * heading, two with a rule above them and one with neither, hints that sat
 * beside a switch in one row and under the whole row in the next, and a
 * different blue on every button. Nothing on it was wrong, and none of it read
 * as one screen.
 *
 * So there is one of each now. A section is a small title over a card; a card
 * is rows divided by a hairline; a row is a label, the control for it at the
 * far end, and whatever needs saying underneath. Anything nested inside a row
 * sits in a well. Buttons come from the four below and nowhere else.
 */

interface SettingsSectionProps {
  title: string;
  /**
   * The card's first row already says what the title would. The title is kept
   * for screen readers, which still need a name for the section.
   */
  hideTitle?: boolean;
  children: ReactNode;
}

export function SettingsSection({ title, hideTitle, children }: SettingsSectionProps) {
  const titleId = useId();

  return (
    <section aria-labelledby={titleId}>
      {/* No uppercase and no letter-spacing, which is what a caption like this
          usually gets: half the languages here have no capitals, and spacing
          the letters pulls joined Arabic script apart. */}
      <h2
        id={titleId}
        className={hideTitle ? 'sr-only' : 'mb-1.5 px-1 text-xs font-semibold text-gray-500 dark:text-gray-400'}
      >
        {title}
      </h2>
      <div data-ui="settings-card" className="divide-y divide-gray-200 rounded-lg border border-gray-200 bg-white dark:divide-dark-600 dark:border-dark-600 dark:bg-dark-700">
        {children}
      </div>
    </section>
  );
}

interface SettingRowProps {
  label: string;
  /** Set when the control is a form field, so the label is a real <label>. */
  htmlFor?: string;
  hint?: ReactNode;
  /** A hint that reports a state rather than explaining the setting. */
  tone?: 'ok' | 'warn';
  control?: ReactNode;
  /**
   * The control is small and fixed — a switch — so it always stays beside the
   * label and a long label wraps its text instead.
   */
  inline?: boolean;
  /** Anything that belongs to the row and is more than a line of text. */
  children?: ReactNode;
}

const HINT_TONE = {
  neutral: 'text-gray-500 dark:text-gray-400',
  ok: 'text-green-700 dark:text-green-400',
  warn: 'text-yellow-700 dark:text-yellow-500',
};

export function SettingRow({ label, htmlFor, hint, tone, control, inline, children }: SettingRowProps) {
  const labelClass = `text-sm text-gray-900 dark:text-gray-100 ${inline ? 'min-w-0 flex-1' : 'grow'}`;

  return (
    <div className="px-3 py-2.5">
      {/* Wraps rather than squeezes: at the 320px popup a three-way switch with
          translated segments is wider than what is left beside its label, and
          it drops to a line of its own instead of crushing the label into a
          column one word wide. */}
      <div className={`flex items-center justify-between gap-x-3 gap-y-1.5 ${inline ? '' : 'flex-wrap'}`}>
        {htmlFor ? (
          <label htmlFor={htmlFor} className={labelClass}>
            {label}
          </label>
        ) : (
          <span className={labelClass}>{label}</span>
        )}
        {control}
      </div>
      {hint && <p className={`mt-1 text-[11px] leading-relaxed ${HINT_TONE[tone ?? 'neutral']}`}>{hint}</p>}
      {children}
    </div>
  );
}

const BUTTON = 'inline-flex flex-shrink-0 items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-50';
const TEXT_BUTTON = 'flex-shrink-0 text-xs font-medium hover:underline disabled:opacity-50';

/** Every button on the Settings screen is one of these. */
export const settingsButton = {
  /** The one thing the row is asking for. At most one per section. */
  primary: `${BUTTON} bg-accent-600 text-white hover:bg-accent-700`,
  secondary: `${BUTTON} border border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-dark-500 dark:text-gray-200 dark:hover:bg-dark-600`,
  link: `${TEXT_BUTTON} text-accent-600 dark:text-accent-300`,
  danger: `${TEXT_BUTTON} text-red-600 dark:text-red-400`,
};

/** Something nested inside a row: a list, a form that opened. */
export const settingsWell = 'mt-2 rounded-md bg-gray-100 dark:bg-dark-800';

/** A text field inside a well. */
export const settingsInput =
  'w-full rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-xs text-gray-900 focus:outline-none focus:ring-1 focus:ring-accent-500 dark:border-dark-500 dark:bg-dark-700 dark:text-gray-100';
