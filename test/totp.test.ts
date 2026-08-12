// Code generation and the parsers that feed it.
//
// These three modules had no tests at all, and between them they held the
// defects that produced silently wrong codes and the one that took the whole
// popup down. They are pure functions, so the scenarios below are the cheapest
// coverage in the project.

import { check, scenario } from './harness';

const base = {
  id: 'x',
  name: 'a@b.com',
  issuer: 'Example',
  algorithm: 'SHA1' as const,
  digits: 6,
  period: 30,
  createdAt: 1,
};

export async function run(): Promise<void> {
  const totp = await import('@/utils/totp');
  const qr = await import('@/utils/qr-parser');
  const migration = await import('@/utils/migration-parser');

  // RFC 6238 appendix B. Without these there was nothing anywhere asserting the
  // extension produces correct codes at all.
  scenario('Codes match the RFC 6238 test vectors');
  const seed = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // ASCII "12345678901234567890"
  const at = (seconds: number, digits: number, algorithm: any) => {
    const spy = Date.now;
    (Date as any).now = () => seconds * 1000;
    try {
      return totp.generateTOTP({ ...base, secret: seed, digits, algorithm } as any).code;
    } finally {
      (Date as any).now = spy;
    }
  };
  check('T=59 SHA1 8 digits', at(59, 8, 'SHA1') === '94287082', at(59, 8, 'SHA1'));
  check('T=1111111109 SHA1 8 digits', at(1111111109, 8, 'SHA1') === '07081804', at(1111111109, 8, 'SHA1'));
  check('T=1234567890 SHA1 8 digits', at(1234567890, 8, 'SHA1') === '89005924', at(1234567890, 8, 'SHA1'));
  check('T=2000000000 SHA1 8 digits', at(2000000000, 8, 'SHA1') === '69279037', at(2000000000, 8, 'SHA1'));

  // The defect: otpauth throws on any non-base32 character, and useTOTP
  // generates during render — so this throw unmounted every account, on every
  // open, permanently.
  scenario('A hyphenated secret is read, not fatal');
  check('hyphens are stripped', totp.cleanSecret('JBSW-Y3DP-EHPK-3PXP') === 'JBSWY3DPEHPK3PXP');
  check('so are unicode dashes and nbsp', totp.cleanSecret('JBSW‑Y3DP EHPK　3PXP') === 'JBSWY3DPEHPK3PXP');
  check('lowercase is normalised', totp.cleanSecret('jbswy3dpehpk3pxp') === 'JBSWY3DPEHPK3PXP');
  check(
    'a hyphenated secret now generates',
    totp.tryGenerateTOTP({ ...base, secret: 'JBSW-Y3DP-EHPK-3PXP' } as any)?.code ===
      totp.tryGenerateTOTP({ ...base, secret: 'JBSWY3DPEHPK3PXP' } as any)?.code
  );

  scenario('Digits that are not base32 stay invalid rather than being quietly dropped');
  // Stripping 0/1/8 would turn a corrupt secret into a well-formed one and
  // generate confident, wrong codes.
  check('a hex-looking secret is rejected', !totp.isUsableSecret('ABCDEFGH01234567'));
  check('and does not throw out of tryGenerate', totp.tryGenerateTOTP({ ...base, secret: 'ABCDEFGH01234567' } as any) === null);
  check('an empty secret is rejected', !totp.isUsableSecret(''));
  check('an empty secret yields no code', totp.tryGenerateTOTP({ ...base, secret: '' } as any) === null);
  check('a non-string secret is rejected', !totp.isUsableSecret(undefined));

  scenario('generateTOTP still throws so callers cannot ignore a bad record');
  let threw = false;
  try {
    totp.generateTOTP({ ...base, secret: 'ABCDEFGH01234567' } as any);
  } catch (error: any) {
    threw = error?.name === 'InvalidSecretError';
  }
  check('with a named error', threw);

  // A zero or NaN period made otpauth emit the same code at every timestamp,
  // behind a countdown that looked healthy because ProgressRing substitutes a
  // sane value for display.
  scenario('A broken period cannot freeze the code');
  for (const period of [0, -30, NaN, undefined, 'abc']) {
    const a = totp.tryGenerateTOTP({ ...base, secret: 'JBSWY3DPEHPK3PXP', period } as any);
    check(`period=${String(period)} falls back to 30`, a?.period === 30, JSON.stringify(a));
    check(`period=${String(period)} has a finite countdown`, Number.isFinite(a?.remaining));
  }

  scenario('Digit counts survive instead of being rounded down');
  check('7 digits is honoured', totp.tryGenerateTOTP({ ...base, secret: 'JBSWY3DPEHPK3PXP', digits: 7 } as any)?.code.length === 7);
  check('8 digits is honoured', totp.tryGenerateTOTP({ ...base, secret: 'JBSWY3DPEHPK3PXP', digits: 8 } as any)?.code.length === 8);
  check('a nonsense digit count falls back to 6', totp.tryGenerateTOTP({ ...base, secret: 'JBSWY3DPEHPK3PXP', digits: NaN } as any)?.code.length === 6);

  scenario('The countdown and the code come from the same instant');
  const sample = totp.tryGenerateTOTP({ ...base, secret: 'JBSWY3DPEHPK3PXP' } as any)!;
  check('remaining is within the period', sample.remaining > 0 && sample.remaining <= 30);

  // --- qr-parser ----------------------------------------------------------

  scenario('Counter-based tokens are refused, not stored as TOTP');
  let hotpRefused = false;
  try {
    qr.parseOTPAuthURL('otpauth://hotp/ACME:alice?secret=JBSWY3DPEHPK3PXP&counter=42');
  } catch (error: any) {
    hotpRefused = error?.name === 'UnsupportedOTPTypeError';
  }
  check('a hotp URL throws UnsupportedOTPTypeError', hotpRefused);

  scenario('otpauth:// parameters are range-checked at the door');
  const parsed = qr.parseOTPAuthURL('otpauth://totp/ACME:alice?secret=JBSWY3DPEHPK3PXP&period=0&digits=99&algorithm=SHA-256');
  check('a zero period is replaced', parsed?.period === 30);
  check('an absurd digit count is replaced', parsed?.digits === 6);
  check('hyphenated SHA-256 is preserved, not downgraded', parsed?.algorithm === 'SHA256', String(parsed?.algorithm));

  const seven = qr.parseOTPAuthURL('otpauth://totp/ACME:alice?secret=JBSWY3DPEHPK3PXP&digits=7');
  check('7 digits survives the parser', seven?.digits === 7, String(seven?.digits));

  check(
    'a secret that is not base32 is refused',
    qr.parseOTPAuthURL('otpauth://totp/ACME:alice?secret=NOT_VALID_0189') === null
  );

  const spaced = qr.parseOTPAuthURL('otpauth://totp/ACME%3A%20alice%40example.com?secret=JBSWY3DPEHPK3PXP');
  check('Google’s "Issuer: Account" space is trimmed', spaced?.name === 'alice@example.com', JSON.stringify(spaced?.name));

  // --- migration-parser ---------------------------------------------------

  // Build a real MigrationPayload so the assertions run against the same bytes
  // Google Authenticator emits.
  const buildPayload = (entries: Array<{ secret: number[]; name: string; issuer: string; type?: number }>) => {
    const bytes: number[] = [];
    const varint = (n: number) => { while (n > 127) { bytes.push((n & 0x7f) | 0x80); n >>>= 7; } bytes.push(n); };
    const utf8 = (s: string) => Array.from(new TextEncoder().encode(s));
    for (const entry of entries) {
      const body: number[] = [];
      const push = (arr: number[]) => body.push(...arr);
      const bvarint = (n: number) => { const out: number[] = []; while (n > 127) { out.push((n & 0x7f) | 0x80); n >>>= 7; } out.push(n); return out; };
      push([0x0a]); push(bvarint(entry.secret.length)); push(entry.secret);
      const nameBytes = utf8(entry.name); push([0x12]); push(bvarint(nameBytes.length)); push(nameBytes);
      const issuerBytes = utf8(entry.issuer); push([0x1a]); push(bvarint(issuerBytes.length)); push(issuerBytes);
      push([0x20, 1]); // algorithm = SHA1
      push([0x28, 1]); // digits = SIX
      push([0x30, entry.type ?? 2]); // type: 2 = TOTP, 1 = HOTP
      bytes.push(0x0a); varint(body.length); bytes.push(...body);
    }
    return new Uint8Array(bytes);
  };

  const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

  scenario('A migration payload containing "+" is decoded, not silently corrupted');
  // Find a payload whose base64 contains a '+', which is where URLSearchParams
  // substituted a space and atob then skipped it, shifting every later bit.
  let plusPayload: Uint8Array | null = null;
  for (let i = 0; i < 400 && !plusPayload; i++) {
    const secret = Array.from({ length: 20 }, (_, k) => (i * 31 + k * 17) % 256);
    const candidate = buildPayload([{ secret, name: `user${i}`, issuer: 'ACME' }]);
    if (toBase64(candidate).includes('+')) plusPayload = candidate;
  }
  check('a payload with "+" was constructed', plusPayload !== null);

  if (plusPayload) {
    const url = `otpauth-migration://offline?data=${encodeURIComponent(toBase64(plusPayload))}`;
    const direct = migration.parseMigrationURL(`otpauth-migration://offline?data=${toBase64(plusPayload)}`);
    const encoded = migration.parseMigrationURL(url);
    check('the percent-encoded form parses', encoded !== null && encoded.accounts.length === 1);
    check('the raw "+" form parses too', direct !== null && direct.accounts.length === 1);
    check(
      'both yield the same secret',
      direct?.accounts[0]?.secret === encoded?.accounts[0]?.secret,
      `${direct?.accounts[0]?.secret} vs ${encoded?.accounts[0]?.secret}`
    );
  }

  scenario('Migration entries carry their real type through');
  const mixed = buildPayload([
    { secret: Array.from({ length: 20 }, (_, i) => i + 1), name: 'totp-one', issuer: 'ACME' },
    { secret: Array.from({ length: 20 }, (_, i) => i + 9), name: 'hotp-one', issuer: 'BANK', type: 1 },
  ]);
  const mixedParsed = migration.parseMigrationURL(`otpauth-migration://offline?data=${encodeURIComponent(toBase64(mixed))}`);
  check('both entries parse', mixedParsed?.accounts.length === 2, String(mixedParsed?.accounts.length));
  check('the hotp entry is labelled hotp', mixedParsed?.accounts.some(a => a.type === 'hotp') === true);

  const viaQr = qr.parseQRCode(`otpauth-migration://offline?data=${encodeURIComponent(toBase64(mixed))}`);
  check('the QR layer keeps only the totp entry', viaQr?.accounts.length === 1, String(viaQr?.accounts.length));
  check('and reports the one it dropped', viaQr?.skipped === 1, String(viaQr?.skipped));

  scenario('An all-HOTP migration is refused with a reason');
  const allHotp = buildPayload([{ secret: Array.from({ length: 20 }, (_, i) => i + 3), name: 'only', issuer: 'BANK', type: 1 }]);
  let batchRefused = false;
  try {
    qr.parseQRCode(`otpauth-migration://offline?data=${encodeURIComponent(toBase64(allHotp))}`);
  } catch (error: any) {
    batchRefused = error?.name === 'UnsupportedOTPTypeError';
  }
  check('parseQRCode throws rather than returning a bare null', batchRefused);

  scenario('Malformed migration data is rejected instead of truncated');
  const truncated = buildPayload([{ secret: Array.from({ length: 20 }, (_, i) => i + 1), name: 'user', issuer: 'ACME' }]);
  const chopped = truncated.slice(0, truncated.length - 6);
  const choppedResult = migration.parseMigrationURL(`otpauth-migration://offline?data=${encodeURIComponent(toBase64(chopped))}`);
  check('a payload cut short yields no accounts', choppedResult === null, JSON.stringify(choppedResult));

  // Google splits an export at ten accounts per code, behind a "Next" button on
  // the phone that people miss — so the UI has to be able to say which code it
  // just read. The payload carries it; the parser used to skip past it.
  scenario('Batch metadata survives the parse');
  const withBatch = (() => {
    const body = buildPayload([{ secret: Array.from({ length: 20 }, (_, i) => i + 5), name: 'u', issuer: 'ACME' }]);
    // MigrationPayload: field 3 = batch_size, field 4 = batch_index.
    return new Uint8Array([...body, 0x18, 3, 0x20, 1]);
  })();
  const batched = migration.parseMigrationURL(`otpauth-migration://offline?data=${encodeURIComponent(toBase64(withBatch))}`);
  check('batch size is read', batched?.batchSize === 3, String(batched?.batchSize));
  check('batch index is read', batched?.batchIndex === 1, String(batched?.batchIndex));
  check('the account still parses alongside it', batched?.accounts.length === 1);

  const batchedQr = qr.parseQRCode(`otpauth-migration://offline?data=${encodeURIComponent(toBase64(withBatch))}`);
  check('the QR layer reports it 1-based', batchedQr?.batch?.index === 2 && batchedQr?.batch?.total === 3, JSON.stringify(batchedQr?.batch));

  const single = qr.parseQRCode(`otpauth-migration://offline?data=${encodeURIComponent(toBase64(truncated))}`);
  check('a single-code export reports no batch', single?.batch === undefined, JSON.stringify(single?.batch));

  check(
    'a data param that is not base64 is refused',
    migration.parseMigrationURL('otpauth-migration://offline?data=@@@not-base64@@@') === null
  );

  scenario('Random bytes are never accepted as accounts');
  let accepted = 0;
  for (let i = 0; i < 300; i++) {
    const junk = new Uint8Array(Array.from({ length: 24 }, (_, k) => (i * 7 + k * 13) % 256));
    const result = migration.parseMigrationURL(`otpauth-migration://offline?data=${encodeURIComponent(toBase64(junk))}`);
    if (result) accepted++;
  }
  check('none of 300 junk payloads parsed as an account', accepted === 0, `${accepted} accepted`);
}
