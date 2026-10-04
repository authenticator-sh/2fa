// What this install knows about billing, and nothing about accounts.
//
// Everything here lives in chrome.storage.local under `billing*` keys, except
// two small facts that follow the person to their other Chrome profiles through
// sync when sync is on: that this person installed before the paywall existed,
// and the license key they bought.

import { isSyncEnabled } from '@/utils/sync-preference';
import { withLock } from '@/utils/write-lock';
import { BILLING_FIRST_VERSION, BILLING_RELEASE_DATE } from './config';
import { serverSilent, UNGATED, type GateSnapshot } from './gate';
import { verifyToken } from './jws';
import type { DisplayPrice, Entitlement, InstallRecord, LegacySource, Policy } from './types';

export const BILLING_KEYS = {
  install: 'billingInstall',
  policy: 'billingPolicy',
  entitlement: 'billingEntitlement',
  events: 'billingEvents',
  /** Opens of the extension per UTC day, until the server has them (opens.ts). */
  opens: 'billingOpens',
  lastSync: 'billingLastSync',
  pendingCheckout: 'billingPendingCheckout',
  paywallSeenAt: 'billingPaywallSeenAt',
  /** The key this install holds (typed in, or handed over after a purchase here), kept to put back in sync. */
  licenseKey: 'billingKey',
  /** When the server last answered with a policy that verified (ms, this machine's clock). */
  verifiedAt: 'billingVerifiedAt',
} as const;

export const BILLING_SYNC_KEYS = {
  legacy: 'billingLegacy',
  licenseKey: 'billingLicenseKey',
} as const;

const INSTALL_LOCK = 'authenticator-billing-install';

async function localGet<T>(key: string): Promise<T | undefined> {
  try {
    const result = await chrome.storage.local.get(key);
    return result[key] as T | undefined;
  } catch {
    return undefined;
  }
}

/** Dotted versions compared numerically; missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(n => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

const LEGACY_SOURCES: readonly LegacySource[] = ['update', 'existing-data', 'sync-marker', 'backup-file', 'sync-accounts'];

function readInstallRecord(value: unknown): InstallRecord | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || !/^[0-9a-f-]{36}$/.test(v.id)) return null;
  const legacySrc = LEGACY_SOURCES.includes(v.legacySrc as LegacySource) ? (v.legacySrc as LegacySource) : null;
  return {
    id: v.id,
    createdAt: typeof v.createdAt === 'number' ? v.createdAt : Date.now(),
    installedAt: typeof v.installedAt === 'number' ? v.installedAt : null,
    legacy: v.legacy === true,
    legacySrc: v.legacy === true ? legacySrc : null,
  };
}

export async function readInstall(): Promise<InstallRecord | null> {
  return readInstallRecord(await localGet(BILLING_KEYS.install));
}

/**
 * Anything an earlier version of the extension leaves behind. Only consulted
 * when the service worker did not get to record the install first — its
 * `onInstalled` normally does, before any page of the extension can open.
 */
async function hasPreexistingData(): Promise<boolean> {
  try {
    const found = await chrome.storage.local.get(['authenticator_accounts', 'crossPromo', 'lastSeenWhatsNewVersion', 'openCount', 'vault_meta']);
    const accounts = found.authenticator_accounts;
    if (Array.isArray(accounts) && accounts.length > 0) return true;
    const promo = found.crossPromo as { firstOpenDate?: unknown } | undefined;
    if (promo && typeof promo.firstOpenDate === 'number') return true;
    if (typeof found.lastSeenWhatsNewVersion === 'string') return true;
    if (typeof found.openCount === 'number' && found.openCount > 0) return true;
    return !!found.vault_meta;
  } catch {
    return false;
  }
}

/**
 * What the sync marker says. `true` is the word of an install that knew it
 * predated the paywall; `'backup-file'` only that one was restored from an old
 * backup, and `'sync-accounts'` that old accounts came through sync — kept
 * apart so the weaker evidence stays visible as such.
 */
function markerSource(value: unknown): LegacySource | null {
  if (value === true) return 'sync-marker';
  if (value === 'backup-file') return 'backup-file';
  if (value === 'sync-accounts') return 'sync-accounts';
  return null;
}

type MarkerValue = true | 'backup-file' | 'sync-accounts';

function markerValue(source: LegacySource | null): MarkerValue {
  if (source === 'backup-file' || source === 'sync-accounts') return source;
  return true;
}

/** Stronger evidence outranks weaker; a marker is never replaced by a weaker one. */
function markerRank(value: unknown): number {
  if (value === true) return 3;
  if (value === 'sync-accounts') return 2;
  if (value === 'backup-file') return 1;
  return 0;
}

async function syncMarker(): Promise<LegacySource | null> {
  try {
    if (!(await isSyncEnabled())) return null;
    const found = await chrome.storage.sync.get(BILLING_SYNC_KEYS.legacy);
    return markerSource(found[BILLING_SYNC_KEYS.legacy]);
  } catch {
    return null;
  }
}

/** The source a sync-marker change announces, for the service worker's listener. */
export const legacySourceOfMarker = markerSource;

/**
 * Tells this person's other Chrome profiles that they predate the paywall.
 * Sync only if it is on. Never weakens a marker already there.
 */
export async function writeLegacyMarker(source: LegacySource | null): Promise<void> {
  try {
    if (!(await isSyncEnabled())) return;
    const value = markerValue(source);
    const found = await chrome.storage.sync.get(BILLING_SYNC_KEYS.legacy);
    if (markerRank(found[BILLING_SYNC_KEYS.legacy]) >= markerRank(value)) return;
    await chrome.storage.sync.set({ [BILLING_SYNC_KEYS.legacy]: value });
  } catch {
    // Quota or a sync outage: the marker is a convenience, the local record stands.
  }
}

export interface InstallHint {
  reason: 'install' | 'update' | 'other';
  previousVersion?: string;
}

/**
 * The install record, created on first use. The service worker creates it
 * from `onInstalled`, which knows whether this is a fresh install or an update
 * from a version older than billing; any other caller only reaches the
 * creation branch if that did not happen.
 */
export async function ensureInstall(hint: InstallHint = { reason: 'other' }): Promise<InstallRecord> {
  return withLock(INSTALL_LOCK, async () => {
    const updatedFromOld =
      hint.reason === 'update' && !!hint.previousVersion && compareVersions(hint.previousVersion, BILLING_FIRST_VERSION) < 0;

    const existing = await readInstall();
    if (existing) {
      // Created lazily by a page a moment before onInstalled('update') reached
      // the worker: the update is the better witness. Only a moment before — a
      // record from days ago belongs to an install of this version that was
      // rolled back to an older build and is now updated again, and that is a
      // new user, not an old one.
      if (updatedFromOld && !existing.legacy && Date.now() - existing.createdAt < LAZY_RECORD_MS) return writeLegacy(existing, 'update');
      return existing;
    }

    let legacy = false;
    let legacySrc: LegacySource | null = null;
    let installedAt: number | null = null;
    if (updatedFromOld) {
      legacy = true;
      legacySrc = 'update';
    } else if (hint.reason !== 'install' && (await hasPreexistingData())) {
      legacy = true;
      legacySrc = 'existing-data';
    } else {
      installedAt = Date.now();
    }
    if (!legacy) {
      const marker = await syncMarker();
      if (marker) {
        legacy = true;
        legacySrc = marker;
      }
    }
    // Usually too early to see them (sync downloads after the install), so the
    // service worker asks again when they arrive.
    if (!legacy && (await syncedAccountsPredateBilling(Date.now()))) {
      legacy = true;
      legacySrc = 'sync-accounts';
    }

    const record: InstallRecord = { id: crypto.randomUUID(), createdAt: Date.now(), installedAt, legacy, legacySrc };
    await chrome.storage.local.set({ [BILLING_KEYS.install]: record });
    if (legacy) await writeLegacyMarker(legacySrc);
    return record;
  });
}

async function writeLegacy(current: InstallRecord, source: LegacySource): Promise<InstallRecord> {
  if (current.legacy) return current;
  const next: InstallRecord = { ...current, legacy: true, legacySrc: source };
  await chrome.storage.local.set({ [BILLING_KEYS.install]: next });
  await writeLegacyMarker(source);
  return next;
}

// ─── Old accounts arriving through sync ──────────────────────────────────────

/**
 * Where utils/storage.ts keeps the accounts and the vault metadata in
 * chrome.storage.sync. Named here rather than imported: storage.ts imports this
 * module, and the names are part of what every version already wrote.
 */
const SYNC_ACCOUNTS_KEY = 'authenticator_accounts';
const SYNC_CHUNK = /^authenticator_accounts_\d+$/;
const SYNC_VAULT_META_KEY = 'vault_meta';

/** Whether a change to chrome.storage.sync touches the accounts or the vault that seals them. */
export function touchesSyncedAccounts(changes: Record<string, unknown>): boolean {
  return Object.keys(changes).some(key => key === SYNC_ACCOUNTS_KEY || SYNC_CHUNK.test(key) || key === SYNC_VAULT_META_KEY);
}

/**
 * When an id this app minted says the account first came in, if it says:
 * the form and the QR paths start the id with Date.now(), imports with
 * `imported-<ms>` or `cxf-<ms>`. A backup keeps the id, so an old account
 * keeps its old time.
 */
function mintedAt(id: unknown): number | null {
  if (typeof id !== 'string') return null;
  const match = /^(?:imported-|cxf-)?(\d{13})/.exec(id);
  return match ? Number(match[1]) : null;
}

/**
 * Whether accounts in Chrome sync show that this person used the extension
 * before the paywall: one made before `cutoff`, or one so old it has no
 * `createdAt` at all — what another computer that never ran 1.14 leaves there.
 *
 * Not an account whose id says it came in after the cutoff, whatever its
 * `createdAt`: a CXF import from another app keeps that app's creation date,
 * and a new user moving in from elsewhere is not an old user of this one.
 *
 * A sealed record (password protection) hides its dates; the vault that sealed
 * it shows in the clear when it was created, and a vault from before the
 * cutoff is the same evidence.
 */
export function syncedAccountsPredate(records: readonly unknown[], vaultMeta: unknown, cutoff: number): boolean {
  const meta = vaultMeta && typeof vaultMeta === 'object' ? (vaultMeta as Record<string, unknown>) : null;
  const oldVault = !!meta && typeof meta.createdAt === 'number' && Number.isFinite(meta.createdAt) && meta.createdAt < cutoff;
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const r = record as Record<string, unknown>;
    if (typeof r.enc === 'string') {
      if (oldVault && (r.v === undefined || r.v === meta!.vaultId)) return true;
      continue;
    }
    if (typeof r.secret !== 'string' || !r.secret) continue;
    const minted = mintedAt(r.id);
    if (minted !== null && minted >= cutoff) continue;
    if (typeof r.createdAt !== 'number' || !Number.isFinite(r.createdAt) || r.createdAt < cutoff) return true;
  }
  return false;
}

/**
 * syncedAccountsPredate over what Chrome sync holds now. Only while sync is on
 * here. Nothing made after this install itself came to be (`installCreatedAt`)
 * counts, whatever the release date says: the install's own new accounts reach
 * sync too, and before release day — or with the clock behind — they would
 * otherwise make every new user an old one.
 */
export async function syncedAccountsPredateBilling(installCreatedAt: number, cutoff = BILLING_RELEASE_DATE): Promise<boolean> {
  try {
    if (!(await isSyncEnabled())) return false;
    const all = await chrome.storage.sync.get(null);
    const records = Object.keys(all)
      .filter(key => key === SYNC_ACCOUNTS_KEY || SYNC_CHUNK.test(key))
      .flatMap(key => (Array.isArray(all[key]) ? (all[key] as unknown[]) : []));
    return syncedAccountsPredate(records, all[SYNC_VAULT_META_KEY], Math.min(cutoff, installCreatedAt));
  } catch {
    return false;
  }
}

/** How long a page's lazily created record still counts as "just now" when onInstalled('update') arrives. */
const LAZY_RECORD_MS = 10 * 60_000;

/** Legacy only ever turns on. Returns the updated record. */
export async function markLegacy(source: LegacySource): Promise<InstallRecord> {
  const current = await ensureInstall();
  // Web Locks are not re-entrant, so this takes the lock only after
  // ensureInstall has released it.
  return withLock(INSTALL_LOCK, async () => writeLegacy((await readInstall()) ?? current, source));
}

// ─── Tokens ──────────────────────────────────────────────────────────────────

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function readPrices(value: unknown): Record<string, DisplayPrice> {
  const out: Record<string, DisplayPrice> = {};
  if (!value || typeof value !== 'object') return out;
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as Record<string, unknown>;
    const kind = p.kind === 'sub' || p.kind === 'life' || p.kind === 'pass' ? p.kind : null;
    const amount = num(p.amount);
    if (!kind || amount === null || typeof p.currency !== 'string') continue;
    out[id] = {
      kind,
      interval: p.interval === 'month' || p.interval === 'year' ? p.interval : null,
      pass_days: num(p.pass_days),
      amount,
      currency: p.currency,
      exp: p.exp === 0 || p.exp === 3 ? p.exp : 2,
      approx: p.approx === true,
    };
  }
  return out;
}

/**
 * Server-written paywall text, or null for the shipped one. Plain text of a
 * sane length only: anything else is ignored rather than shown, whatever
 * signed it.
 */
function readPaywallText(value: unknown): { lang: string; title: string; body: string } | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const clean = (s: unknown, max: number): string | null => {
    if (typeof s !== 'string') return null;
    const text = s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    return text.length > 0 && text.length <= max ? text : null;
  };
  const title = clean(v.title, 80);
  const body = clean(v.body, 300);
  if (typeof v.lang !== 'string' || !/^[a-z]{2,3}$/.test(v.lang) || !title || !body) return null;
  return { lang: v.lang, title, body };
}

/** A signed policy payload as the paywall reads it; malformed fields fall back safely. */
export function readPolicyPayload(payload: Record<string, unknown>): Policy | null {
  if (payload.typ !== 'policy' || typeof payload.pid !== 'string') return null;
  const paywall = (payload.paywall ?? {}) as Record<string, unknown>;
  const ui = (payload.ui ?? {}) as Record<string, unknown>;
  const limit = payload.free_limit === null ? null : num(payload.free_limit);
  if (payload.free_limit !== null && limit === null) return null;
  return {
    pid: payload.pid,
    free_limit: limit === null ? null : Math.max(0, Math.floor(limit)),
    warn_at: num(payload.warn_at),
    paywall: {
      copy: typeof paywall.copy === 'string' ? paywall.copy : 'default',
      plans: Array.isArray(paywall.plans) ? paywall.plans.filter((p): p is string => typeof p === 'string') : [],
      default_plan: typeof paywall.default_plan === 'string' ? paywall.default_plan : '',
      trial_days: num(paywall.trial_days) ?? 0,
      promo_codes: paywall.promo_codes === true,
      text: readPaywallText(paywall.text),
    },
    prices: readPrices(payload.prices),
    // Absent from a policy issued before the field existed: imports free, the owner's call.
    ui: { pro_in_settings: ui.pro_in_settings === true, import_partial: ui.import_partial !== false, import_free: ui.import_free !== false },
    iat: num(payload.iat),
    exps: Array.isArray(payload.exps)
      ? payload.exps.filter(
          (e): e is Policy['exps'][number] =>
            !!e && typeof e === 'object' && typeof (e as Record<string, unknown>).id === 'string',
        )
      : [],
  };
}

export async function readPolicy(iid: string): Promise<Policy | null> {
  const verified = await verifyToken(await localGet<string>(BILLING_KEYS.policy), iid);
  return verified ? readPolicyPayload(verified.payload) : null;
}

export function readEntitlementPayload(verified: { payload: Record<string, unknown>; exp: number | null }): Entitlement | null {
  const p = verified.payload;
  if (p.typ !== 'ent' || typeof p.lid !== 'string' || verified.exp === null) return null;
  const kind = p.kind === 'life' || p.kind === 'comp' || p.kind === 'sub' || p.kind === 'pass' ? p.kind : null;
  if (!kind) return null;
  return {
    lid: p.lid,
    kind,
    features: Array.isArray(p.features) ? p.features.filter((f): f is string => typeof f === 'string') : [],
    until: num(p.until),
    key_hint: typeof p.key_hint === 'string' ? p.key_hint : '',
    expiresAt: verified.exp * 1000,
  };
}

/** The license this install holds, if a trusted token says so and it has not expired. */
export async function readEntitlement(iid: string, now = Date.now()): Promise<Entitlement | null> {
  const verified = await verifyToken(await localGet<string>(BILLING_KEYS.entitlement), iid);
  if (!verified) return null;
  const ent = readEntitlementPayload(verified);
  return ent && ent.expiresAt > now ? ent : null;
}

/**
 * When the server last answered with a policy that verified: the time this
 * machine wrote down, or failing that the time the server signed the policy
 * it holds.
 */
async function lastHeardFromServer(policy: Policy | null): Promise<number | null> {
  const at = await localGet<number>(BILLING_KEYS.verifiedAt);
  if (typeof at === 'number' && Number.isFinite(at)) return at;
  return policy?.iat ? policy.iat * 1000 : null;
}

/**
 * What the limit check needs, read fresh from storage. Before the first
 * successful sync there is no policy, and so no limit; nor is there once the
 * server has not answered for SERVER_SILENCE_MS (gate.ts).
 */
export async function loadGate(now = Date.now()): Promise<GateSnapshot> {
  try {
    const install = await readInstall();
    if (!install) return { policy: null, entitled: false };
    const [policy, entitlement] = await Promise.all([readPolicy(install.id), readEntitlement(install.id, now)]);
    const standing = policy && !serverSilent(await lastHeardFromServer(policy), now) ? policy : null;
    return {
      policy: standing ? { free_limit: standing.free_limit, warn_at: standing.warn_at, import_free: standing.ui.import_free } : null,
      entitled: !!entitlement && entitlement.features.includes('unlimited_accounts'),
    };
  } catch {
    // Something unreadable in billing state must never stand between a person
    // and adding an account.
    return UNGATED;
  }
}

export async function storeTokens(values: { policy?: string; entitlement?: string | null; verifiedAt?: number }): Promise<void> {
  const set: Record<string, unknown> = {};
  if (values.policy !== undefined) set[BILLING_KEYS.policy] = values.policy;
  if (values.verifiedAt !== undefined) set[BILLING_KEYS.verifiedAt] = values.verifiedAt;
  if (values.entitlement) set[BILLING_KEYS.entitlement] = values.entitlement;
  if (Object.keys(set).length) await chrome.storage.local.set(set);
  if (values.entitlement === null) await chrome.storage.local.remove(BILLING_KEYS.entitlement);
}

// ─── License key in sync ─────────────────────────────────────────────────────

/**
 * The canonical 20-character body of a license key, or null if this cannot be
 * one — the server's rule (server/src/lib/license/key.ts normalizeKey): case,
 * spaces, dashes, underscores and dots do not matter, the `2FA` prefix is
 * dropped, O reads as 0, I and L as 1.
 */
export function normalizeLicenseKey(input: string): string | null {
  let s = input.toUpperCase().replace(/[\s\-_.]/g, '');
  if (s.length === 23 && s.startsWith('2FA')) s = s.slice(3);
  s = s.replace(/O/g, '0').replace(/[IL]/g, '1');
  return /^[0-9A-HJKMNP-TV-Z]{20}$/.test(s) ? s : null;
}

/**
 * The last four characters of a key's body: what the sync request says about
 * the key held here, so the server can tell a newly bought key from it.
 */
export function licenseKeyHint(key: string | null): string | null {
  const body = key === null ? null : normalizeLicenseKey(key);
  return body ? body.slice(-4) : null;
}

export async function readSyncedLicenseKey(): Promise<string | null> {
  try {
    if (!(await isSyncEnabled())) return null;
    const found = await chrome.storage.sync.get(BILLING_SYNC_KEYS.licenseKey);
    const key = found[BILLING_SYNC_KEYS.licenseKey];
    return typeof key === 'string' && key.length <= 64 ? key : null;
  } catch {
    return null;
  }
}

/**
 * The key typed in on this install, remembered here and — while sync is on —
 * offered to this person's other Chrome profiles. Null forgets it everywhere.
 */
export async function writeSyncedLicenseKey(key: string | null): Promise<void> {
  try {
    if (key === null) await chrome.storage.local.remove(BILLING_KEYS.licenseKey);
    else await chrome.storage.local.set({ [BILLING_KEYS.licenseKey]: key });
    // A device with sync off leaves the shared sync area alone, removals
    // included: another profile's copy of the key is not this one's to take.
    if (!(await isSyncEnabled())) return;
    if (key === null) await chrome.storage.sync.remove(BILLING_SYNC_KEYS.licenseKey);
    else await chrome.storage.sync.set({ [BILLING_SYNC_KEYS.licenseKey]: key });
  } catch {
    // Pro still works here; only the convenience on other profiles is lost.
  }
}

/** The key this install holds, typed in here or handed over after buying here. */
export async function readLocalLicenseKey(): Promise<string | null> {
  const key = await localGet<string>(BILLING_KEYS.licenseKey);
  return typeof key === 'string' && key.length <= 64 ? key : null;
}

/**
 * Puts the two facts back in sync if they are missing there: after sync is
 * turned on again (turning it off removed them) or after another profile
 * turned sync off and took them. Only what this install knows first-hand, and
 * a write only when sync lacks it, so a daily check-in costs no quota.
 */
export async function reassertSyncedFacts(): Promise<void> {
  try {
    if (!(await isSyncEnabled())) return;
    const install = await readInstall();
    if (!install) return;
    if (install.legacy) await writeLegacyMarker(install.legacySrc);
    const key = await localGet<string>(BILLING_KEYS.licenseKey);
    if (typeof key !== 'string' || !(await readEntitlement(install.id))) return;
    const found = await chrome.storage.sync.get(BILLING_SYNC_KEYS.licenseKey);
    if (found[BILLING_SYNC_KEYS.licenseKey] !== key) await chrome.storage.sync.set({ [BILLING_SYNC_KEYS.licenseKey]: key });
  } catch {
    // A convenience for other profiles; nothing here depends on it.
  }
}

/** Whether a paywall was on screen in the last `days` days — rating and promo prompts wait. */
export async function recentlySawPaywall(days = 7, now = Date.now()): Promise<boolean> {
  const at = await localGet<number>(BILLING_KEYS.paywallSeenAt);
  return typeof at === 'number' && at <= now && now - at < days * 86_400_000;
}
