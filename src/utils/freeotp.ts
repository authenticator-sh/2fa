// FreeOTP's own backups — Red Hat's app, not the FreeOTP+ fork, whose JSON is
// read with the other apps' files in import-formats.ts.
//
// FreeOTP 2's backup always has a password — there is no export without
// one — so it is opened with that password, as Aegis's and 2FAS's encrypted
// files are (sealed-backups.ts). The password is used here to open the file
// and is not kept.
//
// The format, as FreeOTP 2 writes it and Aegis reads it (FreeOtpImporter.java,
// checked against the backups in Aegis's tests, 2026-10-27):
// - the file is a Java-serialized HashMap<String, String>, though it is named
//   .xml;
// - `masterKey` is JSON: PBKDF2 (`mAlgorithm`, `mSalt`, `mIterations`) gives a
//   256-bit AES key that opens `mEncryptedKey` — AES-GCM, the nonce in
//   DER-encoded `mParameters`, `mToken` as the additional data;
// - `<id>-token` is the token without its secret, as plain JSON;
// - `<id>` is `{key: "<JSON>"}`, that token's secret sealed the same way under
//   the master key.
//
// FreeOTP 1.x kept the same tokens unencrypted in an Android preferences file
// (shared_prefs/tokens.xml), which only a rooted phone or adb backup gets
// out — and so does FreeOTP+ for its own. Read too, since it is the same
// token and a few lines.

import { DamagedBackupFileError, WrongExportPasswordError } from './backup-file';
import { readFreeOtpToken, type ImportFile } from './import-formats';

const STREAM_MAGIC = 0xaced;
const STREAM_VERSION = 5;
const TC_NULL = 0x70;
const TC_REFERENCE = 0x71;
const TC_CLASSDESC = 0x72;
const TC_OBJECT = 0x73;
const TC_STRING = 0x74;
const TC_BLOCKDATA = 0x77;
const TC_ENDBLOCKDATA = 0x78;
const TC_LONGSTRING = 0x7c;
const BASE_HANDLE = 0x7e0000;

/** Bytes per value of each primitive field type in a serialized class. */
const PRIMITIVE_SIZE: Record<string, number> = { B: 1, C: 2, D: 8, F: 4, I: 4, J: 8, S: 2, Z: 1 };

/** Checked before the derivation, as for our own files: a hostile count is a hang. */
const MAX_ITERATIONS = 5_000_000;

const KDF_HASH: Record<string, string> = {
  PBKDF2withHmacSHA1: 'SHA-1',
  PBKDF2withHmacSHA512: 'SHA-512',
};

/** A Java object stream holding a HashMap — FreeOTP 2's backup, by its first bytes. */
export function isFreeOtpBackup(bytes: Uint8Array): boolean {
  if (bytes.length < 24 || ((bytes[0] << 8) | bytes[1]) !== STREAM_MAGIC) return false;
  // `sr`, a two-byte length, then the class name.
  const name = new TextDecoder().decode(bytes.subarray(8, 8 + ((bytes[6] << 8) | bytes[7])));
  return bytes[4] === TC_OBJECT && bytes[5] === TC_CLASSDESC && name === 'java.util.HashMap';
}

/**
 * The accounts in a FreeOTP 2 backup. Throws WrongExportPasswordError when the
 * master key does not open, DamagedBackupFileError when the file is not the
 * shape FreeOTP writes.
 */
export async function readFreeOtpBackup(bytes: Uint8Array, password: string): Promise<ImportFile> {
  let map: Map<string, string>;
  let masterKey: SealedKey;
  let kdf: { hash: string; salt: Uint8Array; iterations: number };
  try {
    map = readSerializedStringMap(bytes);
    const master = JSON.parse(map.get('masterKey') ?? '') as Record<string, unknown>;
    masterKey = readSealedKey(master.mEncryptedKey);
    kdf = {
      hash: KDF_HASH[String(master.mAlgorithm)],
      salt: javaBytes(master.mSalt),
      iterations: Number(master.mIterations),
    };
  } catch (error) {
    throw new DamagedBackupFileError(error instanceof Error ? error.message : 'not a FreeOTP backup');
  }
  if (!kdf.hash) throw new DamagedBackupFileError('unknown key derivation');
  if (!Number.isInteger(kdf.iterations) || kdf.iterations < 1 || kdf.iterations > MAX_ITERATIONS) {
    throw new DamagedBackupFileError(`unsupported iteration count ${kdf.iterations}`);
  }

  const passwordKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: kdf.salt as BufferSource, iterations: kdf.iterations, hash: kdf.hash },
    await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']),
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
  let masterBytes: Uint8Array;
  try {
    masterBytes = await openSealedKey(masterKey, passwordKey);
  } catch {
    throw new WrongExportPasswordError();
  }
  const key = await crypto.subtle.importKey('raw', masterBytes as BufferSource, 'AES-GCM', false, ['decrypt']);

  const entries: unknown[] = [];
  let unreadable = 0;
  for (const id of inOrder(map)) {
    const token = parseObject(map.get(`${id}-token`));
    const sealed = parseObject(map.get(id));
    if (!token || !sealed) {
      unreadable++;
      continue;
    }
    try {
      const secret = await openSealedKey(readSealedKey(JSON.parse(String(sealed.key))), key);
      entries.push(readFreeOtpToken({ ...token, secret: Array.from(secret) }));
    } catch {
      // The master key opened, so this is one damaged entry, not the password.
      unreadable++;
    }
  }
  return { entries, unreadable, unsupported: 0, recognised: true };
}

/**
 * The tokens in an Android preferences file — FreeOTP 1.x's tokens.xml, or
 * FreeOTP+'s own. Null for any other text, so the caller tries the next format.
 */
export function readFreeOtpPreferences(text: string): ImportFile | null {
  if (!/^\s*(<\?xml[^>]*>\s*)?<map>/.test(text)) return null;
  const map = new Map<string, string>();
  for (const match of text.matchAll(/<string name="([^"]*)">([\s\S]*?)<\/string>/g)) {
    map.set(xmlText(match[1]), xmlText(match[2]));
  }
  const entries: unknown[] = [];
  let unreadable = 0;
  for (const name of inOrder(map)) {
    const token = parseObject(map.get(name));
    if (token) entries.push(readFreeOtpToken(token));
    else unreadable++;
  }
  // A preferences file of some other app is not ours to call a FreeOTP backup.
  if (entries.length === 0) return null;
  return { entries, unreadable, unsupported: 0, recognised: true };
}

/**
 * The token ids, in the order FreeOTP lists them when the file says it
 * (`tokenOrder`, a JSON array of ids), then any it leaves out.
 */
function inOrder(map: Map<string, string>): string[] {
  const ids = [...map.keys()].filter(k => k !== 'masterKey' && k !== 'tokenOrder' && !k.endsWith('-token'));
  let order: unknown = null;
  try {
    order = JSON.parse(map.get('tokenOrder') ?? 'null');
  } catch {
    // Order is a nicety; the tokens are what matter.
  }
  if (!Array.isArray(order)) return ids;
  const rank = new Map(order.map((id, index) => [String(id), index]));
  return ids.sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity));
}

function parseObject(json: string | undefined): Record<string, unknown> | null {
  if (json === undefined) return null;
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function xmlText(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|quot|apos|lt|gt|amp);/gi, (_, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) return String.fromCodePoint(parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return String.fromCodePoint(parseInt(lower.slice(1), 10));
    return { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' }[lower] ?? '';
  });
}

// ---- AES-GCM as Java's Cipher sealed it -----------------------------------

interface SealedKey {
  cipherText: Uint8Array;
  nonce: Uint8Array;
  /** Bits. */
  tagLength: number;
  /** `mToken` — the key's algorithm name, bound to it as additional data. */
  additionalData: Uint8Array;
}

function readSealedKey(value: unknown): SealedKey {
  const sealed = value as Record<string, unknown> | null;
  if (!sealed || sealed.mCipher !== 'AES/GCM/NoPadding') throw new Error('unexpected cipher');
  return {
    cipherText: javaBytes(sealed.mCipherText),
    ...gcmParameters(javaBytes(sealed.mParameters)),
    additionalData: new TextEncoder().encode(String(sealed.mToken ?? '')),
  };
}

async function openSealedKey(sealed: SealedKey, key: CryptoKey): Promise<Uint8Array> {
  const plain = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: sealed.nonce as BufferSource,
      tagLength: sealed.tagLength,
      additionalData: sealed.additionalData as BufferSource,
    },
    key,
    sealed.cipherText as BufferSource
  );
  return new Uint8Array(plain);
}

/**
 * Java's GCMParameters: `SEQUENCE { OCTET STRING nonce, INTEGER tagBytes }`,
 * the tag length 12 bytes when left out. FreeOTP writes 16.
 */
function gcmParameters(der: Uint8Array): { nonce: Uint8Array; tagLength: number } {
  let pos = 0;
  /** A tag and length, leaving `pos` at the start of the value. */
  const header = () => {
    const tag = der[pos++];
    let length = der[pos++];
    if (length & 0x80) {
      let size = length & 0x7f;
      for (length = 0; size > 0; size--) length = (length << 8) | der[pos++];
    }
    if (!(pos + length <= der.length)) throw new Error('truncated parameters');
    return { tag, length };
  };
  const value = (length: number) => der.subarray(pos, (pos += length));

  let { tag, length } = header();
  // A bare nonce, which Aegis also accepts; Java's own default tag then.
  if (tag === 0x04) return { nonce: value(length), tagLength: 128 };
  if (tag !== 0x30) throw new Error('unexpected parameters');
  ({ tag, length } = header());
  if (tag !== 0x04) throw new Error('no nonce in parameters');
  const nonce = value(length);
  let tagBytes = 12;
  if (pos < der.length) {
    ({ tag, length } = header());
    if (tag === 0x02) tagBytes = value(length).reduce((n, b) => (n << 8) | b, 0);
  }
  return { nonce, tagLength: tagBytes * 8 };
}

/** Java's signed bytes in a JSON array, as bytes. */
function javaBytes(value: unknown): Uint8Array {
  if (!Array.isArray(value) || !value.every(b => Number.isInteger(b) && b >= -128 && b <= 255)) {
    throw new Error('not a byte array');
  }
  return Uint8Array.from(value as number[], b => b & 0xff);
}

// ---- Java object serialization, as much of it as a HashMap of strings takes ----

/**
 * Reads `java.util.HashMap<String, String>` out of an object stream. Anything
 * else in the stream is an error: this is a reader for one file, not for Java.
 */
function readSerializedStringMap(bytes: Uint8Array): Map<string, string> {
  let pos = 0;
  const handles: unknown[] = [];
  const need = (n: number) => {
    if (pos + n > bytes.length) throw new Error('truncated');
  };
  const u8 = () => {
    need(1);
    return bytes[pos++];
  };
  const u16 = () => (u8() << 8) | u8();
  const u32 = () => ((u16() << 16) | u16()) >>> 0;
  const utf = (length: number) => {
    need(length);
    const text = modifiedUtf8(bytes.subarray(pos, pos + length));
    pos += length;
    return text;
  };

  if (u16() !== STREAM_MAGIC || u16() !== STREAM_VERSION) throw new Error('not a Java object stream');
  if (u8() !== TC_OBJECT || u8() !== TC_CLASSDESC) throw new Error('not an object');
  if (utf(u16()) !== 'java.util.HashMap') throw new Error('not a HashMap');
  pos += 8; // serialVersionUID
  handles.push('class');
  u8(); // flags: serializable, with a writeObject of its own
  let fieldBytes = 0;
  for (let fields = u16(); fields > 0; fields--) {
    const size = PRIMITIVE_SIZE[String.fromCharCode(u8())];
    if (!size) throw new Error('unexpected field');
    utf(u16());
    fieldBytes += size;
  }
  if (u8() !== TC_ENDBLOCKDATA || u8() !== TC_NULL) throw new Error('unexpected class');
  handles.push('map');
  need(fieldBytes);
  pos += fieldBytes; // loadFactor, threshold

  // What HashMap.writeObject adds: the capacity and the size, then the pairs.
  if (u8() !== TC_BLOCKDATA || u8() !== 8) throw new Error('unexpected map header');
  u32(); // capacity
  const size = u32();

  const string = (): string => {
    const tag = u8();
    if (tag === TC_REFERENCE) {
      const value = handles[u32() - BASE_HANDLE];
      if (typeof value !== 'string') throw new Error('bad reference');
      return value;
    }
    let text: string;
    if (tag === TC_STRING) text = utf(u16());
    else if (tag === TC_LONGSTRING) {
      if (u32() !== 0) throw new Error('string too long');
      text = utf(u32());
    } else throw new Error('not a string');
    handles.push(text);
    return text;
  };

  const map = new Map<string, string>();
  for (let i = 0; i < size; i++) {
    const key = string();
    map.set(key, string());
  }
  return map;
}

/**
 * Java's "modified UTF-8": NUL as two bytes, and characters past U+FFFF as
 * their two UTF-16 halves, three bytes each. TextDecoder turns those halves
 * into replacement characters — an emoji in a label would come out as "��".
 */
function modifiedUtf8(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const a = bytes[i++];
    let unit: number;
    if (a < 0x80) unit = a;
    else if ((a & 0xe0) === 0xc0) unit = ((a & 0x1f) << 6) | (bytes[i++] & 0x3f);
    else unit = ((a & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    out += String.fromCharCode(unit);
  }
  return out;
}
