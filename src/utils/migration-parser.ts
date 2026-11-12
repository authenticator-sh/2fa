/**
 * Google Authenticator Migration Parser
 * Parses otpauth-migration:// URLs that contain protobuf-encoded account data,
 * and writes them.
 *
 * The reader and the writer live in one file deliberately, the way
 * parseOTPAuthURL and buildOTPAuthURL do: they are one format read from both
 * ends, and reading back what was written is what makes "move to Google
 * Authenticator" safe to offer. The secret and every setting a code depends on
 * come back unchanged; the name and issuer come back as our reader stores them
 * (trimmed, and a name with a colon but no issuer split at it). A wrong byte on
 * the way out is worse than a refusal — Google Authenticator then shows
 * confident codes no service accepts. The round-trip is covered in
 * transfer.test.ts; break either side and it fails.
 */

import * as OTPAuth from 'otpauth';
import type { Account } from '@/types';
import { cleanSecret, isSteamAccount, isUsableSecret } from './totp';
import { nonStandardParams } from './transfer';

/**
 * A whole MigrationPayload, batch metadata included.
 *
 * Google Authenticator caps an export at ten accounts per QR and splits the
 * rest across further codes, behind a "Next" button people routinely miss —
 * they scan one code, read "10 accounts imported" as "done", and never learn
 * the other twenty stayed on the phone. The payload says which code this is,
 * so the UI can say it too instead of hedging.
 */
export interface MigrationPayload {
  accounts: MigrationAccount[];
  /** 0-based position of this QR in the export. */
  batchIndex?: number;
  /** How many QR codes the export was split into. */
  batchSize?: number;
  /**
   * Entries that were in the payload and could not be read.
   *
   * A malformed entry used to be dropped with a console warning and nothing
   * else, so the count the user was shown came out of what the parser
   * returned — which is the number that survived, not the number that was
   * there. "10 accounts imported" from a code holding twelve is the shape of
   * every "I moved my accounts over and some are missing" ticket, and it is
   * unfalsifiable from the outside: the user has no way to count what they
   * scanned. Reporting it is the whole point.
   */
  unreadable: number;
}

export interface MigrationAccount {
  secret: string;
  name: string;
  issuer: string;
  algorithm: 'SHA1' | 'SHA256' | 'SHA512';
  digits: 6 | 8;
  /**
   * `unsupported`: the entry names an algorithm (MD5), a digit count or an OTP
   * type that this app cannot generate. Read far enough to count, never stored.
   */
  type: 'totp' | 'hotp' | 'unsupported';
  counter?: number;
}

// Protobuf wire types
const WIRE_TYPE_VARINT = 0;
const WIRE_TYPE_FIXED64 = 1;
const WIRE_TYPE_LENGTH_DELIMITED = 2;
const WIRE_TYPE_FIXED32 = 5;

/**
 * Decodes a varint from protobuf data. Uses safe arithmetic to handle values
 * beyond 32 bits (e.g., large HOTP counters).
 */
function decodeVarint(buffer: Uint8Array, offset: number): { value: number; offset: number } {
  let value = 0;
  let multiplier = 1;
  let currentOffset = offset;
  let bytesRead = 0;

  while (currentOffset < buffer.length) {
    const byte = buffer[currentOffset++];
    value += (byte & 0x7f) * multiplier;
    bytesRead++;

    if ((byte & 0x80) === 0) {
      return { value, offset: currentOffset };
    }

    multiplier *= 128;
    if (bytesRead >= 10) {
      throw new Error('Varint too long (max 10 bytes)');
    }
  }

  throw new Error('Invalid varint encoding');
}

/**
 * Skips a field of unknown type so parsing can continue past forward-compatible
 * additions in the protobuf schema.
 */
function skipField(buffer: Uint8Array, offset: number, wireType: number): number {
  switch (wireType) {
    case WIRE_TYPE_VARINT:
      return decodeVarint(buffer, offset).offset;
    case WIRE_TYPE_FIXED64:
      return offset + 8;
    case WIRE_TYPE_LENGTH_DELIMITED: {
      const { value: length, offset: newOffset } = decodeVarint(buffer, offset);
      return newOffset + length;
    }
    case WIRE_TYPE_FIXED32:
      return offset + 4;
    default:
      throw new Error(`Unsupported wire type: ${wireType}`);
  }
}

/**
 * Reads a length-delimited field from protobuf data
 */
function readLengthDelimited(buffer: Uint8Array, offset: number): { data: Uint8Array; offset: number } {
  const { value: length, offset: newOffset } = decodeVarint(buffer, offset);

  // `slice` clamps silently, so a field claiming more bytes than remain used to
  // yield a short secret rather than an error — a valid-looking base32 string
  // that generates confident, permanently wrong codes. Truncation has to be an
  // error here, not a shrug.
  if (length < 0 || newOffset + length > buffer.length) {
    throw new Error('Length-delimited field runs past the end of the buffer');
  }

  const data = buffer.slice(newOffset, newOffset + length);
  return { data, offset: newOffset + length };
}

/**
 * Appends a varint: the inverse of decodeVarint. Arithmetic rather than bit
 * shifts, as there, so a value past 32 bits is not silently wrapped.
 */
function encodeVarint(out: number[], value: number): void {
  let rest = value;
  while (rest >= 0x80) {
    out.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  out.push(rest);
}

function writeVarintField(out: number[], fieldNumber: number, value: number): void {
  encodeVarint(out, (fieldNumber << 3) | WIRE_TYPE_VARINT);
  encodeVarint(out, value);
}

/** The inverse of readLengthDelimited: tag, length, then the bytes. */
function writeLengthDelimited(out: number[], fieldNumber: number, data: Uint8Array | number[]): void {
  encodeVarint(out, (fieldNumber << 3) | WIRE_TYPE_LENGTH_DELIMITED);
  encodeVarint(out, data.length);
  for (const byte of data) out.push(byte);
}

/**
 * Converts bytes to base32 string (for TOTP secrets)
 */
function bytesToBase32(bytes: Uint8Array): string {
  const base32Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let output = '';

  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;

    while (bits >= 5) {
      output += base32Chars[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += base32Chars[(value << (5 - bits)) & 31];
  }

  // Add padding
  while (output.length % 8 !== 0) {
    output += '=';
  }

  return output;
}

/**
 * Parses a single OtpParameters message from protobuf
 */
function parseOtpParameters(buffer: Uint8Array): MigrationAccount {
  let offset = 0;
  let secret: Uint8Array | null = null;
  let name = '';
  let issuer = '';
  let algorithm: 'SHA1' | 'SHA256' | 'SHA512' = 'SHA1';
  let digits: 6 | 8 = 6;
  let type: 'totp' | 'hotp' = 'totp';
  let counter: number | undefined;
  // Set by an enum value we cannot honour. Every one of these used to fall back
  // to the default — MD5 (4) was read as SHA1, an unknown digit count as 6 —
  // and the account was stored generating codes for a different key schedule.
  // 0 is protobuf's "unspecified" in each enum and still means the default:
  // that is an absent value, not a stated one.
  let unsupported = false;

  while (offset < buffer.length) {
    // Read field tag
    const { value: tag, offset: tagOffset } = decodeVarint(buffer, offset);
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x7;

    offset = tagOffset;

    if (wireType === WIRE_TYPE_LENGTH_DELIMITED) {
      const { data, offset: newOffset } = readLengthDelimited(buffer, offset);
      offset = newOffset;

      switch (fieldNumber) {
        case 1: // secret (bytes)
          secret = data;
          break;
        case 2: // name (string)
          name = new TextDecoder().decode(data);
          break;
        case 3: // issuer (string)
          issuer = new TextDecoder().decode(data);
          break;
      }
    } else if (wireType === WIRE_TYPE_VARINT) {
      const { value, offset: newOffset } = decodeVarint(buffer, offset);
      offset = newOffset;

      switch (fieldNumber) {
        case 4: // algorithm (enum): 0 unspecified, 1 SHA1, 2 SHA256, 3 SHA512, 4 MD5
          switch (value) {
            case 0:
            case 1:
              algorithm = 'SHA1';
              break;
            case 2:
              algorithm = 'SHA256';
              break;
            case 3:
              algorithm = 'SHA512';
              break;
            default:
              unsupported = true;
          }
          break;
        case 5: // digits (enum): 0 unspecified, 1 six, 2 eight
          if (value === 0 || value === 1) digits = 6;
          else if (value === 2) digits = 8;
          else unsupported = true;
          break;
        case 6: // type (enum): 0 unspecified, 1 HOTP, 2 TOTP
          if (value === 1) type = 'hotp';
          else if (value === 0 || value === 2) type = 'totp';
          else unsupported = true;
          break;
        case 7: // counter (int64)
          counter = value;
          break;
      }
    } else {
      // Forward-compatible: skip unknown wire types instead of aborting the whole batch
      offset = skipField(buffer, offset, wireType);
    }
  }

  // `!secret` is false for a zero-length Uint8Array, so an empty secret field
  // used to sail through — and otpauth does not throw on an empty key either,
  // it emits a plausible six-digit code from it.
  if (!secret || secret.length === 0) {
    throw new Error('Missing secret in OtpParameters');
  }

  return {
    secret: bytesToBase32(secret),
    ...splitLabel(name, issuer),
    algorithm,
    digits,
    // HOTP stays HOTP even with an odd algorithm: it is refused either way, and
    // "counter-based" is the more useful thing to be told.
    type: type === 'hotp' ? 'hotp' : unsupported ? 'unsupported' : 'totp',
    counter,
  };
}

/**
 * Google writes the whole otpauth label into `name` — "Issuer:account" — and
 * the issuer again on its own. Stored as-is, every migrated account read
 * "Test1: Test1:test1@…", unlike the same account added from its QR.
 *
 * Split the way parseOTPAuthURL splits a label, so both doors store the same
 * account the same way: the stated issuer wins and its prefix comes off the
 * name; with no issuer, the label's first colon divides them. No issuer is
 * left empty rather than filled in with the name or "Unknown" — see the same
 * rule in qr-parser.ts, and why an invented issuer then came back renamed from
 * its own backup.
 */
function splitLabel(rawName: string, rawIssuer: string): { name: string; issuer: string } {
  let name = rawName.trim();
  let issuer = rawIssuer.trim();
  if (issuer) {
    if (name.toLowerCase().startsWith(issuer.toLowerCase() + ':')) {
      name = name.slice(issuer.length + 1).trim();
    }
  } else {
    const separator = name.indexOf(':');
    if (separator >= 0) {
      issuer = name.slice(0, separator).trim();
      name = name.slice(separator + 1).trim();
    }
  }
  // A name is still needed for the card; the one otpauth labels fall back to.
  return { name: name || 'Account', issuer };
}

/**
 * Read one query parameter without the `+`-to-space substitution.
 *
 * Percent-escapes are still decoded, because Google's own exports use them;
 * only the space rule — which belongs to form encoding, not to URLs — is left
 * out.
 */
function readRawQueryParam(url: string, name: string): string | null {
  const query = url.slice(url.indexOf('?') + 1);
  if (url.indexOf('?') === -1) return null;

  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq) !== name) continue;
    try {
      return decodeURIComponent(pair.slice(eq + 1));
    } catch {
      // A stray `%` that is not an escape — hand back the raw value and let the
      // base64 check below decide.
      return pair.slice(eq + 1);
    }
  }
  return null;
}

/**
 * Parses Google Authenticator migration data from otpauth-migration:// URL
 */
export function parseMigrationURL(url: string): MigrationPayload | null {
  try {
    // The migration payload holds every secret — log nothing from it.

    // Check if it's a migration URL
    // Case-insensitive like parseQRCode, which routes here on that basis.
    if (!/^otpauth-migration:\/\//i.test(url)) {
      console.error('Not a migration URL');
      return null;
    }

    // Extract the data parameter.
    //
    // Deliberately NOT via URLSearchParams: it decodes `+` as a space, and the
    // payload is standard base64, where `+` is a value. `atob` then *strips*
    // whitespace instead of rejecting it, shifting the whole bit stream and
    // producing secrets that are wrong but well-formed. Google percent-encodes
    // its own exports, so this only bit payloads that had passed through a
    // third-party tool or a text round-trip — silently, every time.
    const dataParam = readRawQueryParam(url, 'data');

    if (!dataParam) {
      console.error('No data parameter found in migration URL');
      return null;
    }

    // Google spells the payload in standard base64, but third-party export
    // tooling routinely emits base64url — and a `-` or `_` used to fail the
    // test below and lose the user their entire vault with "that link could
    // not be read". The two alphabets differ in exactly two characters, so
    // accepting both costs one substitution.
    const normalized = dataParam.replace(/-/g, '+').replace(/_/g, '/');

    // Reject rather than let atob skip characters it does not recognise.
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
      console.error('Migration data is not valid base64');
      return null;
    }

    // Decode base64 data
    const binaryString = atob(normalized);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    console.log('Decoded migration data length:', bytes.length);

    // Parse MigrationPayload protobuf message
    const accounts: MigrationAccount[] = [];
    let unreadable = 0;
    let batchIndex: number | undefined;
    let batchSize: number | undefined;
    let offset = 0;

    while (offset < bytes.length) {
      // Everything inside this try either advances `offset` or gives up on the
      // rest of the payload. The per-entry catch below covers a bad *account*;
      // this one covers a bad *frame* — a length that runs past the end, a
      // group-encoded field (wire types 3 and 4, which skipField refuses), a
      // varint longer than ten bytes. Those used to throw all the way out to
      // the catch at the bottom, which returns null and discards every account
      // already parsed. A migration URL truncated by a chat client is the
      // common way in, and losing twenty accounts because the twenty-first was
      // cut in half is the opposite of what the per-entry catch was for.
      try {
        const { value: tag, offset: tagOffset } = decodeVarint(bytes, offset);
        const fieldNumber = tag >>> 3;
        const wireType = tag & 0x7;

        offset = tagOffset;

        if (fieldNumber === 1 && wireType === WIRE_TYPE_LENGTH_DELIMITED) {
          // otp_parameters field — one OtpParameters message per repeat
          const { data, offset: newOffset } = readLengthDelimited(bytes, offset);
          offset = newOffset;

          try {
            accounts.push(parseOtpParameters(data));
          } catch (err) {
            // One malformed entry must not drop the rest of the batch — but it
            // must be counted, or the user is told a number that omits it.
            unreadable++;
            console.warn('Skipping malformed OtpParameters:', err);
          }
        } else if (wireType === WIRE_TYPE_VARINT && (fieldNumber === 3 || fieldNumber === 4)) {
          // MigrationPayload: 2 = version, 3 = batch_size, 4 = batch_index,
          // 5 = batch_id. Only the two that describe the split are of use here.
          const { value, offset: newOffset } = decodeVarint(bytes, offset);
          offset = newOffset;
          if (fieldNumber === 3) batchSize = value;
          else batchIndex = value;
        } else {
          // Forward-compatible: skip metadata or unknown fields instead of aborting
          offset = skipField(bytes, offset, wireType);
        }
      } catch (err) {
        // The remainder is unreadable. Whatever was in it is unknowable — one
        // entry or fifty — so it counts as one rather than pretending to a
        // number, and the caller reports "some could not be read".
        unreadable++;
        console.warn('Migration payload ends in something unreadable:', err);
        break;
      }
    }

    console.log(
      `Migration parser recovered ${accounts.length} account(s)` +
        (unreadable ? `, ${unreadable} unreadable` : '') +
        (batchSize ? ` from code ${(batchIndex ?? 0) + 1} of ${batchSize}` : '')
    );
    return accounts.length > 0 ? { accounts, batchIndex, batchSize, unreadable } : null;
  } catch (error) {
    console.error('Error parsing migration URL:', error);
    return null;
  }
}

/**
 * Why an account cannot travel in a Google Authenticator migration code.
 *
 * - `steam`: Steam's codes are its own alphabet; Google would show digits.
 * - `secret`: there is no key to hand over.
 * - `period`: the payload has no field for it, so Google would assume 30 s and
 *   show wrong codes — without a word.
 * - `params`: the payload could state the digit count or the algorithm, but
 *   whether Google Authenticator honours them varies by platform and version.
 *   Wrong codes that look right are worse than a named refusal.
 */
export type MigrationSkipReason = 'steam' | 'secret' | 'period' | 'params';

/** The first reason in that order, or null when the account can go. */
export function migrationSkipReason(account: Account): MigrationSkipReason | null {
  if (isSteamAccount(account)) return 'steam';
  if (!isUsableSecret(account.secret)) return 'secret';
  const params = nonStandardParams(account);
  if (params.some((p) => p.kind === 'period')) return 'period';
  if (params.length > 0) return 'params';
  return null;
}

/** Google's own exporter puts ten accounts in a code. */
export const MIGRATION_BATCH_ACCOUNTS = 10;

/**
 * A limit we chose, not one the format sets: the overlay draws the code in a
 * field at most 216 CSS px wide, and a URL of up to 1000 characters stays
 * within 121 modules a side — about 1.8 px a module — where 1400 would take
 * 141, about 1.5. Long labels close a batch before ten.
 */
export const MIGRATION_MAX_URL_LENGTH = 1000;

export interface MigrationBatch {
  /** Never log it: it carries every secret in the batch. */
  url: string;
  accounts: Account[];
}

/** OtpParameters for one account already cleared by migrationSkipReason. */
function encodeOtpParameters(account: Account): number[] {
  const out: number[] = [];
  const utf8 = new TextEncoder();
  // The same bytes generation HMACs with: otpauth decodes the cleaned string.
  writeLengthDelimited(out, 1, OTPAuth.Secret.fromBase32(cleanSecret(account.secret)).bytes); // secret
  writeLengthDelimited(out, 2, utf8.encode(account.name)); // name
  writeLengthDelimited(out, 3, utf8.encode(account.issuer ?? '')); // issuer
  writeVarintField(out, 4, 1); // algorithm: SHA1
  writeVarintField(out, 5, 1); // digits: six
  writeVarintField(out, 6, 2); // type: TOTP
  return out;
}

function migrationURL(
  entries: number[][],
  batchSize: number,
  batchIndex: number,
  batchId: number,
): string {
  const out: number[] = [];
  for (const entry of entries) writeLengthDelimited(out, 1, entry); // otp_parameters
  writeVarintField(out, 2, 1); // version
  writeVarintField(out, 3, batchSize); // batch_size
  writeVarintField(out, 4, batchIndex); // batch_index
  writeVarintField(out, 5, batchId); // batch_id
  let binary = '';
  for (const byte of out) binary += String.fromCharCode(byte);
  // Standard base64, percent-encoded as Google writes it: a bare `+` is read as
  // a space by any reader that uses form decoding (see parseMigrationURL).
  return `otpauth-migration://offline?data=${encodeURIComponent(btoa(binary))}`;
}

/** A random non-negative int32, which is what batch_id is declared as. */
function randomBatchId(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] >>> 1;
}

/**
 * Split entries into batches, measuring each candidate URL exactly as it will
 * be written. Every field but batch_size is known while filling; that one is
 * the guess, so the caller iterates until the guess is the result.
 */
function fillBatches(
  entries: number[][],
  batchSize: number,
  batchId: number,
  limit: number,
): number[] {
  const counts: number[] = [];
  let start = 0;
  while (start < entries.length) {
    let end = start + 1; // one account always gets a code, however long
    while (
      end < entries.length &&
      end - start < MIGRATION_BATCH_ACCOUNTS &&
      migrationURL(entries.slice(start, end + 1), batchSize, counts.length, batchId).length <= limit
    ) {
      end++;
    }
    counts.push(end - start);
    start = end;
  }
  return counts;
}

/**
 * Every account that can go, as Google Authenticator migration codes in
 * order, plus every one that cannot and why — named, never dropped, so the
 * screen can say "these three stay behind" instead of the user discovering it
 * on the other phone.
 *
 * Never log the URLs: they carry the secrets.
 */
export function buildMigrationURLs(
  accounts: Account[],
  batchId: number = randomBatchId(),
): { batches: MigrationBatch[]; skipped: { account: Account; reason: MigrationSkipReason }[] } {
  if (!Number.isInteger(batchId) || batchId < 0 || batchId > 0x7fffffff) {
    throw new RangeError('batchId must be a non-negative 31-bit integer');
  }

  const exportable: Account[] = [];
  const skipped: { account: Account; reason: MigrationSkipReason }[] = [];
  for (const account of accounts) {
    const reason = migrationSkipReason(account);
    if (reason) skipped.push({ account, reason });
    else exportable.push(account);
  }
  if (exportable.length === 0) return { batches: [], skipped };

  const entries = exportable.map(encodeOtpParameters);

  // batch_size is written into every code but only known once they are all
  // filled, and its value can move a URL by a character or two. Measure with a
  // guess and repeat until the guess holds, so the length checked is the
  // length written.
  let size = Math.ceil(entries.length / MIGRATION_BATCH_ACCOUNTS);
  let counts = fillBatches(entries, size, batchId, MIGRATION_MAX_URL_LENGTH);
  for (let attempt = 0; attempt < 8 && counts.length !== size; attempt++) {
    size = counts.length;
    counts = fillBatches(entries, size, batchId, MIGRATION_MAX_URL_LENGTH);
  }
  if (counts.length !== size) {
    // Never seen, but not impossible: two sizes that each split the other
    // way. Below 128 codes batch_size is one byte, touching at most two base64
    // characters — four URL characters once percent-encoded — so leaving that
    // much room makes the limit hold whatever the final size reads.
    counts = fillBatches(entries, counts.length, batchId, MIGRATION_MAX_URL_LENGTH - 4);
  }

  const batches: MigrationBatch[] = [];
  let start = 0;
  counts.forEach((count, index) => {
    batches.push({
      url: migrationURL(entries.slice(start, start + count), counts.length, index, batchId),
      accounts: exportable.slice(start, start + count),
    });
    start += count;
  });
  return { batches, skipped };
}
