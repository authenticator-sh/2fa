// Aegis and 2FAS backups exported with a password, and the scrypt Aegis's
// needs.
//
// scrypt is checked against RFC 7914's own vectors. The files built here are
// sealed the way each app seals them, with the RFC 6238 seeds and the cases a
// phone rarely hands a test: a biometric slot before the password one, a vault
// with two passwords, a damaged vault, parameters no app writes. The encrypted
// backups in Aegis's tests were written by Aegis and by 2FAS itself; each must
// import exactly as its plain twin from the same tests does.

import { aegisFiles } from './aegis-fixtures';
import { check, resetState, scenario } from './harness';

const SHA1_SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const SHA256_SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA';
const PASSWORD = 'correct horse';

const enc = (text: string) => new TextEncoder().encode(text);
const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const random = (length: number) => crypto.getRandomValues(new Uint8Array(length));

/** AES-GCM, the tag split off as Aegis stores it. */
async function gcm(key: Uint8Array, plain: Uint8Array) {
  const iv = random(12);
  const aes = await crypto.subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, ['encrypt']);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, plain as BufferSource));
  return { iv, sealed, data: sealed.slice(0, -16), tag: sealed.slice(-16) };
}

// ---- an Aegis vault, sealed by hand ------------------------------------------

const AEGIS_ENTRIES = [
  { type: 'totp', uuid: 'u1', name: 'alice', issuer: 'GitHub', info: { secret: SHA1_SEED, algo: 'SHA1', digits: 6, period: 30 } },
  { type: 'totp', uuid: 'u2', name: 'bob', issuer: 'Acme', info: { secret: SHA256_SEED, algo: 'SHA256', digits: 8, period: 60 } },
  { type: 'hotp', uuid: 'u3', name: 'carol', issuer: 'Bank', info: { secret: 'JBSWY3DPEHPK3PXP', algo: 'SHA1', digits: 6, counter: 1 } },
];

async function aegisVault(
  passwords: string[],
  options: { damaged?: boolean; n?: number } = {}
): Promise<Record<string, unknown>> {
  const { scrypt } = await import('@/utils/scrypt');
  const master = random(32);
  const slots: unknown[] = [
    // A fingerprint slot comes first in a real vault; only the phone opens it.
    { type: 2, uuid: 'bio', key: hex(random(32)), key_params: { nonce: hex(random(12)), tag: hex(random(16)) } },
  ];
  for (const password of passwords) {
    const salt = random(32);
    const wrapped = await gcm(await scrypt(enc(password), salt, 32768, 8, 1, 32), master);
    slots.push({
      type: 1, uuid: password, key: hex(wrapped.data), key_params: { nonce: hex(wrapped.iv), tag: hex(wrapped.tag) },
      n: options.n ?? 32768, r: 8, p: 1, salt: hex(salt), repaired: true, is_backup: false,
    });
  }
  const db = await gcm(master, enc(JSON.stringify({ version: 3, entries: AEGIS_ENTRIES, groups: [] })));
  if (options.damaged) db.data[10] ^= 1;
  return {
    version: 1,
    header: { slots, params: { nonce: hex(db.iv), tag: hex(db.tag) } },
    db: b64(db.data),
  };
}

// ---- a 2FAS backup, sealed by hand -------------------------------------------

const TWOFAS_SERVICES = [
  { name: 'GitHub', secret: SHA1_SEED, otp: { account: 'alice', issuer: 'GitHub', digits: 6, period: 30, algorithm: 'SHA1', tokenType: 'TOTP' } },
  { name: 'Acme', secret: SHA256_SEED, otp: { account: 'bob', digits: 8, period: 60, algorithm: 'SHA256', tokenType: 'TOTP' } },
  { name: 'Steam', secret: 'JBSWY3DPEHPK3PXP', otp: { account: 'gamer', tokenType: 'STEAM' } },
];

async function twoFasBackup(password = PASSWORD): Promise<Record<string, unknown>> {
  const salt = random(256);
  const key = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: 10_000, hash: 'SHA-256' },
      await crypto.subtle.importKey('raw', enc(password), 'PBKDF2', false, ['deriveBits']),
      256
    )
  );
  const services = await gcm(key, enc(JSON.stringify(TWOFAS_SERVICES)));
  const reference = await gcm(key, enc('tRViSsLKzd86Hprh4ceC2OP7xazn4rrt4xhfEUbOjxLX8Rc3mkISXE0lWbmnWfggogbBJhtYgpK6fMl1D6mtsy92R8HlLXGCHqzAbmeXHVa8hd0ga7mbcmOp7yIBm8c7'));
  return {
    services: [], groups: [], updatedAt: 1702934782660, schemaVersion: 4, appOrigin: 'android',
    servicesEncrypted: `${b64(services.sealed)}:${b64(salt)}:${b64(services.iv)}`,
    reference: `${b64(reference.sealed)}:${b64(salt)}:${b64(reference.iv)}`,
  };
}

export async function run(): Promise<void> {
  const EI = await import('@/components/ExportImport');
  const storage = await import('@/utils/storage');
  const importMessage = await import('@/utils/import-message');
  const { scrypt } = await import('@/utils/scrypt');
  const { sealedBackupApp } = await import('@/utils/sealed-backups');

  scenario('scrypt gives RFC 7914\'s test vectors');
  const vectors: [string, string, number, number, number, string][] = [
    ['', '', 16, 1, 1, '77d6576238657b203b19ca42c18a0497f16b4844e3074ae8dfdffa3fede21442fcd0069ded0948f8326a753a0fc81f17e8d3e0fb2e0d3628cf35e20c38d18906'],
    ['password', 'NaCl', 1024, 8, 16, 'fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b3731622eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640'],
    ['pleaseletmein', 'SodiumChloride', 16384, 8, 1, '7023bdcb3afd7348461c06cd81fd38ebfda8fbba904f8e3ea9b543f6545da1f2d5432955613f0fcf62d49705242a9af9e61e85dc0d651e40dfcf017b45575887'],
  ];
  for (const [P, S, N, r, p, want] of vectors) {
    const got = hex(await scrypt(enc(P), enc(S), N, r, p, 64));
    check(`P="${P}" S="${S}" N=${N} r=${r} p=${p}`, got === want, got);
  }

  const prompts: (string | undefined)[] = [];
  const importJson = async (file: unknown, password: string | null, name = 'backup.json') => {
    prompts.length = 0;
    const text = typeof file === 'string' ? file : JSON.stringify(file);
    return EI.importBackupText(text, app => (prompts.push(app), password), name, new Blob([text]));
  };
  const failure = async (file: unknown, password: string | null) => {
    try {
      await importJson(file, password);
      return 'imported';
    } catch (error: any) {
      return error?.reason ?? error?.name ?? String(error);
    }
  };

  scenario('An encrypted Aegis backup asks for Aegis\'s password and comes in whole');
  await resetState();
  const vault = await aegisVault(['backup password', PASSWORD]);
  check('recognised as sealed by Aegis', sealedBackupApp(vault) === 'Aegis');
  const aegis = await importJson(vault, PASSWORD);
  check('the prompt says whose password it is', prompts.length === 1 && prompts[0] === 'Aegis', JSON.stringify(prompts));
  check('two accounts added, the counter one counted', aegis?.added === 2 && aegis.unsupported === 1 && aegis.unreadable === 0, JSON.stringify(aegis));
  const fromAegis = await storage.getAccounts();
  const acme = fromAegis.find(a => a.issuer === 'Acme');
  check('the secret, algorithm, digits and period are the vault\'s',
    acme?.secret === SHA256_SEED && acme.algorithm === 'SHA256' && acme.digits === 8 && acme.period === 60, JSON.stringify(acme));
  await resetState();
  check('the vault\'s other password opens it too', (await importJson(vault, 'backup password'))?.added === 2);

  scenario('Aegis: a wrong password, a cancelled prompt, a damaged or hostile file');
  await resetState();
  check('wrong password', (await failure(vault, 'nope')) === 'WrongExportPasswordError');
  check('nothing stored', (await storage.getAccounts()).length === 0);
  check('a dismissed prompt returns null and asks nothing more', (await importJson(vault, null)) === null && prompts.length === 1);
  check('a vault that does not open with its own key is damaged, not a wrong password',
    (await failure(await aegisVault([PASSWORD], { damaged: true }), PASSWORD)) === 'DamagedBackupFileError');
  const started = Date.now();
  check('scrypt parameters no app writes are refused before deriving',
    (await failure(await aegisVault([PASSWORD], { n: 1 << 24 }), PASSWORD)) === 'DamagedBackupFileError' && Date.now() - started < 2000);
  const onlyFingerprint = { ...vault, header: { ...(vault.header as object), slots: [(vault.header as any).slots[0]] } };
  check('a vault only a fingerprint opens is damaged here', (await failure(onlyFingerprint, PASSWORD)) === 'DamagedBackupFileError');
  check('a mangled header is damaged', (await failure({ ...vault, header: { slots: 'x' } }, PASSWORD)) === 'DamagedBackupFileError');

  scenario('An encrypted 2FAS backup asks for 2FAS\'s password and comes in whole');
  await resetState();
  const twoFas = await twoFasBackup();
  check('recognised as sealed by 2FAS', sealedBackupApp(twoFas) === '2FAS');
  const fromFile = await importJson(twoFas, PASSWORD, 'backup.2fas');
  check('the prompt says whose password it is', prompts.length === 1 && prompts[0] === '2FAS', JSON.stringify(prompts));
  check('all three added', fromFile?.added === 3 && !fromFile.unreadable && !fromFile.unsupported, JSON.stringify(fromFile));
  const twoFasAccounts = await storage.getAccounts();
  check('the account and issuer are 2FAS\'s', twoFasAccounts.some(a => a.issuer === 'GitHub' && a.name === 'alice'));
  check('a Steam service is a Steam Guard account', twoFasAccounts.find(a => a.issuer === 'Steam')?.type === 'steam',
    JSON.stringify(twoFasAccounts.find(a => a.issuer === 'Steam')));
  await resetState();
  check('wrong password', (await failure(twoFas, 'nope')) === 'WrongExportPasswordError');
  check('the message is the wrong-password one',
    importMessage.importErrorMessage(Object.assign(new Error(), { name: 'WrongExportPasswordError' }), 'en') === 'Wrong password for this file');
  check('a dismissed prompt returns null', (await importJson(twoFas, null)) === null);
  check('a sealed list in two parts is damaged',
    (await failure({ ...twoFas, servicesEncrypted: 'AAAA:BBBB' }, PASSWORD)) === 'DamagedBackupFileError');
  check('a plain 2FAS file asks nothing', (await importJson({ services: TWOFAS_SERVICES, schemaVersion: 4 }, null))?.added === 3 && prompts.length === 0);

  scenario('Proton\'s encrypted file is still refused, with the way out');
  await resetState();
  const proton = { version: 1, salt: 'c2FsdA==', content: 'Y29udGVudA==' };
  check('refused as another app\'s encrypted file, no password asked', (await failure(proton, PASSWORD)) === 'encrypted' && prompts.length === 0);

  scenario('The encrypted backups Aegis and 2FAS wrote, from Aegis\'s tests');
  const pairs: [string, string][] = [
    ['aegis_encrypted.json', 'aegis_plain.json'],
    ['2fas_authenticator_encrypted.2fas', '2fas_authenticator_plain.2fas'],
    ['2fas_authenticator_encrypted_v3.2fas', '2fas_authenticator_plain_v3.2fas'],
    ['2fas_authenticator_encrypted_v4.2fas', '2fas_authenticator_plain_v4.2fas'],
  ];
  const files = await aegisFiles(pairs.flat());
  if (!files) {
    console.log('  SKIP could not fetch Aegis\'s test files (offline?) — run again with a network');
    return;
  }
  const imported = async (name: string, password: string | null) => {
    await resetState();
    const read = await importJson(new TextDecoder().decode(files.get(name)), password, name);
    const accounts = (await storage.getAccounts())
      .map(a => [a.type ?? 'totp', a.issuer, a.name, a.secret, a.algorithm, a.digits, a.period].join('|'))
      .sort();
    return { read, accounts };
  };
  for (const [sealedName, plainName] of pairs) {
    const sealed = await imported(sealedName, 'test');
    const plain = await imported(plainName, null);
    check(`${sealedName}: opens with "test" into the same ${plain.accounts.length} accounts as ${plainName}`,
      plain.accounts.length > 0 && JSON.stringify(sealed.accounts) === JSON.stringify(plain.accounts) &&
      sealed.read?.unsupported === plain.read?.unsupported && sealed.read?.unreadable === plain.read?.unreadable,
      JSON.stringify({ sealed, plain }));
  }
  await resetState();
  check('and "Test" does not open them',
    (await failure(new TextDecoder().decode(files.get('aegis_encrypted.json')), 'Test')) === 'WrongExportPasswordError' &&
    (await failure(new TextDecoder().decode(files.get('2fas_authenticator_encrypted_v4.2fas')), 'Test')) === 'WrongExportPasswordError');
}
