// Verification of the tokens the billing server signs.
//
// ES256 over compact JWS, checked with WebCrypto and nothing else: the format
// carries the signature as raw r‖s, which is exactly what WebCrypto's ECDSA
// verifies, so there is no DER to unwrap and no library to ship in the popup.
//
// Verification is the whole point of the tokens. A policy or a license read
// from storage is believed only if a key this build trusts signed it for this
// install; anything else — a hand-edited value, a token copied from another
// profile, a token from a server this build does not know — reads as absent.

import { trustedKeys, type PublicKey } from './keys';

function base64UrlToBytes(input: string): Uint8Array<ArrayBuffer> {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(base64UrlToBytes(part)));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function importKey(kid: string, jwk: PublicKey): Promise<CryptoKey> {
  let key = keyCache.get(kid);
  if (!key) {
    key = crypto.subtle.importKey('jwk', { ...jwk, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    keyCache.set(kid, key);
  }
  return key;
}

export interface VerifiedToken {
  payload: Record<string, unknown>;
  /** Seconds since the epoch, as the server stamped them. */
  iat: number | null;
  exp: number | null;
  sub: string | null;
}

/**
 * The payload of `token` if a trusted key signed it and, when `subject` is
 * given, it was issued for that install. Expiry is NOT checked here — callers
 * decide what an expired token still means (a policy has no expiry; a license
 * has).
 */
export async function verifyToken(token: unknown, subject?: string): Promise<VerifiedToken | null> {
  if (typeof token !== 'string' || token.length > 16_384) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

  const header = decodeJson(headerPart);
  if (!header || header.alg !== 'ES256' || typeof header.kid !== 'string') return null;
  const jwk = trustedKeys()[header.kid];
  if (!jwk) return null;

  let signature: Uint8Array<ArrayBuffer>;
  try {
    signature = base64UrlToBytes(signaturePart);
  } catch {
    return null;
  }
  if (signature.length !== 64) return null;

  try {
    const key = await importKey(header.kid, jwk);
    const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, signed);
    if (!ok) return null;
  } catch {
    return null;
  }

  const payload = decodeJson(payloadPart);
  if (!payload) return null;
  const sub = typeof payload.sub === 'string' ? payload.sub : null;
  if (subject !== undefined && sub !== subject) return null;
  return {
    payload,
    iat: typeof payload.iat === 'number' ? payload.iat : null,
    exp: typeof payload.exp === 'number' ? payload.exp : null,
    sub,
  };
}
