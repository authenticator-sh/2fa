// What an import does with a value it cannot honour.
//
// The failure these pin down has no symptom: a link or file that says MD5, or
// four digits, or a two-hour period, used to be stored with SHA1, six digits
// and thirty seconds instead. The card looked healthy and every code it showed
// was wrong. A value nobody wrote down may be defaulted; a value somebody DID
// write down and we cannot generate with is refused and counted, through every
// door — a scanned QR, a Google Authenticator export, each backup format, a
// pasted list, CXF.
//
// Alongside it, the smaller things the same audit found at those doors: a
// damaged code of ours told apart from somebody else's QR, migration labels,
// an encrypted Steam Desktop Authenticator file, size limits, and Base64 that
// arrives wrapped or URL-safe.

import { check, resetState, scenario, USER_ADD } from './harness';

const SECRET = 'JBSWY3DPEHPK3PXP';

// ---- protobuf, by hand, the way Google Authenticator writes it --------------

const varint = (n: number): number[] => {
  const out: number[] = [];
  while (n > 127) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
};
const tag = (field: number, wire: number) => varint((field << 3) | wire);
const lengthDelimited = (field: number, bytes: number[]) => [...tag(field, 2), ...varint(bytes.length), ...bytes];
const varintField = (field: number, n: number) => [...tag(field, 0), ...varint(n)];
const utf8 = (s: string) => Array.from(new TextEncoder().encode(s));
const SEED = Array.from({ length: 20 }, (_, i) => i + 1);

function otpParameters(o: {
  name?: string;
  issuer?: string;
  algorithm?: number;
  digits?: number;
  type?: number;
  secret?: number[];
  extra?: number[];
}): number[] {
  return [
    ...lengthDelimited(1, o.secret ?? SEED),
    ...lengthDelimited(2, utf8(o.name ?? 'bob@example.com')),
    ...(o.issuer === undefined ? [] : lengthDelimited(3, utf8(o.issuer))),
    ...varintField(4, o.algorithm ?? 1),
    ...varintField(5, o.digits ?? 1),
    ...varintField(6, o.type ?? 2),
    ...(o.extra ?? []),
  ];
}

const migrationURL = (bytes: number[]) =>
  `otpauth-migration://offline?data=${encodeURIComponent(Buffer.from(bytes).toString('base64'))}`;
const payload = (...entries: number[][]) => entries.flatMap(entry => lengthDelimited(1, entry));

export async function run(): Promise<void> {
  const qr = await import('@/utils/qr-parser');
  const formats = await import('@/utils/import-formats');
  const uriImport = await import('@/utils/uri-import');
  const importMessage = await import('@/utils/import-message');
  const EI = await import('@/components/ExportImport');

  /** What parseQRCode made of it: the account, null, or the refusal's reason. */
  const outcome = (text: string): any => {
    try {
      return qr.parseQRCode(text);
    } catch (error: any) {
      return error?.name === 'UnsupportedOTPTypeError' ? { refused: error.reason } : { threw: String(error) };
    }
  };
  const link = (query: string) => `otpauth://totp/Acme:bob?secret=${SECRET}&${query}`;

  // ---- 1. stated and unsupported is refused, absent is defaulted -------------

  scenario('A link stating a parameter we cannot generate with is refused, not defaulted');
  for (const query of [
    'algorithm=MD5',
    'algorithm=SHA224',
    'digits=4',
    'digits=5',
    'digits=12',
    'period=0',
    'period=7200',
    'period=30.5',
    'digits=six',
  ]) {
    const result = outcome(link(query));
    check(`${query} is refused as unsupported`, result?.refused === 'other', JSON.stringify(result));
  }

  scenario('A link that leaves a parameter out still gets the RFC default');
  const bare = outcome(`otpauth://totp/Acme:bob?secret=${SECRET}`)?.accounts?.[0];
  check('SHA1, 6 digits, 30 seconds', bare?.algorithm === 'SHA1' && bare?.digits === 6 && bare?.period === 30, JSON.stringify(bare));
  const empty = outcome(link('algorithm=&digits=&period='))?.accounts?.[0];
  check('an empty parameter counts as left out', empty?.digits === 6 && empty?.period === 30, JSON.stringify(empty));
  const spelled = outcome(link('algorithm=HMAC-SHA-256&digits=8&period=60'))?.accounts?.[0];
  check('HMAC-SHA-256 is SHA256, 8 digits and 60 seconds are kept',
    spelled?.algorithm === 'SHA256' && spelled?.digits === 8 && spelled?.period === 60, JSON.stringify(spelled));
  const steam = outcome(`otpauth://steam/Steam:me?secret=${SECRET}&digits=6&algorithm=MD5`)?.accounts?.[0];
  check('a Steam link keeps Steam\'s own parameters whatever it states', steam?.type === 'steam' && steam?.digits === 5, JSON.stringify(steam));

  scenario('An OTP kind we do not generate is refused, not called damaged');
  check('yaotp', outcome(`otpauth://yaotp/A:b?secret=${SECRET}`)?.refused === 'other');
  check('motp', outcome(`otpauth://motp/A:b?secret=${SECRET}`)?.refused === 'other');
  check('hotp keeps its own reason', outcome(`otpauth://hotp/A:b?secret=${SECRET}&counter=1`)?.refused === 'hotp');

  scenario('Each refusal names its own message');
  const refusal = (text: string) => {
    try {
      qr.parseQRCode(text);
      return undefined;
    } catch (error) {
      return error;
    }
  };
  check('MD5 says unsupported', qr.qrFailureKey(link('algorithm=MD5'), refusal(link('algorithm=MD5'))) === 'addAccount.errorUnsupportedCode');
  const hotpLink = `otpauth://hotp/A:b?secret=${SECRET}`;
  check('HOTP says counter-based', qr.qrFailureKey(hotpLink, refusal(hotpLink)) === 'addAccount.errorHotp');

  scenario('A Google Authenticator export with MD5 or an unknown digit count skips just those');
  const mixed = outcome(
    migrationURL(
      payload(
        otpParameters({ name: 'good', issuer: 'Good' }),
        otpParameters({ name: 'md5', issuer: 'Old', algorithm: 4 }),
        otpParameters({ name: 'seven', issuer: 'Odd', digits: 3 }),
        otpParameters({ name: 'future', issuer: 'New', type: 9 })
      )
    )
  );
  check('only the usable account is imported', mixed?.accounts?.length === 1 && mixed.accounts[0].name === 'good', JSON.stringify(mixed?.accounts?.map((a: any) => a.name)));
  check('and the other three are counted', mixed?.skipped === 3, String(mixed?.skipped));
  check('an export of only MD5 is refused with a reason',
    outcome(migrationURL(payload(otpParameters({ algorithm: 4 }))))?.refused === 'other');
  const unspecified = outcome(migrationURL(payload(otpParameters({ algorithm: 0, digits: 0, type: 0 }))))?.accounts?.[0];
  check('protobuf\'s "unspecified" (0) is still the default',
    unspecified?.algorithm === 'SHA1' && unspecified?.digits === 6, JSON.stringify(unspecified));
  const eight = outcome(migrationURL(payload(otpParameters({ algorithm: 3, digits: 2 }))))?.accounts?.[0];
  check('SHA512 and eight digits are read', eight?.algorithm === 'SHA512' && eight?.digits === 8, JSON.stringify(eight));

  scenario('Every backup format refuses a stated parameter it cannot honour');
  const plan = (file: unknown) => {
    try {
      const planned = formats.planImport(formats.readImportFile(file));
      return { n: planned.usable.length, unsupported: planned.unsupported, unreadable: planned.unreadable, usable: planned.usable };
    } catch (error: any) {
      return { rejected: error?.reason ?? String(error) } as any;
    }
  };
  const aegis = plan({
    version: 1,
    header: { slots: null, params: null },
    db: {
      version: 3,
      entries: [
        { type: 'totp', name: 'ok', issuer: 'A', info: { secret: SECRET, algo: 'SHA256', digits: 8, period: 60 } },
        { type: 'totp', name: 'md5', issuer: 'A', info: { secret: SECRET + 'AA', algo: 'MD5', digits: 6, period: 30 } },
        { type: 'totp', name: 'four', issuer: 'A', info: { secret: SECRET + 'BB', algo: 'SHA1', digits: 4, period: 30 } },
        { type: 'totp', name: 'slow', issuer: 'A', info: { secret: SECRET + 'CC', algo: 'SHA1', digits: 6, period: 7200 } },
        { type: 'steam', name: 'steam', issuer: 'Steam', info: { secret: SECRET + 'DD', algo: 'SHA1', digits: 5, period: 30 } },
      ],
    },
  });
  check('Aegis: the good entry and Steam are imported', aegis.n === 2, JSON.stringify(aegis.n));
  check('Aegis: MD5, 4 digits and 7200 s are counted as unsupported', aegis.unsupported === 3, String(aegis.unsupported));
  check('Aegis: what was imported kept its stated parameters',
    aegis.usable?.some((a: any) => a.algorithm === 'SHA256' && a.digits === 8 && a.period === 60));
  const twoFas = plan({
    schemaVersion: 4,
    services: [
      { name: 'Good', secret: SECRET, otp: { account: 'a', tokenType: 'TOTP', algorithm: 'SHA1', digits: 6, period: 30 } },
      { name: 'Bad', secret: SECRET + 'AA', otp: { account: 'b', tokenType: 'TOTP', algorithm: 'SHA224', digits: 6, period: 30 } },
    ],
  });
  check('2FAS: SHA224 is unsupported', twoFas.n === 1 && twoFas.unsupported === 1, JSON.stringify(twoFas));
  const andOtp = plan([
    { secret: SECRET, issuer: 'I', label: 'five', digits: 5, type: 'TOTP', algorithm: 'SHA1', period: 30 },
    { secret: SECRET + 'AA', issuer: 'I', label: 'ok', digits: 6, type: 'TOTP', algorithm: 'SHA1', period: 30 },
  ]);
  check('andOTP: five digits on a TOTP entry is unsupported, not rounded to six', andOtp.n === 1 && andOtp.unsupported === 1, JSON.stringify(andOtp));
  const raivo = plan([{ secret: SECRET, issuer: 'I', account: 'r', kind: 'TOTP', algorithm: 'SHA1', digits: '6', timer: '7200' }]);
  check('Raivo: a timer of "7200" makes the file only-unsupported', raivo.rejected === 'only-unsupported', JSON.stringify(raivo));
  const freeOtp = plan({ tokens: [{ secret: [72, 101, 108, 108, 111, 33, -34, -83, -66, -17], label: 'f', issuerExt: 'F', algo: 'MD5', digits: 6, period: 30, type: 'TOTP' }] });
  check('FreeOTP+: MD5 is refused', freeOtp.rejected === 'only-unsupported', JSON.stringify(freeOtp));
  const bitwarden = plan({
    encrypted: false,
    items: [{ name: 'Site', login: { username: 'u', totp: `otpauth://totp/Site:u?secret=${SECRET}&algorithm=MD5` } }],
  });
  check('Bitwarden: an MD5 link is refused', bitwarden.rejected === 'only-unsupported', JSON.stringify(bitwarden));

  // Proton Authenticator's plain export, shaped as its exporter writes it
  // (proton-pass-common, entry/exporter.rs): the account rides in `content.uri`.
  const steamKey = Buffer.from('0123456789abcdefghij').toString('base64').replace(/=+$/, '');
  const proton = plan({
    version: 1,
    entries: [
      { id: 'a', content: { uri: `otpauth://totp/alice%40example.com?secret=${SECRET}&issuer=GitHub&algorithm=SHA256&digits=8&period=60`, entry_type: 'Totp', name: 'alice@example.com' }, note: null },
      { id: 'b', content: { uri: `otpauth://totp/?secret=${SECRET}AA&issuer=Dropbox`, entry_type: 'Totp', name: 'Dropbox' }, note: 'x' },
      { id: 'c', content: { uri: `steam://${steamKey}`, entry_type: 'Steam', name: 'gamer' }, note: null },
    ],
  });
  check('Proton Authenticator: all three entries import', proton.n === 3, JSON.stringify(proton));
  check('Proton Authenticator: a link keeps its account, issuer and parameters',
    proton.usable?.some((a: any) => a.name === 'alice@example.com' && a.issuer === 'GitHub' && a.algorithm === 'SHA256' && a.digits === 8 && a.period === 60),
    JSON.stringify(proton.usable));
  check('Proton Authenticator: an account with no name is called what Proton showed, not "Account"',
    proton.usable?.some((a: any) => a.name === 'Dropbox' && a.issuer === 'Dropbox'), JSON.stringify(proton.usable?.map((a: any) => a.name)));
  check('Proton Authenticator: its unpadded Base64 Steam key becomes ours',
    proton.usable?.some((a: any) => a.type === 'steam' && a.secret === formats.base64ToBase32(steamKey)), JSON.stringify(proton.usable?.map((a: any) => [a.type, a.secret])));
  const protonSealed = plan({ version: 1, salt: 'c2FsdHNhbHRzYWx0c2FsdA==', content: 'AAAA' });
  check('Proton Authenticator: a password-protected export asks for one without, not "unknown format"',
    protonSealed.rejected === 'encrypted', JSON.stringify(protonSealed));
  const missing = plan([{ secret: SECRET, issuer: 'I', label: 'x', type: 'TOTP' }]);
  check('a file that leaves the parameters out still imports with the defaults',
    missing.n === 1 && missing.usable[0].digits === 6 && missing.usable[0].period === 30 && missing.usable[0].algorithm === 'SHA1', JSON.stringify(missing));

  // Our own backups keep being read the way they always were. A record of ours
  // with an out-of-range value has been generating with the repaired one — the
  // code the user has been typing — so the restore must reproduce exactly that.
  scenario('Our own backup, including records written before the checks, reads as before');
  const ownRecord = { id: 'own-1', name: 'me', issuer: 'Old', secret: SECRET, createdAt: 1600000000000 };
  const ours = plan({ version: '1.2', exportDate: '2024-01-01', accounts: [{ ...ownRecord, algorithm: 'SHA1', digits: 4, period: 0 }] });
  check('an out-of-range record of ours is repaired, not dropped',
    ours.n === 1 && ours.usable[0].digits === 6 && ours.usable[0].period === 30, JSON.stringify(ours));
  const oldArray = plan([ownRecord]);
  check('a pre-1.2 bare array without parameters still imports with the defaults',
    oldArray.n === 1 && oldArray.usable[0].algorithm === 'SHA1' && oldArray.usable[0].digits === 6, JSON.stringify(oldArray));

  scenario('A pasted list names unsupported lines apart from counter-based ones');
  const list = [link('algorithm=MD5'), `otpauth://hotp/H:h?secret=${SECRET}`, `otpauth://totp/Ok:ok?secret=${SECRET}AA`].join('\n');
  const listPlan = uriImport.planURIImport(list);
  check('line 1 is unsupported', listPlan.unsupported.join() === '1', JSON.stringify(listPlan.unsupported));
  check('line 2 is counter-based', listPlan.hotp.join() === '2', JSON.stringify(listPlan.hotp));
  check('line 3 is imported', listPlan.accounts.length === 1);
  await resetState();
  const listOutcome = await uriImport.importURIList(list, 'en', USER_ADD);
  check('the message says both, not "counter-based" for the MD5 line',
    /can't generate/.test(listOutcome.message) && /counter-based/.test(listOutcome.message), listOutcome.message);

  scenario('The file-level messages no longer call every refusal counter-based');
  const fileMessage = importMessage.describeFileImport({ added: 1, alreadyHere: 0, unsupported: 2 }, 'en');
  check('unsupported settings are named', /algorithm/.test(fileMessage), fileMessage);

  // ---- 3. our QR with an unreadable payload vs somebody else's QR -------------

  scenario('A damaged code of ours is told apart from a QR that is not ours');
  const damaged = [
    `otpauth://totp/A:b?secret=0000`,
    `otpauth://totp/A:b?issuer=A`,
    migrationURL(payload(otpParameters({ secret: [] }))),
    'otpauth-migration://offline?data=@@@',
  ];
  for (const text of damaged) {
    check(`${text.slice(0, 40)}… parses to nothing`, qr.parseQRCode(text) === null);
    check('and is recognised as ours', qr.isAuthenticatorQR(text));
    check('so it gets the damaged-code message', qr.qrFailureKey(text) === 'addAccount.errorDamagedQR', qr.qrFailureKey(text));
  }
  for (const text of ['https://example.com/login', 'WIFI:S:home;T:WPA;P:pw;;', 'otpauth:/totp/A:b?secret=' + SECRET]) {
    check(`${text.slice(0, 30)} is not ours — the scanner keeps looking`, !qr.isAuthenticatorQR(text) && qr.qrFailureKey(text) === 'addAccount.errorInvalidQR');
  }

  // ---- 4. the scanner's upload control is a real button ------------------------

  scenario('The scanner\'s "Choose image" is a focusable button');
  {
    const React = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const Scan = (await import('@/scan/App')).default;
    const html = renderToStaticMarkup(React.createElement(Scan));
    // The input stays hidden; what a keyboard reaches is the button next to it.
    check('it is a <button type="button">', /<button type="button"[^>]*>(?:(?!<\/button>).)*Choose Image<\/button>/.test(html), html.slice(0, 200));
    check('the file input is not wrapped in a label', !/<label[^>]*>(?:(?!<\/label>).)*type="file"/.test(html));
  }

  // ---- 5. migration labels -------------------------------------------------------

  scenario('A migrated account is named the way its QR would name it');
  const label = (name: string, issuer?: string) =>
    outcome(migrationURL(payload(otpParameters({ name, issuer }))))?.accounts?.[0];
  const prefixed = label('Test1:test1@example.com', 'Test1');
  check('the issuer prefix comes off the name', prefixed?.name === 'test1@example.com' && prefixed?.issuer === 'Test1', JSON.stringify(prefixed));
  const spaced = label('Test1: test1@example.com', 'Test1');
  check('with Google\'s space after the colon', spaced?.name === 'test1@example.com', JSON.stringify(spaced));
  const noIssuer = label('Acme:alice@example.com');
  check('no issuer: the label is split at its first colon', noIssuer?.issuer === 'Acme' && noIssuer?.name === 'alice@example.com', JSON.stringify(noIssuer));
  const plain = label('alice@example.com');
  check('no issuer and no colon: the issuer stays empty, not the name or "Unknown"', plain?.issuer === '' && plain?.name === 'alice@example.com', JSON.stringify(plain));
  const other = label('Other:bob', 'Acme');
  check('a colon that is not the issuer\'s prefix is left alone', other?.name === 'Other:bob' && other?.issuer === 'Acme', JSON.stringify(other));
  const via = qr.parseQRCode(`otpauth://totp/Test1:test1@example.com?secret=${SECRET}&issuer=Test1`)?.accounts[0];
  check('and it matches what the same account\'s own QR gives', via?.name === prefixed?.name && via?.issuer === prefixed?.issuer);

  // ---- 6. encrypted Steam Desktop Authenticator files ----------------------------

  scenario('An encrypted SDA .maFile gets a way out, not "unknown format"');
  const cipher = Buffer.from(Array.from({ length: 1024 }, (_, i) => (i * 37) & 0xff)).toString('base64');
  const importText = async (text: string, fileName?: string) => {
    try {
      await EI.importBackupText(text, () => null, fileName);
      return 'imported';
    } catch (error: any) {
      return error?.reason ?? String(error);
    }
  };
  await resetState();
  check('an encrypted .maFile is recognised', (await importText(cipher, '76561198000000000.maFile')) === 'steam-encrypted');
  check('the message sends them to SDA',
    /Steam Desktop Authenticator/.test(importMessage.importErrorMessage(new formats.ImportRejectedError('steam-encrypted'), 'en')));
  check('the same bytes under another name are not called an SDA file',
    (await importText(cipher, 'backup.json')) === 'unknown-format');
  check('nor with no name at all', (await importText(cipher)) === 'unknown-format');
  check('a .maFile that is plain garbage is not either', (await importText('not base64 at all!', 'x.maFile')) === 'unknown-format');
  const manifest = { encrypted: true, first_run: false, entries: [{ encryption_iv: 'aXY=', encryption_salt: 'c2FsdA==', filename: '7656.maFile', steamid: 7656 }] };
  check('an encrypted SDA manifest.json is not taken for a Bitwarden export',
    (await importText(JSON.stringify(manifest), 'manifest.json')) === 'steam-encrypted');
  check('an unencrypted one holds no secrets and says so as unknown',
    (await importText(JSON.stringify({ ...manifest, encrypted: false }), 'manifest.json')) === 'unknown-format');
  const maFile = { shared_secret: Buffer.from(SEED).toString('base64'), account_name: 'gamer', revocation_code: 'R00000' };
  check('an unencrypted .maFile still imports', (await importText(JSON.stringify(maFile), 'gamer.maFile')) === 'imported');

  // ---- 7. size limits ---------------------------------------------------------------

  scenario('A secret longer than any issued key is refused everywhere; long names are cut');
  const huge = 'A'.repeat(100_000);
  check('a link with a 100 000-character secret parses to nothing', qr.parseQRCode(`otpauth://totp/A:b?secret=${huge}`) === null);
  check('a 512-character secret is still fine', qr.parseQRCode(`otpauth://totp/A:b?secret=${'A'.repeat(512)}`) !== null);
  check('513 is not', qr.parseQRCode(`otpauth://totp/A:b?secret=${'A'.repeat(513)}`) === null);
  const hugeFile = plan([{ secret: huge, issuer: 'I', label: 'x', type: 'TOTP' }]);
  check('a file entry with one is unreadable', hugeFile.rejected === 'nothing-readable', JSON.stringify(hugeFile));
  const hugeSeed = Array.from({ length: 400 }, (_, i) => i & 0xff);
  const hugeMigration = outcome(migrationURL(payload(otpParameters({ secret: hugeSeed }), otpParameters({ name: 'ok' }))));
  check('a migration entry with one is skipped', hugeMigration?.accounts?.length === 1 && hugeMigration?.skipped === 1, JSON.stringify(hugeMigration?.skipped));
  const cxf = await import('@/utils/cxf');
  const hugeCxf = cxf.readCxf(JSON.stringify({ version: 1, exporter: 'x', items: [{ id: 'h', title: 'H', credentials: [{ type: 'totp', secret: huge }] }] }));
  check('a CXF credential with one is unreadable', hugeCxf.accounts.length === 0 && hugeCxf.unreadable === 1);
  const longName = 'n'.repeat(5000);
  const clampedLink = qr.parseQRCode(`otpauth://totp/${'i'.repeat(5000)}:${longName}?secret=${SECRET}`)?.accounts[0];
  check('a link\'s name and issuer are cut to 256', clampedLink?.name.length === 256 && clampedLink?.issuer.length === 256,
    `${clampedLink?.name.length}/${clampedLink?.issuer.length}`);
  const clampedFile = plan([{ secret: SECRET, issuer: 'i'.repeat(5000), label: longName, type: 'TOTP' }]);
  check('a file entry\'s too', clampedFile.usable?.[0]?.name.length === 256 && clampedFile.usable?.[0]?.issuer.length === 256);
  const clampedMigration = label(longName, 'I');
  check('a migration entry\'s too', clampedMigration?.name.length === 256, String(clampedMigration?.name.length));
  check('an emoji is never cut in half', qr.clampLabel('😀'.repeat(300)) === '😀'.repeat(256));

  // ---- 8. Base64 wrapped or URL-safe -------------------------------------------------

  scenario('A Steam key in Base64 is read wrapped or URL-safe, and grouped Base32 stays Base32');
  // 20 bytes whose Base64 uses both `+` and `/`, so the URL-safe spelling differs.
  const steamBytes = [0xfb, 0xff, 0xbf, 0x01, 0x02, 0x03, 0xfb, 0xef, 0xff, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80, 0x90, 0xa0, 0xb0];
  const standard = Buffer.from(steamBytes).toString('base64');
  const expected = formats.base64ToBase32(standard);
  check('the fixture really uses + and /', /[+/]/.test(standard), standard);
  check('URL-safe Base64 reads the same', formats.base64ToBase32(standard.replace(/\+/g, '-').replace(/\//g, '_')) === expected);
  check('unpadded URL-safe too', formats.base64ToBase32(standard.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')) === expected);
  check('wrapped across lines reads the same', formats.base64ToBase32(`${standard.slice(0, 12)}\n${standard.slice(12)}\r\n`) === expected);
  check('and through the Steam reader', formats.steamSecretToBase32(standard.replace(/\+/g, '-').replace(/\//g, '_')) === expected);
  const base32Key = expected; // 32 characters of Base32: exactly Steam's 20 bytes
  const hyphenated = base32Key.match(/.{4}/g)!.join('-');
  check('a Base32 Steam key grouped with hyphens stays that key', formats.steamSecretToBase32(hyphenated) === base32Key, hyphenated);
  check('grouped with spaces too', formats.steamSecretToBase32(base32Key.match(/.{4}/g)!.join(' ')) === base32Key);
  // 22 Base32 characters in groups of four is 27 characters with separators —
  // exactly 20 bytes if the hyphens were read as URL-safe Base64.
  const oddKey = 'JBSWY3DPEHPK3PXPJBSWY3';
  const oddGrouped = oddKey.match(/.{1,4}/g)!.join('-');
  check('an odd-length grouped Base32 key is not re-read as 20 bytes of Base64',
    formats.steamSecretToBase32(oddGrouped) === oddKey, `${oddGrouped} → ${formats.steamSecretToBase32(oddGrouped)}`);

  // ---- 9. unknown protobuf fields ------------------------------------------------------

  scenario('Unknown protobuf fields of every wire type are skipped, not fatal');
  const unknownInside = [
    ...varintField(20, 300), // wire 0
    ...tag(21, 1), 1, 2, 3, 4, 5, 6, 7, 8, // wire 1: fixed64
    ...lengthDelimited(22, utf8('future field')), // wire 2
    ...tag(23, 5), 9, 9, 9, 9, // wire 5: fixed32
  ];
  const withUnknown = migrationURL([
    ...varintField(2, 1), // version
    ...lengthDelimited(9, [1, 2, 3]), // an unknown top-level message
    ...lengthDelimited(1, otpParameters({ name: 'alice', issuer: 'Acme', algorithm: 2, digits: 2, extra: unknownInside })),
    ...tag(10, 5), 0, 0, 0, 0, // an unknown top-level fixed32
    ...varintField(3, 1), // batch_size
    ...varintField(4, 0), // batch_index
    ...varintField(5, 12345), // batch_id
  ]);
  const unknownResult = outcome(withUnknown);
  const unknownAccount = unknownResult?.accounts?.[0];
  check('the account is read', unknownResult?.accounts?.length === 1, JSON.stringify(unknownResult));
  check('with nothing counted as skipped', unknownResult?.skipped === 0, String(unknownResult?.skipped));
  check('and every known field intact',
    unknownAccount?.name === 'alice' && unknownAccount?.issuer === 'Acme' && unknownAccount?.algorithm === 'SHA256' && unknownAccount?.digits === 8,
    JSON.stringify(unknownAccount));
  const { cleanSecret } = await import('@/utils/totp');
  check('including the secret', cleanSecret(unknownAccount?.secret ?? '').replace(/=+$/, '') === formats.base64ToBase32(Buffer.from(SEED).toString('base64')));
}
