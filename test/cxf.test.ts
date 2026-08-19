// Credential Exchange Format, the interchange format shared with Apple,
// Google, 1Password, Bitwarden and Dashlane.
//
// Two failure modes are worth more than the rest put together, because both are
// silent: a secret that survives export but decodes differently on the far side
// (every code wrong, forever), and a real-world file whose TOTP credential sits
// next to a password inside one login item (the 2FA half vanishes and nobody
// notices until a login is needed).

import { check, flush, resetState, scenario } from './harness';

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
  const first = document.items[0].credentials[0];
  check('the credential is tagged totp', first.type === 'totp');
  check('the secret is unchanged', first.secret === 'JBSWY3DPEHPK3PXP', first.secret);
  check('the algorithm is lowercase per the spec', first.algorithm === 'sha1', first.algorithm);
  check('the document declares a version', typeof document.version === 'number');
  check('and an exporter', document.exporter === 'authenticator.sh');

  scenario('A file from another vendor is recognised, ours is not mistaken for it');
  check('our own CXF file is detected', cxf.isCxfFile(text));
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
  check('a nonsensical period is replaced, not stored', cxf.readCxfFile(
    JSON.stringify({
      version: 1,
      exporter: 'x',
      items: [{ id: 'c2', credentials: [{ type: 'totp', secret: 'JBSWY3DPEHPK3PXP', period: 0, digits: 99 }] }],
    })
  )[0]?.period === 30);

  scenario('A CXF file imports through the normal import path');
  await resetState();
  const result = await storage.importAccountList(cxf.readCxfFile(text));
  await flush();
  check('all three are written', result.added === 3, `added ${result.added}`);
  const stored = await storage.getAccounts();
  check('and read back', stored.length === 3, `got ${stored.length}`);
  check('with their algorithms intact', stored.some((a) => a.algorithm === 'SHA512'));

  scenario('Importing the same CXF file twice adds nothing the second time');
  const again = await storage.importAccountList(cxf.readCxfFile(text));
  await flush();
  check('nothing is duplicated', again.added === 0, `added ${again.added}`);
  check('the list is unchanged', (await storage.getAccounts()).length === 3);
}
