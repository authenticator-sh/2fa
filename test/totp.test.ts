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

  // Plain-text export writes these URIs and batch import reads them back, so
  // the two directions are one feature. Anything that survives build() but not
  // parse() is a backup the user cannot restore, discovered on the day they
  // need it.
  scenario('An account survives the trip out to otpauth:// and back');
  const roundTrip = (account: any) => qr.parseOTPAuthURL(qr.buildOTPAuthURL(account));
  const secret = 'JBSWY3DPEHPK3PXP';

  const cases = [
    { label: 'a plain account', issuer: 'Example', name: 'a@b.com' },
    { label: 'spaces in both halves', issuer: 'Acme Corp', name: 'first last@x.com' },
    // The label is split at its first colon, so this is the case that forced
    // build() to strip colons from the issuer half and lean on issuer=.
    { label: 'a colon in the issuer', issuer: 'Acme: Inc', name: 'u@x.com' },
    { label: 'a colon in the name', issuer: 'Acme', name: 'a:b@x.com' },
    { label: 'non-ASCII', issuer: 'Больница', name: '日本@example.jp' },
    { label: 'characters the query string reserves', issuer: 'A&B=C', name: 'q?x=1&y=2' },
    { label: 'a percent sign', issuer: '100% Bank', name: 'a%b@x.com' },
    { label: 'a plus sign, which form encoding would eat', issuer: 'A+B', name: 'a+tag@x.com' },
  ];

  for (const { label, issuer, name } of cases) {
    const back = roundTrip({ ...base, issuer, name, secret });
    check(
      `${label}: issuer`,
      back?.issuer === issuer,
      `${JSON.stringify(back?.issuer)} != ${JSON.stringify(issuer)}`
    );
    check(
      `${label}: name`,
      back?.name === name,
      `${JSON.stringify(back?.name)} != ${JSON.stringify(name)}`
    );
    check(`${label}: secret`, back?.secret === secret, String(back?.secret));
  }

  scenario('Non-default parameters are written out, not assumed');
  for (const algorithm of ['SHA1', 'SHA256', 'SHA512'] as const) {
    for (const digits of [6, 7, 8]) {
      for (const period of [15, 30, 60]) {
        const back = roundTrip({ ...base, secret, algorithm, digits, period });
        check(
          `${algorithm}/${digits}/${period}`,
          back?.algorithm === algorithm && back?.digits === digits && back?.period === period,
          JSON.stringify({ a: back?.algorithm, d: back?.digits, p: back?.period })
        );
      }
    }
  }

  scenario('The URI is the shape other authenticators expect');
  const url = qr.buildOTPAuthURL({ ...base, secret, issuer: 'Example', name: 'a@b.com' });
  check('scheme and type', url.startsWith('otpauth://totp/'), url.slice(0, 20));
  check('the label carries a literal colon, not %3A', url.includes('Example:a%40b.com'), url);
  check('a space is %20, never +', !qr.buildOTPAuthURL({ ...base, secret, issuer: 'A B', name: 'c d' }).includes('+'));

  // build() omits an empty issuer; parse() fills one in. The asymmetry is the
  // parser's long-standing behaviour, recorded here so it is a decision rather
  // than a surprise.
  const noIssuer = roundTrip({ ...base, secret, issuer: '', name: 'lonely@x.com' });
  check('an account with no issuer keeps its name', noIssuer?.name === 'lonely@x.com', String(noIssuer?.name));
  check('and is read back as "Unknown"', noIssuer?.issuer === 'Unknown', String(noIssuer?.issuer));

  scenario('A pasted list of links is read line by line');
  const uriImport = await import('@/utils/uri-import');
  const backupFile = await import('@/utils/backup-file');
  const link = (name: string, issuer = 'Example') =>
    qr.buildOTPAuthURL({ ...base, name, issuer, secret });

  const plan = uriImport.planURIImport(
    [link('a@x.com'), '', '   ', link('b@x.com'), 'not a link at all', link('c@x.com')].join('\n')
  );
  check('three links parsed', plan.accounts.length === 3, String(plan.accounts.length));
  check('blank lines do not become entries', plan.unreadable.length === 1, JSON.stringify(plan.unreadable));
  check('and the bad one is named by line number', plan.unreadable[0] === 5, String(plan.unreadable[0]));

  // Line numbers, not line contents: every one of these lines carries ?secret=.
  // Serialised and searched, so it fails if any future field carries the line
  // through — asserting the types only restates what the compiler knows, and
  // the old version ran half of it over an empty array.
  const leaky = uriImport.planURIImport(
    [link('a@x.com'), `otpauth://hotp/E:c@x.com?secret=${secret}&counter=1`, 'broken'].join('\n')
  );
  const report = JSON.stringify({ ...leaky, accounts: leaky.accounts.length });
  check('the report carries no secret', !report.includes(secret), report);
  check('and no URL', !report.toLowerCase().includes('otpauth'), report);

  const hotpPlan = uriImport.planURIImport(
    [link('good@x.com'), `otpauth://hotp/Example:c@x.com?secret=${secret}&counter=1`].join('\n')
  );
  check('a counter-based link is refused, not called unreadable',
    hotpPlan.hotp.length === 1 && hotpPlan.unreadable.length === 0,
    JSON.stringify({ hotp: hotpPlan.hotp, unreadable: hotpPlan.unreadable }));
  check('and the readable one beside it still lands', hotpPlan.accounts.length === 1);

  const capped = uriImport.planURIImport(
    Array.from({ length: uriImport.MAX_IMPORT_LINES + 7 }, (_, i) => link(`u${i}@x.com`)).join('\n')
  );
  check('the cap is applied', capped.accounts.length === uriImport.MAX_IMPORT_LINES, String(capped.accounts.length));
  check('and the remainder is reported, not dropped in silence', capped.ignored === 7, String(capped.ignored));

  // Some inputs collapse a paste onto one line. Every link is still there.
  const joined = uriImport.planURIImport(`${link('p@x.com')} ${link('q@x.com')}`);
  check('links joined by a space are still separate accounts', joined.accounts.length === 2, String(joined.accounts.length));

  check('a JSON backup is not mistaken for a link list',
    uriImport.looksLikeURIList('{"version":"2.0","accounts":[]}') === false);
  check('a link list is recognised', uriImport.looksLikeURIList(`\n${link('z@x.com')}\n`) === true);
  check('an uppercase scheme too', uriImport.looksLikeURIList(link('z@x.com').toUpperCase()) === true);

  // The two halves of the feature are one format. If export ever writes
  // something import cannot read, it is a backup nobody can restore.
  scenario('What the text export writes is what the paste import reads');
  const exported = backupFile.buildURIBackupFile([
    { ...base, id: '1', name: 'a@x.com', issuer: 'Acme: Inc', secret, digits: 8, period: 60 },
    { ...base, id: '2', name: 'b:c@x.com', issuer: 'Пример', secret, algorithm: 'SHA256' },
    { ...base, id: '3', name: 'broken', issuer: 'X', secret: '!' },
  ] as any);
  check('the unusable secret is left out', exported.skipped === 1, String(exported.skipped));
  const reread = uriImport.planURIImport(exported.text);
  check('and both real accounts come back', reread.accounts.length === 2, String(reread.accounts.length));
  check('with their issuer intact', reread.accounts[0]?.issuer === 'Acme: Inc', String(reread.accounts[0]?.issuer));
  check('with a colon in the name intact', reread.accounts[1]?.name === 'b:c@x.com', String(reread.accounts[1]?.name));
  check('and their parameters intact',
    reread.accounts[0]?.digits === 8 && reread.accounts[0]?.period === 60 && reread.accounts[1]?.algorithm === 'SHA256',
    JSON.stringify(reread.accounts.map(a => [a.digits, a.period, a.algorithm])));

  // Found by review, not by the tests above: with no issuer there is no
  // issuer= to fall back on, so the label's first colon was read as the
  // separator and the front of the name became the issuer.
  scenario('An account with no issuer survives a colon in its name');
  for (const [issuer, name] of [['', 'a:b@x.com'], ['   ', 'GitHub: work'], ['', ':bob']] as const) {
    const back = roundTrip({ ...base, secret, issuer, name });
    check(
      `issuer ${JSON.stringify(issuer)} + name ${JSON.stringify(name)}`,
      back?.name === name.trim() && (back?.issuer === 'Unknown' || back?.issuer === ''),
      JSON.stringify({ issuer: back?.issuer, name: back?.name })
    );
  }

  // The point of this format is that other apps read it, and most reject
  // anything outside base32 in secret=. Our own parser normalises on the way in,
  // which is exactly why a round trip through it could not see this.
  scenario('The secret is written in the form other apps will accept');
  for (const stored of ['JBSW-Y3DP-EHPK-3PXP', 'JBSW Y3DP EHPK 3PXP', 'jbswy3dpehpk3pxp']) {
    const url = qr.buildOTPAuthURL({ ...base, issuer: 'Ex', name: 'a@x.com', secret: stored });
    check(`${JSON.stringify(stored)} is normalised`, url.includes(`secret=${secret}&`), url);
  }

  scenario('Failures are reported by line, and the cap is counted in links');
  const twoBadLines = uriImport.planURIImport('junkA junkB junkC\nbad');
  check(
    'several failures on one line are one line',
    twoBadLines.unreadable.join() === '1,2',
    JSON.stringify(twoBadLines.unreadable)
  );
  const overCap = uriImport.planURIImport(
    Array.from({ length: uriImport.MAX_IMPORT_LINES }, (_, i) => link(`u${i}@x.com`)).join('\n') +
      `\n${link('x@x.com')} ${link('y@x.com')}\n${link('z@x.com')}`
  );
  check('links past the cap are counted, not the lines holding them', overCap.ignored === 3, String(overCap.ignored));

  // The case the line-counting version got wrong, and got wrong silently: a
  // paste whose newlines collapsed to spaces puts every link on line 1, so
  // every dropped link's line had already been reached and the count came out
  // zero. Six hundred links in, five hundred imported, "Successfully imported
  // 500 account(s)" — and no mention of the hundred thrown away.
  const oneLine = uriImport.planURIImport(
    Array.from({ length: uriImport.MAX_IMPORT_LINES + 100 }, (_, i) => link(`v${i}@x.com`)).join(' ')
  );
  check(
    'a single-line paste past the cap still says what it left',
    oneLine.ignored === 100,
    String(oneLine.ignored)
  );
  check(
    'and it read exactly the cap',
    oneLine.accounts.length === uriImport.MAX_IMPORT_LINES,
    String(oneLine.accounts.length)
  );

  // The shared path both file inputs and the paste dialog now go through. It
  // was two copies before, and only one of them knew what a .txt of links was:
  // the file this extension writes came back as "invalid backup file" through
  // the input the onboarding points at.
  scenario('A list of links imports the same way from every entry point');
  const { resetState } = await import('./harness');
  await resetState();
  // Two different secrets on purpose: storage collapses accounts that share
  // one, so a pair built from the same seed would test de-duplication rather
  // than import — as the first draft of this scenario did.
  const secondSecret = 'KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU';
  const twoLinks = [
    link('one@x.com'),
    qr.buildOTPAuthURL({ ...base, issuer: 'Other', name: 'two@x.com', secret: secondSecret }),
  ].join('\n');

  const first = await uriImport.importURIList(twoLinks, 'en');
  check('the first import reports what it wrote', first.added === 2, JSON.stringify(first));
  check('and says so as a success', first.kind === 'success', first.kind);

  const storage = await import('@/utils/storage');
  check('both accounts are on disk', (await storage.getAccounts()).length === 2);

  // Same text again: the de-duplication is what stops a second attempt at a
  // half-finished migration from doubling everything.
  const second = await uriImport.importURIList(twoLinks, 'en');
  check('a repeat adds nothing', second.added === 0, JSON.stringify(second));
  check('and still leaves two accounts', (await storage.getAccounts()).length === 2);

  const nothing = await uriImport.importURIList('not a link at all', 'en');
  check('a file with no links is an error, not a silent no-op',
    nothing.kind === 'error' && nothing.added === undefined, JSON.stringify(nothing));

  // What the export writes must survive the trip through the shared importer,
  // not just through the parser.
  await resetState();
  const written = backupFile.buildURIBackupFile([
    { ...base, id: 'a', name: 'x@y.com', issuer: 'Acme', secret },
    { ...base, id: 'b', name: 'z@y.com', issuer: 'Acme', secret: 'KRSXG5CTMVRXEZLU' },
  ] as any);
  const restored = await uriImport.importURIList(written.text, 'en');
  check('an exported .txt imports as its own accounts', restored.added === 2, JSON.stringify(restored));
  check('and the file was recognised as a link list', uriImport.looksLikeURIList(written.text));

  scenario('Random bytes are never accepted as accounts');
  let accepted = 0;
  for (let i = 0; i < 300; i++) {
    const junk = new Uint8Array(Array.from({ length: 24 }, (_, k) => (i * 7 + k * 13) % 256));
    const result = migration.parseMigrationURL(`otpauth-migration://offline?data=${encodeURIComponent(toBase64(junk))}`);
    if (result) accepted++;
  }
  check('none of 300 junk payloads parsed as an account', accepted === 0, `${accepted} accepted`);
}
