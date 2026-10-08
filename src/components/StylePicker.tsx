import { appearanceClass, UI_STYLES, type UiStyle } from '@/utils/appearance';

interface StylePickerProps {
  /** Names the group for screen readers; the row's visible label sits above it. */
  label: string;
  value: UiStyle;
  /** The previews are drawn in the theme on screen, so they show what a click gives. */
  dark: boolean;
  labels: Record<UiStyle, string>;
  onChange: (style: UiStyle) => void;
}

/**
 * The style switch: a tile per style, each a small drawing of a code row in
 * that style.
 *
 * A segmented control would say "Classic | Modern" and leave the difference to
 * be found by trying. Each preview carries its own theme class, so it is drawn
 * by the same variables as the real screen — it cannot drift from what
 * choosing it does.
 */
export function StylePicker({ label, value, dark, labels, onChange }: StylePickerProps) {
  return (
    <div role="group" aria-label={label} className="mt-2 grid grid-cols-2 gap-2">
      {UI_STYLES.map(style => {
        const selected = style === value;
        return (
          <button
            key={style}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(style)}
            className={`rounded-lg p-1 text-start transition-colors ${
              selected
                ? 'ring-2 ring-accent-600 dark:ring-accent-400'
                : 'ring-1 ring-gray-200 hover:ring-gray-300 dark:ring-dark-600 dark:hover:ring-dark-500'
            }`}
          >
            <StylePreview style={style} dark={dark} />
            <span
              className={`mt-1 block px-1 pb-0.5 text-xs ${
                selected ? 'font-semibold text-gray-900 dark:text-gray-100' : 'font-medium text-gray-600 dark:text-gray-300'
              }`}
            >
              {labels[style]}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** A code row as the list draws it: name, code, ring — in the style given. */
function StylePreview({ style, dark }: { style: UiStyle; dark: boolean }) {
  const grouped = style === 'apple';
  return (
    <div
      aria-hidden
      className={`${appearanceClass({ style, dark })} overflow-hidden rounded-md ${
        grouped ? 'bg-gray-50 p-1.5 dark:bg-dark-900' : 'border border-gray-200 bg-white dark:border-dark-600 dark:bg-dark-800'
      }`}
    >
      <div className={`flex items-center justify-between bg-white px-2 py-1.5 dark:bg-dark-800 ${grouped ? 'rounded-lg' : ''}`}>
        <div className="min-w-0">
          <div className="h-1.5 w-12 rounded-full bg-gray-300 dark:bg-dark-500" />
          <div
            dir="ltr"
            className={`mt-1 text-sm leading-none text-accent-600 dark:text-accent-400 ${
              grouped ? 'font-sans font-semibold tabular-nums' : 'font-mono'
            }`}
          >
            123 456
          </div>
        </div>
        <span className="h-4 w-4 flex-shrink-0 rounded-full border-2 border-gray-200 border-t-gray-700 dark:border-dark-600 dark:border-t-gray-300" />
      </div>
    </div>
  );
}
