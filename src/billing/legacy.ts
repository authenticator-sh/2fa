// Recognising a person who predates the paywall when the install itself
// cannot tell — they moved to a new computer and brought their accounts in a
// backup file rather than through Chrome sync (MONETIZATION.md §3.1).

import { BILLING_FIRST_VERSION, BILLING_RELEASE_DATE } from './config';
import { compareVersions, markLegacy, readInstall } from './state';
import { syncBilling } from './sync';

/**
 * Whether a parsed backup file of ours was written before billing existed,
 * or by an install that did. Anything else — another app's file, a bare list —
 * says nothing either way.
 *
 * From 1.14.0 on every export names the version that wrote it, so a file of
 * ours without one comes from before the paywall whatever its date: a person
 * whose Chrome took a week to update exported from 1.13 after release day.
 * The date is the fallback for a version that cannot be read.
 */
export function backupPredatesBilling(doc: unknown): boolean {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false;
  const d = doc as Record<string, unknown>;
  if (d.legacy === true) return true;
  const ours =
    d.format === 'authenticator-encrypted-backup' ||
    (typeof d.version === 'string' && typeof d.exportDate === 'string' && Array.isArray(d.accounts));
  if (!ours) return false;
  if (!('appVersion' in d)) return true;
  if (typeof d.appVersion === 'string' && /^\d+(\.\d+){0,3}$/.test(d.appVersion)) {
    return compareVersions(d.appVersion, BILLING_FIRST_VERSION) < 0;
  }
  if (typeof d.exportDate !== 'string') return false;
  const at = Date.parse(d.exportDate);
  return Number.isFinite(at) && at < BILLING_RELEASE_DATE;
}

/**
 * Marks this install legacy and asks the server again before the import is
 * written, so the answer the server gives legacy installs is the one the
 * import meets. Offline, the import meets the last policy instead; the
 * install is legacy from the next sync on.
 */
export async function adoptLegacyFromBackup(): Promise<void> {
  const install = await readInstall();
  if (install?.legacy) return;
  await markLegacy('backup-file');
  await syncBilling({ force: true, urgent: true });
}

/**
 * Written into our own exports, so a file made on a legacy install carries
 * the fact to the computer it is restored on.
 */
export async function installPredatesBilling(): Promise<boolean> {
  try {
    return (await readInstall())?.legacy === true;
  } catch {
    return false;
  }
}
