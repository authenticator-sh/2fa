// Credential Exchange Format, the interchange format shared with Apple,
// Google, 1Password, Bitwarden and Dashlane.
//
// Two failure modes are worth more than the rest put together, because both are
// silent: a secret that survives export but decodes differently on the far side
// (every code wrong, forever), and a real-world file whose TOTP credential sits
// next to a password inside one login item (the 2FA half vanishes and nobody
// notices until a login is needed).

import { check, flush, resetState, scenario, USER_ADD } from './harness';

const ACCOUNTS: any[] = [
  { id: 'a1', name: 'alice@example.com', issuer: 'GitHub', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, createdAt: 1700000000000 },
  { id: 'a2', name: 'bob@example.com', issuer: 'Google', secret: 'KRSXG5CTMVRXEZLU', algorithm: 'SHA256', digits: 8, period: 60, createdAt: 1700000001000 },
  { id: 'a3', name: 'ops', issuer: 'AWS', secret: 'MFRGGZDFMZTWQ2LK', algorithm: 'SHA512', digits: 7, period: 30, createdAt: 1700000002000 },
];

export async function run(): Promise<void> {
  const cxf = await import('@/utils/cxf');
  const storage = await import('@/utils/storage');

  scenario('An export round-trips through the format without losing a field');
  const text = cxf.buildCxfFile(ACCOUNTS);
  const back = cxf.readCxfFile(text);
  check('every account survives', back.length === 3, `got ${back.length}`);
  for (const original of ACCOUNTS) {
    const restored = back.find((a) => a.secret === original.secret);
    check(`${original.issuer}: secret matches`, restored?.secret === original.secret);
    check(`${original.issuer}: algorithm matches`, restored?.algorithm === original.algorithm);
    check(`${original.issuer}: digits match`, restored?.digits === original.digits, `got ${restored?.digits}`);
    check(`${original.issuer}: period matches`, restored?.period === original.period, `got ${restored?.period}`);
    check(`${original.issuer}: issuer matches`, restored?.issuer === original.issuer);
    check(`${original.issuer}: username matches`, restored?.name === original.name);
  }

  // The secret is the account. Base32 in, Base32 out, byte for byte — any
  // re-encoding step here is a silent generator of wrong codes.
  scenario('The secret is written as plain Base32, not re-encoded');
  const document = JSON.parse(text);
  const first = document.accounts[0].items[0].credentials[0];
  check('the credential is tagged totp', first.type === 'totp');
  check('the secret is unchanged', first.secret === 'JBSWY3DPEHPK3PXP', first.secret);
  check('the algorithm is lowercase per the spec', first.algorithm === 'sha1', first.algorithm);

  // CXF 1.0 §3.1. Up to 1.13.x the root was the Account itself with a numeric
  // version and an `exporter` — an earlier draft's shape, which a reader
  // written to the standard does not recognise as a CXF file at all.
  scenario('The export is a CXF 1.0 Header, as the standard defines it');
  check('version is {major: 1, minor: 0}',
    document.version?.major === 1 && document.version?.minor === 0, JSON.stringify(document.version));
  check('exporterRpId names us', document.exporterRpId === 'authenticator.sh', String(document.exporterRpId));
  check('exporterDisplayName is present', typeof document.exporterDisplayName === 'string' && document.exporterDisplayName.length > 0);
  check('timestamp is in seconds', Number.isInteger(document.timestamp) && document.timestamp < 1e11, String(document.timestamp));
  check('the data sits under accounts[]', Array.isArray(document.accounts) && document.accounts.length === 1);
  const cxfAccount = document.accounts[0];
  check('the Account has its required members',
    typeof cxfAccount.id === 'string' && cxfAccount.username === '' && typeof cxfAccount.email === 'string' &&
      Array.isArray(cxfAccount.collections) && Array.isArray(cxfAccount.items));
  check('no draft-era root fields remain', !('exporter' in document) && !('items' in document));
  check('every item has an id, a title and credentials',
    cxfAccount.items.every((item: any) => typeof item.id === 'string' && typeof item.title === 'string' && Array.isArray(item.credentials)));
  check('ids are base64url', cxfAccount.items.every((item: any) => /^[A-Za-z0-9_-]+$/.test(item.id)));
  check('the secret carries no padding',
    !cxf.buildCxfFile([{ ...ACCOUNTS[0], secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ====' }]).includes('='.repeat(4)));

  scenario('A file from another vendor is recognised, ours is not mistaken for it');
  check('our own CXF file is detected', cxf.isCxfFile(text));
  check('a plain backup with a version string and accounts is not',
    !cxf.isCxfFile(JSON.stringify({ version: '2.0', exportDate: 'x', accounts: ACCOUNTS })));
  check('a plain backup is not', !cxf.isCxfFile(JSON.stringify({ version: '2.0', accounts: ACCOUNTS })));
  check('nonsense is not', !cxf.isCxfFile('not json at all'));

  // How password managers actually write it: one login item holding the
  // password and the TOTP seed together. Walking only the first credential of
  // each item would drop every 2FA account in the file.
  scenario('A TOTP credential sitting next to a password is still found');
  const fromVendor = JSON.stringify({
    version: 1,
    exporter: 'com.example.vault',
    items: [
      {
        id: 'x1',
        type: 'login',
        title: 'Fastmail',
        creationAt: 1700000000,
        credentials: [
          { type: 'basic-auth', username: { value: 'u' }, password: { value: 'p' } },
          { type: 'totp', secret: 'NBSWY3DPEB3W64TMMQ', period: 30, digits: 6, algorithm: 'sha1', username: 'me@fastmail.com' },
        ],
      },
    ],
  });
  const vendor = cxf.readCxfFile(fromVendor);
  check('the TOTP credential is picked up', vendor.length === 1, `got ${vendor.length}`);
  check('with its secret', vendor[0]?.secret === 'NBSWY3DPEB3W64TMMQ');
  check('and its username', vendor[0]?.name === 'me@fastmail.com');
  check('the password credential is ignored', vendor.every((a) => a.secret !== 'p'));

  scenario('One malformed entry never costs the rest of the file');
  const partlyBroken = JSON.stringify({
    version: 1,
    exporter: 'com.example.vault',
    items: [
      { id: 'b1', type: 'login', title: 'No credentials' },
      { id: 'b2', type: 'login', title: 'Empty secret', credentials: [{ type: 'totp', secret: '' }] },
      { id: 'b3', type: 'login', title: 'One character', credentials: [{ type: 'totp', secret: 'A' }] },
      null,
      { id: 'b4', type: 'login', title: 'Good', credentials: [{ type: 'totp', secret: 'JBSWY3DPEHPK3PXP' }] },
    ],
  });
  const salvaged = cxf.readCxfFile(partlyBroken);
  check('the usable account is imported', salvaged.length === 1, `got ${salvaged.length}`);
  check('and it is the right one', salvaged[0]?.secret === 'JBSWY3DPEHPK3PXP');
  // One base32 character carries no whole byte; otpauth would HMAC nothing and
  // return a confident six digits that no service will ever accept.
  check('a one-character secret is refused, not stored', !salvaged.some((a) => a.secret === 'A'));

  scenario('Missing optional fields fall back to the RFC defaults');
  const bare = cxf.readCxfFile(
    JSON.stringify({
      version: 1,
      exporter: 'x',
      items: [{ id: 'c1', credentials: [{ type: 'totp', secret: 'JBSWY3DPEHPK3PXP' }] }],
    })
  );
  check('algorithm defaults to SHA1', bare[0]?.algorithm === 'SHA1');
  check('digits default to 6', bare[0]?.digits === 6);
  check('period defaults to 30', bare[0]?.period === 30);
  // Stated and unusable is not missing. Replaced with the defaults, a zero
  // period and 99 digits were stored as a 30-second, 6-digit account whose
  // codes were wrong every time; the spec says to ignore an unknown algorithm.
  for (const [label, credential] of [
    ['a zero period', { period: 0 }],
    ['99 digits', { digits: 99 }],
    ['4 digits', { digits: 4 }],
    ['a two-hour period', { period: 7200 }],
    ['the MD5 algorithm', { algorithm: 'md5' }],
    ['SHA-224', { algorithm: 'sha224' }],
  ] as const) {
    const read = cxf.readCxf(
      JSON.stringify({
        version: 1,
        exporter: 'x',
        items: [{ id: 'c2', credentials: [{ type: 'totp', secret: 'JBSWY3DPEHPK3PXP', ...credential }] }],
      })
    );
    check(`${label} is refused and counted as unsupported, not defaulted`,
      read.accounts.length === 0 && read.unsupported === 1 && read.unreadable === 0,
      JSON.stringify({ n: read.accounts.length, unsupported: read.unsupported, unreadable: read.unreadable }));
  }

  // Records imported from files without these fields exist on disk, and
  // `account.algorithm.toLowerCase()` turned the whole export into "Export
  // failed" for the sake of one of them.
  scenario('An account without algorithm, digits or period still exports');
  let exported = '';
  try {
    exported = cxf.buildCxfFile([{ id: 'n1', name: 'n', issuer: 'I', secret: 'JBSWY3DPEHPK3PXP', createdAt: 1 } as any]);
  } catch (error) {
    exported = `threw: ${(error as Error).message}`;
  }
  const bareCredential = exported.startsWith('{') ? JSON.parse(exported).accounts[0].items[0].credentials[0] : null;
  check('the export does not throw', bareCredential !== null, exported.slice(0, 80));
  check('with the RFC defaults written out',
    bareCredential?.algorithm === 'sha1' && bareCredential?.digits === 6 && bareCredential?.period === 30,
    JSON.stringify(bareCredential && { a: bareCredential.algorithm, d: bareCredential.digits, p: bareCredential.period }));

  scenario('An account with no issuer comes back with no issuer');
  // CXF wants a title on every item, so ours writes the name there when there
  // is no issuer. Read back as the issuer, "bob" became "bob: bob".
  const noIssuer = cxf.readCxfFile(cxf.buildCxfFile([{ ...ACCOUNTS[0], issuer: '' }]))[0];
  check('the issuer stays empty', noIssuer?.issuer === '', String(noIssuer?.issuer));
  check('the name is kept', noIssuer?.name === 'alice@example.com', String(noIssuer?.name));
  check('another vendor\'s title still stands in for a missing issuer', vendor[0]?.issuer === 'Fastmail', String(vendor[0]?.issuer));

  scenario('Unusable secrets in a CXF file are counted, and a file of only those is refused');
  const counted = cxf.readCxf(partlyBroken);
  check('the empty and one-character secrets are counted', counted.unreadable === 2, String(counted.unreadable));
  await resetState();
  const EI = await import('@/components/ExportImport');
  let refused: any = null;
  let report: any = null;
  try {
    report = await EI.importBackupText(
      JSON.stringify({ version: 1, exporter: 'x', items: [{ id: 'z', title: 'GitHub', credentials: [{ type: 'totp', secret: '1111' }] }] }),
      () => null
    );
  } catch (error) {
    refused = error;
  }
  check('not reported as a successful import of nothing', refused?.reason === 'nothing-readable', JSON.stringify(report));
  check('nothing written', (await storage.getAccounts()).length === 0);

  scenario('A CXF file of only unsupported parameters is refused as such');
  await resetState();
  let onlyUnsupported: any = null;
  try {
    await EI.importBackupText(
      JSON.stringify({ version: 1, exporter: 'x', items: [{ id: 'm', title: 'Old', credentials: [{ type: 'totp', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'md5' }] }] }),
      () => null
    );
  } catch (error) {
    onlyUnsupported = error;
  }
  check('told it is unsupported, not unreadable', onlyUnsupported?.reason === 'only-unsupported', String(onlyUnsupported?.reason));
  check('and nothing written', (await storage.getAccounts()).length === 0);

  // What another vendor's CXF 1.0 file looks like, per the standard.
  scenario('A CXF 1.0 file from another vendor is read, every account of it');
  const fixture = JSON.stringify((await import('./fixtures/cxf-1.0.json')).default);
  check('it is recognised as CXF', cxf.isCxfFile(fixture));
  const spec = cxf.readCxf(fixture);
  check('the three TOTP seeds across both accounts are found', spec.accounts.length === 3, String(spec.accounts.length));
  check('the MD5 entry is ignored and counted, as the spec requires', spec.unsupported === 1, String(spec.unsupported));
  check('the password and the passkey are not counted as anything', spec.unreadable === 0, String(spec.unreadable));
  const totp = await import('@/utils/totp');
  const rfc: Record<string, string> = { SHA1: '94287082', SHA256: '46119246', SHA512: '90693936' };
  for (const account of spec.accounts) {
    check(`${account.issuer || account.name} (${account.algorithm}) gives the RFC 6238 code at T=59`,
      totp.generateCodeAt(account, 59_000) === rfc[account.algorithm],
      `${totp.generateCodeAt(account, 59_000)} vs ${rfc[account.algorithm]}`);
  }
  const github = spec.accounts.find((a) => a.algorithm === 'SHA1');
  check('username and issuer come from the credential', github?.name === 'alice@example.com' && github?.issuer === 'GitHub',
    JSON.stringify({ name: github?.name, issuer: github?.issuer }));
  check('an item title stands in for a missing issuer', spec.accounts.find((a) => a.algorithm === 'SHA256')?.issuer === 'Google');
  check('creationAt is read as seconds', github?.createdAt === 1700000000 * 1000, String(github?.createdAt));

  scenario('A CXF file of a future major version is refused, not half-read');
  let future: any = null;
  try {
    cxf.readCxf(JSON.stringify({ ...JSON.parse(fixture), version: { major: 2, minor: 0 } }));
  } catch (error) {
    future = error;
  }
  check('refused as a format we cannot read', future?.reason === 'unknown-format', String(future));

  scenario('A CXF file imports through the normal import path');
  await resetState();
  const result = await storage.importAccountList(cxf.readCxfFile(text), USER_ADD);
  await flush();
  check('all three are written', result.added === 3, `added ${result.added}`);
  const stored = await storage.getAccounts();
  check('and read back', stored.length === 3, `got ${stored.length}`);
  check('with their algorithms intact', stored.some((a) => a.algorithm === 'SHA512'));

  scenario('Importing the same CXF file twice adds nothing the second time');
  const again = await storage.importAccountList(cxf.readCxfFile(text), USER_ADD);
  await flush();
  check('nothing is duplicated', again.added === 0, `added ${again.added}`);
  check('the list is unchanged', (await storage.getAccounts()).length === 3);
}
