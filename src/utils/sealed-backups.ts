// Aegis and 2FAS backups exported with a password, opened with that password.
//
// We used to refuse these with "export it again without a password". That
// advice puts every secret in a plain file in Downloads, where it tends to
// stay, so opening the encrypted file is the safer path. The rule is now the
// same as for FreeOTP (freeotp.ts): another app's password is asked for only
// to open its file here, and it is not kept. Proton Authenticator's sealed
// file is still refused: it needs Argon2id, which WebCrypto does not have,
// and Proton exports without a password too.
//
// Each file opens into the plain shape readImportFile already reads, so the
// accounts take one path from here on, whether the file had a password or not.
//
// The formats, as the apps write them and Aegis's importers read them
// (VaultFile/Slot/PasswordSlotDecryptTask.java and TwoFASImporter.java, checked
// against the encrypted backups in Aegis's tests, 2026-10-28):
// - Aegis: `db` is Base64 of the vault JSON, AES-GCM under a random master
//   key (nonce and tag in `header.params`). Each password slot in
//   `header.slots` (type 1) holds that master key, AES-GCM under
//   scrypt(password, salt, n, r, p). Slots of other types are opened with a
//   key in the phone's keystore, which never leaves it.
// - 2FAS: `servicesEncrypted` is "ciphertext+tag:salt:iv", each Base64, AES-GCM
//   under PBKDF2-HMAC-SHA256(password, salt, 10 000), and holds the `services`
//   array. `reference` is the same key over a fixed text, used by 2FAS to check
//   the password; the GCM tag does that here.

import { DamagedBackupFileError, WrongExportPasswordError } from './backup-file';
import { fromBase64 } from './crypto';
import { scrypt } from './scrypt';

export type SealedBackupApp = 'Aegis' | '2FAS';

const AEGIS_PASSWORD_SLOT = 1;
const TWOFAS_ITERATIONS = 10_000;
/**
 * Bounds on a slot's scrypt parameters, checked before deriving: the file
 * chooses them, and its N·r is memory. Aegis writes N = 2^15, r = 8, p = 1
 * (32 MB); these allow 32 times that work and 4 times that memory.
 */
const MAX_SCRYPT_MEMORY = 128 * 1024 * 1024;
const MAX_SCRYPT_WORK = 32 * 128 * 8 * 32768;

/** The app whose password a parsed JSON backup is sealed with, or null for anything else. */
export function sealedBackupApp(parsed: unknown): SealedBackupApp | null {
  const file = record(parsed);
  if (!file) return null;
  // The same shapes readImportFile tells these apps apart by.
  if ('header' in file && typeof file.db === 'string') return 'Aegis';
  const services = Array.isArray(file.services) ? file.services : [];
  if (services.length === 0 && typeof file.servicesEncrypted === 'string' && file.servicesEncrypted) return '2FAS';
  return null;
}

/**
 * The same file with its accounts opened, for readImportFile. Throws
 * WrongExportPasswordError when the password does not open it,
 * DamagedBackupFileError when the file is not the shape the app writes.
 */
export async function openSealedBackup(parsed: unknown, password: string): Promise<Record<string, unknown>> {
  const file = record(parsed);
  const app = sealedBackupApp(parsed);
  if (!file || !app) throw new DamagedBackupFileError('not an encrypted Aegis or 2FAS backup');
  return app === 'Aegis' ? openAegis(file, password) : openTwoFas(file, password);
}

interface AegisSlot {
  key: Uint8Array;
  nonce: Uint8Array;
  salt: Uint8Array;
  n: number;
  r: number;
  p: number;
}

async function openAegis(file: Record<string, unknown>, password: string): Promise<Record<string, unknown>> {
  let slots: AegisSlot[];
  let sealed: { data: Uint8Array; nonce: Uint8Array };
  try {
    const header = record(file.header);
    const params = record(header?.params);
    slots = (Array.isArray(header?.slots) ? header.slots : [])
      .map(record)
      .filter(slot => slot?.type === AEGIS_PASSWORD_SLOT)
      .map(slot => {
        const keyParams = record(slot!.key_params);
        return {
          key: concat(hex(slot!.key), hex(keyParams?.tag)),
          nonce: hex(keyParams?.nonce),
          salt: hex(slot!.salt),
          n: Number(slot!.n),
          r: Number(slot!.r),
          p: Number(slot!.p),
        };
      });
    sealed = { data: concat(fromBase64(String(file.db)), hex(params?.tag)), nonce: hex(params?.nonce) };
  } catch (error) {
    throw new DamagedBackupFileError(error instanceof Error ? error.message : 'not an Aegis backup');
  }
  // Only a phone's keystore opens it: Aegis's own export always has a password slot.
  if (slots.length === 0) throw new DamagedBackupFileError('no password slot');

  // A vault can have more than one password (a separate one for backups among
  // them); any of them opens it. A slot written by Aegis before it repaired
  // its handling of passwords over 64 bytes needs the old encoding, but Aegis
  // repairs a slot when the vault is unlocked, and an export is made from an
  // unlocked vault.
  let masterKey: CryptoKey | null = null;
  for (const slot of slots) {
    if (!scryptWithinBounds(slot)) throw new DamagedBackupFileError(`unsupported scrypt parameters n=${slot.n} r=${slot.r} p=${slot.p}`);
    const passwordKey = await aesKey(await scrypt(new TextEncoder().encode(password), slot.salt, slot.n, slot.r, slot.p, 32));
    const opened = await decrypt(passwordKey, slot.nonce, slot.key);
    if (opened) {
      masterKey = await aesKey(opened);
      break;
    }
  }
  if (!masterKey) throw new WrongExportPasswordError();

  // The master key opened, so a vault that does not is damaged, not the password.
  const plain = await decrypt(masterKey, sealed.nonce, sealed.data);
  const db = plain ? parseJson(plain) : undefined;
  if (!record(db)) throw new DamagedBackupFileError('the vault does not open with its key');
  return { ...file, db };
}

async function openTwoFas(file: Record<string, unknown>, password: string): Promise<Record<string, unknown>> {
  let data: Uint8Array, salt: Uint8Array, iv: Uint8Array;
  try {
    const parts = String(file.servicesEncrypted).split(':');
    if (parts.length < 3) throw new Error(`${parts.length} parts`);
    [data, salt, iv] = parts.slice(0, 3).map(fromBase64);
  } catch (error) {
    throw new DamagedBackupFileError(error instanceof Error ? error.message : 'not a 2FAS backup');
  }

  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: TWOFAS_ITERATIONS, hash: 'SHA-256' },
    await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']),
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
  // One key over the whole list: a tag that does not match is, by far most
  // likely, a mistyped password.
  const plain = await decrypt(key, iv, data);
  if (!plain) throw new WrongExportPasswordError();
  const services = parseJson(plain);
  if (!Array.isArray(services)) throw new DamagedBackupFileError('the services are not a list');
  const { servicesEncrypted: _sealed, reference: _reference, ...rest } = file;
  return { ...rest, services };
}

function scryptWithinBounds({ n, r, p }: AegisSlot): boolean {
  if (![n, r, p].every(value => Number.isInteger(value) && value >= 1)) return false;
  if (n < 2 || (n & (n - 1)) !== 0) return false;
  return 128 * r * n <= MAX_SCRYPT_MEMORY && 128 * r * n * p <= MAX_SCRYPT_WORK;
}

function aesKey(bytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', bytes as BufferSource, 'AES-GCM', false, ['decrypt']);
}

/** AES-GCM with a 16-byte tag at the end of `data`; null when the tag does not match. */
async function decrypt(key: CryptoKey, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, data as BufferSource));
  } catch {
    return null;
  }
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

function hex(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.length === 0 || !/^(?:[0-9a-f]{2})+$/i.test(value)) {
    throw new Error('expected hex');
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
