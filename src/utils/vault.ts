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
import { SESSION_LOCK, withAccountsLock, withLock } from './write-lock';

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
/**
 * Whether the module-scoped copy is the only copy there is — auto-lock 0 never
 * persists the key, and a refused session write leaves nothing else to read.
 *
 * Otherwise session storage is the source of truth, and deliberately so: the
 * app now runs in windows that live for hours, side by side. Reading the local
 * copy first meant "Lock now" in one of them, or the idle deadline expiring
 * there, left every other one open until it was closed and reopened.
 */
let memoryIsAuthoritative = false;

function hasSessionStorage(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.storage && !!chrome.storage.session;
}

/**
 * The session, and whether it came out of chrome.storage.session rather than
 * this context's own memory. The distinction matters on auto-lock 0 only: there
 * the key is never persisted, so one found in session storage is a leftover —
 * see pastIdleDeadline.
 */
interface ReadSession {
  state: SessionState;
  persisted: boolean;
}

async function readSession(): Promise<ReadSession | null> {
  const fromMemory = (): ReadSession | null =>
    memoryFallback ? { state: memoryFallback, persisted: false } : null;

  if (memoryIsAuthoritative || !hasSessionStorage()) return fromMemory();
  try {
    const result = await chrome.storage.session.get(SESSION_KEY);
    const state = (result[SESSION_KEY] as SessionState) || null;
    return state ? { state, persisted: true } : null;
  } catch {
    return fromMemory();
  }
}

async function writeSession(state: SessionState | null): Promise<void> {
  memoryFallback = state;
  memoryIsAuthoritative = false;
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
      memoryIsAuthoritative = state !== null;
    }
  } catch {
    // Memory fallback already holds the value.
    memoryIsAuthoritative = state !== null;
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

/**
 * What a staged key is for. A hand-off is only ever adopted by the context it
 * was staged for.
 *
 * It used to carry no purpose, and every popup open consumed whatever was
 * waiting. "Add a passkey" stages the key for the ceremony window and leaves it
 * there for up to two minutes, so anyone who clicked the toolbar icon in that
 * window — the user having walked away from the ceremony prompt, say — got the
 * vault opened without a password. The ceremony page takes only 'register', a
 * popup only 'unlock', and one never swallows the other's.
 */
export type HandoffPurpose = 'register' | 'unlock';

/** Hand the unlocked master key to the next context that asks for `purpose`, once. */
export async function stageKeyHandoff(masterKeyBytes: Uint8Array, purpose: HandoffPurpose): Promise<void> {
  if (!hasSessionStorage()) return;
  try {
    await chrome.storage.session.set({
      [HANDOFF_KEY]: { mk: toBase64(masterKeyBytes), stagedAt: Date.now(), purpose },
    });
  } catch {
    // Nothing to fall back to, and nothing is lost: the caller either still
    // holds the key or the user repeats the ceremony.
  }
}

/**
 * Take a staged key meant for `purpose`, if one is waiting. Single use: a
 * matching copy is removed whether or not it turned out valid; one staged for
 * the other purpose is left where it is for the context it belongs to.
 *
 * Only an 'unlock' hand-off is adopted as this context's session. A
 * 'register' one is returned to the ceremony page and nothing more — linking a
 * passkey is not an unlock, and must not leave that window holding an open
 * vault it was never asked to open.
 */
export async function consumeKeyHandoff(purpose: HandoffPurpose): Promise<Uint8Array | null> {
  if (!hasSessionStorage()) return null;

  let staged: { mk?: unknown; stagedAt?: unknown; purpose?: unknown } | undefined;
  try {
    staged = (await chrome.storage.session.get(HANDOFF_KEY))[HANDOFF_KEY];
  } catch {
    return null;
  }
  if (!staged || typeof staged.mk !== 'string') return null;

  // An unreadable or wound-back clock reads as expired. The failure direction
  // here has to be "make them do it again", never "accept an old key".
  const age = ageOf(typeof staged.stagedAt === 'number' ? staged.stagedAt : 0) ?? Infinity;
  const expired = age > HANDOFF_TTL_MS;

  // Not ours and still live: someone else's to take. A copy with no purpose at
  // all can only have been staged by an older build, and belongs to nobody.
  if (!expired && staged.purpose !== purpose && (staged.purpose === 'register' || staged.purpose === 'unlock')) {
    return null;
  }

  // Removed before use, and best-effort: a copy that cannot be deleted is worth
  // far less than an unlock that fails, and session storage dies with the
  // browser regardless.
  chrome.storage.session.remove(HANDOFF_KEY).catch(() => {});

  if (expired || staged.purpose !== purpose) return null;

  const masterKeyBytes = fromBase64(staged.mk);
  if (purpose === 'unlock') {
    await writeSession({ mk: staged.mk, lastActivity: Date.now() });
  }
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
  if (areaName !== 'session') return false;
  if (HANDOFF_KEY in changes) return true;

  const session = changes[SESSION_KEY] as { oldValue?: SessionState; newValue?: SessionState } | undefined;
  if (!session) return false;

  // Every key read refreshes the activity stamp, so the entry is rewritten by
  // the very re-read this event triggers. Reacting to that too made the popup
  // spin — refresh, stamp, event, refresh — hundreds of times a second for as
  // long as it was open, and each turn pushed the idle deadline out again.
  // Only the key appearing, disappearing or changing is a lock or unlock.
  return session.oldValue?.mk !== session.newValue?.mk;
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

  // A device with sync switched off does not take its vault from sync. It used
  // to: with no local metadata, whatever another machine had put up was adopted
  // on the spot, and a device that had never had a vault — whose user had
  // turned sync off precisely to keep it apart — opened on a lock screen for
  // someone else's password, with its own accounts behind it.
  if (!(await isSyncEnabled())) return localMeta ?? null;

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
  const syncOn = await isSyncEnabled();
  if (syncOn) {
    try {
      const synced = (await chrome.storage.sync.get(VAULT_META_KEY))[VAULT_META_KEY] as VaultMeta | undefined;
      seen = Math.max(seen, metaRevision(synced));
    } catch {
      // Sync unavailable — same reasoning.
    }
  }

  meta = { ...meta, rev: seen + 1, updatedAt: Date.now() };
  await chrome.storage.local.set({ [VAULT_META_KEY]: meta });
  // Metadata is a few hundred bytes — it fits sync's per-item limit even when
  // the account list does not, so cross-device unlock keeps working. It must
  // honour the sync preference: this is the wrapped master key, and leaving it
  // on Google's servers after the user asked us to stop syncing would make the
  // setting a lie. Turning sync off already removed it (setSyncEnabled); with
  // sync off this device leaves the area alone, because what is up there now
  // was put there by another machine, for that machine's other devices.
  if (syncOn) {
    chrome.storage.sync.set({ [VAULT_META_KEY]: meta }).catch(() => {});
  }
}

export async function clearVaultMeta(): Promise<void> {
  await chrome.storage.local.remove(VAULT_META_KEY);
  // Same rule as saveVaultMeta: a sync-off device switching its own vault off
  // must not delete the metadata a sync-on machine's ciphertext depends on.
  if (await isSyncEnabled()) chrome.storage.sync.remove(VAULT_META_KEY).catch(() => {});
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
  await withLock(SESSION_LOCK, lockNow);
}

/** `lock` for code already holding the session lock. */
async function lockNow(): Promise<void> {
  clearKeyCache();
  await writeSession(null);
  // A staged hand-off is an unlocked key by another name. Leaving one behind
  // would mean "lock now" did not lock.
  await clearKeyHandoff();
}

// --- passkey unlock -------------------------------------------------------

/**
 * Prove the current password and stage the master key for the passkey
 * ceremony page, which links the passkey in a window of its own.
 *
 * The password is asked even though the vault is open. A passkey is a new,
 * permanent way in: linked from an unlocked vault on the strength of the
 * session alone, anyone passing an unattended, unlocked browser could add
 * their own authenticator in a few seconds and come back for the codes any
 * time after — through every password change, since the passkey wraps the
 * master key, not the password. Turning protection off asks for the password
 * for the same reason.
 *
 * The key comes from the password wrapper, not the session, so this also
 * works on auto-lock "every open", where no other context can read the key.
 */
export async function stagePasskeyRegistration(password: string): Promise<void> {
  const masterKeyBytes = await verifyPassword(password);
  await stageKeyHandoff(masterKeyBytes, 'register');
}

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

  await updateVaultMeta(meta.vaultId, current => ({
    ...current,
    passkey: { credentialId, prfSalt, wrapped, label, addedAt: Date.now() },
  }));
}

/**
 * Write a change to the metadata, spread over the copy on disk NOW.
 *
 * Every caller does slow crypto first — PBKDF2 at 600 000 iterations, a
 * passkey ceremony — and spreading the copy it read before that over whatever
 * happened meanwhile undid it: a password changed in the side panel while the
 * passkey page was registering came back as the old password, which is then
 * the only one that works, and the one the user just replaced. Under the
 * accounts lock, re-read, refuse if the vault is not the one the change was
 * built for (a wrapper of this master key opens nothing else), and only then
 * write.
 */
async function updateVaultMeta(vaultId: string, change: (current: VaultMeta) => VaultMeta): Promise<void> {
  await withAccountsLock(async () => {
    const current = await getVaultMeta();
    if (!current || current.vaultId !== vaultId) {
      throw new Error('Password protection was changed somewhere else — nothing was changed');
    }
    await saveVaultMeta(change(current));
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
  await withAccountsLock(async () => {
    const meta = await getVaultMeta();
    if (!meta || !meta.passkey) return;

    const { passkey: _removed, ...withoutPasskey } = meta;
    await saveVaultMeta(withoutPasskey as VaultMeta);
  });
}

export async function getAutoLockMinutes(): Promise<number> {
  const result = await chrome.storage.local.get(AUTO_LOCK_KEY);
  const value = result[AUTO_LOCK_KEY];
  return typeof value === 'number' ? value : DEFAULT_AUTO_LOCK_MINUTES;
}

export async function setAutoLockMinutes(minutes: number): Promise<void> {
  // Under the session lock, so a key read in another context cannot write the
  // session back between the setting changing and the key leaving storage.
  await withLock(SESSION_LOCK, async () => {
    await chrome.storage.local.set({ [AUTO_LOCK_KEY]: minutes });
    if (minutes !== 0) return;

    // Choosing "every open" used to change the setting and nothing else. The
    // key stayed in session storage, where 0 never looks for a deadline, so
    // the next popup — hours later — opened without asking, and quick fill in
    // the service worker went on reading it. The switch now does what the
    // setting promises from then on: the key leaves shared storage, and only
    // this page, the one the user is looking at, keeps it in memory — exactly
    // the state an unlock on 0 produces.
    const session = await readSession();
    await writeSession(session ? session.state : null);
  });
}

/**
 * The unlocked master key, or null when locked/expired.
 *
 * Auto-lock is enforced lazily here rather than by a chrome.alarms timer: an
 * alarm would require an extra permission, and the key is unusable past the
 * deadline either way because every read goes through this function.
 */
export async function getMasterKeyBytes(): Promise<Uint8Array | null> {
  // Read, check and refresh as one step against "Lock now". The refresh writes
  // the whole session back, key included, so a read that had fetched the
  // session just before a lock in another context — quick fill in the service
  // worker, say, while the popup's Lock button was pressed — wrote the key
  // straight back after the lock had removed it. The vault said "locked" and
  // stayed open.
  return withLock(SESSION_LOCK, async () => {
    const session = await readSession();
    if (!session) return null;

    if (await pastIdleDeadline(session)) {
      await lockNow();
      return null;
    }

    await writeSession({ ...session.state, lastActivity: Date.now() });
    return fromBase64(session.state.mk);
  });
}

async function pastIdleDeadline({ state, persisted }: ReadSession): Promise<boolean> {
  const autoLockMinutes = await getAutoLockMinutes();

  // -1 keeps the key until the browser closes (session storage does that for
  // us). Nothing to check.
  if (autoLockMinutes < 0) return false;

  // 0 never persists the key, so the copy in this page's memory is the only
  // legitimate one. A key in session storage is left over — written before
  // the switch to 0, or by a context that raced it — and it is expired by
  // definition: honouring it is how "every open" came to mean "never" for
  // every popup after the first.
  if (autoLockMinutes === 0) return persisted;

  // A stamp we cannot trust — clock wound back, or a malformed session — is
  // treated as infinitely idle. This check is the only thing enforcing the
  // deadline the user chose, so its failure direction has to be "lock", not
  // "keep handing out the master key".
  const idleMs = ageOf(state.lastActivity) ?? Infinity;
  return idleMs > autoLockMinutes * 60_000;
}

/**
 * Lock if the idle deadline has passed. True when the vault is locked afterwards.
 *
 * The deadline is otherwise only checked when the key is read, which happens
 * when the accounts load — once per popup open, and never again in a window
 * that stays open all day. A page that outlives the deadline polls this; unlike
 * getMasterKeyBytes it does not count as activity, so polling cannot keep the
 * vault open by itself.
 */
export async function enforceAutoLock(): Promise<boolean> {
  return withLock(SESSION_LOCK, async () => {
    const session = await readSession();
    if (!session) return true;
    if (!(await pastIdleDeadline(session))) return false;
    await lockNow();
    return true;
  });
}

/**
 * Push the idle deadline out: the user did something.
 *
 * Goes through the key read on purpose, so activity that arrives after the
 * deadline locks the vault rather than extending it.
 */
export async function noteVaultActivity(): Promise<void> {
  await getMasterKeyBytes();
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
  const wrappedByPassword = await wrapMasterKey(masterKeyBytes, passwordKey);

  // Spread over the copy on disk after both derivations, not the one read
  // before them: a passkey registered meanwhile used to vanish here.
  await updateVaultMeta(meta.vaultId, current => ({
    ...current,
    salt: toBase64(salt),
    // The wrapper was just built at PBKDF2_ITERATIONS, and unwrapWith derives
    // at whatever meta.iterations says. Spreading the old count forward left
    // the two describing different keys the moment the constant differed from
    // what this vault was created with — and then neither the new password nor
    // the old one opens it, on every device, with the user holding a password
    // they set thirty seconds ago. Nothing has shipped but 600 000, so this has
    // never fired; a one-line bump of the constant, or metadata arriving by
    // sync from a build with a different one, is all it would take.
    iterations: PBKDF2_ITERATIONS,
    wrappedByPassword,
  }));

  await writeSession({ mk: toBase64(masterKeyBytes), lastActivity: Date.now() });
}

export interface PreparedRecovery {
  /** Show this and have it typed back BEFORE calling commit(). */
  recoveryCode: string;
  /**
   * Whether the vault has a passkey linked, which commit() will unlink. Read
   * when the reset was prepared; the commit drops whatever is linked by then.
   */
  removesPasskey: boolean;
  /**
   * Replaces the password and recovery wrappers and unlocks. Until this
   * resolves, the old password and the old recovery code both still work.
   */
  commit: () => Promise<void>;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/**
 * A forgotten-password reset, built and verified in memory, with nothing written.
 *
 * Split from the commit for the same reason prepareVault is. The reset rotates
 * the recovery code — the old one was just read off a screen or out of a text
 * file, so it has to be treated as spent — and the moment the new wrappers are
 * saved, the replacement exists nowhere but in memory. This used to save first
 * and show the code afterwards. Saving also writes the unlocked key to session
 * storage; the popup's storage listener reads that as "unlocked" and swaps the
 * lock screen for the account list, so the new code vanished before it could be
 * read. The user was let in once, and the next time they forgot the password
 * the only code they held was refused.
 */
export async function prepareRecovery(code: string, newPassword: string): Promise<PreparedRecovery> {
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
  const recoveryCode = generateRecoveryCode();
  const [passwordKey, recoveryKey] = await Promise.all([
    deriveKeyFromPassword(newPassword, salt),
    deriveKeyFromPassword(normalizeRecoveryCode(recoveryCode), recoverySalt),
  ]);

  const wrappers: Pick<
    VaultMeta,
    'salt' | 'iterations' | 'wrappedByPassword' | 'recoverySalt' | 'wrappedByRecovery'
  > = {
    salt: toBase64(salt),
    // Both wrappers are new, so the count that describes them must be too —
    // see changePassword.
    iterations: PBKDF2_ITERATIONS,
    wrappedByPassword: await wrapMasterKey(masterKeyBytes, passwordKey),
    recoverySalt: toBase64(recoverySalt),
    wrappedByRecovery: await wrapMasterKey(masterKeyBytes, recoveryKey),
  };

  // Opened again the way unlocking will open them — a fresh derivation at the
  // stored iteration count, through the same normalisation — rather than with
  // the keys already in hand. A wrapper that only opens with the key object that
  // built it looks fine today and fails on the one day it is needed.
  const candidate: VaultMeta = { ...meta, ...wrappers };
  const opened = await Promise.all([
    unwrapWith(candidate, newPassword, 'salt', 'wrappedByPassword'),
    unwrapWith(candidate, normalizeRecoveryCode(recoveryCode), 'recoverySalt', 'wrappedByRecovery'),
  ]).catch(() => null);
  if (!opened || !opened.every(bytes => sameBytes(bytes, masterKeyBytes))) {
    throw new Error('The new password could not be verified — nothing was changed');
  }

  let committing: Promise<void> | null = null;

  const commit = (): Promise<void> => {
    committing ??= (async () => {
      // Asked again, not only in prepare: the screen between the two is one the
      // user lingers on, copying a code onto paper, and another window can turn
      // protection off or rebuild the vault meanwhile. This master key opens
      // only the vault it was unwrapped from; written over any other, the new
      // password would open nothing.
      //
      // Spread over the copy read just now, not the one from prepare, so
      // nothing else changed in between is undone.
      //
      // Except the passkey, which goes. A recovery reset is what someone does
      // when a way in is lost or may be in the wrong hands — the recovery code
      // is rotated for exactly that reason — and a passkey linked before it
      // went on opening the vault afterwards, silently. Whoever the reset was
      // meant to shut out kept a key. The user adds their own passkey again
      // in one step; LockScreen tells them so.
      await updateVaultMeta(meta.vaultId, current => {
        const { passkey: _unlinked, ...rest } = current;
        return { ...rest, ...wrappers } as VaultMeta;
      });
      await writeSession({ mk: toBase64(masterKeyBytes), lastActivity: Date.now() });
    })().catch(error => {
      committing = null;
      throw error;
    });
    return committing;
  };

  return { recoveryCode, removesPasskey: !!meta.passkey, commit };
}

/** Verifies a password without changing session state. */
export async function verifyPassword(password: string): Promise<Uint8Array> {
  const meta = await getVaultMeta();
  if (!meta) throw new Error('No vault configured');
  return unwrapWith(meta, password, 'salt', 'wrappedByPassword');
}

/** Re-export so UI code has a single import site for vault concerns. */
export { encryptJson, generateRecoveryCode };
