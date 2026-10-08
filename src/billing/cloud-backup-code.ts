// Where cloud backup's recovery code is kept, and how it follows the vault.
//
// Its own module because storage.ts has to reach it — turning password
// protection on seals the code, turning it off opens it — and storage.ts
// cannot import cloud-backup.ts, which imports storage.ts.
//
// The code lives under one name in chrome.storage.local and, while sync is on,
// chrome.storage.sync: in the clear ({c}) without password protection, and
// otherwise wrapped ({w, v}) under a key derived from the vault's master key,
// `v` being the vault it belongs to. Never in the clear while a vault exists:
// with this install's id and the code, the copies on our server open without
// the password that protects everything else on this disk.

import { decryptJson, encryptJson, normalizeRecoveryCode, type EncryptedPayload } from '@/utils/crypto';
import { isSyncEnabled } from '@/utils/sync-preference';
import { getVaultMeta, peekMasterKeyBytes } from '@/utils/vault';

/** The code, in chrome.storage.local and — while sync is on — chrome.storage.sync. */
export const CLOUD_BACKUP_CODE_KEY = 'cloudBackupCode';

/** The code in the clear, or wrapped under the vault (`v` is the vault it belongs to). */
export type StoredCode = { c: string } | { w: EncryptedPayload; v: string };

const encoder = new TextEncoder();

export function readStoredCode(value: unknown): StoredCode | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.c === 'string' && normalizeRecoveryCode(v.c).length === 20) return { c: normalizeRecoveryCode(v.c) };
  if (typeof v.w === 'string' && typeof v.v === 'string') return { w: v.w, v: v.v };
  return null;
}

/** The key that wraps the stored code while password protection is on. */
async function wrappingKey(masterKey: Uint8Array): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey('raw', masterKey as BufferSource, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode('authenticator-cloud-backup-code-wrap-v1') },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function wrapCode(code: string, masterKey: Uint8Array, vaultId: string): Promise<StoredCode> {
  return { w: await encryptJson(normalizeRecoveryCode(code), await wrappingKey(masterKey)), v: vaultId };
}

/** The code inside `stored`, if this master key opens it. */
export async function openCode(stored: StoredCode, masterKey: Uint8Array | null, vaultId: string | null): Promise<string | null> {
  if ('c' in stored) return stored.c;
  if (!masterKey || stored.v !== vaultId) return null;
  try {
    const code = normalizeRecoveryCode(await decryptJson<string>(stored.w, await wrappingKey(masterKey)));
    return code.length === 20 ? code : null;
  } catch {
    return null;
  }
}

export async function readLocalCode(): Promise<StoredCode | null> {
  try {
    return readStoredCode((await chrome.storage.local.get(CLOUD_BACKUP_CODE_KEY))[CLOUD_BACKUP_CODE_KEY]);
  } catch {
    return null;
  }
}

export async function readSyncedCode(): Promise<StoredCode | null> {
  try {
    if (!(await isSyncEnabled())) return null;
    return readStoredCode((await chrome.storage.sync.get(CLOUD_BACKUP_CODE_KEY))[CLOUD_BACKUP_CODE_KEY]);
  } catch {
    return null;
  }
}

/**
 * Writes the code here and — while sync is on — to sync; null forgets it in
 * both. `syncToo: false` leaves sync alone: what another profile put there is
 * not this one's to replace on a hunch.
 */
export async function putStoredCode(value: StoredCode | null, options: { syncToo?: boolean } = {}): Promise<void> {
  if (value === null) await chrome.storage.local.remove(CLOUD_BACKUP_CODE_KEY);
  else await chrome.storage.local.set({ [CLOUD_BACKUP_CODE_KEY]: value });
  if (options.syncToo === false || !(await isSyncEnabled())) return;
  try {
    if (value === null) await chrome.storage.sync.remove(CLOUD_BACKUP_CODE_KEY);
    else await chrome.storage.sync.set({ [CLOUD_BACKUP_CODE_KEY]: value });
  } catch {
    // Only the other profiles' convenience is lost; this one has its copy.
  }
}

/** The stored form for `code` as things stand: wrapped when there is a vault. Null when it is locked. */
export async function storedFormFor(code: string): Promise<StoredCode | null> {
  const meta = await getVaultMeta();
  if (!meta) return { c: normalizeRecoveryCode(code) };
  const mk = await peekMasterKeyBytes();
  return mk ? wrapCode(code, mk, meta.vaultId) : null;
}

/**
 * Password protection was just turned on (storage.ts prepareVault, after the
 * vault is real): wrap a code kept in the clear, here and in sync. Never
 * throws; a code that cannot be wrapped is removed instead — the person has it
 * on paper, and a readable code under a vault is the one outcome not allowed.
 */
export async function sealCodeUnderVault(masterKey: Uint8Array, vaultId: string): Promise<void> {
  try {
    // Each place on its own: local and sync can hold different codes (another
    // profile started over), and a readable one in either is a readable one.
    // Nothing is copied from one to the other here — adopting is readCode's,
    // which knows which codes the server refused.
    const local = await readLocalCode();
    if (local && 'c' in local) await chrome.storage.local.set({ [CLOUD_BACKUP_CODE_KEY]: await wrapCode(local.c, masterKey, vaultId) });
    const synced = await readSyncedCode();
    if (synced && 'c' in synced) await chrome.storage.sync.set({ [CLOUD_BACKUP_CODE_KEY]: await wrapCode(synced.c, masterKey, vaultId) });
  } catch (error) {
    console.warn('cloud backup: could not seal the code under the vault; removing it', error);
    try {
      const local = await readLocalCode();
      if (local && 'c' in local) await chrome.storage.local.remove(CLOUD_BACKUP_CODE_KEY);
      const synced = await readSyncedCode();
      if (synced && 'c' in synced) await chrome.storage.sync.remove(CLOUD_BACKUP_CODE_KEY);
    } catch {
      // Nothing more to try.
    }
  }
}

/**
 * Password protection is being turned off (storage.ts disableVault, before
 * the metadata goes): the wrapped code would open with nothing afterwards, and
 * backups would stop without a word. Put it back in the clear, like the
 * accounts themselves. Never throws: at worst the person types the code again.
 */
export async function openCodeFromVault(masterKey: Uint8Array, vaultId: string): Promise<void> {
  try {
    for (const [area, read] of [
      ['local', readLocalCode],
      ['sync', readSyncedCode],
    ] as const) {
      const stored = await read();
      if (!stored || 'c' in stored || stored.v !== vaultId) continue;
      const code = await openCode(stored, masterKey, vaultId);
      if (!code) continue;
      await chrome.storage[area].set({ [CLOUD_BACKUP_CODE_KEY]: { c: code } });
    }
  } catch (error) {
    console.warn('cloud backup: could not take the code out of the vault', error);
  }
}
