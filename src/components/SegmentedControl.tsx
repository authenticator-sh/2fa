interface SegmentedControlProps<T extends string> {
  /** Names the group for screen readers; the visible label sits beside it. */
  label: string;
  options: readonly (readonly [value: T, label: string])[];
  value: T;
  onChange: (value: T) => void;
}

/**
 * The small grey switch Settings uses for view mode, popup size, where the app
 * opens and the list order.
 *
 * Four hand-copied rows of buttons, none of which said which one was on — a
 * screen reader read out "Normal, button. Compact, button." and left the
 * choice to be guessed from a shade of grey. Each segment now reports
 * aria-pressed, and the row is a named group.
 */
export function SegmentedControl<T extends string>({ label, options, value, onChange }: SegmentedControlProps<T>) {
  return (
    // Wraps as a last resort: three Ukrainian segments are 14px wider than a
    // row of the 320px popup, and a second line beats a control cut off at the
    // edge of its card.
    <div role="group" aria-label={label} className="flex max-w-full flex-wrap bg-gray-200 dark:bg-dark-600 rounded-lg p-0.5">
      {options.map(([option, optionLabel]) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          onClick={() => onChange(option)}
          className={`text-xs font-medium px-2.5 py-1 rounded-md transition-colors ${
            value === option
              ? 'bg-white dark:bg-dark-800 text-gray-900 dark:text-gray-100 shadow-sm'
              : 'text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100'
          }`}
        >
          {optionLabel}
        </button>
      ))}
    </div>
  );
}
