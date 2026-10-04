import type { ReactNode } from 'react';
import { SettingRow } from '@/components/SettingsSection';

interface SettingToggleProps {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: () => void;
  /** Shown under the hint — a warning that belongs to this switch. */
  children?: ReactNode;
}

/**
 * A labelled switch for the settings panel.
 *
 * Flex rather than an absolutely positioned knob: a button inherits
 * text-align:center, which shifts an absolute child's static position to the
 * middle of the track and pushes the knob out the side.
 */
export function SettingToggle({ label, hint, checked, onChange, children }: SettingToggleProps) {
  return (
    <SettingRow
      label={label}
      hint={hint}
      inline
      control={
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-label={label}
          onClick={onChange}
          className={`inline-flex items-center w-9 h-5 px-0.5 rounded-full flex-shrink-0 transition-colors ${
            checked ? 'bg-[#1a73e8]' : 'bg-gray-300 dark:bg-dark-500'
          }`}
        >
          {/* rtl:-translate-x-4 is not decoration: a CSS transform does not mirror
              under dir=rtl. In Arabic the flex row starts the knob at the right
              edge already, so the positive shift pushed it a full 16px — the whole
              travel of a 36px track — clean out of the track. */}
          <span
            className={`block w-4 h-4 bg-white rounded-full shadow-sm transition-transform ${
              checked ? 'translate-x-4 rtl:-translate-x-4' : 'translate-x-0'
            }`}
          />
        </button>
      }
    >
      {children}
    </SettingRow>
  );
}
