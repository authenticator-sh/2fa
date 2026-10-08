// How the app looks: one of two styles, each in light or dark.
//
// The two are independent settings. The sun/moon in the header switches light
// and dark within whichever style is on, and the style picker in Settings
// switches the style without touching light or dark — so every combination is
// one click from any other.
//
// A style is a class on the root element (theme-classic, theme-apple) that
// redefines the colour, radius and font variables in globals.css; `dark` sits
// beside it as before.

export type UiStyle = 'classic' | 'apple';

export const UI_STYLES: readonly UiStyle[] = ['classic', 'apple'];

export const DEFAULT_UI_STYLE: UiStyle = 'classic';

/** The chrome.storage.local key, and the name of its synchronous mirror. */
export const UI_STYLE_KEY = 'uiStyle';
/** Where darkMode is mirrored for the first paint; chrome.storage keeps `darkMode`. */
const DARK_MIRROR_KEY = 'darkModeMirror';

export function readUiStyle(value: unknown): UiStyle {
  return UI_STYLES.includes(value as UiStyle) ? (value as UiStyle) : DEFAULT_UI_STYLE;
}

export interface Appearance {
  style: UiStyle;
  dark: boolean;
}

/**
 * The appearance to paint with before chrome.storage answers — the same trick
 * as cachedPopupSize: storage is async, so reading only from there paints the
 * classic light screen first and then visibly repaints it on every open.
 * chrome.storage stays the source of truth.
 */
export function cachedAppearance(): Appearance {
  try {
    return {
      style: readUiStyle(localStorage.getItem(UI_STYLE_KEY)),
      dark: localStorage.getItem(DARK_MIRROR_KEY) === '1',
    };
  } catch {
    // localStorage can throw when the profile blocks site data.
    return { style: DEFAULT_UI_STYLE, dark: false };
  }
}

/** Keep the synchronous mirror in step with what chrome.storage holds. */
export function rememberAppearance(patch: Partial<Appearance>): void {
  try {
    if (patch.style !== undefined) localStorage.setItem(UI_STYLE_KEY, patch.style);
    if (patch.dark !== undefined) localStorage.setItem(DARK_MIRROR_KEY, patch.dark ? '1' : '0');
  } catch {
    // Losing the mirror only costs a repaint on the next open.
  }
}

/** The classes the root element carries for this appearance. */
export function appearanceClass({ style, dark }: Appearance): string {
  return `theme-${style}${dark ? ' dark' : ''}`;
}
