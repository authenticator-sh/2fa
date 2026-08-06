// Popup window size.
//
// A Chrome popup has no window of its own to resize: it is sized to its
// document, and the browser caps it at 800x600. So the setting is applied as
// plain width/height on the root element, and the presets stay inside that cap.

import type { CSSProperties } from 'react';

export type PopupSize = 'small' | 'medium' | 'large';

export const POPUP_SIZES: Record<PopupSize, { width: number; minHeight: number; maxHeight: number }> = {
  small: { width: 320, minHeight: 400, maxHeight: 480 },
  medium: { width: 400, minHeight: 500, maxHeight: 600 },
  large: { width: 500, minHeight: 560, maxHeight: 600 },
};

export const DEFAULT_POPUP_SIZE: PopupSize = 'medium';

const KEY = 'popupSize';

function isPopupSize(value: unknown): value is PopupSize {
  return typeof value === 'string' && value in POPUP_SIZES;
}

/**
 * The size to paint with before chrome.storage answers.
 *
 * chrome.storage is async and the popup is already on screen by the time it
 * resolves, so reading only from there makes the window visibly jump from the
 * default to the chosen size on every single open. localStorage is synchronous
 * on an extension page, so the choice is mirrored there purely to get the first
 * paint right; chrome.storage stays the source of truth.
 */
export function cachedPopupSize(): PopupSize {
  try {
    const cached = localStorage.getItem(KEY);
    return isPopupSize(cached) ? cached : DEFAULT_POPUP_SIZE;
  } catch {
    // localStorage can throw when the profile blocks site data.
    return DEFAULT_POPUP_SIZE;
  }
}

/** Keep the synchronous mirror in step with a value read from chrome.storage. */
export function rememberPopupSize(size: PopupSize): void {
  try {
    localStorage.setItem(KEY, size);
  } catch {
    // Losing the mirror only costs a resize flash on the next open.
  }
}

export function readPopupSize(value: unknown): PopupSize | null {
  return isPopupSize(value) ? value : null;
}

export function popupSizeStyle(size: PopupSize): CSSProperties {
  const { width, minHeight, maxHeight } = POPUP_SIZES[size];
  return { width, minHeight, maxHeight };
}
