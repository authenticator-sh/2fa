// Lifecycle of the optional password-protected vault: creation, unlocking,
// auto-lock, password change and recovery.
//
// This module owns key material and vault metadata only. Encrypting the actual
// account records lives in storage.ts, which consumes getMasterKeyBytes() —
// keeping the dependency one-directional (crypto -> vault -> storage).
//
// Where the unlocked key lives, and why:
// MV3 evicts the service worker after ~30s idle and the popup is destroyed on
// every close, so a key held in JS memory would mean re-entering the password
// on every single click of the toolbar icon. chrome.storage.session is memory
// backed, never written to disk, cleared when the browser closes, and is not
// reachable from content scripts — which is exactly the lifetime we want. It
// is covered by the "storage" permission we already hold, so this costs no new
// permission (using chrome.alarms for auto-lock would have).

import {
  deriveKeyFromPassword,
  encryptJson,
  fromBase64,
  generateRecoveryCode,
  importFingerprintKey,
  importMasterKey,
  newMasterKeyBytes,
  newSalt,
  normalizeRecoveryCode,
  PBKDF2_ITERATIONS,
  toBase64,
  unwrapMasterKey,
  wrapMasterKey,
} from './crypto';
import { isSyncEnabled } from './sync-preference';

const VAULT_META_KEY = 'vault_meta';
const SESSION_KEY = 'vault_session';
const AUTO_LOCK_KEY = 'vault_autolock_minutes';

/** 0 = require the password every time the popup opens. */
export const AUTO_LOCK_OPTIONS = [0, 5, 15, 60, -1] as const;
/** -1 = stay unlocked until the browser is closed. */
export const DEFAULT_AUTO_LOCK_MINUTES = 15;

export interface VaultMeta {
  v: 1;
  vaultId: string;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  /** Salt for the password-derived key-encryption key. */
  salt: string;
  wrappedByPassword: string;
  /** Independent salt so the recovery code never shares a KDF stream. */
  recoverySalt: string;
  wrappedByRecovery: string;
  createdAt: number;
  /**
   * Bumped on every write. Without it, a device that cached the metadata from
   * sync never noticed a password change made elsewhere: the user's new, correct
   * password was rejected here forever, while the old one kept unwrapping the
   * same master key — a live backdoor on every other device.
   */
  updatedAt?: number;
}

function metaVersion(meta: VaultMeta): number {
  return meta.updatedAt ?? meta.createdAt;
}

interface SessionState {
  mk: string;
  lastActivity: number;
}

export class VaultLockedError extends Error {
  constructor() {
    super('Vault is locked');
    this.name = 'VaultLockedError';
  }
}

export class WrongPasswordError extends Error {
  constructor() {
    super('Incorrect password');
    this.name = 'WrongPasswordError';
  }
}

// --- session storage ------------------------------------------------------
// chrome.storage.session landed in Chrome 102. On anything older we degrade to
// a module-scoped variable: the vault still works, it just re-prompts on every
// popup open rather than breaking outright.
let memoryFallback: SessionState | null = null;

function hasSessionStorage(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.storage && !!chrome.storage.session;
}

async function readSession(): Promise<SessionState | null> {
  if (memoryFallback) return memoryFallback;
  if (!hasSessionStorage()) return null;
  try {
    const result = await chrome.storage.session.get(SESSION_KEY);
    return (result[SESSION_KEY] as SessionState) || null;
  } catch {
    return null;
  }
}

async function writeSession(state: SessionState | null): Promise<void> {
  memoryFallback = state;
  if (!hasSessionStorage()) return;

  // With auto-lock set to 0 the key must not outlive the current popup, so it
  // is never handed to session storage — the module-scoped copy above dies
  // with the page.
  const persist = state !== null && (await getAutoLockMinutes()) !== 0;

  try {
    if (persist) {
      await chrome.storage.session.set({ [SESSION_KEY]: state });
    } else {
      await chrome.storage.session.remove(SESSION_KEY);
    }
  } catch {
    // Memory fallback already holds the value.
  }
}

// --- vault metadata -------------------------------------------------------

export async function getVaultMeta(): Promise<VaultMeta | null> {
  const localMeta = (await chrome.storage.local.get(VAULT_META_KEY))[VAULT_META_KEY] as
    | VaultMeta
    | undefined;

  let syncedMeta: VaultMeta | undefined;
  try {
    syncedMeta = (await chrome.storage.sync.get(VAULT_META_KEY))[VAULT_META_KEY] as
      | VaultMeta
      | undefined;
  } catch {
    // Sync unavailable — fall back to whatever is local.
  }

  if (!syncedMeta) return localMeta ?? null;

  // A fresh install on a second device has the synced records but no local
  // metadata, so there is nothing here that adopting could strand.
  if (!localMeta) {
    await chrome.storage.local.set({ [VAULT_META_KEY]: syncedMeta });
    return syncedMeta;
  }

  // Same vault: a newer copy is a password change made on another device, and
  // adopting it is the entire reason this comparison exists — without it the
  // user's new password is rejected here forever while the old one keeps
  // working, which is a live backdoor on every device that missed the change.
  if (syncedMeta.vaultId === localMeta.vaultId) {
    if (metaVersion(syncedMeta) > metaVersion(localMeta)) {
      await chrome.storage.local.set({ [VAULT_META_KEY]: syncedMeta });
      return syncedMeta;
    }
    return localMeta;
  }

  // Different vault. Whatever the timestamps say, this metadata cannot open the
  // records this device holds — and `updatedAt` is a wall clock, so "newer" also
  // loses to a skewed clock on the other machine.
  //
  // Overwriting here was unrecoverable: the local wrapping is the only copy of
  // the key for the local ciphertext, and replacing it left every account
  // quarantined with nothing anywhere able to decrypt them. Two vaults existing
  // at once is a state the user has to resolve; it is not one we may resolve for
  // them by discarding a key.
  console.warn(
    'Ignoring vault metadata from sync: it belongs to a different vault than the records ' +
      'on this device. Both vaults still have their own key.'
  );
  return localMeta;
}

export async function isVaultEnabled(): Promise<boolean> {
  return (await getVaultMeta()) !== null;
}

export async function saveVaultMeta(meta: VaultMeta): Promise<void> {
  meta = { ...meta, updatedAt: Date.now() };
  await chrome.storage.local.set({ [VAULT_META_KEY]: meta });
  // Metadata is a few hundred bytes — it fits sync's per-item limit even when
  // the account list does not, so cross-device unlock keeps working. It must
  // honour the sync preference: this is the wrapped master key, and leaving it
  // on Google's servers after the user asked us to stop syncing would make the
  // setting a lie.
  if (await isSyncEnabled()) {
    chrome.storage.sync.set({ [VAULT_META_KEY]: meta }).catch(() => {});
  } else {
    chrome.storage.sync.remove(VAULT_META_KEY).catch(() => {});
  }
}

export async function clearVaultMeta(): Promise<void> {
  await chrome.storage.local.remove(VAULT_META_KEY);
  chrome.storage.sync.remove(VAULT_META_KEY).catch(() => {});
}

/**
 * Build metadata for a brand-new vault. Does not persist anything — the caller
 * (storage.enableVault) must first prove it can re-read the encrypted data.
 */
export async function createVaultMeta(password: string): Promise<{
  meta: VaultMeta;
  masterKeyBytes: Uint8Array;
  recoveryCode: string;
}> {
  const masterKeyBytes = newMasterKeyBytes();
  const salt = newSalt();
  const recoverySalt = newSalt();
  const recoveryCode = generateRecoveryCode();

  const passwordKey = await deriveKeyFromPassword(password, salt);
  const recoveryKey = await deriveKeyFromPassword(normalizeRecoveryCode(recoveryCode), recoverySalt);

  const meta: VaultMeta = {
    v: 1,
    vaultId: toBase64(crypto.getRandomValues(new Uint8Array(8))),
    kdf: 'PBKDF2-SHA256',
    iterations: PBKDF2_ITERATIONS,
    salt: toBase64(salt),
    wrappedByPassword: await wrapMasterKey(masterKeyBytes, passwordKey),
    recoverySalt: toBase64(recoverySalt),
    wrappedByRecovery: await wrapMasterKey(masterKeyBytes, recoveryKey),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  return { meta, masterKeyBytes, recoveryCode };
}

// --- unlocking ------------------------------------------------------------

async function unwrapWith(
  meta: VaultMeta,
  secret: string,
  saltField: 'salt' | 'recoverySalt',
  wrappedField: 'wrappedByPassword' | 'wrappedByRecovery'
): Promise<Uint8Array> {
  const key = await deriveKeyFromPassword(secret, fromBase64(meta[saltField]), meta.iterations);
  try {
    return await unwrapMasterKey(meta[wrappedField], key);
  } catch {
    // AES-GCM authentication failure is the only way we learn the secret was
    // wrong — there is deliberately no verifier stored separately.
    throw new WrongPasswordError();
  }
}

export async function unlockWithPassword(password: string): Promise<Uint8Array> {
  const meta = await getVaultMeta();
  if (!meta) throw new Error('No vault configured');

  const masterKeyBytes = await unwrapWith(meta, password, 'salt', 'wrappedByPassword');
  await writeSession({ mk: toBase64(masterKeyBytes), lastActivity: Date.now() });
  return masterKeyBytes;
}

export async function unlockWithRecoveryCode(code: string): Promise<Uint8Array> {
  const meta = await getVaultMeta();
  if (!meta) throw new Error('No vault configured');

  const masterKeyBytes = await unwrapWith(
    meta,
    normalizeRecoveryCode(code),
    'recoverySalt',
    'wrappedByRecovery'
  );
  await writeSession({ mk: toBase64(masterKeyBytes), lastActivity: Date.now() });
  return masterKeyBytes;
}

export async function lock(): Promise<void> {
  clearKeyCache();
  await writeSession(null);
}

export async function getAutoLockMinutes(): Promise<number> {
  const result = await chrome.storage.local.get(AUTO_LOCK_KEY);
  const value = result[AUTO_LOCK_KEY];
  return typeof value === 'number' ? value : DEFAULT_AUTO_LOCK_MINUTES;
}

export async function setAutoLockMinutes(minutes: number): Promise<void> {
  await chrome.storage.local.set({ [AUTO_LOCK_KEY]: minutes });
}

/**
 * The unlocked master key, or null when locked/expired.
 *
 * Auto-lock is enforced lazily here rather than by a chrome.alarms timer: an
 * alarm would require an extra permission, and the key is unusable past the
 * deadline either way because every read goes through this function.
 */
export async function getMasterKeyBytes(): Promise<Uint8Array | null> {
  const session = await readSession();
  if (!session) return null;

  const autoLockMinutes = await getAutoLockMinutes();

  // -1 keeps the key until the browser closes (session storage does that for
  // us); 0 never persisted it in the first place. Only positive values need an
  // idle deadline checked here.
  if (autoLockMinutes > 0) {
    const idleMs = Date.now() - session.lastActivity;
    if (idleMs > autoLockMinutes * 60_000) {
      await lock();
      return null;
    }
  }

  await writeSession({ ...session, lastActivity: Date.now() });
  return fromBase64(session.mk);
}

export async function isUnlocked(): Promise<boolean> {
  return (await getMasterKeyBytes()) !== null;
}

// --- derived keys ---------------------------------------------------------
// Cached because storage.ts derives them once per account read; importKey is
// cheap but HKDF on every record in a 50-account list is measurable in a popup
// that must paint instantly.
let cachedKeys: { mk: string; dataKey: CryptoKey; fingerprintKey: CryptoKey } | null = null;

export async function deriveKeys(
  masterKeyBytes: Uint8Array
): Promise<{ dataKey: CryptoKey; fingerprintKey: CryptoKey }> {
  const cacheId = toBase64(masterKeyBytes);
  if (cachedKeys && cachedKeys.mk === cacheId) {
    return { dataKey: cachedKeys.dataKey, fingerprintKey: cachedKeys.fingerprintKey };
  }

  const dataKey = await importMasterKey(masterKeyBytes);
  const fingerprintKey = await importFingerprintKey(masterKeyBytes);
  cachedKeys = { mk: cacheId, dataKey, fingerprintKey };
  return { dataKey, fingerprintKey };
}

export function clearKeyCache(): void {
  cachedKeys = null;
}

// --- password management --------------------------------------------------

/**
 * Re-wraps the existing master key under a new password. Account records,
 * backups and previous exports are untouched — that is the whole point of the
 * two-level key design.
 */
export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  const meta = await getVaultMeta();
  if (!meta) throw new Error('No vault configured');

  const masterKeyBytes = await unwrapWith(meta, currentPassword, 'salt', 'wrappedByPassword');
  const salt = newSalt();
  const passwordKey = await deriveKeyFromPassword(newPassword, salt);

  await saveVaultMeta({
    ...meta,
    salt: toBase64(salt),
    wrappedByPassword: await wrapMasterKey(masterKeyBytes, passwordKey),
  });

  await writeSession({ mk: toBase64(masterKeyBytes), lastActivity: Date.now() });
}

/**
 * Sets a new password after a recovery-code unlock, and rotates the recovery
 * code — the old one was just read aloud from a screen or a text file, so it
 * has to be treated as spent.
 */
export async function resetPasswordWithRecoveryCode(
  code: string,
  newPassword: string
): Promise<string> {
  const meta = await getVaultMeta();
  if (!meta) throw new Error('No vault configured');

  const masterKeyBytes = await unwrapWith(
    meta,
    normalizeRecoveryCode(code),
    'recoverySalt',
    'wrappedByRecovery'
  );

  const salt = newSalt();
  const recoverySalt = newSalt();
  const newRecoveryCode = generateRecoveryCode();
  const passwordKey = await deriveKeyFromPassword(newPassword, salt);
  const recoveryKey = await deriveKeyFromPassword(normalizeRecoveryCode(newRecoveryCode), recoverySalt);

  await saveVaultMeta({
    ...meta,
    salt: toBase64(salt),
    wrappedByPassword: await wrapMasterKey(masterKeyBytes, passwordKey),
    recoverySalt: toBase64(recoverySalt),
    wrappedByRecovery: await wrapMasterKey(masterKeyBytes, recoveryKey),
  });

  await writeSession({ mk: toBase64(masterKeyBytes), lastActivity: Date.now() });
  return newRecoveryCode;
}

/** Verifies a password without changing session state. */
export async function verifyPassword(password: string): Promise<Uint8Array> {
  const meta = await getVaultMeta();
  if (!meta) throw new Error('No vault configured');
  return unwrapWith(meta, password, 'salt', 'wrappedByPassword');
}

/** Re-export so UI code has a single import site for vault concerns. */
export { encryptJson, generateRecoveryCode };
