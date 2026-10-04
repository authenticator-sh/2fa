// The public halves of the keys the billing server signs with. Public by
// nature — the extension is open source — and useless without the private
// halves, which live only in the server's environment.
//
// A store build trusts production alone. Development builds (BILLING_ENV=preview)
// talk to a local or preview server signed with the preview key, and tests
// (BILLING_ENV=test) sign with a key checked in under test/fixtures. A token
// signed by a key the build does not list is ignored as if absent.
//
// Rotating the production key: ship the new public key here in a release
// first, and only once that release has reached users switch the server to
// sign with it (MONETIZATION.md §4.7).

import { BILLING_ENV } from './config';

export interface PublicKey {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

const PRODUCTION: Record<string, PublicKey> = {
  'prod-2026-09-29': {"kty": "EC", "crv": "P-256", "x": "m6okERRHdmGRsByc9Xv6hCVOn5LLx54K2Ec17uzMROU", "y": "C-m9hLuDR_QLd5QM8lmOrH0SM6OB6wlDm2FVSwajEM0"},
};

const PREVIEW: Record<string, PublicKey> = {
  'prev-2026-09-29': {"kty": "EC", "crv": "P-256", "x": "6JvQ95-bt6jPUkBKvdtXJwJp6qjsNbzYF90YYMna3Rs", "y": "LX3ANIw2J4TFmwuxavax2_Jxc0Gdfaypd2LWPRt-yAo"},
};

const TEST: Record<string, PublicKey> = {
  'test-only': {"kty": "EC", "crv": "P-256", "x": "5L1l1J4h3Y94hzBwBpSdSNUSPKgUTu7etaJDdEFDaqg", "y": "7wunp-jXoQgHd_2whLixNBOA9bMmJ86TKvf2wTVVgBg"},
};

export function trustedKeys(): Record<string, PublicKey> {
  if (BILLING_ENV === 'test') return TEST;
  if (BILLING_ENV === 'preview') return { ...PRODUCTION, ...PREVIEW };
  return PRODUCTION;
}
