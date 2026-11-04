// FreeOTP's own backups: the encrypted Java-serialized file FreeOTP 2 writes,
// and the plain preferences file of FreeOTP 1.x and FreeOTP+.
//
// Two kinds of check. The files built here are written the way FreeOTP writes
// them, with the RFC 6238 seeds and the cases a real phone rarely produces in
// a test: an emoji label, a Steam token, a counter token, one damaged entry.
// The backups in Aegis's tests are files FreeOTP itself wrote on four Android
// versions; they are fetched (pinned to one commit, never committed — Aegis is
// GPL) and checked against the list of accounts Aegis's tests expect.

import { aegisFiles } from './aegis-fixtures';
import { check, resetState, scenario } from './harness';

const SHA1_SEED = Array.from(new TextEncoder().encode('12345678901234567890'));
const SHA256_SEED = Array.from(new TextEncoder().encode('12345678901234567890123456789012'));
const PASSWORD = 'correct horse';

// ---- a FreeOTP 2 backup, written by hand ----------------------------------

/** Java's DataOutput.writeUTF: NUL as two bytes, astral characters as their surrogate halves. */
function modifiedUtf8(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit > 0 && unit < 0x80) out.push(unit);
    else if (unit < 0x800) out.push(0xc0 | (unit >> 6), 0x80 | (unit & 0x3f));
    else out.push(0xe0 | (unit >> 12), 0x80 | ((unit >> 6) & 0x3f), 0x80 | (unit & 0x3f));
  }
  return out;
}
const utf = (text: string) => {
  const bytes = modifiedUtf8(text);
  return [bytes.length >> 8, bytes.length & 0xff, ...bytes];
};
const int32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

/** ObjectOutputStream.writeObject(HashMap<String, String>). */
function serializedMap(pairs: [string, string][]): Uint8Array {
  const out = [0xac, 0xed, 0x00, 0x05, 0x73, 0x72, ...utf('java.util.HashMap')];
  out.push(0x05, 0x07, 0xda, 0xc1, 0xc3, 0x16, 0x60, 0xd1, 0x03, 0x00, 0x02);
  out.push(0x46, ...utf('loadFactor'), 0x49, ...utf('threshold'), 0x78, 0x70);
  out.push(0x3f, 0x40, 0x00, 0x00, ...int32(24));
  out.push(0x77, 0x08, ...int32(32), ...int32(pairs.length));
  for (const [key, value] of pairs) {
    out.push(0x74, ...utf(key), 0x74, ...utf(value));
  }
  out.push(0x78);
  return Uint8Array.from(out);
}

const signed = (bytes: Uint8Array | number[]) => Array.from(bytes, b => (b > 127 ? b - 256 : b));

async function seal(plain: Uint8Array, key: CryptoKey, token: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipherText = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(token) },
      key,
      plain as BufferSource
    )
  );
  return {
    mCipher: 'AES/GCM/NoPadding',
    mCipherText: signed(cipherText),
    mParameters: signed([0x30, 0x11, 0x04, 0x0c, ...iv, 0x02, 0x01, 0x10]),
    mToken: token,
  };
}

interface Token {
  id: string;
  meta: Record<string, unknown>;
  secret: number[];
  /** Seal it with some other key, as a damaged entry would read. */
  damaged?: boolean;
}

async function freeOtpBackup(tokens: Token[], password = PASSWORD): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const iterations = 100_000;
  const passwordKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-512' },
    await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']),
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );
  const masterBytes = crypto.getRandomValues(new Uint8Array(32));
  const masterKey = await crypto.subtle.importKey('raw', masterBytes, 'AES-GCM', false, ['encrypt']);
  const otherKey = await crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)), 'AES-GCM', false, ['encrypt']);

  const pairs: [string, string][] = [];
  for (const token of tokens) {
    const key = await seal(Uint8Array.from(token.secret), token.damaged ? otherKey : masterKey, `Hmac${token.meta.algo ?? 'SHA1'}`);
    pairs.push([token.id, JSON.stringify({ key: JSON.stringify(key) })]);
    pairs.push([`${token.id}-token`, JSON.stringify(token.meta)]);
  }
  pairs.push([
    'masterKey',
    JSON.stringify({
      mAlgorithm: 'PBKDF2withHmacSHA512',
      mEncryptedKey: await seal(masterBytes, passwordKey, 'AES'),
      mIterations: iterations,
      mSalt: signed(salt),
    }),
  ]);
  return serializedMap(pairs);
}

// ---- the files FreeOTP wrote, from Aegis's tests ------------------------------

const AEGIS_FILES = [
  'freeotp_v2_api23.xml',
  'freeotp_v2_api25.xml',
  'freeotp_v2_api27.xml',
  'freeotp_v2_api34.xml',
  'freeotp_v2_null_algo.xml',
  'freeotp.xml',
  'freeotp_plus_internal.xml',
  'plain.txt',
];

export async function run(): Promise<void> {
  const EI = await import('@/components/ExportImport');
  const storage = await import('@/utils/storage');
  const importMessage = await import('@/utils/import-message');
  const qr = await import('@/utils/qr-parser');
  const { isFreeOtpBackup } = await import('@/utils/freeotp');
  const t = (await import('@/utils/i18n')).createT('en');

  const prompts: (string | undefined)[] = [];
  const importFile = async (bytes: Uint8Array, password: string | null, name = 'externalBackup.xml') => {
    prompts.length = 0;
    const text = new TextDecoder().decode(bytes);
    return EI.importBackupText(text, app => (prompts.push(app), password), name, new Blob([bytes as BlobPart]));
  };
  const failure = async (bytes: Uint8Array, password: string | null) => {
    try {
      await importFile(bytes, password);
      return 'imported';
    } catch (error: any) {
      return error?.reason ?? error?.name ?? String(error);
    }
  };

  scenario('A FreeOTP 2 backup asks for FreeOTP\'s password and comes in whole');
  await resetState();
  const backup = await freeOtpBackup([
    { id: 'a1', meta: { algo: 'SHA1', digits: 6, issuerExt: 'GitHub', issuerInt: 'GitHub', label: 'alice 🦊', period: 30, type: 'TOTP' }, secret: SHA1_SEED },
    { id: 'b2', meta: { algo: 'SHA256', digits: 8, issuerExt: 'Acme', label: 'bob', period: 60, type: 'TOTP' }, secret: SHA256_SEED },
    { id: 'c3', meta: { issuerExt: 'Steam', label: 'gamer', type: 'TOTP' }, secret: SHA1_SEED.slice().reverse() },
    { id: 'd4', meta: { algo: 'SHA1', counter: 3, digits: 6, issuerExt: 'Bank', label: 'carol', type: 'HOTP' }, secret: SHA1_SEED.map(b => b ^ 1) },
    { id: 'e5', meta: { algo: 'SHA1', digits: 6, issuerExt: 'Broken', label: 'dave', period: 30, type: 'TOTP' }, secret: SHA1_SEED.map(b => b ^ 2), damaged: true },
  ]);
  check('recognised by its bytes', isFreeOtpBackup(backup));
  const result = await importFile(backup, PASSWORD);
  check('the prompt says whose password it is', prompts.length === 1 && prompts[0] === 'FreeOTP', JSON.stringify(prompts));
  check('three accounts added, the counter token and the damaged one counted',
    result?.added === 3 && result.unsupported === 1 && result.unreadable === 1, JSON.stringify(result));
  const stored = await storage.getAccounts();
  const byIssuer = (issuer: string) => stored.find(a => a.issuer === issuer);
  check('the secret is the seed, in Base32', byIssuer('GitHub')?.secret === 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', byIssuer('GitHub')?.secret);
  check('an emoji in the label survives Java\'s spelling of UTF-8', byIssuer('GitHub')?.name === 'alice 🦊', byIssuer('GitHub')?.name);
  const acme = byIssuer('Acme');
  check('the stated algorithm, digits and period are kept', acme?.algorithm === 'SHA256' && acme.digits === 8 && acme.period === 60, JSON.stringify(acme));
  check('a token issued by Steam is a Steam Guard account', byIssuer('Steam')?.type === 'steam', JSON.stringify(byIssuer('Steam')));
  const said = importMessage.describeFileImport(result!, 'en');
  check('the message names both that were left out',
    said.includes(t('import.fileUnsupported', 1)) && said.includes(t('import.fileUnreadable', 1)), said);

  scenario('A wrong password says so and writes nothing; cancelling is not an error');
  await resetState();
  check('wrong password', (await failure(backup, 'nope')) === 'WrongExportPasswordError');
  check('the message is the wrong-password one',
    importMessage.importErrorMessage(Object.assign(new Error(), { name: 'WrongExportPasswordError' }), 'en') === 'Wrong password for this file');
  check('nothing stored', (await storage.getAccounts()).length === 0);
  check('a dismissed prompt returns null', (await importFile(backup, null)) === null);

  scenario('A damaged FreeOTP backup is called damaged, not an unknown format');
  check('cut off halfway', (await failure(backup.slice(0, 400), PASSWORD)) === 'DamagedBackupFileError');
  const noMaster = serializedMap([['x', '{}']]);
  check('no master key', (await failure(noMaster, PASSWORD)) === 'DamagedBackupFileError');
  check('another Java object is not taken for one', !isFreeOtpBackup(Uint8Array.from([0xac, 0xed, 0, 5, 0x73, 0x72, ...utf('java.util.ArrayList'), ...new Array(16).fill(0)])));

  scenario('FreeOTP 1.x and FreeOTP+ preferences files are read without a password');
  await resetState();
  const xmlToken = (meta: unknown) =>
    JSON.stringify(meta).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const preferences = `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
    <string name="Acme:bob">${xmlToken({ algo: 'SHA1', digits: 6, issuerExt: 'Acme', label: 'bob', period: 30, secret: signed(SHA1_SEED), type: 'TOTP' })}</string>
    <string name="R&amp;D:alice">${xmlToken({ algo: 'SHA256', digits: 8, issuerExt: 'R&D', label: 'alice', period: 30, secret: signed(SHA256_SEED), type: 'TOTP' })}</string>
    <string name="tokenOrder">${xmlToken(['R&D:alice', 'Acme:bob'])}</string>
</map>`;
  const plain = await importFile(new TextEncoder().encode(preferences), null, 'tokens.xml');
  check('no password asked', prompts.length === 0);
  check('both added', plain?.added === 2, JSON.stringify(plain));
  const fromXml = await storage.getAccounts();
  check('entities are decoded', fromXml.some(a => a.issuer === 'R&D'), JSON.stringify(fromXml.map(a => a.issuer)));
  check('FreeOTP\'s order is kept',
    fromXml.find(a => a.issuer === 'R&D')!.createdAt < fromXml.find(a => a.issuer === 'Acme')!.createdAt);
  const otherPrefs = `<?xml version='1.0' encoding='utf-8'?>\n<map>\n<boolean name="dark" value="true" />\n<string name="lang">en</string>\n</map>`;
  check('some other app\'s preferences are not a FreeOTP backup',
    (await failure(new TextEncoder().encode(otherPrefs), null)) === 'unknown-format');

  scenario('The backups FreeOTP itself wrote, from Aegis\'s tests');
  const files = await aegisFiles(AEGIS_FILES);
  if (!files) {
    console.log('  SKIP could not fetch Aegis\'s test files (offline?) — run again with a network');
    return;
  }
  // Only the TOTP lines: the counter ones are what the import leaves out.
  const vectors = new TextDecoder().decode(files.get('plain.txt')).trim().split('\n')
    .filter(line => line.startsWith('otpauth://totp/'))
    .map(line => qr.parseQRCode(line.trim())?.accounts[0])
    .filter(a => a !== undefined);
  const matches = async (name: string, password: string | null, expected: { added: number; unsupported: number }) => {
    await resetState();
    const read = await importFile(files.get(name)!, password, name);
    const accounts = await storage.getAccounts();
    const wrong = accounts.filter(a => {
      const v = vectors.find(x => x!.secret === a.secret);
      return !v || v.issuer !== a.issuer || v.name !== a.name || v.algorithm !== a.algorithm || v.digits !== a.digits || v.period !== a.period;
    });
    check(`${name}: ${expected.added} added, ${expected.unsupported} counter tokens left out, every one as Aegis expects`,
      read?.added === expected.added && read.unsupported === expected.unsupported && read.unreadable === 0 && wrong.length === 0,
      JSON.stringify({ read, wrong }));
  };
  for (const name of ['freeotp_v2_api23.xml', 'freeotp_v2_api25.xml', 'freeotp_v2_api27.xml', 'freeotp_v2_api34.xml']) {
    await matches(name, 'test', { added: 3, unsupported: 3 });
  }
  await matches('freeotp_v2_null_algo.xml', 'test', { added: 1, unsupported: 0 });
  await matches('freeotp.xml', null, { added: 2, unsupported: 2 });
  await matches('freeotp_plus_internal.xml', null, { added: 3, unsupported: 3 });
  await resetState();
  check('and "test" is the only password that opens them',
    (await failure(files.get('freeotp_v2_api34.xml')!, 'Test')) === 'WrongExportPasswordError');
}
