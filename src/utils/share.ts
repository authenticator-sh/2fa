// Sharing an account's codes by link — https://www.authenticator.sh/s#…
//
// What goes into the link is a run of pre-computed codes, never the secret.
// TOTP is deterministic — code(t) = HOTP(secret, ⌊t/period⌋) — so the codes for
// the next hour can be computed now and handed over on their own. The recipient
// opens the link in any browser and reads a live code for as long as the run
// lasts; when it ends there is nothing left in the link to read. The time limit
// is not a rule the page enforces, it is the absence of any further codes.
//
// There is no server. The whole payload travels in the URL fragment, which the
// browser never sends to a host, and the page that displays it is a static
// file: nothing is uploaded when a link is made and nothing is stored when it
// is opened. The site side of this is site/public/s/ and it decodes exactly
// what this file encodes — test/fixtures/share-vectors.json is the fixture the
// two are held together by.
//
// Layout of the fragment, base64url without padding:
//
//   [0]      envelope version, 1
//   [1]      flags — bit 0: a password is needed
//   [2..18)  16 random bytes, the link's own secret
//   [18..30) AES-GCM nonce
//   [30..]   AES-256-GCM ciphertext and tag, over the payload below
//
// and the payload, before encryption:
//
//   [0..2)   period, seconds, big-endian
//   [2]      digits
//   [3..7)   counter of the first code, big-endian
//   [7..9)   number of codes
//   [9]      issuer length; that many bytes of UTF-8
//   [..]     name length; that many bytes of UTF-8
//   [..]     the codes, bit-packed at ⌈log2(10^digits)⌉ bits each, MSB first
//
// A six-digit code is twenty bits, not six characters: an hour of them is 300
// bytes, and that is what keeps the link short enough for a QR code and for
// email clients that break lines at 998 characters.
//
// The key: with no password, HKDF of the sixteen random bytes — anyone with the
// link can read it, which is the point of a link. With a password, PBKDF2 of
// the password salted with those same bytes, so the password alone is useless
// without the link and the link alone is useless without the password. Neither
// half is enough, and that is what "send the password another way" buys.

import type { Account } from '@/types';
import { generateCodeAt, getTimeOffsetMs, totpParams } from './totp';
import { PBKDF2_ITERATIONS, randomBytes } from './crypto';

export const SHARE_PAGE_URL = 'https://www.authenticator.sh/s';

/**
 * The longest a link can be valid for.
 *
 * An hour of six-digit codes is a link of about 550 characters — readable as a
 * QR code from a screen, and under the line length at which email clients
 * start wrapping URLs. Eight hours would be over 3 000, which is neither. The
 * page refuses anything longer, so this is a promise about every link the site
 * will display, not only about the ones this build makes.
 */
export const MAX_SHARE_SECONDS = 60 * 60;

/** The choices offered, in seconds. The last one is the maximum. */
export const SHARE_DURATIONS = [5 * 60, 15 * 60, 30 * 60, MAX_SHARE_SECONDS] as const;

/**
 * Every bound the page checks before it trusts a decoded payload. The site's
 * copy of these lives in public/s/codec.mjs and the shared fixture keeps them
 * equal.
 */
export const SHARE_LIMITS = {
  envelopeVersion: 1,
  secretBytes: 16,
  nonceBytes: 12,
  /** Longest an issuer or a name travels as, in bytes of UTF-8. */
  maxLabelBytes: 64,
  minPeriod: 1,
  maxPeriod: 3600,
  minDigits: 6,
  maxDigits: 10,
} as const;

const FLAG_PASSWORD = 0x01;

/** Domain separation for the no-password key. Never reused elsewhere. */
const HKDF_INFO = 'authenticator.sh/s v1';

export interface SharePayload {
  period: number;
  digits: number;
  /** ⌊t/period⌋ of the first code in the run. */
  startCounter: number;
  issuer: string;
  name: string;
  /** Codes as integers, in slot order. Leading zeros come back from `digits`. */
  codes: number[];
}

export interface ShareLink {
  url: string;
  /** When the last code in the run stops being valid. */
  validUntilMs: number;
  /** How many codes went into the link. */
  count: number;
}

/** A link this build cannot make — the account's secret produces no code. */
export class ShareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShareError';
  }
}

// --- bit packing ------------------------------------------------------------

/** Bits needed to hold any code of `digits` digits: 20 for six, 27 for eight. */
export function bitsPerCode(digits: number): number {
  return Math.ceil(Math.log2(10 ** digits));
}

export function packCodes(codes: readonly number[], bits: number): Uint8Array {
  const out = new Uint8Array(Math.ceil((codes.length * bits) / 8));
  let bitPos = 0;
  for (const code of codes) {
    for (let i = bits - 1; i >= 0; i--) {
      // Bit by bit rather than by shifting a 32-bit accumulator: a run of
      // eight-digit codes crosses the sign bit inside one accumulator, and a
      // negative intermediate is the kind of mistake that packs cleanly and
      // unpacks to a different number.
      const bit = Math.floor(code / 2 ** i) % 2;
      if (bit) out[bitPos >> 3] |= 0x80 >> (bitPos & 7);
      bitPos++;
    }
  }
  return out;
}

export function unpackCodes(bytes: Uint8Array, bits: number, count: number): number[] {
  const codes: number[] = [];
  let bitPos = 0;
  for (let n = 0; n < count; n++) {
    let value = 0;
    for (let i = 0; i < bits; i++) {
      const bit = (bytes[bitPos >> 3] >> (7 - (bitPos & 7))) & 1;
      value = value * 2 + bit;
      bitPos++;
    }
    codes.push(value);
  }
  return codes;
}

// --- payload ----------------------------------------------------------------

/**
 * UTF-8 bytes of `text`, cut to at most `max` bytes on a character boundary.
 *
 * The label is for the recipient to recognise the account by, not a field to
 * round-trip, so a long one is shortened rather than refused — and shortened
 * whole characters at a time, because a byte length that lands inside a
 * multi-byte character would decode to a replacement mark at the far end.
 */
export function clampLabel(text: string, max: number = SHARE_LIMITS.maxLabelBytes): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= max) return text;
  let kept = '';
  for (const ch of text) {
    const next = kept + ch;
    if (encoder.encode(next).length > max) break;
    kept = next;
  }
  return kept;
}

function encodeLabel(text: string, max: number): Uint8Array {
  return new TextEncoder().encode(clampLabel(text, max));
}

export function encodePayload(payload: SharePayload): Uint8Array {
  const { period, digits, startCounter, codes } = payload;
  const issuer = encodeLabel(payload.issuer, SHARE_LIMITS.maxLabelBytes);
  const name = encodeLabel(payload.name, SHARE_LIMITS.maxLabelBytes);
  const packed = packCodes(codes, bitsPerCode(digits));

  const out = new Uint8Array(9 + 1 + issuer.length + 1 + name.length + packed.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, period);
  out[2] = digits;
  view.setUint32(3, startCounter);
  view.setUint16(7, codes.length);
  let at = 9;
  out[at++] = issuer.length;
  out.set(issuer, at);
  at += issuer.length;
  out[at++] = name.length;
  out.set(name, at);
  at += name.length;
  out.set(packed, at);
  return out;
}

/**
 * The inverse of encodePayload, with the same bounds the page applies.
 *
 * Present here so the round trip is testable on this side alone, and so the
 * page's decoder has a reference to be held against.
 */
export function decodePayload(bytes: Uint8Array): SharePayload {
  if (bytes.length < 11) throw new ShareError('payload too short');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const period = view.getUint16(0);
  const digits = bytes[2];
  const startCounter = view.getUint32(3);
  const count = view.getUint16(7);
  if (period < SHARE_LIMITS.minPeriod || period > SHARE_LIMITS.maxPeriod) throw new ShareError('bad period');
  if (digits < SHARE_LIMITS.minDigits || digits > SHARE_LIMITS.maxDigits) throw new ShareError('bad digits');

  const decoder = new TextDecoder('utf-8', { fatal: true });
  let at = 9;
  const issuerLength = bytes[at++];
  const issuer = decoder.decode(bytes.subarray(at, at + issuerLength));
  at += issuerLength;
  const nameLength = bytes[at++];
  const name = decoder.decode(bytes.subarray(at, at + nameLength));
  at += nameLength;

  const bits = bitsPerCode(digits);
  const packedLength = Math.ceil((count * bits) / 8);
  if (bytes.length !== at + packedLength) throw new ShareError('code run does not match its count');
  const codes = unpackCodes(bytes.subarray(at), bits, count);
  const limit = 10 ** digits;
  if (codes.some((code) => code >= limit)) throw new ShareError('code out of range');

  return { period, digits, startCounter, issuer, name, codes };
}

// --- keys and sealing ---------------------------------------------------------

export async function deriveShareKey(secret: Uint8Array, password: string): Promise<CryptoKey> {
  const aes = { name: 'AES-GCM', length: 256 } as const;

  if (password) {
    // Same stretching as the vault: the password is the one thing a holder of
    // the link does not have, and guessing it is the only attack this leaves
    // open, so the guess has to cost what a vault guess costs.
    const base = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(password.normalize('NFKC')),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: secret as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      base,
      aes,
      false,
      ['encrypt', 'decrypt']
    );
  }

  // Sixteen random bytes are already a key; HKDF only gives them the right
  // length and a label, and costs nothing — the page opens instantly.
  const base = await crypto.subtle.importKey('raw', secret as BufferSource, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(HKDF_INFO) },
    base,
    aes,
    false,
    ['encrypt', 'decrypt']
  );
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
  // Anything outside the alphabet is dropped, not rejected: a link pasted into
  // a chat picks up a trailing bracket or full stop, and an email client wraps
  // it with a newline. The authentication tag still catches a real change.
  //
  // Percent-escapes are undone first, because the hex digits a browser leaves
  // behind are themselves in the alphabet: `<payload>` arrives as
  // `%3Cpayload%3E` and strips to `3Cpayload3E`, which is a different payload.
  // The page's copy of this function does the same thing — see
  // site/public/s/codec.mjs — and the shared fixture keeps them equal.
  let source = text;
  try {
    source = decodeURIComponent(text);
  } catch {
    // A stray `%` that is not an escape; strip as before.
  }
  const clean = source.replace(/[^A-Za-z0-9_-]/g, '');
  const base64 = clean.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (clean.length % 4)) % 4);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface SealOptions {
  password?: string;
  /** Injected by the fixture generator; random otherwise. */
  secret?: Uint8Array;
  nonce?: Uint8Array;
}

/** The whole fragment: header, secret, nonce, ciphertext — as bytes. */
export async function sealShare(payload: SharePayload, options: SealOptions = {}): Promise<Uint8Array> {
  const secret = options.secret ?? randomBytes(SHARE_LIMITS.secretBytes);
  const nonce = options.nonce ?? randomBytes(SHARE_LIMITS.nonceBytes);
  const password = options.password ?? '';

  const header = new Uint8Array([SHARE_LIMITS.envelopeVersion, password ? FLAG_PASSWORD : 0]);
  const key = await deriveShareKey(secret, password);
  // The header is authenticated along with the body, so the flag that says
  // "ask for a password" cannot be flipped in transit.
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: header as BufferSource },
    key,
    encodePayload(payload) as BufferSource
  );

  const out = new Uint8Array(header.length + secret.length + nonce.length + sealed.byteLength);
  out.set(header, 0);
  out.set(secret, header.length);
  out.set(nonce, header.length + secret.length);
  out.set(new Uint8Array(sealed), header.length + secret.length + nonce.length);
  return out;
}

/** Whether a fragment asks for a password — readable without the key. */
export function shareNeedsPassword(fragment: Uint8Array): boolean {
  return fragment.length > 1 && (fragment[1] & FLAG_PASSWORD) !== 0;
}

/** The inverse of sealShare. Throws on a wrong password or a damaged link. */
export async function openShare(fragment: Uint8Array, password = ''): Promise<SharePayload> {
  const { envelopeVersion, secretBytes, nonceBytes } = SHARE_LIMITS;
  const headerLength = 2;
  if (fragment.length < headerLength + secretBytes + nonceBytes + 16) throw new ShareError('fragment too short');
  if (fragment[0] !== envelopeVersion) throw new ShareError('unknown envelope version');

  const header = fragment.subarray(0, headerLength);
  const secret = fragment.subarray(headerLength, headerLength + secretBytes);
  const nonce = fragment.subarray(headerLength + secretBytes, headerLength + secretBytes + nonceBytes);
  const body = fragment.subarray(headerLength + secretBytes + nonceBytes);

  const key = await deriveShareKey(secret, shareNeedsPassword(fragment) ? password : '');
  const opened = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: header as BufferSource },
    key,
    body as BufferSource
  );
  return decodePayload(new Uint8Array(opened));
}

// --- the link -----------------------------------------------------------------

export interface ShareRequest {
  account: Account;
  /** One of SHARE_DURATIONS. Anything above the maximum is clamped to it. */
  durationSec: number;
  password?: string;
  /**
   * What the page prints above the code, when the sender has written it
   * themselves. Left out, the account's own issuer and name travel instead.
   * An empty string is a choice too: the page then names no account at all.
   */
  label?: string;
  /** Corrected "now". Defaults to the device clock plus the measured offset. */
  nowMs?: number;
  /** Fixture generation only. */
  secret?: Uint8Array;
  nonce?: Uint8Array;
}

/**
 * The run of codes for `durationSec` from now, sealed into a link.
 *
 * The run starts one slot early. The page corrects the reader's clock against
 * the site's, but a link opened where that request fails runs on whatever the
 * device says, and one spare code behind covers a clock a period slow without
 * making the link meaningfully longer. The end is not padded: "valid until" is
 * a promise to the sender, and it has to be the moment it says.
 */
export async function buildShareLink(request: ShareRequest): Promise<ShareLink> {
  const { account, password } = request;
  const { period, digits } = totpParams(account);
  const durationSec = Math.min(Math.max(request.durationSec, period), MAX_SHARE_SECONDS);
  const nowMs = request.nowMs ?? Date.now() + getTimeOffsetMs();

  const currentCounter = Math.floor(nowMs / 1000 / period);
  const startCounter = Math.max(0, currentCounter - 1);
  // The page refuses a run whose slots add up to more than an hour plus the one
  // spare it knows every run starts with, and it is right to: that is the
  // promise it makes to whoever opens the link. Rounding the duration up broke
  // that arithmetic for every period the hour does not divide — 35 seconds asks
  // for 104 slots where the page accepts 103 — so an hour-long link on such an
  // account was built, drawn as a QR code, and refused on arrival with nothing
  // on the sender's side to say why. The count is capped at what the page
  // takes; "valid until" is computed from the end, so it stays exact.
  const maxCodes = Math.floor(MAX_SHARE_SECONDS / period) + 1;
  const endCounter = Math.min(
    currentCounter + Math.ceil(durationSec / period),
    startCounter + maxCodes
  ); // exclusive

  const codes: number[] = [];
  for (let counter = startCounter; counter < endCounter; counter++) {
    let code: string;
    try {
      code = generateCodeAt(account, counter * period * 1000);
    } catch {
      throw new ShareError('The secret cannot produce a code');
    }
    codes.push(Number(code));
  }

  // The page prints issuer and name joined with ": ", so a sender-written
  // label travels as the name with nothing in front of it — what was typed is
  // what is read, and the wire format does not grow a third field to say so.
  const custom = request.label !== undefined;
  const issuer = custom ? '' : account.issuer || '';
  const name = custom ? request.label!.trim() : account.name || '';

  const fragment = await sealShare(
    { period, digits, startCounter, issuer, name, codes },
    { password, secret: request.secret, nonce: request.nonce }
  );

  return {
    url: `${SHARE_PAGE_URL}#${toBase64Url(fragment)}`,
    validUntilMs: endCounter * period * 1000,
    count: codes.length,
  };
}
