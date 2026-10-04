// The daily check-in with the billing server.
//
// What goes out is the closed list in buildSyncRequest and nothing more: an
// install id minted on this machine, the extension version, the interface and
// browser language, whether this install predates the paywall, how many
// accounts it holds (a number — never which ones), three settings, how many
// times it was opened on each day since the last check-in (./opens), and the
// queued events from ./events. What comes back is a signed policy and, if
// this install holds one, a signed license.
//
// Runs after the popup has painted and when the browser starts — never on
// the way to showing a code. At most once a day unless something just
// happened that the server needs to answer (a purchase, a key).

import { countLocalAccounts } from '@/utils/storage';
import { isSyncEnabled } from '@/utils/sync-preference';
import { isVaultEnabled } from '@/utils/vault';
import { detectLanguage, SUPPORTED_LANGUAGES } from '@/utils/language';
import { getOpenMode } from '@/utils/open-mode';
import { BillingApiError, post } from './api';
import { ackEvents, peekEvents, type QueuedEvent } from './events';
import { ackOpens, peekOpens, type OpenDay } from './opens';
import { verifyToken } from './jws';
import {
  BILLING_KEYS,
  ensureInstall,
  licenseKeyHint,
  normalizeLicenseKey,
  readEntitlement,
  readEntitlementPayload,
  readPolicy,
  readPolicyPayload,
  readLocalLicenseKey,
  readSyncedLicenseKey,
  reassertSyncedFacts,
  storeTokens,
  writeSyncedLicenseKey,
} from './state';
import type { InstallRecord } from './types';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** After a failure, wait this long before the next unforced attempt. */
const RETRY_AFTER_FAILURE_MS = 15 * 60_000;
/** Even forced syncs are spaced, so a popup opened ten times does not call ten times. */
const MIN_FORCED_INTERVAL_MS = 20_000;
/** A pending purchase is looked for on every open for this long. */
export const PENDING_CHECKOUT_MS = DAY;

export const SYNC_LOCK = 'authenticator-billing-sync';

interface LastSync {
  at: number;
  ok: boolean;
  nextAfterMs: number;
  /** Last attempt to activate a license key that came in through Chrome sync. */
  syncedKeyTriedAt?: number;
}

export interface SyncRequest {
  iid: string;
  ver: string;
  ui_lang: string | null;
  browser_lang: string | null;
  installed_at: number | null;
  legacy: boolean;
  legacy_src: InstallRecord['legacySrc'];
  accounts: number | null;
  vault: boolean | null;
  sync: boolean | null;
  open_mode: string | null;
  pid: string | null;
  lid: string | null;
  /** Whether this install holds a license key at all — what a server from before key_hint reads. */
  has_key: boolean;
  /**
   * The last four characters of that key (normalised), or null. The paying
   * install is sent the key it bought whenever this differs from its hint — so
   * a second purchase still reaches it, not only the first.
   */
  key_hint: string | null;
  /** Opens per UTC day not yet delivered. A server from before them refuses the field: deploy it first. */
  opens: OpenDay[];
  events: QueuedEvent[];
}

interface SyncResponse {
  policy: string;
  entitlement: string | null;
  revoke: string | null;
  /** The key of a license this install bought, sent until key_hint says it arrived. */
  key?: string;
  ack: string[];
  next_sync_s: number;
}

/**
 * The shape a response must have before any of it is used. A 200 from
 * something that is not our API — an error page, a captive portal, a proxy —
 * is a failed sync, never "you hold no license".
 */
function isSyncResponse(value: unknown): value is SyncResponse {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.policy === 'string' &&
    (r.entitlement === null || typeof r.entitlement === 'string') &&
    (r.revoke === null || r.revoke === undefined || typeof r.revoke === 'string') &&
    (r.key === undefined || typeof r.key === 'string') &&
    Array.isArray(r.ack) &&
    (r.next_sync_s === undefined || typeof r.next_sync_s === 'number')
  );
}

/**
 * Runs `fn` holding `name` if nobody else holds it; otherwise returns
 * `whenBusy` at once. Two windows opening together sync once, not twice.
 */
export async function ifLockAvailable<T>(name: string, whenBusy: T, fn: () => Promise<T>): Promise<T> {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (!locks || typeof locks.request !== 'function') return fn();
  return locks.request(name, { ifAvailable: true }, async lock => (lock ? fn() : whenBusy)) as Promise<T>;
}

async function localGet<T>(key: string): Promise<T | undefined> {
  const found = await chrome.storage.local.get(key);
  return found[key] as T | undefined;
}

const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
  try {
    return await fn();
  } catch {
    return fallback;
  }
};

/**
 * The interface language in use: the one picked, or the browser's when none
 * was. The same rule as resolveLanguage in utils/i18n, written out here so the
 * service worker does not take the translations along with it.
 */
function shownLanguage(stored: unknown): string {
  return typeof stored === 'string' && SUPPORTED_LANGUAGES.has(stored) ? stored : detectLanguage();
}

function languageTag(value: unknown, max: number): string | null {
  return typeof value === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/.test(value) ? value.slice(0, max) : null;
}

/** The request body. Every field is listed here; nothing is added elsewhere. */
export async function buildSyncRequest(install: InstallRecord): Promise<SyncRequest> {
  const [accounts, vault, syncOn, openMode, stored, policy, entitlement, events, key, opens] = await Promise.all([
    // Locked vault: the count is unknown, and the server keeps the last one.
    // From local storage only: a full read would merge sync and start its download window (countLocalAccounts).
    safe(() => countLocalAccounts(), null as number | null),
    safe(() => isVaultEnabled(), null as boolean | null),
    safe(() => isSyncEnabled(), null as boolean | null),
    safe(() => getOpenMode(), null as string | null),
    safe(() => chrome.storage.local.get('language'), {} as Record<string, unknown>),
    safe(() => readPolicy(install.id), null),
    safe(() => readEntitlement(install.id), null),
    safe(() => peekEvents(50), [] as QueuedEvent[]),
    safe(() => readLocalLicenseKey(), null as string | null),
    safe(() => peekOpens(), [] as OpenDay[]),
  ]);
  return {
    iid: install.id,
    ver: chrome.runtime.getManifest().version,
    // The language on screen, not only one picked by hand: the server answers
    // with paywall text in it, and "never picked" still shows some language.
    ui_lang: languageTag(shownLanguage(stored.language), 12),
    browser_lang: languageTag(typeof navigator !== 'undefined' ? navigator.language : null, 35),
    installed_at: install.installedAt,
    legacy: install.legacy,
    legacy_src: install.legacySrc,
    accounts,
    vault,
    sync: syncOn,
    open_mode: openMode,
    pid: policy?.pid ?? null,
    lid: entitlement?.lid ?? null,
    has_key: key !== null,
    key_hint: licenseKeyHint(key),
    opens,
    events,
  };
}

export type SyncOutcome = 'synced' | 'fresh' | 'busy' | 'failed';

/**
 * Checks in if it is time to (or `force`), storing what the server signed.
 * Never throws: a failed sync leaves the last policy and license in place.
 */
/**
 * `urgent` skips even the spacing between forced syncs: for the one moment a
 * decision waits on the answer (an import from a pre-billing backup).
 */
export async function syncBilling(options: { force?: boolean; urgent?: boolean } = {}): Promise<SyncOutcome> {
  // An urgent sync waits its turn: the one already running may have been sent
  // before what the caller needs the server to know (a legacy mark, a purchase).
  if (options.urgent) return withLockWaiting(SYNC_LOCK, () => syncLocked(options));
  return ifLockAvailable<SyncOutcome>(SYNC_LOCK, 'busy', () => syncLocked(options));
}

async function withLockWaiting<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (!locks || typeof locks.request !== 'function') return fn();
  return locks.request(name, () => fn()) as Promise<T>;
}

async function syncLocked(options: { force?: boolean; urgent?: boolean }): Promise<SyncOutcome> {
  const now = Date.now();
  const last = await safe(() => localGet<LastSync>(BILLING_KEYS.lastSync), undefined);
  // A clock set backwards makes every stored time look like the future; treat that as due.
  if (last && last.at <= now && !options.urgent) {
    const since = now - last.at;
    if (options.force ? since < MIN_FORCED_INTERVAL_MS : since < (last.ok ? last.nextAfterMs : RETRY_AFTER_FAILURE_MS)) {
      return 'fresh';
    }
  }

  let install: InstallRecord;
  try {
    install = await ensureInstall();
  } catch {
    return 'failed';
  }

  const failed = async (): Promise<SyncOutcome> => {
    await safe(() => chrome.storage.local.set({ [BILLING_KEYS.lastSync]: { ...last, at: now, ok: false, nextAfterMs: DAY } }), undefined);
    // A last answer stamped in the future was written before the clock moved
    // back. Counted from now on, so the fourteen days without an answer
    // (gate.ts serverSilent) are fourteen days of the clock as it now reads.
    await safe(async () => {
      const heard = await localGet<number>(BILLING_KEYS.verifiedAt);
      if (typeof heard === 'number' && heard > now) await chrome.storage.local.set({ [BILLING_KEYS.verifiedAt]: now });
    }, undefined);
    return 'failed';
  };

  let response: unknown;
  let body: SyncRequest;
  try {
    body = await buildSyncRequest(install);
    response = await post<unknown>('/v1/sync', body);
  } catch (error) {
    if (!(error instanceof BillingApiError)) console.warn('billing: sync failed', error);
    return failed();
  }
  if (!isSyncResponse(response)) return failed();

  try {
    // An answer whose policy does not verify is not our server's either: keep
    // everything as it was rather than read its "no license" as the truth.
    if (!(await applySyncResponse(install, response))) return failed();
    await safe(() => ackOpens(body.opens), undefined);
    const nextAfterMs = Math.min(7 * DAY, Math.max(HOUR, (response.next_sync_s || 86_400) * 1000));
    await chrome.storage.local.set({ [BILLING_KEYS.lastSync]: { ...last, at: now, ok: true, nextAfterMs } satisfies LastSync });
    await maybeActivateSyncedKey(install);
    await reassertSyncedFacts();
  } catch (error) {
    console.warn('billing: could not store the sync answer', error);
    return failed();
  }
  return 'synced';
}

/**
 * Stores the server's answer. A token that does not verify is ignored rather
 * than stored; a response without a license means this install holds none,
 * which the server — when it answers — knows better than the local copy.
 */
export async function applySyncResponse(install: InstallRecord, response: SyncResponse): Promise<boolean> {
  const policy = await verifyToken(response.policy, install.id);
  const policyOk = !!policy && !!readPolicyPayload(policy.payload);
  // Only a response carrying a policy our server signed for this install is
  // believed about the license too — above all when it says there is none.
  if (!policyOk) return false;

  let entitlement: string | null | undefined;
  if (response.entitlement) {
    const verified = await verifyToken(response.entitlement, install.id);
    entitlement = verified && readEntitlementPayload(verified) ? response.entitlement : undefined;
  } else if (response.entitlement === null) {
    entitlement = null;
  }

  await storeTokens({ policy: response.policy, entitlement, verifiedAt: Date.now() });
  if (entitlement) {
    await chrome.storage.local.remove(BILLING_KEYS.pendingCheckout);
    // The key of what this install bought: kept, and offered to the person's
    // other profiles through Chrome sync like a key typed in. A key other than
    // the one held here is a newer purchase, and replaces it in both places.
    if (typeof response.key === 'string' && /^[0-9A-Za-z-]{10,64}$/.test(response.key)) {
      const held = await readLocalLicenseKey();
      const incoming = normalizeLicenseKey(response.key);
      if (held === null || incoming === null || incoming !== normalizeLicenseKey(held)) await writeSyncedLicenseKey(response.key);
    }
  }
  if (Array.isArray(response.ack) && response.ack.length) await ackEvents(response.ack);
  return true;
}

/**
 * A key bought on another Chrome profile of this person arrives through
 * sync; try it here once a day while this install holds no license.
 */
async function maybeActivateSyncedKey(install: InstallRecord): Promise<void> {
  if (await readEntitlement(install.id)) return;
  const key = await readSyncedLicenseKey();
  if (!key) return;
  const last = await localGet<LastSync>(BILLING_KEYS.lastSync);
  if (last?.syncedKeyTriedAt && Date.now() - last.syncedKeyTriedAt < DAY && last.syncedKeyTriedAt <= Date.now()) return;
  await chrome.storage.local.set({ [BILLING_KEYS.lastSync]: { ...last, syncedKeyTriedAt: Date.now() } });
  try {
    const { entitlement } = await post<{ entitlement: string }>('/v1/license/activate', { iid: install.id, key, method: 'sync' });
    const verified = await verifyToken(entitlement, install.id);
    if (verified && readEntitlementPayload(verified)) await storeTokens({ entitlement });
  } catch {
    // Seat limit or a lapsed license: the person can still enter a key by hand.
  }
}

/** What a page sends the service worker to check in on its behalf. */
export const SYNC_REQUEST_MESSAGE = 'authenticator:billing-sync';

export function isSyncRequestMessage(message: unknown): boolean {
  return !!message && typeof message === 'object' && (message as { type?: unknown }).type === SYNC_REQUEST_MESSAGE;
}

/**
 * Asks the service worker for a forced check-in, for a page that will not live
 * to finish one: the popup, which the browser closes the moment the Checkout
 * tab opens. Waits until the worker has the request, or a moment at most;
 * never throws. Without a worker to ask, the next open checks in instead.
 */
export async function syncFromWorker(): Promise<void> {
  try {
    await Promise.race([
      chrome.runtime.sendMessage({ type: SYNC_REQUEST_MESSAGE }),
      new Promise(resolve => setTimeout(resolve, 300)),
    ]);
  } catch {
    // No listener, or the worker is restarting: the events wait for the next sync.
  }
}

/**
 * Whether a purchase from this install is waiting to be confirmed by the
 * server — opened in the last `within` ms (a day by default) and not yet seen.
 */
export async function hasPendingCheckout(now = Date.now(), within = PENDING_CHECKOUT_MS): Promise<boolean> {
  const pending = await safe(() => localGet<{ at?: number }>(BILLING_KEYS.pendingCheckout), undefined);
  return !!pending && typeof pending.at === 'number' && now - pending.at < within && pending.at <= now;
}
