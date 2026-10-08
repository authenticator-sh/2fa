// The way from install to a first account and a first code, reported step by
// step, so the admin can tell where new installs stop (server: /admin/activation).
//
// Three things here and nothing else:
//
// - Events from the closed list in events.ts: the extension opened for the
//   first time, the "add your first account" screen shown, the way picked on
//   it, each screen of an add flow, each failure and each back-out, an
//   account added, the first code used. Their props are kinds and counts —
//   which way, which screen, which error, how many — never a name, an issuer,
//   a secret or a site.
//
// - Sent at once while the install is new. The daily check-in has already
//   happened at install, and most of those who remove the extension do it in
//   its first ten minutes: their events would never leave. The service worker
//   sends them (syncFromWorker), so a popup closing does not stop it; at most
//   one such check-in every few minutes, under the server's twelve an hour.
//
// - The stage: the last step, written into the uninstall address (&s=), which
//   Chrome opens after the extension is gone. For somebody who leaves between
//   two check-ins it is the one record of how far they got.

import { withLock } from '@/utils/write-lock';
import { track, type EventName, type EventProps } from './events';
import { BILLING_KEYS, readInstall } from './state';
import { syncBilling, syncFromWorker } from './sync';

/** The ways on the empty screen (components/EmptyStateGuide.tsx). */
export type OnboardOption = 'ga' | 'new' | 'other' | 'manual' | 'key';

/**
 * Where an add happens: the empty screen's steps, the scan page's camera, the
 * add dialog's QR and key tabs, the file picker, pasted links — the last two
 * from the popup or from Settings.
 */
export type AddFlow = 'guide' | 'camera' | 'qr' | 'manual' | 'import' | 'paste' | 'settings_import' | 'settings_paste';

/** What the "via" of a saved account is: how addWithLimit was entered. */
export type AddVia = 'form' | 'qr' | 'migration' | 'file' | 'uri' | 'scan' | 'settings' | 'backup';

// www, not the apex: the uninstall address is opened after we are gone, and
// the apex only redirects.
export const UNINSTALL_FEEDBACK_URL = 'https://www.authenticator.sh/uninstall';

const KEY = BILLING_KEYS.onboarding;
const LOCK = 'authenticator-billing-onboarding';
/** How long an install counts as new: its events go out at once. */
const NEW_FOR_MS = 3 * 24 * 3_600_000;
/** Between two check-ins sent for these events. The server takes twelve an hour from an install. */
const FLUSH_GAP_MS = 5 * 60_000;
/**
 * For the moments that matter most — first open, first account, first code — a
 * short wait only: someone who opens the extension and adds an account half a
 * minute later is the activation this exists to count.
 */
const KEY_MOMENT_GAP_MS = 15_000;

interface State {
  firstOpen?: boolean;
  firstCode?: boolean;
  added?: boolean;
  stage?: string;
  flushedAt?: number;
}

async function read(): Promise<State> {
  try {
    const found = (await chrome.storage.local.get(KEY))[KEY];
    return found && typeof found === 'object' && !Array.isArray(found) ? (found as State) : {};
  } catch {
    return {};
  }
}

/**
 * Changes the state under a lock — a pick and the screen it opens are reported
 * a moment apart, and each reads before it writes. `change` returns the patch,
 * or null to leave things as they are; the answer is whether it wrote.
 */
async function update(change: (state: State) => Partial<State> | null): Promise<boolean> {
  try {
    return await withLock(LOCK, async () => {
      const state = await read();
      const patch = change(state);
      if (!patch) return false;
      await chrome.storage.local.set({ [KEY]: { ...state, ...patch } });
      return true;
    });
  } catch {
    return false;
  }
}

/** A kind, cut to what the stage and the props allow: lower case, digits, underscores. */
export function slug(value: string): string {
  return (
    value
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 24) || 'unknown'
  );
}

/** The uninstall address for an install, with the stage when there is one. */
export function uninstallUrl(installId: string | null, stage?: string | null): string {
  if (!installId) return UNINSTALL_FEEDBACK_URL;
  const s = stage ? `&s=${encodeURIComponent(stage)}` : '';
  return `${UNINSTALL_FEEDBACK_URL}?i=${encodeURIComponent(installId)}${s}`;
}

/** Points Chrome's uninstall address at this install and its last stage. Never throws. */
export async function applyUninstallUrl(installId?: string | null): Promise<void> {
  try {
    const id = installId ?? (await readInstall())?.id ?? null;
    await chrome.runtime.setUninstallURL(uninstallUrl(id, (await read()).stage));
  } catch {}
}

/**
 * Whether `next` may take the place of `current`. Until there is an account,
 * the latest step is the story; after one, only the first code moves it on —
 * a failed second add says nothing about whether the extension got going.
 */
export function stageMayMove(current: string | undefined, next: string): boolean {
  if (current === 'used') return false;
  if (current?.startsWith('added')) return next === 'used';
  return true;
}

/**
 * Whether this install is followed from its start: its stage was seeded at
 * install (markInstalled, 1.15.0 on, new installs only). An update of an older
 * install has none, and its first open after the update is not a first open —
 * nor its next copy a first code, nor its stage worth an uninstall address.
 */
const followed = (state: State) => state.stage !== undefined;

async function setStage(stage: string, seed = false): Promise<void> {
  const moved = await update(state =>
    (seed ? state.stage === undefined : followed(state)) && state.stage !== stage && stageMayMove(state.stage, stage) ? { stage } : null
  );
  if (moved) await applyUninstallUrl();
}

/** Sends what is queued now, if the install is new and the last such send is far enough back. */
async function flush(keyMoment = false): Promise<void> {
  const install = await readInstall();
  if (!install || install.legacy) return;
  const now = Date.now();
  if (now - (install.installedAt ?? install.createdAt) > NEW_FOR_MS) return;
  const gap = keyMoment ? KEY_MOMENT_GAP_MS : FLUSH_GAP_MS;
  // Any check-in counts, not only ours: the install's own, the paywall's. The
  // server takes twelve an hour from an install, and a 429 holds the next
  // ordinary check-in back a quarter of an hour.
  const lastSync = await chrome.storage.local
    .get(BILLING_KEYS.lastSync)
    .then(found => (found[BILLING_KEYS.lastSync] as { at?: unknown } | undefined)?.at)
    .catch(() => undefined);
  if (typeof lastSync === 'number' && lastSync <= now && now - lastSync < gap) return;
  const due = await update(({ flushedAt = 0 }) => (now - flushedAt < gap && flushedAt <= now ? null : { flushedAt: now }));
  if (!due) return;
  // From a page, the worker sends it, so the page closing does not stop it; in
  // the worker itself (quick fill) there is nobody to ask but itself.
  const inWorker = typeof window === 'undefined' && typeof (globalThis as { importScripts?: unknown }).importScripts === 'function';
  if (inWorker) await syncBilling({ force: true, urgent: true });
  else await syncFromWorker();
}

async function report(
  name: EventName,
  props: EventProps | undefined | (() => Promise<EventProps>),
  stage: string | null,
  keyMoment = false
): Promise<void> {
  try {
    await track(name, typeof props === 'function' ? await props() : props);
    if (stage) await setStage(stage);
    await flush(keyMoment);
  } catch {
    // Reporting must not break the thing reported.
  }
}

async function secondsSinceInstall(): Promise<number | null> {
  try {
    const install = await readInstall();
    if (!install || install.legacy) return null;
    return Math.max(0, Math.round((Date.now() - (install.installedAt ?? install.createdAt)) / 1000));
  } catch {
    return null;
  }
}

/**
 * A fresh install: the stage the uninstall address starts from, so a removal
 * before the extension was ever opened says so. No event — the server has the
 * install from its first check-in.
 */
export function markInstalled(): Promise<void> {
  return setStage('installed', true);
}

/** The popup, window or side panel opened. Reported the first time only. */
export async function reportFirstOpen(): Promise<void> {
  if (!(await update(state => (state.firstOpen || !followed(state) ? null : { firstOpen: true })))) return;
  await report('first_open', async () => ({ secs: await secondsSinceInstall() }), 'opened', true);
}

/** The "add your first account" screen shown. */
export function reportOnboardView(): Promise<void> {
  return report('onboard_view', undefined, 'onboard');
}

/** A way picked on it. */
export function reportOnboardPick(option: OnboardOption): Promise<void> {
  return report('onboard_pick', { option }, `pick:${option}`);
}

/** A screen of an add flow shown, or a step of it taken. */
export function reportAddStep(flow: AddFlow, step: string): Promise<void> {
  const s = slug(step);
  return report('add_step', { flow, step: s }, `step:${flow}:${s}`);
}

/** An add that did not work: what the person was told, as a kind. */
export function reportAddFail(flow: AddFlow, reason: string): Promise<void> {
  const r = slug(reason);
  return report('add_fail', { flow, reason: r }, `fail:${flow}:${r}`);
}

/** The reason in a message key the person was shown: 'addAccount.errorNoQr' → 'error_no_qr'. */
export function reasonOfKey(key: string): string {
  return slug(key.slice(key.lastIndexOf('.') + 1));
}

/** An add flow left without adding: closed, gone back, a picker cancelled. */
export function reportAddCancel(flow: AddFlow, step: string): Promise<void> {
  const s = slug(step);
  return report('add_cancel', { flow, step: s }, `cancel:${flow}:${s}`);
}

/** How many accounts an add's result says it wrote. */
export function addedBy(result: unknown): number {
  if (result === true) return 1;
  if (result && typeof result === 'object') {
    const added = (result as { added?: unknown }).added;
    if (typeof added === 'number' && Number.isFinite(added)) return Math.max(0, added);
  }
  return 0;
}

/** Accounts saved, from any way in (billing/add.ts). */
export async function reportAccountAdded(via: AddVia, n: number): Promise<void> {
  if (n <= 0) return;
  const first = await update(state => (state.added || !followed(state) ? null : { added: true }));
  await report('account_added', async () => ({ via, n, first, secs: first ? await secondsSinceInstall() : null }), `added:${via}`, first);
}

/** A code copied or filled in. Reported the first time only. */
export async function reportCodeUsed(via: 'copy' | 'fill'): Promise<void> {
  if (!(await update(state => (state.firstCode || !followed(state) ? null : { firstCode: true })))) return;
  await report('first_code', async () => ({ via, secs: await secondsSinceInstall() }), 'used', true);
}
