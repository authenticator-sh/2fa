// Cloud backup: an end-to-end encrypted copy of the accounts on our server,
// for Pro, and only once the person turns it on.
//
// What reaches the server is ciphertext it has no way to open. The key is
// derived from a recovery code made here, shown to the person once and kept in
// this browser — and, while sync is on, in their Google account, so their other
// Chrome profiles can open the same copies (cloud-backup-code.ts). The code is
// never sent to us. The server sees the size of a copy, when it was made, which
// install sent it, `kid` — a hash of the code, so a device can tell which code
// a copy needs — and the hash of `auth`, a second value derived from the code
// that proves a device holds it.
//
// The server keeps the license's current code (its kid and auth hash) and
// refuses an upload under any other, or after cloud backup was turned off: a
// device still holding an old code is told so (backup_wrong_code, backup_off),
// forgets it, and asks for the current one. One license, one code, so a copy on
// the list is always one the current code opens. Turning off needs the code;
// starting over without it needs the license key.
//
// Restoring a copy by hand goes through restoreFromSnapshot, so it only ever
// adds — the same merge as the automatic copies in Settings.
//
// Sync: every device sends its own list, and reads the newest copy of each
// other device (syncWithCloud) — on opening the list, on coming back to a
// window, and every few minutes while one stays open. The copies carry each
// account's last edit and the deletions made since the device started syncing,
// and utils/cloud-merge.ts folds them together: the newer edit wins, and a
// deletion removes only what was not changed after it.

import type { Account, StoredAccount } from '@/types';
import { decryptJson, encryptJson, generateRecoveryCode, normalizeRecoveryCode, toBase64 } from '@/utils/crypto';
import { ageOf, stampNow } from '@/utils/clock';
import { applyCloudMerge, decodeRecords, getStoredAccounts, restoreFromSnapshot, type CloudMergeResult, type RawCloudCopy, type RestoreResult } from '@/utils/storage';
import { readDeletionMarks } from '@/utils/tombstones';
import { getVaultMeta, peekMasterKeyBytes, VaultLockedError } from '@/utils/vault';
import { withAccountsLock } from '@/utils/write-lock';
import { BillingApiError, post } from './api';
import {
  CLOUD_BACKUP_CODE_KEY,
  openCode,
  putStoredCode,
  readLocalCode,
  readSyncedCode,
  sealCodeUnderVault,
  storedFormFor,
} from './cloud-backup-code';
import { BILLING_KEYS, ensureInstall, readEntitlement, readInstall } from './state';
import type { Entitlement } from './types';

export { CLOUD_BACKUP_CODE_KEY };

/** What this install last sent (local only). */
const STATE_KEY = 'cloudBackupState';
/** What this install last read from the other devices (local only). */
const SYNC_KEY = 'cloudSyncState';
/** A code turned on but not yet confirmed, kept while the person writes it down (session only). */
const PENDING_KEY = 'cloudBackupPendingCode';
const LOCK = 'authenticator-cloud-backup';

/** After a failed upload, how long before the next page load tries again. */
const RETRY_AFTER_FAILURE_MS = 15 * 60_000;
const UPLOAD_TIMEOUT_MS = 30_000;
/** A list that keeps changing while it is sent (sync arriving in pieces) is sent at most this many times in a row. */
const MAX_PASSES = 3;

const FORMAT = 'authenticator-cloud-backup';

interface UploadState {
  /** When the last copy reached the server — this machine's clock, for "last copy today". */
  at: number | null;
  /** HMAC of what that copy held, under the backup key: "unchanged" needs no upload. */
  mac: string | null;
  kid: string | null;
  /** When the last attempt failed, so a failing server is not asked on every open. */
  failedAt: number | null;
  /**
   * A code the server refused (turned off, or replaced by "start over" on
   * another device). Never adopted again from sync, where another profile may
   * still hold it, until the person types a code themselves.
   */
  rejectedKid: string | null;
}

interface CloudPayload {
  format: typeof FORMAT;
  v: 1;
  /** The code this copy was made under; checked after opening, against a server handing out another license's copy. */
  kid: string;
  createdAt: number;
  appVersion?: string;
  accounts: Account[];
  /**
   * Seed hash -> when this device deleted it, for the deletions made since it
   * started syncing (SyncState.since). Absent in copies from before sync.
   */
  deleted?: Record<string, number>;
  /**
   * Records this device holds but cannot read — another vault's ciphertext,
   * damaged entries — exactly as stored. The automatic copies keep them, so
   * the one copy that survives the device must too.
   */
  held: StoredAccount[];
}

export interface CloudBackupSummary {
  id: string;
  createdAt: number;
  bytes: number;
  kid: string;
  thisDevice: boolean;
  /** Which device sent it (the server's tag); null from a server that does not say. */
  device: string | null;
}

export interface CloudBackupList {
  copies: CloudBackupSummary[];
  /** The license's current code; null = cloud backup is off for the license. */
  kid: string | null;
}

/** The code typed in is not the license's current one. */
export class WrongBackupCodeError extends Error {
  constructor() {
    super('This recovery code does not open these backups');
    this.name = 'WrongBackupCodeError';
  }
}

/** The copy opened but is not one of ours, or is cut short. */
export class DamagedCloudBackupError extends Error {
  /** Written by a later build in a format this one does not read — not broken, and readable after an update. */
  readonly newer: boolean;
  constructor(options: { newer?: boolean } = {}) {
    super('The backup could not be read');
    this.name = 'DamagedCloudBackupError';
    this.newer = options.newer === true;
  }
}

/** "Back up now" on an empty list. */
export class NothingToBackUpError extends Error {
  constructor() {
    super('There are no accounts to back up');
    this.name = 'NothingToBackUpError';
  }
}

// ─── Keys ──────────────────────────────────────────────────────────────────

interface BackupKeys {
  enc: CryptoKey;
  mac: CryptoKey;
  kid: string;
  /** Proof for the server that this device holds the code; not a key to anything. */
  auth: string;
}

const encoder = new TextEncoder();

/**
 * Everything from the recovery code. HKDF without stretching: the code carries
 * about 101 bits from a generator, not a password someone chose, so a guesser
 * has nothing to gain from a slow derivation and the person would only wait.
 * Each output has its own info string, so none of them says anything about
 * another — `auth` in particular reveals nothing about the encryption key.
 */
export async function deriveBackupKeys(code: string): Promise<BackupKeys> {
  const normalized = normalizeRecoveryCode(code);
  const ikm = await crypto.subtle.importKey('raw', encoder.encode(normalized), 'HKDF', false, ['deriveKey', 'deriveBits']);
  const hkdf = (info: string) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode(info) });
  const [enc, mac, auth, digest] = await Promise.all([
    crypto.subtle.deriveKey(hkdf('authenticator-cloud-backup-v1'), ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
    crypto.subtle.deriveKey(hkdf('authenticator-cloud-backup-mac-v1'), ikm, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']),
    crypto.subtle.deriveBits(hkdf('authenticator-cloud-backup-auth-v1'), ikm, 256),
    crypto.subtle.digest('SHA-256', encoder.encode(`authenticator-cloud-backup-kid-v1:${normalized}`)),
  ]);
  const kid = Array.from(new Uint8Array(digest).subarray(0, 8), b => b.toString(16).padStart(2, '0')).join('');
  return { enc, mac, kid, auth: toBase64(auth) };
}

/** Whether `code` is one a person could have been shown: 20 symbols of the alphabet. */
export function isWellFormedCode(code: string): boolean {
  return normalizeRecoveryCode(code).length === 20;
}

// ─── State ─────────────────────────────────────────────────────────────────

const NO_STATE: UploadState = { at: null, mac: null, kid: null, failedAt: null, rejectedKid: null };

export async function readUploadState(): Promise<UploadState> {
  try {
    const raw = (await chrome.storage.local.get(STATE_KEY))[STATE_KEY] as Partial<UploadState> | undefined;
    if (!raw || typeof raw !== 'object') return NO_STATE;
    const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
    const str = (x: unknown) => (typeof x === 'string' ? x : null);
    return { at: num(raw.at), mac: str(raw.mac), kid: str(raw.kid), failedAt: num(raw.failedAt), rejectedKid: str(raw.rejectedKid) };
  } catch {
    return NO_STATE;
  }
}

async function writeUploadState(state: UploadState): Promise<void> {
  await chrome.storage.local.set({ [STATE_KEY]: state });
}

// ─── The code ──────────────────────────────────────────────────────────────

export type CodeState =
  | { kind: 'none' }
  | { kind: 'ready'; code: string; kid: string }
  /** Wrapped under the vault, which is locked. */
  | { kind: 'locked' }
  /** Wrapped under a vault that is gone, or another one: the person has to type the code again. */
  | { kind: 'unreadable' };

/**
 * The code this browser holds. Reads the vault's key without counting as
 * activity: a status line redrawn because storage changed must not keep the
 * vault open. A code the server refused is not adopted again from sync.
 */
export async function readCode(): Promise<CodeState> {
  const state = await readUploadState();
  const meta = await getVaultMeta().catch(() => null);
  const mk = meta ? await peekMasterKeyBytes().catch(() => null) : null;

  const resolve = async (stored: NonNullable<Awaited<ReturnType<typeof readLocalCode>>>): Promise<CodeState> => {
    if ('w' in stored && meta && stored.v === meta.vaultId && !mk) return { kind: 'locked' };
    const code = await openCode(stored, mk, meta?.vaultId ?? null);
    if (!code) return { kind: 'unreadable' };
    const { kid } = await deriveBackupKeys(code);
    return { kind: 'ready', code, kid };
  };

  // In the clear under a vault, anywhere: sealed now, if the key is at hand
  // (storage.ts seals what is there when protection is turned on; this covers
  // a code that arrived in the clear afterwards, through sync or otherwise).
  //
  // Under the accounts lock, with the vault read again inside it: turning
  // protection off (storage.ts disableVault) holds that lock from start to
  // finish, and puts the code back in the clear a moment before the vault's
  // metadata goes. Sealing in that moment — this read woken by that very
  // write — wrapped the code under a vault about to stop existing, and backups
  // stopped until the code was typed again.
  if (meta && mk) {
    await withAccountsLock(async () => {
      const current = await getVaultMeta().catch(() => null);
      if (current?.vaultId === meta.vaultId) await sealCodeUnderVault(mk, meta.vaultId);
    });
  }

  const local = await readLocalCode();
  let unreadable: CodeState | null = null;
  if (local) {
    const found = await resolve(local);
    // A code the server refused, back in local through a read that raced the
    // refusal: not this browser's any more.
    if (found.kind === 'ready' && found.kid === state.rejectedKid) {
      await chrome.storage.local.remove(CLOUD_BACKUP_CODE_KEY).catch(() => {});
      return { kind: 'none' };
    }
    // One that cannot be opened here may still be readable in sync — put back
    // in the clear by another profile that turned its protection off.
    if (found.kind !== 'unreadable') return found;
    unreadable = found;
  }

  // Turned on in another profile of this person: adopt it here.
  const synced = await readSyncedCode();
  if (!synced) return unreadable ?? { kind: 'none' };
  const found = await resolve(synced);
  if (unreadable && found.kind !== 'ready') return unreadable;
  if (found.kind === 'ready') {
    if (found.kid === state.rejectedKid) return { kind: 'none' };
    const form = await storedFormFor(found.code).catch(() => null);
    if (form) await putStoredCode(form, { syncToo: false }).catch(() => {});
  }
  return found;
}

/**
 * Keeps `code` as this browser's, wrapped when there is a vault. Typed or made
 * here by the person, so a past refusal of it no longer stands.
 */
async function keepCode(code: string, options: { syncToo?: boolean } = {}): Promise<void> {
  const form = await storedFormFor(code);
  if (!form) throw new VaultLockedError();
  await putStoredCode(form, options);
  const state = await readUploadState();
  await writeUploadState({ ...state, rejectedKid: null });
  await updateSyncState({ needsCode: false }).catch(() => {});
}

/**
 * The server said this code is no longer the license's: forget it here, and in
 * sync when sync holds the same one, and never adopt it again. Another
 * profile's newer code in sync is left alone.
 */
async function forgetRefusedCode(kid: string, options: { needsCode?: boolean } = {}): Promise<void> {
  // The refusal first: removing the code fires a storage event, and a screen
  // reading the code on it must already know not to take it back from sync.
  await writeUploadState({ ...NO_STATE, rejectedKid: kid });
  // Sync starts over with the next code; until then the header says the code
  // is wanted, when the license still has one (started over elsewhere) —
  // not when it has none (turned off elsewhere), which is just "off".
  await resetSyncState({ needsCode: options.needsCode === true });
  await chrome.storage.local.remove(CLOUD_BACKUP_CODE_KEY).catch(() => {});
  try {
    const synced = await readSyncedCode();
    if (synced) {
      const meta = await getVaultMeta().catch(() => null);
      const mk = meta ? await peekMasterKeyBytes().catch(() => null) : null;
      const code = await openCode(synced, mk, meta?.vaultId ?? null);
      if (code && (await deriveBackupKeys(code)).kid === kid) await chrome.storage.sync.remove(CLOUD_BACKUP_CODE_KEY);
    }
  } catch {
    // The refusal above still keeps it from being adopted.
  }
}

/** A new code, the same one until it is confirmed or dropped — the popup may close while it is being written down. */
export async function pendingBackupCode(): Promise<string> {
  try {
    const found = (await chrome.storage.session.get(PENDING_KEY))[PENDING_KEY];
    if (typeof found === 'string' && isWellFormedCode(found)) return found;
  } catch {
    // No session storage: a code for this screen only.
  }
  const code = generateRecoveryCode();
  try {
    await chrome.storage.session.set({ [PENDING_KEY]: code });
  } catch {
    // As above.
  }
  return code;
}

export async function dropPendingBackupCode(): Promise<void> {
  try {
    await chrome.storage.session.remove(PENDING_KEY);
  } catch {
    // Nothing kept.
  }
}

/** Pro that includes cloud backup, held by this install right now. */
export async function cloudBackupEntitlement(): Promise<Entitlement | null> {
  const install = await readInstall();
  if (!install) return null;
  const entitlement = await readEntitlement(install.id);
  return entitlement && entitlement.features.includes('cloud_backup') ? entitlement : null;
}

/**
 * Cloud backup is on and the copy on the server is what this device last
 * held: Pro still includes it, a copy reached the server under a code, and no
 * attempt has failed since. Turning it off or a refused code clears the upload
 * state, so either reads as not covered.
 */
export async function cloudBackupCovers(): Promise<boolean> {
  try {
    if (!(await cloudBackupEntitlement())) return false;
    const state = await readUploadState();
    if (state.at === null || state.kid === null) return false;
    return state.failedAt === null || state.failedAt < state.at;
  } catch {
    return false;
  }
}

// ─── What a copy holds ─────────────────────────────────────────────────────

/** Same accounts, same string: fields in a fixed order, accounts by id. */
function canonical(value: unknown): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map(k => [k, sortKeys((v as Record<string, unknown>)[k])])
      );
    }
    return v;
  };
  return JSON.stringify(sortKeys(value));
}

const byId = <T extends { id?: unknown }>(list: T[]) => [...list].sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));

/** Everything this device holds, read fresh: what it can open, and what it cannot, as stored. */
async function snapshot(): Promise<{ accounts: Account[]; held: StoredAccount[] }> {
  const { accounts, held } = await decodeRecords(await getStoredAccounts());
  return { accounts, held };
}

async function macOf(content: { accounts: Account[]; held: StoredAccount[] }, key: CryptoKey): Promise<string> {
  const text = canonical({ accounts: byId(content.accounts), held: byId(content.held) });
  return toBase64(await crypto.subtle.sign('HMAC', key, encoder.encode(text)));
}

function appVersion(): string | undefined {
  try {
    const version = chrome.runtime.getManifest().version;
    return typeof version === 'string' ? version : undefined;
  } catch {
    return undefined;
  }
}

// ─── Talking to the server ─────────────────────────────────────────────────

/** Sends one copy. On a refusal of the code, forgets it before rethrowing. */
async function upload(
  content: { accounts: Account[]; held: StoredAccount[] },
  keys: BackupKeys,
  mac: string,
  options: { claim?: boolean } = {}
): Promise<void> {
  const payload: CloudPayload = {
    format: FORMAT,
    v: 1,
    kid: keys.kid,
    createdAt: Date.now(),
    appVersion: appVersion(),
    deleted: await deletionsToSend(),
    ...content,
  };
  const data = await encryptJson(payload, keys.enc);
  const install = await ensureInstall();
  const previous = await readUploadState();
  try {
    const sent = await post<{ id: string; created_at: number }>(
      '/v1/backup/upload',
      { iid: install.id, kid: keys.kid, auth: keys.auth, data, ...(options.claim ? { claim: true } : {}) },
      UPLOAD_TIMEOUT_MS
    );
    await writeUploadState({ at: Date.now(), mac, kid: keys.kid, failedAt: null, rejectedKid: null });
    if (typeof sent?.id === 'string') await rememberUpload(sent.id).catch(() => {});
  } catch (error) {
    if (error instanceof BillingApiError && (error.code === 'backup_off' || error.code === 'backup_wrong_code') && !options.claim) {
      await forgetRefusedCode(keys.kid, { needsCode: error.code === 'backup_wrong_code' });
    } else {
      await writeUploadState({ ...previous, failedAt: Date.now() });
    }
    throw error;
  }
}

/**
 * Without Web Locks (none of our platforms, but a browser could), one page's
 * own queue: a reload that sends the copy must still wait for a sync that is
 * merging, not run beside it and send the list twice.
 */
let localQueue: Promise<void> = Promise.resolve();
let localBusy = false;
function queueHere<T>(fn: () => Promise<T>): Promise<T> {
  const run = localQueue.then(async () => {
    localBusy = true;
    try {
      return await fn();
    } finally {
      localBusy = false;
    }
  });
  localQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/** Waits its turn: the user's own actions never race an upload or each other. */
async function withBackupLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (!locks || typeof locks.request !== 'function') return queueHere(fn);
  return locks.request(LOCK, () => fn()) as Promise<T>;
}

async function ifLockAvailable<T>(fn: () => Promise<T>, busy: T): Promise<T> {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (!locks || typeof locks.request !== 'function') return localBusy ? busy : queueHere(fn);
  return locks.request(LOCK, { ifAvailable: true }, lock => (lock ? fn() : busy)) as Promise<T>;
}

export type UploadOutcome = 'uploaded' | 'unchanged' | 'skipped' | 'failed';

/**
 * Sends a copy when what this device holds differs from the last copy it
 * sent. Called after the list loads; never throws.
 *
 * Never a copy of an empty list, for the reason the automatic copies skip one:
 * a store that only read as empty — sync not downloaded yet — must not become
 * the newest copy. A list that changes while it is being sent (sync arriving
 * in pieces) is sent again, a few times at most, rather than left behind until
 * the next open.
 */
export async function cloudBackupIfDue(accounts: Account[], now = Date.now()): Promise<UploadOutcome> {
  try {
    if (accounts.length === 0) return 'skipped';
    if (!(await cloudBackupEntitlement())) {
      // Pro ended: no sync, so what is deleted from here on stays here.
      await endSyncEpoch();
      return 'skipped';
    }
    return await ifLockAvailable(async (): Promise<UploadOutcome> => {
      let outcome: UploadOutcome = 'unchanged';
      for (let pass = 0; pass < MAX_PASSES; pass++) {
        const code = await readCode();
        if (code.kind !== 'ready') return 'skipped';
        await syncSince();
        const state = await readUploadState();
        const keys = await deriveBackupKeys(code.code);
        const content = await snapshot();
        if (content.accounts.length === 0) return 'skipped';
        const mac = await macOf(content, keys.mac);
        if (state.mac === mac && state.kid === keys.kid) {
          // Back to what the last copy holds — an upload that failed, then a
          // change undone: nothing is missing from the cloud any more.
          if (state.failedAt !== null) await writeUploadState({ ...state, failedAt: null });
          return outcome;
        }
        // Only what other devices' copies brought in, and a copy went out from
        // here within the hour: not sent yet. They hold all of it already, and
        // each device sending on every merge was N uploads per change, enough
        // on a busy day to spend the license's hundred.
        if (pass === 0 && (await mergeOnly(mac, state.at, now))) return 'unchanged';
        if (pass === 0 && state.failedAt !== null && state.failedAt <= now && now - state.failedAt < RETRY_AFTER_FAILURE_MS) return 'skipped';
        try {
          await upload(content, keys, mac);
          outcome = 'uploaded';
        } catch (error) {
          console.warn('cloud backup: upload failed', error);
          return 'failed';
        }
      }
      return outcome;
    }, 'skipped');
  } catch (error) {
    console.warn('cloud backup: could not check', error);
    return 'failed';
  }
}

/** "Back up now": what this device holds, whether or not it changed. Throws on failure. */
export async function backupNow(): Promise<void> {
  await withBackupLock(async () => {
    const code = await readCode();
    if (code.kind === 'locked') throw new VaultLockedError();
    if (code.kind !== 'ready') throw new WrongBackupCodeError();
    const keys = await deriveBackupKeys(code.code);
    const content = await snapshot();
    if (content.accounts.length === 0 && content.held.length === 0) throw new NothingToBackUpError();
    await upload(content, keys, await macOf(content, keys.mac));
  });
}

interface ServerSummary {
  id: string;
  created_at: number;
  bytes: number;
  kid: string;
  this_device: boolean;
  device?: string;
}

/**
 * The license's copies and its current code. With `licenseKey`, the copies of
 * the license that key belongs to, whether or not this browser holds it and
 * whether or not it is paid up — how a lapsed license is restored on a new
 * browser. Throws on any failure: an unanswered question is not "no copies".
 */
export async function listCloudBackups(licenseKey?: string): Promise<CloudBackupList> {
  const install = await ensureInstall();
  const answer = await post<{ backups?: ServerSummary[]; kid?: string | null }>('/v1/backup/list', {
    iid: install.id,
    ...(licenseKey ? { key: licenseKey } : {}),
  });
  if (!answer || !Array.isArray(answer.backups)) throw new BillingApiError('internal', 200);
  const copies = answer.backups
    .filter(b => b && typeof b.id === 'string' && typeof b.created_at === 'number' && typeof b.kid === 'string')
    .map(b => ({
      id: b.id,
      createdAt: b.created_at,
      bytes: Number(b.bytes) || 0,
      kid: b.kid,
      thisDevice: b.this_device === true,
      device: typeof b.device === 'string' && b.device ? b.device : null,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
  return { copies, kid: typeof answer.kid === 'string' ? answer.kid : null };
}

/**
 * Turns cloud backup on with a new code and sends the first copy.
 *
 * Asks the server first, under the lock: the license may already have a code
 * — set from another browser while this one showed "Turn on", or just as the
 * person was writing theirs down — and then this one is refused, so a license
 * never has copies under two codes. The server refuses a second claim too, if
 * two browsers get this far at once.
 */
export async function enableCloudBackup(code: string): Promise<void> {
  await withBackupLock(async () => {
    const keys = await deriveBackupKeys(code);
    const { kid } = await listCloudBackups();
    if (kid !== null && kid !== keys.kid) throw new WrongBackupCodeError();
    await syncSince();
    const content = await snapshot();
    const previous = await readUploadState();
    // Here only until the server has taken it: in sync before that, another
    // profile would adopt a code the server does not know yet, be refused
    // (backup_off), and refuse it for good.
    await keepCode(code, { syncToo: false });
    try {
      await upload(content, keys, await macOf(content, keys.mac), { claim: true });
    } catch (error) {
      // Not on unless the server took the code. Kept, a code the server never
      // heard of would be refused on the next upload (backup_off) and dropped
      // without a word. The code on screen stays (pendingBackupCode), so trying
      // again keeps it; a claim that landed despite the error is taken again
      // as the same code.
      await chrome.storage.local.remove(CLOUD_BACKUP_CODE_KEY).catch(() => {});
      await writeUploadState({ ...NO_STATE, rejectedKid: previous.rejectedKid }).catch(() => {});
      if (error instanceof BillingApiError && error.code === 'backup_wrong_code') throw new WrongBackupCodeError();
      throw error;
    }
    await keepCode(code).catch(() => {});
    await dropPendingBackupCode();
  });
}

/**
 * Takes the license's current code, typed in here — a new browser, or one whose
 * code went stale. Checked against the server's before anything is kept.
 *
 * Then the newest copy is brought in first — merged, never replacing anything,
 * like every restore — and only then is this browser's list compared with it.
 * Typing the code is joining the backup: sending this browser's list as it
 * was (a new computer with one account added by hand) made a copy of that one
 * account the newest, and the backup looked empty to the next browser. Now the
 * list sent is the copy's and this browser's together, and only when this
 * browser added something — a second computer with sync off, whose accounts
 * must reach the cloud now, not at its next change.
 *
 * Returns what the merge brought in, or null when there was no copy to merge.
 */
/** What joining brought in: a restore's counts, and the edits and deletions of the other devices. */
export type JoinResult = RestoreResult & { updated: number; removed: number };

export async function adoptBackupCode(typed: string, licenseKey?: string): Promise<JoinResult | null> {
  return withBackupLock(async () => {
    if (!isWellFormedCode(typed)) throw new WrongBackupCodeError();
    const keys = await deriveBackupKeys(typed);
    const { kid, copies } = await listCloudBackups(licenseKey);
    if (kid === null || kid !== keys.kid) throw new WrongBackupCodeError();
    await keepCode(typed);
    await syncSince();
    const newest = copies[0]?.id ?? null;
    let merged: JoinResult | null = null;
    if (newest) {
      try {
        // Every device's newest copy, merged as sync merges them — not the
        // newest one restored: a restore only adds, and stamps what it adds as
        // new, so an account another device has since deleted came back here
        // and then went out to every device again as this one's addition.
        const outcome = await mergeOtherDevices(keys, copies, { licenseKey });
        merged = { added: outcome.added, skipped: 0, unreadable: outcome.unreadable, updated: outcome.updated, removed: outcome.removed };
      } catch (error) {
        // A locked vault is the person's to open; anything else (a broken
        // copy, the server gone a moment) leaves the code kept and the copies
        // listed, to be restored by hand — and sends nothing from here, below.
        if (error instanceof VaultLockedError) throw error;
        console.warn('cloud backup: could not bring the newest copy in', error);
      }
    }
    const content = await snapshot();
    const mac = await macOf(content, keys.mac);
    const entitled = !!(await cloudBackupEntitlement());
    const complete = !newest || merged !== null;
    if (entitled && complete && content.accounts.length > 0 && (await holdsSomethingNew(content.accounts, newest, keys))) {
      try {
        await upload(content, keys, mac);
        return merged;
      } catch (error) {
        console.warn('cloud backup: first copy from this browser failed', error);
      }
    }
    // This list counts as sent even when nothing was: only a change made here
    // afterwards sends one, never the next open on its own.
    await writeUploadState({ at: null, mac, kid: keys.kid, failedAt: null, rejectedKid: null });
    return merged;
  });
}

const secretOf = (account: Account) => account.secret.replace(/\s+/g, '').replace(/=+$/, '').toUpperCase();

/** Whether `accounts` has one the newest copy lacks (or there is no copy to compare with). */
async function holdsSomethingNew(accounts: Account[], newestId: string | null, keys: BackupKeys): Promise<boolean> {
  if (!newestId) return true;
  try {
    const install = await ensureInstall();
    const answer = await post<{ kid?: string; data?: string }>('/v1/backup/get', { iid: install.id, id: newestId, auth: keys.auth });
    if (typeof answer?.data !== 'string' || answer.kid !== keys.kid) return true;
    const payload = await decryptJson<CloudPayload>(answer.data, keys.enc);
    const there = new Set((Array.isArray(payload?.accounts) ? payload.accounts : []).map(secretOf));
    return accounts.some(a => !there.has(secretOf(a)));
  } catch {
    // Cannot tell: sending this browser's list costs one copy; not sending
    // could leave its accounts out of every copy.
    return true;
  }
}

/**
 * Restores one copy into this device's list — merge only, like every restore.
 * Uses `typed` when given (a lapsed license on a new browser, with its license
 * key), otherwise the code kept here.
 */
export async function restoreCloudBackup(id: string, options: { typed?: string; licenseKey?: string } = {}): Promise<RestoreResult> {
  let code: string | null = null;
  if (options.typed) code = normalizeRecoveryCode(options.typed);
  else {
    const stored = await readCode();
    if (stored.kind === 'locked') throw new VaultLockedError();
    if (stored.kind === 'ready') code = stored.code;
  }
  if (!code || !isWellFormedCode(code)) throw new WrongBackupCodeError();
  const keys = await deriveBackupKeys(code);
  const payload = await fetchCopy(id, keys, options.licenseKey);
  const held = Array.isArray(payload.held) ? payload.held : [];
  return restoreFromSnapshot([...payload.accounts, ...held]);
}

/** One copy, opened and checked. Throws WrongBackupCodeError or DamagedCloudBackupError. */
async function fetchCopy(id: string, keys: BackupKeys, licenseKey?: string): Promise<CloudPayload> {
  const install = await ensureInstall();
  // With the proof of the code: an install id alone reaches no ciphertext.
  const answer = await post<{ kid?: string; data?: string }>('/v1/backup/get', {
    iid: install.id,
    id,
    auth: keys.auth,
    ...(licenseKey ? { key: licenseKey } : {}),
  });
  if (typeof answer?.data !== 'string' || typeof answer.kid !== 'string') throw new DamagedCloudBackupError();
  if (keys.kid !== answer.kid) throw new WrongBackupCodeError();

  let payload: CloudPayload;
  try {
    payload = await decryptJson<CloudPayload>(answer.data, keys.enc);
  } catch {
    // The kid matched, so the code is right: the copy itself is broken.
    throw new DamagedCloudBackupError();
  }
  // v: a copy a later version writes differently is not read as this one.
  if (payload && payload.format === FORMAT && typeof payload.v === 'number' && payload.v > 1) {
    throw new DamagedCloudBackupError({ newer: true });
  }
  if (!payload || payload.format !== FORMAT || payload.v !== 1 || payload.kid !== keys.kid || !Array.isArray(payload.accounts)) {
    throw new DamagedCloudBackupError();
  }
  return payload;
}

/**
 * Turns cloud backup off for this license: deletes every copy on the server —
 * those other devices sent too, which is what "off" has to mean when the copies
 * are shared — then forgets the code here and in sync. Other browsers learn it
 * on their next upload (backup_off) and forget theirs. Needs the code: an
 * install id alone, which leaves the browser in the uninstall link, must not
 * be enough to wipe someone's backups.
 */
export async function disableCloudBackup(): Promise<number> {
  return withBackupLock(async () => {
    const code = await readCode();
    if (code.kind === 'locked') throw new VaultLockedError();
    if (code.kind !== 'ready') throw new WrongBackupCodeError();
    const keys = await deriveBackupKeys(code.code);
    const install = await ensureInstall();
    const answer = await post<{ deleted?: number }>('/v1/backup/delete', { iid: install.id, auth: keys.auth });
    await putStoredCode(null);
    await writeUploadState({ ...NO_STATE, rejectedKid: keys.kid });
    // Deletions made while it is off are this device's own, as before sync.
    await resetSyncState();
    return typeof answer?.deleted === 'number' ? answer.deleted : 0;
  });
}

/**
 * "Lost the code": deletes every copy of the license the key belongs to, so a
 * new code can be made. Proven by the license key, the one thing a person
 * without the code still has.
 */
export async function resetCloudBackup(licenseKey: string): Promise<number> {
  return withBackupLock(async () => {
    const install = await ensureInstall();
    const answer = await post<{ deleted?: number }>('/v1/backup/reset', { iid: install.id, key: licenseKey });
    const stale = await readCode().catch(() => ({ kind: 'none' }) as CodeState);
    await putStoredCode(null);
    await writeUploadState({ ...NO_STATE, rejectedKid: stale.kind === 'ready' ? stale.kid : null });
    await resetSyncState();
    return typeof answer?.deleted === 'number' ? answer.deleted : 0;
  });
}

/**
 * Forgets the code kept here when the server's answer — asked again now, under
 * the lock — says the license has another one or none: turned off, or started
 * over, in another browser. Asked again rather than trusted from a screen: a
 * list fetched a moment before this browser turned it on would otherwise make
 * it forget the code it just made.
 */
export async function reconcileCloudBackupCode(): Promise<void> {
  await withBackupLock(async () => {
    const code = await readCode();
    if (code.kind !== 'ready') return;
    const { kid } = await listCloudBackups();
    if (kid !== code.kid) await forgetRefusedCode(code.kid, { needsCode: kid !== null });
  });
}

// ─── Sync ──────────────────────────────────────────────────────────────────

interface SyncState {
  /** Device tag -> the id of its copy last folded in here, so an unchanged device is not read again. */
  seen: Record<string, string>;
  /** When the other devices were last read, all of them (written at most every few minutes when nothing changed). */
  pulledAt: number | null;
  /** When reading them last failed. */
  failedAt: number | null;
  /**
   * When this device started syncing. Only deletions from then on go out, or
   * remove this device's own accounts: before sync, deleting an account left
   * the other devices alone by design, and a laptop that dropped a work
   * account a year ago must not take it off the phone the day both update.
   * Cleared when cloud backup is turned off here, or Pro ends.
   */
  since: number | null;
  /** The license has another code now (started over elsewhere): the header asks for it. */
  needsCode: boolean;
  /**
   * Ids of the copies this device sent. The server marks a copy "this device"
   * by install id, and an iPad set up from the iPhone's backup, or a Mac moved
   * with Migration Assistant, has the same one: their copies are told apart by
   * this list instead, which each keeps for itself from then on.
   */
  mine: string[];
  /** The copies already on the server when this list started count as this device's. */
  mineSince: boolean;
  /** The list right after the last merge brought something in: unchanged since, it waits to be sent (mergeOnly). */
  mergedMac: string | null;
}

const NO_SYNC: SyncState = {
  seen: {},
  pulledAt: null,
  failedAt: null,
  since: null,
  needsCode: false,
  mine: [],
  mineSince: false,
  mergedMac: null,
};

/** Reads the other devices at most this often from one browser, unless asked by the person or the last read failed. */
const SYNC_EVERY_MS = 60_000;
/** A list that only changed by merging waits this long after this device's last copy before it is sent. */
const MERGE_UPLOAD_DELAY_MS = 60 * 60_000;
/** pulledAt is rewritten after an uneventful read only when older than this: every write is a whole file on the Mac and iPhone. */
const PULLED_AT_REFRESH_MS = 10 * 60_000;
const MINE_KEPT = 100;
/** When the last read started, across this browser's windows; session storage, so it costs no disk write. */
const ATTEMPT_KEY = 'cloudSyncAttempt';

async function readSyncState(): Promise<SyncState> {
  try {
    const raw = (await chrome.storage.local.get(SYNC_KEY))[SYNC_KEY] as Partial<SyncState> | undefined;
    if (!raw || typeof raw !== 'object') return NO_SYNC;
    const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
    const seen: Record<string, string> = {};
    if (raw.seen && typeof raw.seen === 'object' && !Array.isArray(raw.seen)) {
      for (const [device, id] of Object.entries(raw.seen)) if (typeof id === 'string') seen[device] = id;
    }
    return {
      seen,
      pulledAt: num(raw.pulledAt),
      failedAt: num(raw.failedAt),
      since: num(raw.since),
      needsCode: raw.needsCode === true,
      mine: Array.isArray(raw.mine) ? raw.mine.filter((id): id is string => typeof id === 'string') : [],
      mineSince: raw.mineSince === true,
      mergedMac: typeof raw.mergedMac === 'string' ? raw.mergedMac : null,
    };
  } catch {
    return NO_SYNC;
  }
}

async function updateSyncState(patch: Partial<SyncState>): Promise<void> {
  const state = await readSyncState();
  await chrome.storage.local.set({ [SYNC_KEY]: { ...state, ...patch } });
}

/** Sync starts over: nothing seen, no epoch. The copies this device sent are still its own. */
async function resetSyncState(patch: Partial<SyncState> = {}): Promise<void> {
  const { mine, mineSince } = await readSyncState();
  await chrome.storage.local.set({ [SYNC_KEY]: { ...NO_SYNC, mine, mineSince, ...patch } });
}

/** When this device started syncing; set the first time it is asked. */
async function syncSince(): Promise<number> {
  const state = await readSyncState();
  if (state.since !== null) return state.since;
  const since = await stampNow();
  await updateSyncState({ since });
  return since;
}

/** Pro ended: the epoch closes, and starts again when sync does. */
async function endSyncEpoch(): Promise<void> {
  const state = await readSyncState().catch(() => NO_SYNC);
  if (state.since !== null || Object.keys(state.seen).length > 0) await resetSyncState().catch(() => {});
}

async function rememberUpload(id: string): Promise<void> {
  const state = await readSyncState();
  await updateSyncState({ mine: [id, ...state.mine.filter(x => x !== id)].slice(0, MINE_KEPT) });
}

/** Whether a send can wait: the list is what the last merge made of it, and this device sent a copy within the hour. */
async function mergeOnly(mac: string, lastUpload: number | null, now: number): Promise<boolean> {
  const state = await readSyncState();
  if (state.mergedMac === null || state.mergedMac !== mac || lastUpload === null) return false;
  const age = now - lastUpload;
  return age >= 0 && age < MERGE_UPLOAD_DELAY_MS;
}

async function readAttempt(): Promise<number | null> {
  try {
    const value = (await chrome.storage.session.get(ATTEMPT_KEY))[ATTEMPT_KEY];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

async function writeAttempt(at: number): Promise<void> {
  try {
    await chrome.storage.session.set({ [ATTEMPT_KEY]: at });
  } catch {
    // No session storage: each page paces itself.
  }
}

/** The deletion marks a copy from here carries: those made since this device started syncing. */
async function deletionsToSend(): Promise<Record<string, number>> {
  try {
    const since = await syncSince();
    const marks = await readDeletionMarks();
    return Object.fromEntries(Object.entries(marks).filter(([, at]) => at >= since));
  } catch {
    // A copy without them is a copy without deletions — never one that deletes.
    return {};
  }
}

interface OthersMerged extends CloudMergeResult {
  /** Records in those copies this device cannot read; left where they are. */
  unreadable: number;
}

/**
 * Folds the newest copy of every other device into this list. With
 * `onlyNew`, only devices whose newest copy this device has not folded in yet.
 *
 * A broken copy is skipped and remembered, not fetched again on every open; a
 * copy from a later build is skipped and NOT remembered, to be read once this
 * build is updated. A failure part way — the server refusing one fetch — still
 * folds in the copies already fetched, and then throws.
 */
async function mergeOtherDevices(
  keys: BackupKeys,
  copies: CloudBackupSummary[],
  options: { licenseKey?: string; onlyNew?: boolean } = {}
): Promise<OthersMerged> {
  const state = await readSyncState();
  // The first sync of a device that sent copies before this list existed:
  // those are its own (see SyncState.mine).
  let mine = state.mine;
  if (!state.mineSince) {
    mine = [...copies.filter(copy => copy.thisDevice).map(copy => copy.id), ...mine].slice(0, MINE_KEPT);
    await updateSyncState({ mine, mineSince: true });
  }
  const mineSet = new Set(mine);

  // Newest first already (listCloudBackups), so the first of each device is its newest.
  const newest = new Map<string, CloudBackupSummary>();
  for (const copy of copies) {
    if (copy.kid !== keys.kid || mineSet.has(copy.id)) continue;
    // A copy "from this device" this device did not send: its twin's.
    // A server that does not tag devices gives one group: the newest copy of anyone else.
    const device = copy.thisDevice ? `twin:${copy.device ?? ''}` : (copy.device ?? 'other');
    if (!newest.has(device)) newest.set(device, copy);
  }
  const todo = [...newest.entries()].filter(([device, copy]) => !options.onlyNew || state.seen[device] !== copy.id);

  const read: RawCloudCopy[] = [];
  const seen = { ...state.seen };
  let unreadable = 0;
  let failure: unknown = null;
  for (const [device, copy] of todo) {
    try {
      const payload = await fetchCopy(copy.id, keys, options.licenseKey);
      read.push({ accounts: payload.accounts, deleted: payload.deleted ?? {} });
      unreadable += Array.isArray(payload.held) ? payload.held.length : 0;
      seen[device] = copy.id;
    } catch (error) {
      if (error instanceof DamagedCloudBackupError) {
        console.warn('cloud sync: a copy could not be read', copy.id);
        if (!error.newer) seen[device] = copy.id;
        continue;
      }
      failure = error;
      break;
    }
  }

  // Whether this list had nothing unsent before the merge — what the last
  // copy from here held, or what an earlier merge made of it. Only then may
  // the merged list wait (mergeOnly): an account added here a moment ago must
  // go out now, merge or no merge.
  let nothingUnsent = false;
  if (read.length > 0) {
    try {
      const before = await macOf(await snapshot(), keys.mac);
      nothingUnsent = before === (await readUploadState()).mac || before === state.mergedMac;
    } catch {
      nothingUnsent = false;
    }
  }
  const result = read.length > 0 ? await applyCloudMerge(read, { since: await syncSince() }) : { added: 0, updated: 0, removed: 0 };
  // Devices whose copies are gone from the server are forgotten with them.
  for (const device of Object.keys(seen)) if (!newest.has(device)) delete seen[device];

  const changed = result.added + result.updated + result.removed > 0;
  const patch: Partial<SyncState> = {};
  if (JSON.stringify(seen) !== JSON.stringify(state.seen)) patch.seen = seen;
  if (changed) {
    try {
      patch.mergedMac = nothingUnsent ? await macOf(await snapshot(), keys.mac) : null;
    } catch {
      patch.mergedMac = null;
    }
  }
  if (failure === null) {
    const now = Date.now();
    if (changed || patch.seen || state.failedAt !== null || state.pulledAt === null || Math.abs(now - state.pulledAt) > PULLED_AT_REFRESH_MS) {
      patch.pulledAt = now;
      patch.failedAt = null;
    }
  }
  if (Object.keys(patch).length > 0) await updateSyncState(patch);
  if (failure !== null) throw failure;
  return { ...result, unreadable };
}

export type SyncOutcome = 'merged' | 'unchanged' | 'skipped' | 'failed';

let active = 0;
const listeners = new Set<() => void>();
function setActive(delta: number): void {
  active += delta;
  for (const listener of listeners) listener();
}

/** Told when a sync starts or ends in this page — the header's spinner. */
export function onCloudSyncActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const pageHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

/**
 * Reads the other devices' newest copies and folds in what changed. Called on
 * opening the list and on coming back to a window; at most once a minute from
 * one browser unless `force` or the last read failed. Never throws.
 */
export async function syncWithCloud(options: { force?: boolean } = {}): Promise<SyncOutcome> {
  try {
    if (!(await cloudBackupEntitlement())) {
      await endSyncEpoch();
      return 'skipped';
    }
    const code = await readCode();
    if (code.kind !== 'ready') return 'skipped';
    // Before anything else: a deletion made from here on is one to send, even
    // if no copy goes out until after it.
    await syncSince();
    if (!options.force) {
      const state = await readSyncState();
      const failedLast = state.failedAt !== null && (state.pulledAt === null || state.failedAt > state.pulledAt);
      const attempt = await readAttempt();
      if (!failedLast && attempt !== null && (ageOf(attempt) ?? Infinity) < SYNC_EVERY_MS) return 'skipped';
    }
  } catch (error) {
    console.warn('cloud sync: could not check', error);
    return 'failed';
  }

  setActive(1);
  try {
    return await ifLockAvailable(async (): Promise<SyncOutcome> => {
      await writeAttempt(Date.now());
      const code = await readCode();
      if (code.kind !== 'ready') return 'skipped';
      const keys = await deriveBackupKeys(code.code);
      const { kid, copies } = await listCloudBackups();
      // Turned off or started over in another browser: as an upload refused.
      if (kid !== keys.kid) {
        await forgetRefusedCode(keys.kid, { needsCode: kid !== null });
        return 'skipped';
      }
      const merged = await mergeOtherDevices(keys, copies, { onlyNew: true });
      return merged.added + merged.updated + merged.removed > 0 ? 'merged' : 'unchanged';
    }, 'skipped');
  } catch (error) {
    if (error instanceof VaultLockedError) return 'skipped';
    console.warn('cloud sync failed', error);
    // A request cut off because the app went to the background (iOS does that
    // the moment someone switches to Safari to paste a code) is not a failure
    // to show: the next return to the window tries again.
    if (!pageHidden()) await updateSyncState({ failedAt: Date.now() }).catch(() => {});
    return 'failed';
  } finally {
    setActive(-1);
  }
}

export type CloudSyncStatus =
  /** Cloud backup is not on here — nothing to show. */
  | { state: 'off' }
  | { state: 'syncing' }
  /** `at`: the last time this device and the cloud agreed, null before the first. */
  | { state: 'ok'; at: number | null }
  /** The last upload or read failed, or the code has to be typed again. */
  | { state: 'error' };

/** Storage keys whose change can change the status. */
export const CLOUD_SYNC_STATUS_KEYS: readonly string[] = [STATE_KEY, SYNC_KEY, CLOUD_BACKUP_CODE_KEY, BILLING_KEYS.entitlement];

export async function readCloudSyncStatus(): Promise<CloudSyncStatus> {
  try {
    if (!(await cloudBackupEntitlement())) return { state: 'off' };
    const sync = await readSyncState();
    const code = await readCode();
    if (code.kind === 'unreadable') return { state: 'error' };
    if (code.kind === 'none' && sync.needsCode) return { state: 'error' };
    if (code.kind !== 'ready') return { state: 'off' };
    if (active > 0) return { state: 'syncing' };
    const up = await readUploadState();
    const failed = (at: number | null, failedAt: number | null) => failedAt !== null && (at === null || failedAt > at);
    if (failed(up.at, up.failedAt) || failed(sync.pulledAt, sync.failedAt)) return { state: 'error' };
    const times = [up.at, sync.pulledAt].filter((t): t is number => t !== null);
    return { state: 'ok', at: times.length > 0 ? Math.max(...times) : null };
  } catch {
    return { state: 'off' };
  }
}
