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
  deriveKeyFromPrf,
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
import { ageOf } from './clock';
import { isSyncEnabled } from './sync-preference';

const VAULT_META_KEY = 'vault_meta';
const SESSION_KEY = 'vault_session';
const AUTO_LOCK_KEY = 'vault_autolock_minutes';
const HANDOFF_KEY = 'vault_handoff';
/** A ceremony is a few seconds of biometrics; two minutes is generous. */
const HANDOFF_TTL_MS = 120_000;

/** 0 = require the password every time the popup opens. */
export const AUTO_LOCK_OPTIONS = [0, 5, 15, 60, -1] as const;
/** -1 = stay unlocked until the browser is closed. */
export const DEFAULT_AUTO_LOCK_MINUTES = 15;

/**
 * A third way to unwrap the master key, alongside the password and the recovery
 * code: the output of a passkey's PRF extension.
 *
 * Deliberately additive and never exclusive. The password and recovery wrappers
 * are always kept, so losing the passkey — a wiped phone, a reset laptop, a
 * password manager that dropped it — costs convenience and nothing else. A
 * design where the passkey were the only wrapper would create a brand-new way
 * to destroy every 2FA seed, which is the objection this whole feature would
 * fail on.
 */
export interface VaultPasskey {
  /** Base64 raw credential id, for allowCredentials on unlock. Not secret. */
  credentialId: string;
  /** Base64 PRF input. Not secret; it only has to be stable per vault. */
  prfSalt: string;
  /** The master key, wrapped under the PRF-derived key. */
  wrapped: string;
  /** What the user called this passkey, shown in settings. */
  label: string;
  addedAt: number;
}

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
  /**
   * Write counter, incremented on every save from the highest revision this
   * device can see — local or synced.
   *
   * `updatedAt` alone could not order two devices: it is a raw wall clock, so a
   * machine whose clock ran a year fast outranked every later change made
   * anywhere else, permanently. On that machine the user's new password was
   * rejected and the old one went on working, which is precisely the backdoor
   * `updatedAt` was added to close.
   *
   * Optional because metadata written before 1.12.0 has none. A missing
   * revision counts as zero, and equal revisions fall back to the clock — which
   * is exactly the old behaviour, so a device still running an older version
   * keeps ordering writes the way it always did.
   */
  rev?: number;
  /**
   * Optional passkey wrapper. Absent on every vault created before 1.12.0 and
   * on every vault whose owner never turned it on, which is the default.
   */
  passkey?: VaultPasskey;
}

function metaVersion(meta: VaultMeta): number {
  return meta.updatedAt ?? meta.createdAt;
}

function metaRevision(meta: VaultMeta | undefined): number {
  return typeof meta?.rev === 'number' && Number.isFinite(meta.rev) ? meta.rev : 0;
}

/** Whether `candidate` supersedes `current`, for two copies of the same vault. */
function supersedes(candidate: VaultMeta, current: VaultMeta): boolean {
  const a = metaRevision(candidate);
  const b = metaRevision(current);

  // Both counters present — both copies were written by a version that keeps
  // one, so they are the authority and the clock only breaks ties.
  if (a > 0 && b > 0) {
    return a !== b ? a > b : metaVersion(candidate) > metaVersion(current);
  }

  // One side has no counter, because a version that does not write one touched
  // it last. A counter cannot order that pair, so either signal claiming to be
  // newer is enough. Refusing here is what would hurt: a password change made
  // from an older device would be ignored forever, and its old password would
  // go on opening this vault — the backdoor the counter exists to close.
  return a > b || metaVersion(candidate) > metaVersion(current);
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

// --- one-shot key hand-off between extension contexts ---------------------
//
// The passkey ceremony has to run in a page of its own (the popup is destroyed
// when the authenticator prompt takes focus), and a page is a separate JS
// context: the module-scoped `memoryFallback` above is not shared with it.
//
// In every auto-lock mode but one that does not matter, because the session
// entry in chrome.storage.session is visible to both. With auto-lock set to
// "every open" (0) it matters completely: writeSession deliberately refuses to
// persist, so the key exists only in whichever context unlocked it. Without a
// hand-off, on that setting registering a passkey is impossible (the ceremony
// page cannot read the master key) and unlocking with one silently does nothing
// (the popup opens still locked). Both were verified before this was added.
//
// So the key crosses once, explicitly, and is consumed on first read. That
// preserves what auto-lock 0 actually promises — the key does not outlive the
// popup that used it — while letting a ceremony in another window count as the
// authentication event for exactly one popup. It lives in session storage,
// which is memory-only, cleared when the browser closes and unreachable from
// content scripts, and it expires.

/** Hand the unlocked master key to the next context that asks, once. */
export async function stageKeyHandoff(masterKeyBytes: Uint8Array): Promise<void> {
  if (!hasSessionStorage()) return;
  try {
    await chrome.storage.session.set({
      [HANDOFF_KEY]: { mk: toBase64(masterKeyBytes), stagedAt: Date.now() },
    });
  } catch {
    // Nothing to fall back to, and nothing is lost: the caller either still
    // holds the key or the user repeats the ceremony.
  }
}

/**
 * Take a staged key, if one is waiting, and adopt it as this context's session.
 * Single use: the staged copy is removed whether or not it turned out valid.
 */
export async function consumeKeyHandoff(): Promise<Uint8Array | null> {
  if (!hasSessionStorage()) return null;

  let staged: { mk?: unknown; stagedAt?: unknown } | undefined;
  try {
    staged = (await chrome.storage.session.get(HANDOFF_KEY))[HANDOFF_KEY];
  } catch {
    return null;
  }
  if (!staged || typeof staged.mk !== 'string') return null;

  // Removed before use, and best-effort: a copy that cannot be deleted is worth
  // far less than an unlock that fails, and session storage dies with the
  // browser regardless.
  chrome.storage.session.remove(HANDOFF_KEY).catch(() => {});

  // An unreadable or wound-back clock reads as expired. The failure direction
  // here has to be "make them do it again", never "accept an old key".
  const age = ageOf(typeof staged.stagedAt === 'number' ? staged.stagedAt : 0) ?? Infinity;
  if (age > HANDOFF_TTL_MS) return null;

  const masterKeyBytes = fromBase64(staged.mk);
  await writeSession({ mk: staged.mk, lastActivity: Date.now() });
  return masterKeyBytes;
}

/**
 * Whether a storage change event means this context's lock state may have moved.
 *
 * Extracted rather than inlined in the hook so it can be tested: the popup's only
 * way of learning that a ceremony in another window unlocked the vault is one of
 * these events. Before this existed the popup sat on the lock screen until it was
 * closed and reopened, which is what a user actually reported.
 */
export function affectsVaultSession(
  areaName: string,
  changes: Record<string, unknown>
): boolean {
  return areaName === 'session' && (HANDOFF_KEY in changes || SESSION_KEY in changes);
}

export async function clearKeyHandoff(): Promise<void> {
  if (!hasSessionStorage()) return;
  await chrome.storage.session.remove(HANDOFF_KEY).catch(() => {});
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
    if (supersedes(syncedMeta, localMeta)) {
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
  // One past the highest revision anywhere in reach, so this write outranks
  // both copies no matter what either machine's clock says.
  let seen = metaRevision(meta);
  try {
    const local = (await chrome.storage.local.get(VAULT_META_KEY))[VAULT_META_KEY] as VaultMeta | undefined;
    seen = Math.max(seen, metaRevision(local));
  } catch {
    // Unreadable — the counter can only be too low, never wrong in a way that
    // loses a change: a later write on any device will pass it.
  }
  try {
    const synced = (await chrome.storage.sync.get(VAULT_META_KEY))[VAULT_META_KEY] as VaultMeta | undefined;
    seen = Math.max(seen, metaRevision(synced));
  } catch {
    // Sync unavailable — same reasoning.
  }

  meta = { ...meta, rev: seen + 1, updatedAt: Date.now() };
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
  // A staged hand-off is an unlocked key by another name. Leaving one behind
  // would mean "lock now" did not lock.
  await clearKeyHandoff();
}

// --- passkey unlock -------------------------------------------------------

export async function getVaultPasskey(): Promise<VaultPasskey | null> {
  return (await getVaultMeta())?.passkey ?? null;
}

/**
 * Wrap the master key under a passkey's PRF output and store the wrapper.
 *
 * Order is not stylistic. The wrapper is built and then unwrapped again in
 * memory, and only a byte-for-byte match with the key we started from is
 * allowed to reach storage. Writing first and verifying later is how a vault
 * ends up holding a wrapper that opens nothing — and on a platform where PRF
 * quietly returns a different value on the next assertion, an unverified write
 * would look fine today and fail on the one day it is needed.
 */
export async function attachPasskey(
  masterKeyBytes: Uint8Array,
  credentialId: string,
  prfSalt: string,
  prfOutput: Uint8Array,
  label: string
): Promise<void> {
  const meta = await getVaultMeta();
  if (!meta) throw new Error('No vault configured');

  const wrappingKey = await deriveKeyFromPrf(prfOutput);
  const wrapped = await wrapMasterKey(masterKeyBytes, wrappingKey);

  const check = await unwrapMasterKey(wrapped, await deriveKeyFromPrf(prfOutput));
  const matches =
    check.length === masterKeyBytes.length && check.every((byte, i) => byte === masterKeyBytes[i]);
  if (!matches) {
    throw new Error('Passkey wrapper did not round-trip; nothing was saved');
  }

  await saveVaultMeta({
    ...meta,
    passkey: { credentialId, prfSalt, wrapped, label, addedAt: Date.now() },
  });
}

export async function unlockWithPasskey(prfOutput: Uint8Array): Promise<Uint8Array> {
  const meta = await getVaultMeta();
  if (!meta) throw new Error('No vault configured');
  if (!meta.passkey) throw new Error('No passkey is registered for this vault');

  let masterKeyBytes: Uint8Array;
  try {
    masterKeyBytes = await unwrapMasterKey(meta.passkey.wrapped, await deriveKeyFromPrf(prfOutput));
  } catch {
    // Same reasoning as the password path: a GCM authentication failure is the
    // only signal, and it means this passkey is not the one that wrapped this
    // vault — most often because the vault was rebuilt on another device.
    throw new WrongPasswordError();
  }

  await writeSession({ mk: toBase64(masterKeyBytes), lastActivity: Date.now() });
  return masterKeyBytes;
}

/**
 * Forget the passkey wrapper. The password and recovery wrappers are untouched,
 * so this can never leave the vault unopenable.
 */
export async function detachPasskey(): Promise<void> {
  const meta = await getVaultMeta();
  if (!meta || !meta.passkey) return;

  const { passkey: _removed, ...withoutPasskey } = meta;
  await saveVaultMeta(withoutPasskey as VaultMeta);
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
    // A stamp we cannot trust — clock wound back, or a malformed session — is
    // treated as infinitely idle. This check is the only thing enforcing the
    // deadline the user chose, so its failure direction has to be "lock", not
    // "keep handing out the master key".
    const idleMs = ageOf(session.lastActivity) ?? Infinity;
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
