// Settings changed by another open copy of the app.
//
// The popup, the floating window and the side panel are three live documents
// over one store, and each read its settings once, on mount. A side panel stays
// open for hours: switching to dark mode, another language or the compact view
// in the popup left it on the old ones, and a switch in its Settings screen
// showed a state the store no longer had — pressing it then "turned on"
// something that was already on, and the next open disagreed with both.

import type { ViewMode } from '@/components/AccountCard';
import { resolveLanguage, type Language } from './i18n';
import { readPopupSize, type PopupSize } from './popup-size';
import { OPEN_MODE_KEY, readOpenMode, type OpenMode } from './open-mode';
import { QUICK_FILL_ENABLED_KEY } from './quick-fill';
import { readSortOrder, SORT_ORDER_KEY, type SortOrder } from './list-view';

export interface SettingsPatch {
  language?: Language;
  darkMode?: boolean;
  viewMode?: ViewMode;
  showAvatars?: boolean;
  popupSize?: PopupSize;
  openMode?: OpenMode;
  syncEnabled?: boolean;
  syncOverflow?: boolean;
  quickFill?: boolean;
  suggestions?: boolean;
  sortOrder?: SortOrder;
}

type StorageChanges = Record<string, { oldValue?: unknown; newValue?: unknown }>;

const VIEW_MODES: readonly ViewMode[] = ['normal', 'compact', 'hidden'];

/**
 * The settings a storage change event carries, each read with the same default
 * the page applies on mount — so a key being removed means "back to the
 * default", not "leave it as it was".
 *
 * Only the local area: every one of these keys lives there, and the sync area
 * has keys of its own whose names must not be read as settings.
 */
export function settingsFromChanges(changes: StorageChanges, areaName: string): SettingsPatch {
  if (areaName !== 'local') return {};
  const patch: SettingsPatch = {};
  const has = (key: string) => Object.prototype.hasOwnProperty.call(changes, key);
  const value = (key: string) => changes[key]?.newValue;

  if (has('language')) patch.language = resolveLanguage(value('language'));
  if (has('darkMode')) patch.darkMode = value('darkMode') === true;
  if (has('showAvatars')) patch.showAvatars = value('showAvatars') === true;
  if (has('viewMode')) {
    const mode = value('viewMode');
    patch.viewMode = VIEW_MODES.includes(mode as ViewMode) ? (mode as ViewMode) : 'normal';
  }
  if (has('popupSize')) {
    const size = readPopupSize(value('popupSize'));
    if (size) patch.popupSize = size;
  }
  if (has(OPEN_MODE_KEY)) patch.openMode = readOpenMode(value(OPEN_MODE_KEY)) ?? 'popup';
  // These three default to on: only an explicit false turns them off.
  if (has('syncEnabled')) patch.syncEnabled = value('syncEnabled') !== false;
  if (has(QUICK_FILL_ENABLED_KEY)) patch.quickFill = value(QUICK_FILL_ENABLED_KEY) !== false;
  if (has('suggestionsEnabled')) patch.suggestions = value('suggestionsEnabled') !== false;
  if (has('syncOverflow')) patch.syncOverflow = value('syncOverflow') === true;
  if (has(SORT_ORDER_KEY)) patch.sortOrder = readSortOrder(value(SORT_ORDER_KEY));

  return patch;
}
