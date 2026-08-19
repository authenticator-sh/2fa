// Cryptographic primitives for the optional password-protected vault.
//
// Design notes (see also vault.ts):
// - AES-256-GCM for all confidentiality, PBKDF2-HMAC-SHA256 for password
//   stretching (600k iterations, OWASP 2023 guidance). Both are native
//   WebCrypto — no WASM dependency, nothing to audit beyond the browser.
// - Data is NEVER encrypted directly with a password-derived key. A random
//   256-bit master key (MK) encrypts everything; the password only wraps MK.
//   That way changing the password rewrites 32 bytes instead of re-encrypting
//   every account, backup and export — the bulk rewrite is exactly where data
//   gets lost.
// - The `kdf`/`v` fields in the envelope exist so we can move to Argon2id
//   later without breaking anyone's existing vault.

export const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const MK_BYTES = 32;
const RECOVERY_BYTES = 20; // 160 bits -> 32 Base32 chars

export type EncryptedPayload = string; // "v1.<b64 iv>.<b64 ciphertext>"

export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function toBase64(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = '';
  // Chunked to avoid blowing the argument limit on large buffers.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function newSalt(): Uint8Array {
  return randomBytes(SALT_BYTES);
}

export function newMasterKeyBytes(): Uint8Array {
  return randomBytes(MK_BYTES);
}

/** Stretch a password into a key-encryption key. Deliberately slow. */
export async function deriveKeyFromPassword(
  password: string,
  salt: Uint8Array,
  iterations: number = PBKDF2_ITERATIONS
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password.normalize('NFKC')),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** Import raw master-key bytes as an AES-GCM key for data encryption. */
export async function importMasterKey(rawKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', rawKey as BufferSource, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * Derive a separate HMAC key from the master key, used only for account
 * fingerprints. A distinct subkey means a leaked fingerprint can never be
 * replayed against the data-encryption path.
 */
export async function importFingerprintKey(rawKey: Uint8Array): Promise<CryptoKey> {
  const hkdfKey = await crypto.subtle.importKey('raw', rawKey as BufferSource, 'HKDF', false, ['deriveKey']);

  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode('authenticator-account-fingerprint-v1'),
    },
    hkdfKey,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign']
  );
}

/**
 * Stable, key-bound identifier for a TOTP secret.
 *
 * The local/sync merge in storage.ts deduplicates accounts by their secret,
 * because the same account added on two devices gets two different random ids.
 * Ciphertext is randomised per write, so it can't serve that purpose — this
 * fingerprint can: deterministic under one master key, meaningless without it.
 */
export async function fingerprintSecret(fingerprintKey: CryptoKey, secret: string): Promise<string> {
  const mac = await crypto.subtle.sign(
    'HMAC',
    fingerprintKey,
    new TextEncoder().encode(secret.trim().toUpperCase())
  );
  return toBase64(mac);
}

/**
 * Turn a WebAuthn PRF output into a key-encryption key.
 *
 * PRF hands back 32 bytes that are deterministic for one passkey and one salt.
 * Those bytes are not used directly: they go through HKDF with an info string,
 * exactly like the fingerprint subkey above, so the value that wraps the master
 * key is domain-separated from the raw authenticator output and from any other
 * use of the same passkey.
 *
 * There is no iteration count here and none is needed — the input is 32 bytes of
 * authenticator-held entropy, not a human-chosen password, so stretching it
 * would only cost time.
 */
export async function deriveKeyFromPrf(prfOutput: Uint8Array): Promise<CryptoKey> {
  const hkdfKey = await crypto.subtle.importKey('raw', prfOutput as BufferSource, 'HKDF', false, [
    'deriveKey',
  ]);

  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode('authenticator-vault-passkey-v1'),
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptJson(value: unknown, key: CryptoKey): Promise<EncryptedPayload> {
  const iv = randomBytes(IV_BYTES);
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, plaintext);
  return `v1.${toBase64(iv)}.${toBase64(ciphertext)}`;
}

/** Throws if the key is wrong or the payload was tampered with (GCM auth tag). */
export async function decryptJson<T>(payload: EncryptedPayload, key: CryptoKey): Promise<T> {
  const parts = payload.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') {
    throw new Error('Unsupported encrypted payload format');
  }

  const iv = fromBase64(parts[1]);
  const ciphertext = fromBase64(parts[2]);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    ciphertext as BufferSource
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

export async function wrapMasterKey(masterKeyBytes: Uint8Array, wrappingKey: CryptoKey): Promise<EncryptedPayload> {
  return encryptJson(toBase64(masterKeyBytes), wrappingKey);
}

export async function unwrapMasterKey(wrapped: EncryptedPayload, wrappingKey: CryptoKey): Promise<Uint8Array> {
  const encoded = await decryptJson<string>(wrapped, wrappingKey);
  return fromBase64(encoded);
}

// --- Recovery codes -------------------------------------------------------
// RFC 4648 Base32 without padding, minus the characters that get misread on
// paper. Users transcribe these by hand, so the alphabet matters more than the
// couple of bits of entropy we give up.
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNPQRSTUVWXYZ23456789'; // no O, 0, 1

export function generateRecoveryCode(): string {
  const bytes = randomBytes(RECOVERY_BYTES);
  let output = '';
  for (const byte of bytes) {
    output += BASE32_ALPHABET[byte % BASE32_ALPHABET.length];
  }
  return output.match(/.{1,5}/g)!.join('-');
}

/** Accepts the code with or without dashes/spaces, in any case. */
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z2-9]/g, '');
}

// --- Password strength ----------------------------------------------------
// Not a security control — purely to give the user honest feedback before they
// commit to something they'll be typing for years.
export type PasswordStrength = 'weak' | 'fair' | 'good' | 'strong';

export const MIN_PASSWORD_LENGTH = 8;

export function assessPasswordStrength(password: string): PasswordStrength {
  if (password.length < MIN_PASSWORD_LENGTH) return 'weak';

  let score = 0;
  if (password.length >= 12) score++;
  if (password.length >= 16) score++;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
  if (/\d/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;

  if (score <= 1) return 'weak';
  if (score === 2) return 'fair';
  if (score === 3) return 'good';
  return 'strong';
}
