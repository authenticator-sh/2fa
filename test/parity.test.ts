// The vectors both implementations have to satisfy.
//
// The extension and the website compute TOTP separately — the extension through
// the `otpauth` library, the site with four lines of Web Crypto — and the site
// is the page people open specifically to check the extension. Two answers to
// "what is my code right now" is the worst thing the pair can produce, and a
// review found nine ways they had already drifted apart: one accepted an
// uppercase scheme and the other did not, one produced a code from a
// one-character secret and the other refused it, one truncated a label the
// other kept.
//
// So the agreement is written down instead of assumed. Both repositories carry
// this fixture and both assert against it; the digest is what makes editing one
// copy alone fail loudly rather than silently.

import { createHash } from 'node:crypto';
import { check, scenario } from './harness';
import vectors from './fixtures/totp-vectors.json';

/** Bump deliberately, in BOTH repositories, when the vectors change on purpose. */
const EXPECTED_DIGEST = '9588b534bff73de4';

/**
 * Recomputed, not read out of the file. Comparing the file's own `digest` field
 * against this constant would pass happily on a fixture someone had edited and
 * left the field alone in — which is the single thing the digest exists to stop.
 */
function digestOf(fixture: typeof vectors): string {
  const body = JSON.stringify({ codes: fixture.codes, uris: fixture.uris });
  return createHash('sha256').update(body).digest('hex').slice(0, 16);
}

export async function run(): Promise<void> {
  const totp = await import('@/utils/totp');
  const qr = await import('@/utils/qr-parser');

  // The vectors are pure functions of secret and timestamp, and that is what the
  // site computes too. An earlier suite leaves a measured clock correction in
  // this module, which would shift every code here and make the two sides look
  // as if they had drifted apart.
  totp.setTimeOffsetMs(0);

  scenario('The shared fixture is the one the site also carries');
  const digest = digestOf(vectors);
  check('the vectors are unmodified', digest === EXPECTED_DIGEST, `${digest} vs ${EXPECTED_DIGEST}`);
  check('and the digest stored in the file agrees', vectors.digest === digest, `${vectors.digest} vs ${digest}`);

  scenario('Every shared vector reproduces');
  for (const vector of vectors.codes) {
    const spy = Date.now;
    (Date as any).now = () => vector.atMs;
    let produced: string;
    try {
      produced = totp.generateTOTP({
        id: 'x',
        name: 'n',
        issuer: 'i',
        createdAt: 1,
        secret: vector.secret,
        algorithm: vector.algorithm as any,
        digits: vector.digits,
        period: vector.period,
      }).code;
    } finally {
      (Date as any).now = spy;
    }
    check(vector.name, produced === vector.code, `${produced} vs ${vector.code}`);
  }

  scenario('Every shared URI is read the same way');
  for (const vector of vectors.uris) {
    let parsed: any = null;
    try {
      parsed = qr.parseOTPAuthURL(vector.uri);
    } catch {
      parsed = null; // hotp is refused by throwing here, and by a null there
    }

    if (!vector.accepted) {
      check(`${vector.name} is refused`, parsed === null, JSON.stringify(parsed));
      continue;
    }

    // Labels are deliberately NOT compared: the extension keeps issuer and
    // account in separate fields and the site renders one string. Everything
    // that decides what code comes out is compared.
    check(
      `${vector.name} is accepted with the same parameters`,
      parsed !== null &&
        parsed.secret.replace(/[\s-]/g, '').toUpperCase() === vector.secret &&
        parsed.algorithm === vector.algorithm &&
        parsed.digits === vector.digits &&
        parsed.period === vector.period,
      JSON.stringify(parsed)
    );
  }
}
