// Sharing codes by link.
//
// The link is the only thing the recipient has, and it is built entirely here:
// one bit packed wrong is a run of confident, wrong codes on someone else's
// screen with no way for either side to tell. So the round trip is exercised
// on this side alone before the site's decoder is held to it through the
// shared fixture in test/fixtures/share-vectors.json.

import { createHash } from 'node:crypto';
import { check, scenario } from './harness';
import vectors from './fixtures/share-vectors.json';

/** Bump deliberately, in BOTH repositories, when the vectors change on purpose. */
const EXPECTED_DIGEST = '97d912027f538810';

function digestOf(fixture: typeof vectors): string {
  return createHash('sha256').update(JSON.stringify(fixture.cases)).digest('hex').slice(0, 16);
}

const hex = (text: string) => Uint8Array.from(Buffer.from(text, 'hex'));

const account = {
  id: 'x',
  name: 'family@example.com',
  issuer: 'Netflix',
  secret: 'JBSWY3DPEHPK3PXP',
  algorithm: 'SHA1' as const,
  digits: 6,
  period: 30,
  createdAt: 1,
};

export async function run(): Promise<void> {
  const share = await import('@/utils/share');
  const totp = await import('@/utils/totp');
  totp.setTimeOffsetMs(0);

  scenario('Bit packing is exact at every digit count');
  for (const digits of [6, 7, 8, 10]) {
    const bits = share.bitsPerCode(digits);
    const limit = 10 ** digits;
    check(`${digits} digits fit in ${bits} bits`, 2 ** bits >= limit && 2 ** (bits - 1) < limit);
    const codes = [0, 1, limit - 1, Math.floor(limit / 2), 7, limit - 2];
    const back = share.unpackCodes(share.packCodes(codes, bits), bits, codes.length);
    check(`${digits}-digit extremes survive the trip`, JSON.stringify(back) === JSON.stringify(codes), JSON.stringify(back));
  }
  check('six-digit codes cost twenty bits', share.bitsPerCode(6) === 20);
  check('an hour of them is 300 bytes', share.packCodes(new Array(120).fill(0), 20).length === 300);

  scenario('The payload round-trips through encode and decode');
  const payload = {
    period: 30,
    digits: 6,
    startCounter: 56_666_666,
    issuer: 'Netflix',
    name: 'семья@пример.рф',
    codes: [12, 999_999, 0, 424_242],
  };
  const decoded = share.decodePayload(share.encodePayload(payload));
  check('every field comes back', JSON.stringify(decoded) === JSON.stringify(payload), JSON.stringify(decoded));

  scenario('Labels are cut on a character boundary, not a byte');
  const longName = 'ё'.repeat(100); // two bytes each
  const cut = share.decodePayload(share.encodePayload({ ...payload, name: longName }));
  check('the name is at most 64 bytes', new TextEncoder().encode(cut.name).length <= 64);
  check('and made of whole characters', cut.name === 'ё'.repeat(32), cut.name);

  scenario('Sealing and opening');
  const sealed = await share.sealShare(payload);
  check('the flag says no password', !share.shareNeedsPassword(sealed));
  const opened = await share.openShare(sealed);
  check('opens with no password', JSON.stringify(opened) === JSON.stringify(payload));

  const locked = await share.sealShare(payload, { password: 'hunter2' });
  check('the flag says a password is needed', share.shareNeedsPassword(locked));
  check('opens with the right password', JSON.stringify(await share.openShare(locked, 'hunter2')) === JSON.stringify(payload));
  let refused = false;
  try {
    await share.openShare(locked, 'hunter3');
  } catch {
    refused = true;
  }
  check('and refuses the wrong one', refused);
  refused = false;
  try {
    await share.openShare(locked);
  } catch {
    refused = true;
  }
  check('and refuses none at all', refused);

  scenario('A damaged link fails rather than showing different codes');
  const damaged = Uint8Array.from(sealed);
  damaged[damaged.length - 20] ^= 0x01;
  refused = false;
  try {
    await share.openShare(damaged);
  } catch {
    refused = true;
  }
  check('one flipped bit in the body is refused', refused);
  const flipped = Uint8Array.from(sealed);
  flipped[1] ^= 0x01;
  refused = false;
  try {
    await share.openShare(flipped);
  } catch {
    refused = true;
  }
  check('a flipped password flag is refused', refused);

  scenario('base64url survives what messengers do to a link');
  const text = share.toBase64Url(sealed);
  check('no padding, no + or /', !/[=+/]/.test(text));
  const mangled = `${text.slice(0, 40)}\n${text.slice(40)}).`;
  check('a wrapped line and a trailing bracket decode to the same bytes', share.toBase64Url(share.fromBase64Url(mangled)) === text);
  // What a mail client does, which is different: RFC 3986 recommends wrapping a
  // URL in angle brackets, the browser percent-encodes them, and the hex digits
  // left behind — 3C and 3E — are themselves base64url characters. Stripping
  // only the `%` glued them to the payload and the link was refused as damaged.
  check(
    'angle brackets round the link survive percent-encoding',
    share.toBase64Url(share.fromBase64Url(encodeURI(`<${text}>`))) === text
  );

  scenario('A link carries exactly the codes the popup would show');
  const nowMs = 1_700_000_000_000;
  const link = await share.buildShareLink({ account, durationSec: 15 * 60, nowMs });
  check('it points at the share page', link.url.startsWith('https://www.authenticator.sh/s#'));
  const fragment = share.fromBase64Url(link.url.split('#')[1]);
  const run = await share.openShare(fragment);
  const nowCounter = Math.floor(nowMs / 1000 / 30);
  check('it starts one slot early', run.startCounter === nowCounter - 1);
  check('fifteen minutes is thirty codes plus the spare', run.codes.length === 31, String(run.codes.length));
  check('valid until is the end of the last slot', link.validUntilMs === (nowCounter + 30) * 30_000);
  let agree = true;
  run.codes.forEach((code, i) => {
    const expected = totp.generateCodeAt(account, (run.startCounter + i) * 30_000);
    if (String(code).padStart(6, '0') !== expected) agree = false;
  });
  check('every code matches the generator', agree);
  check(
    'with no label written, the issuer and name travel with it',
    run.issuer === 'Netflix' && run.name === 'family@example.com'
  );

  scenario('The maximum is an hour, whatever is asked for');
  const long = await share.buildShareLink({ account, durationSec: 8 * 60 * 60, nowMs });
  check('eight hours is clamped to sixty minutes', long.validUntilMs === (nowCounter + 120) * 30_000);
  check('an hour is one hundred and twenty codes plus the spare', long.count === 121, String(long.count));
  check('and the link stays under 600 characters', long.url.length < 600, String(long.url.length));

  scenario('The longest link still fits a QR code a screen can show');
  const qr = await import('@/utils/qr-encode');
  const drawing = await qr.drawQR(long.url);
  // Version 18 is 89 modules a side. Past the mid-twenties a code read off a
  // laptop screen by a phone camera stops decoding reliably, and the hour
  // maximum was chosen so that never happens.
  check('version 18 or below', drawing.size <= 89, `${drawing.size} modules`);
  check('and it draws something', drawing.path.length > 0);
  const eight = await share.buildShareLink({ account: { ...account, digits: 8 }, durationSec: 60 * 60, nowMs });
  const dense = await qr.drawQR(eight.url);
  check('eight digits for an hour stays under version 22', dense.size <= 105, `${dense.size} modules`);

  scenario('A period the hour does not divide still makes a link the page accepts');
  {
    // The page refuses a run whose slots exceed an hour plus the spare one
    // every run starts with. Rounding the duration up broke that for every
    // period that is not a divisor of 3600 — 96 of the first 120 — and the
    // link was built, drawn as a QR code and refused on arrival.
    const limit = share.MAX_SHARE_SECONDS;
    let worst = '';
    let allWithin = true;
    for (const period of [1, 7, 11, 35, 45, 70, 90, 119, 250, 3600]) {
      const link = await share.buildShareLink({
        account: { ...account, period },
        durationSec: limit,
        nowMs,
      });
      const opened = await share.openShare(share.fromBase64Url(link.url.split('#')[1]));
      const span = opened.codes.length * period;
      if (span > limit + period) {
        allWithin = false;
        worst = `period ${period}: ${opened.codes.length} codes span ${span}s`;
      }
    }
    check('every period stays inside the run length the page allows', allWithin, worst);

    const odd = await share.buildShareLink({
      account: { ...account, period: 35 },
      durationSec: limit,
      nowMs,
    });
    const oddCounter = Math.floor(nowMs / 1000 / 35);
    check(
      'and "valid until" still names the end of the last slot it holds',
      odd.validUntilMs === (oddCounter - 1 + odd.count) * 35_000,
      String(odd.validUntilMs)
    );
  }

  scenario('A label the sender wrote travels instead of the account name');
  {
    const named = await share.buildShareLink({
      account,
      durationSec: 60,
      nowMs,
      label: '  Work VPN  ',
    });
    const opened = await share.openShare(share.fromBase64Url(named.url.split('#')[1]));
    check('the label arrives trimmed', opened.name === 'Work VPN', opened.name);
    check('and nothing is put in front of it', opened.issuer === '', opened.issuer);

    const blank = await share.buildShareLink({ account, durationSec: 60, nowMs, label: '' });
    const blankRun = await share.openShare(share.fromBase64Url(blank.url.split('#')[1]));
    check(
      'an empty label names no account at all',
      blankRun.issuer === '' && blankRun.name === '',
      `${blankRun.issuer}/${blankRun.name}`
    );

    // The field clamps with the same function that seals the payload, so what
    // is typed is what arrives — in any script, not only in Latin.
    const typed = share.clampLabel('Сбербанк '.repeat(20));
    const cyrillic = await share.buildShareLink({ account, durationSec: 60, nowMs, label: typed });
    const cyrillicRun = await share.openShare(share.fromBase64Url(cyrillic.url.split('#')[1]));
    check(
      'a Cyrillic label arrives exactly as the field would show it',
      cyrillicRun.name === typed.trim(),
      `${cyrillicRun.name} vs ${typed.trim()}`
    );
    check(
      'and it is clamped to the payload limit, not to a character count',
      new TextEncoder().encode(typed).length <= share.SHARE_LIMITS.maxLabelBytes,
      String(new TextEncoder().encode(typed).length)
    );

    const emoji = share.clampLabel('👨‍👩‍👧'.repeat(10));
    check(
      'and a clamp never splits a character',
      !emoji.includes('\uFFFD') && emoji === [...emoji].join(''),
      emoji
    );
  }

  scenario('An account that cannot produce a code cannot be shared');
  refused = false;
  try {
    await share.buildShareLink({ account: { ...account, secret: '1' }, durationSec: 60, nowMs });
  } catch (error) {
    refused = (error as Error).name === 'ShareError';
  }
  check('it throws a ShareError', refused);

  scenario('The shared fixture is the one the site also carries');
  const digest = digestOf(vectors);
  check('the vectors are unmodified', digest === EXPECTED_DIGEST, `${digest} vs ${EXPECTED_DIGEST}`);
  check('and the digest stored in the file agrees', vectors.digest === digest, `${vectors.digest} vs ${digest}`);

  scenario('Every shared vector is reproduced byte for byte');
  for (const vector of vectors.cases) {
    const built = await share.buildShareLink({
      account: { ...account, ...vector.account } as typeof account,
      durationSec: vector.durationSec,
      password: vector.password,
      nowMs: vector.nowMs,
      secret: hex(vector.secret),
      nonce: hex(vector.nonce),
    });
    check(`${vector.name}: the fragment is identical`, built.url === `https://www.authenticator.sh/s#${vector.fragment}`);
    check(`${vector.name}: valid until agrees`, built.validUntilMs === vector.validUntilMs);
    const opened = await share.openShare(share.fromBase64Url(vector.fragment), vector.password);
    check(
      `${vector.name}: the codes are the ones written down`,
      JSON.stringify(opened.codes.map((c) => String(c).padStart(opened.digits, '0'))) === JSON.stringify(vector.codes)
    );
  }
}
