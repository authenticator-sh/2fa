// Regenerates the shared TOTP vectors.
//
//   npx tsx test/fixtures/generate.ts
//
// The extension is the reference implementation here — the site's generator has
// to reproduce these codes exactly, because it is the page people open in order
// to check the extension, and two different answers to "what is my code right
// now" is the worst thing the pair of them can produce.
//
// The file this writes is duplicated into site/test/fixtures/. That duplication
// is deliberate — neither repository can import the other's source — and the
// digest inside it is what makes a one-sided edit fail loudly.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

(globalThis as any).chrome = { storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } } };

const totp = await import('../../src/utils/totp');

const CASES = [
  { name: 'rfc6238 sha1 t=59', secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', algorithm: 'SHA1', digits: 8, period: 30, atMs: 59_000 },
  { name: 'rfc6238 sha1 t=1111111109', secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', algorithm: 'SHA1', digits: 8, period: 30, atMs: 1_111_111_109_000 },
  { name: 'rfc6238 sha256', secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA', algorithm: 'SHA256', digits: 8, period: 30, atMs: 1_234_567_890_000 },
  { name: 'rfc6238 sha512', secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', algorithm: 'SHA512', digits: 8, period: 30, atMs: 2_000_000_000_000 },
  { name: 'six digits', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, atMs: 1_700_000_000_000 },
  { name: 'seven digits', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 7, period: 30, atMs: 1_700_000_000_000 },
  { name: 'sixty second period', secret: 'KRSXG5CTMVRXEZLU', algorithm: 'SHA256', digits: 8, period: 60, atMs: 1_700_000_045_000 },
  { name: 'fifteen second period', secret: 'KRSXG5CTMVRXEZLU', algorithm: 'SHA1', digits: 6, period: 15, atMs: 1_700_000_045_000 },
  { name: 'lowercase secret', secret: 'jbswy3dpehpk3pxp', algorithm: 'SHA1', digits: 6, period: 30, atMs: 1_700_000_000_000 },
  { name: 'spaced secret', secret: 'JBSW Y3DP EHPK 3PXP', algorithm: 'SHA1', digits: 6, period: 30, atMs: 1_700_000_000_000 },
  { name: 'dashed secret', secret: 'JBSW-Y3DP-EHPK-3PXP', algorithm: 'SHA1', digits: 6, period: 30, atMs: 1_700_000_000_000 },
  { name: 'padded secret', secret: 'MZXW6YTBOI======', algorithm: 'SHA1', digits: 6, period: 30, atMs: 1_700_000_000_000 },
  { name: 'two character secret', secret: 'MZ', algorithm: 'SHA1', digits: 6, period: 30, atMs: 1_700_000_000_000 },
  { name: 'thirty two character secret', secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, atMs: 1_700_000_000_000 },
  { name: 'period zero falls back to thirty', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 0, atMs: 1_700_000_000_000 },
  { name: 'boundary just before a step', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, atMs: 1_700_000_009_999 },
  { name: 'boundary at a step', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, atMs: 1_700_000_010_000 },
];

const vectors = CASES.map((c) => {
  const spy = Date.now;
  (Date as any).now = () => c.atMs;
  try {
    const { code } = totp.generateTOTP({ id: 'x', name: 'n', issuer: 'i', createdAt: 1, secret: c.secret, algorithm: c.algorithm as any, digits: c.digits, period: c.period });
    return { ...c, code };
  } finally {
    (Date as any).now = spy;
  }
});

const URIS = [
  { name: 'issuer in the path', uri: 'otpauth://totp/GitHub:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub', accepted: true, secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30 },
  { name: 'uppercase scheme and type', uri: 'OTPAUTH://TOTP/GitHub:alice@example.com?secret=JBSWY3DPEHPK3PXP', accepted: true, secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30 },
  { name: 'no slash before the query', uri: 'otpauth://totp?secret=JBSWY3DPEHPK3PXP', accepted: true, secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30 },
  { name: 'all parameters spelled out', uri: 'otpauth://totp/Acme:bob@example.com?secret=KRSXG5CTMVRXEZLU&algorithm=SHA256&digits=8&period=60', accepted: true, secret: 'KRSXG5CTMVRXEZLU', algorithm: 'SHA256', digits: 8, period: 60 },
  { name: 'dashed algorithm spelling', uri: 'otpauth://totp/Acme?secret=JBSWY3DPEHPK3PXP&algorithm=SHA-256', accepted: true, secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA256', digits: 6, period: 30 },
  { name: 'label with more than one colon', uri: 'otpauth://totp/Acme:a:b@example.com?secret=JBSWY3DPEHPK3PXP', accepted: true, secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30 },
  { name: 'no secret at all', uri: 'otpauth://totp/Acme', accepted: false },
  { name: 'empty secret', uri: 'otpauth://totp/Acme?secret=', accepted: false },
  { name: 'counter based', uri: 'otpauth://hotp/Acme?secret=JBSWY3DPEHPK3PXP&counter=1', accepted: false },
  { name: 'not a uri at all', uri: 'JBSWY3DPEHPK3PXP', accepted: false },
];

const body = {
  note: 'Shared between extension/ and site/. Both implementations must reproduce every code below. Regenerate deliberately, in both repositories at once.',
  digest: '',
  codes: vectors,
  uris: URIS,
};
body.digest = createHash('sha256').update(JSON.stringify({ codes: body.codes, uris: body.uris })).digest('hex').slice(0, 16);
writeFileSync(new URL('totp-vectors.json', import.meta.url), JSON.stringify(body, null, 2) + '\n');
console.log('digest', body.digest);
console.log(vectors.map((v) => `${v.name}: ${v.code}`).join('\n'));
