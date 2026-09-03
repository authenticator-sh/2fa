// Regenerates the shared code-sharing vectors.
//
//   npx tsx test/fixtures/generate-share.ts
//
// The extension makes the links and the site's /s page opens them; they share
// no code. Each case here pins the link's secret and nonce, so the fragment is
// a deterministic function of the inputs and the site can be asked to open the
// exact bytes this build produces — a wrong bit order, a wrong salt, a label
// cut mid-character would all show up as a case that fails to open or opens to
// the wrong codes.
//
// The file this writes is duplicated into site/test/fixtures/. Deliberate —
// neither repository can import the other — and the digest is what makes a
// one-sided edit fail loudly. Update EXPECTED_DIGEST in both test files after
// running this.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

(globalThis as any).chrome = { storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } } };

const share = await import('../../src/utils/share');

const base = {
  id: 'x',
  createdAt: 1,
  name: 'family@example.com',
  issuer: 'Netflix',
  secret: 'JBSWY3DPEHPK3PXP',
  algorithm: 'SHA1' as const,
  digits: 6,
  period: 30,
};

const CASES = [
  {
    name: 'five minutes, six digits',
    account: {},
    durationSec: 300,
    nowMs: 1_700_000_000_000,
    secret: '000102030405060708090a0b0c0d0e0f',
    nonce: '101112131415161718191a1b',
  },
  {
    name: 'an hour, eight digits, sha256, sixty seconds',
    account: { secret: 'KRSXG5CTMVRXEZLU', algorithm: 'SHA256', digits: 8, period: 60, issuer: 'Acme', name: 'bob' },
    durationSec: 3600,
    nowMs: 1_700_000_045_000,
    secret: 'ffeeddccbbaa99887766554433221100',
    nonce: 'a0a1a2a3a4a5a6a7a8a9aaab',
  },
  {
    name: 'a password',
    account: {},
    durationSec: 900,
    nowMs: 1_700_000_000_000,
    password: 'correct horse',
    secret: '0f0e0d0c0b0a09080706050403020100',
    nonce: '0b0a09080706050403020100',
  },
  {
    name: 'seven digits, non-latin labels, an empty issuer',
    account: { digits: 7, issuer: '', name: 'семья · 家族 · 🙂' },
    durationSec: 300,
    nowMs: 1_700_000_000_000,
    secret: '11111111111111111111111111111111',
    nonce: '222222222222222222222222',
  },
  {
    name: 'a label longer than the field',
    account: { issuer: 'ё'.repeat(100), name: 'x'.repeat(200) },
    durationSec: 300,
    nowMs: 1_700_000_000_000,
    secret: '33333333333333333333333333333333',
    nonce: '444444444444444444444444',
  },
  {
    name: 'the last slot before the epoch runs into the padding',
    account: {},
    durationSec: 300,
    nowMs: 15_000,
    secret: '55555555555555555555555555555555',
    nonce: '666666666666666666666666',
  },
];

const hex = (text: string) => Uint8Array.from(Buffer.from(text, 'hex'));

const cases = [];
for (const c of CASES) {
  const account = { ...base, ...c.account } as typeof base;
  const link = await share.buildShareLink({
    account,
    durationSec: c.durationSec,
    password: c.password,
    nowMs: c.nowMs,
    secret: hex(c.secret),
    nonce: hex(c.nonce),
  });
  const fragment = link.url.slice(link.url.indexOf('#') + 1);
  const opened = await share.openShare(share.fromBase64Url(fragment), c.password);
  cases.push({
    ...c,
    fragment,
    validUntilMs: link.validUntilMs,
    startCounter: opened.startCounter,
    issuer: opened.issuer,
    label: opened.name,
    codes: opened.codes.map((code) => String(code).padStart(opened.digits, '0')),
  });
}

const body = {
  note: 'Shared between extension/ and site/. The site must open every fragment below to exactly these codes. Regenerate deliberately, in both repositories at once.',
  digest: '',
  cases,
};
body.digest = createHash('sha256').update(JSON.stringify(body.cases)).digest('hex').slice(0, 16);
writeFileSync(new URL('share-vectors.json', import.meta.url), JSON.stringify(body, null, 2) + '\n');
console.log('digest', body.digest);
console.log(cases.map((c) => `${c.name}: ${c.codes.length} codes, ${c.fragment.length} chars`).join('\n'));
