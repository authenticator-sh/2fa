interface SettingToggleProps {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: () => void;
}

/**
 * A labelled switch for the settings panel.
 *
 * Flex rather than an absolutely positioned knob: a button inherits
 * text-align:center, which shifts an absolute child's static position to the
 * middle of the track and pushes the knob out the side.
 */
export function SettingToggle({ label, hint, checked, onChange }: SettingToggleProps) {
  return (
    <div className="mt-4 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <span className="text-sm text-gray-700 dark:text-gray-300">{label}</span>
        {hint && <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">{hint}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={onChange}
        className={`inline-flex items-center w-9 h-5 px-0.5 rounded-full flex-shrink-0 mt-0.5 transition-colors ${
          checked ? 'bg-[#4285F4]' : 'bg-gray-300 dark:bg-dark-500'
        }`}
      >
        <span
          className={`block w-4 h-4 bg-white rounded-full shadow-sm transition-transform ${
            checked ? 'translate-x-4' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  );
}
