// Why a camera request was refused, from what the browser tells us.
//
// `NotAllowedError` covers three different situations that need three
// different instructions, and the first version of the scanner told all of
// them to "allow the camera in site settings":
//
// - blocked    the site's camera setting is Block (or was, by an earlier No).
//              Nothing happens on a retry; the setting has to be changed.
// - dismissed  the browser's question was closed without an answer. The
//              setting is still "ask", so a retry asks again.
// - system     the browser may use the camera but the operating system does
//              not let the browser: macOS Privacy, Windows Camera access.

export type DenialKind = 'blocked' | 'dismissed' | 'system';

/**
 * @param name        the DOMException name
 * @param message     its message (Chrome: "Permission denied", "Permission
 *                    dismissed", "Permission denied by system")
 * @param permission  `navigator.permissions.query({ name: 'camera' }).state`,
 *                    or null where it cannot be read
 */
export function classifyDenial(name: string, message: string, permission: string | null): DenialKind {
  if (name === 'SecurityError') return 'blocked';
  const text = message.toLowerCase();
  if (text.includes('system')) return 'system';
  if (text.includes('dismiss')) return 'dismissed';
  if (permission === 'prompt') return 'dismissed';
  // Allowed for the site, refused all the same: it is not the site's setting.
  if (permission === 'granted') return 'system';
  return 'blocked';
}

/** The camera permission's state, or null in a browser that does not say. */
export async function cameraPermissionState(): Promise<string | null> {
  try {
    const status = await navigator.permissions.query({ name: 'camera' as PermissionName });
    return status.state;
  } catch {
    return null;
  }
}
