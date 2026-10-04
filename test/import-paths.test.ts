// Every way a list of otpauth:// links can reach the app, checked against each
// other rather than one at a time.
//
// There are three doors: the paste dialog, the file input in Settings, and the
// file input the first-run guide points at. They were not the same code, and
// the difference was invisible until someone walked through the third one with
// the .txt this extension had just written for them and was told it was not a
// backup file. What this suite pins down is that the doors agree.

import { check, resetState, scenario, USER_ADD } from './harness';

const SECRET = 'JBSWY3DPEHPK3PXP';

export async function run(): Promise<void> {
  await runSkippedNote();
  const uriImport = await import('@/utils/uri-import');
  const qr = await import('@/utils/qr-parser');
  const backupFile = await import('@/utils/backup-file');
  const storage = await import('@/utils/storage');

  const base = { algorithm: 'SHA1' as const, digits: 6, period: 30 };
  const link = (name: string, issuer = 'Example') =>
    qr.buildOTPAuthURL({ ...base, name, issuer, secret: SECRET });

  scenario('A list of links written by the export comes back through the shared importer');
  await resetState();
  const exported = backupFile.buildURIBackupFile([
    { ...base, id: '1', name: 'a@x.com', issuer: 'GitHub', secret: SECRET, createdAt: 1 },
    { ...base, id: '2', name: 'b@x.com', issuer: 'AWS', secret: 'KRSXG5CTMVRXEZLU', createdAt: 2 },
  ] as any);

  const first = await uriImport.importURIList(exported.text, 'en', USER_ADD);
  check('both accounts land', first.added === 2, JSON.stringify(first));
  check('and it reports success', first.kind === 'success', first.kind);
  check('storage really holds them', (await storage.getAccounts()).length === 2);

  scenario('Importing the same list twice adds nothing the second time');
  const second = await uriImport.importURIList(exported.text, 'en', USER_ADD);
  check('nothing new is written', second.added === 0, JSON.stringify(second));
  // Not an error: the file was read fine, the accounts were simply already here.
  check('and it is not reported as a failure', second.kind === 'info', second.kind);
  check('the list did not grow', (await storage.getAccounts()).length === 2);

  scenario('A file with nothing usable in it fails without writing');
  await resetState();
  const nothing = await uriImport.importURIList('not a link\nnor this one', 'en', USER_ADD);
  check('reported as an error', nothing.kind === 'error', nothing.kind);
  check('nothing was written', nothing.added === undefined && (await storage.getAccounts()).length === 0);

  scenario('The three doors agree on what a list of links looks like');
  await resetState();
  // looksLikeURIList is the discriminator both file inputs use before handing
  // the text to the JSON reader. If it and the planner ever disagree, one door
  // accepts a file the other rejects — which is exactly what went wrong.
  const cases: [string, boolean][] = [
    [exported.text, true],
    [`${link('z@x.com')}\n`, true],
    // Scheme only. RFC 3986 makes the scheme and authority case-insensitive and
    // real exporters do write OTPAUTH://TOTP/…; the query is not, and nothing
    // writes ?SECRET=.
    [link('z@x.com').replace(/^otpauth:\/\/totp/, 'OTPAUTH://TOTP'), true],
    [`\n\n${link('z@x.com')}`, true],
    [backupFile.buildPlainBackupFile([]), false],
    ['{"version":"2.0","accounts":[]}', false],
    ['', false],
  ];
  for (const [text, expected] of cases) {
    const looks = uriImport.looksLikeURIList(text);
    check(
      `${expected ? 'accepted' : 'refused'}: ${JSON.stringify(text.slice(0, 28))}`,
      looks === expected,
      String(looks)
    );
    // Anything the discriminator accepts must produce accounts, and anything it
    // refuses must not be silently importable through the other branch either.
    if (looks) {
      check('  …and the planner finds accounts in it', uriImport.planURIImport(text).accounts.length > 0);
    }
  }

  scenario('A locked vault refuses the list instead of half-importing it');
  await resetState();
  const vault = await import('@/utils/vault');
  const { meta } = await vault.createVaultMeta('correct horse battery staple');
  await vault.saveVaultMeta(meta);
  // lock(), not clearKeyCache(): the cache is only one of the three places an
  // unlocked key lives, and clearing it alone leaves the session copy behind —
  // which is why the first draft of this scenario "passed" by importing fine.
  await vault.lock();
  const locked = await uriImport.importURIList(`${link('locked@x.com')}\n`, 'en', USER_ADD);
  check('reported as an error', locked.kind === 'error', locked.kind);
  check('and nothing was written', locked.added === undefined, JSON.stringify(locked));

  await otherAppsFiles();
}

// --- files written by other apps, and our own JSON read strictly ------------
//
// Until these, any JSON array of objects with a `secret` string was taken for
// our own backup and spread into storage as it stood. andOTP and Raivo files
// "worked" — their counter-based tokens became 30-second TOTP accounts, a Raivo
// 60-second timer was read at 30 — and a user restoring an Alibaba Cloud app
// backup got a column of "Unknown" cards that could never show a code, under
// "Import successful!". Every account that does land is checked against the
// published RFC 6238 codes, because "imported" and "produces the right code"
// are different claims and only the second one matters.

const RFC = {
  SHA1: { secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', at59: '94287082' },
  SHA256: { secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA', at59: '46119246' },
  SHA512: {
    secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA',
    at59: '90693936',
  },
} as const;

const STORED_FIELDS = new Set(['id', 'name', 'issuer', 'secret', 'algorithm', 'digits', 'period', 'createdAt', 'color', 'group', 'type']);

async function otherAppsFiles(): Promise<void> {
  const fixtures = (await import('./fixtures/import-formats.json')).default as Record<string, unknown>;
  const EI = await import('@/components/ExportImport');
  const storage = await import('@/utils/storage');
  const totp = await import('@/utils/totp');
  const messages = await import('@/utils/import-message');
  const importErrorMessage = (error: unknown) => messages.importErrorMessage(error, 'en');

  /** Import through the same entry both file inputs use. */
  const importFile = async (value: unknown) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    try {
      const report = await EI.importBackupText(text, () => null);
      return { report, error: undefined as any };
    } catch (error) {
      return { report: undefined, error: error as any };
    }
  };
  const find = (list: any[], secret: string) => list.find(a => a.secret === secret);
  const codeAt59 = (account: any) => {
    try {
      return totp.generateCodeAt(account, 59_000);
    } catch {
      return 'no code';
    }
  };
  const checkRfc = (list: any[], algorithms: (keyof typeof RFC)[]) => {
    for (const algorithm of algorithms) {
      const account = find(list, RFC[algorithm].secret);
      check(`  ${algorithm}: the published code at T=59`, codeAt59(account) === RFC[algorithm].at59, `${codeAt59(account)} ${JSON.stringify(account && { a: account.algorithm, d: account.digits, p: account.period })}`);
    }
  };
  const onlyStoredFields = (list: any[]) =>
    list.every(account => Object.keys(account).every(key => STORED_FIELDS.has(key)));

  scenario('A backup with unusable secrets stores only the accounts that can produce a code');
  await resetState();
  const mixed = await importFile([
    // The shapes a proprietary backup hands over: hex, Base64, bare nonsense.
    { secret: '3132333435363738393031323334353637383930', name: 'hex' },
    { secret: 'MTIzNDU2Nzg5MDEyMzQ1Njc4OTA=', name: 'base64' },
    { id: 'ok', name: 'good', issuer: 'GitHub', secret: RFC.SHA1.secret, algorithm: 'SHA1', digits: 8, period: 30, createdAt: 1 },
  ]);
  const afterMixed = await storage.getAccounts();
  check('only the usable one is written', afterMixed.length === 1, JSON.stringify(afterMixed.map(a => a.secret)));
  check('every stored account can generate', afterMixed.every(a => totp.tryGenerateTOTP(a) !== null));
  check('the other two are counted as unreadable', mixed.report?.unreadable === 2, JSON.stringify(mixed.report ?? mixed.error?.message));
  const mixedMessage = mixed.report ? EI.importResultMessage(mixed.report, 'en') : '';
  check('and the message says so', /2 entr/.test(mixedMessage), mixedMessage);

  scenario('A file where nothing can produce a code is refused, not reported as a success');
  await resetState();
  const junk = await importFile([{ secret: '0189' }, { secret: 'hello world!' }, { secret: 'A=======' }]);
  check('rejected', junk.error !== undefined, JSON.stringify(junk.report));
  check('nothing written', (await storage.getAccounts()).length === 0);

  scenario('An Alibaba-style backup is named as a file we cannot read, with what to do instead');
  await resetState();
  const ali = await importFile(fixtures.alibabaLike);
  check('rejected', ali.error?.reason === 'unknown-format', String(ali.error?.reason ?? JSON.stringify(ali.report)));
  const aliMessage = ali.error ? importErrorMessage(ali.error) : '';
  check('the message points at the QR codes', /QR code/.test(aliMessage) && /Alibaba/.test(aliMessage), aliMessage);
  check('nothing written', (await storage.getAccounts()).length === 0);
  // The real Alibaba file is not JSON at all.
  const binary = await importFile(' SQLite format 3  encrypted blob');
  check('a file that is not JSON gets the same answer', binary.error?.reason === 'unknown-format', String(binary.error?.message));

  scenario('andOTP: label is the account, Steam is kept, HOTP is refused and counted');
  await resetState();
  const andOtp = await importFile(fixtures.andOtp);
  const andOtpList = await storage.getAccounts();
  check('two TOTP accounts and the Steam one written', andOtpList.length === 3, JSON.stringify(andOtpList.map(a => a.issuer)));
  check('the Steam one as Steam', find(andOtpList, 'MFRGGZDFMZTWQ2LK')?.type === 'steam');
  check('the HOTP entry is counted as unsupported', andOtp.report?.unsupported === 1, JSON.stringify(andOtp.report));
  // Singular since the tables learned plurals: "1 uses", not "1 use".
  check('and the message names it', /1 uses a code type/.test(andOtp.report ? EI.importResultMessage(andOtp.report, 'en') : ''));
  check('the account name comes from `label`', find(andOtpList, RFC.SHA1.secret)?.name === 'alice@example.com', find(andOtpList, RFC.SHA1.secret)?.name);
  check('a 60-second period is kept', find(andOtpList, 'KRSXG5CTMVRXEZLU')?.period === 60);
  check('the first tag becomes the group', find(andOtpList, RFC.SHA1.secret)?.group === 'Work');
  check('thumbnail, tags and usage counters are not stored', onlyStoredFields(andOtpList), JSON.stringify(andOtpList.map(a => Object.keys(a))));
  checkRfc(andOtpList, ['SHA1']);

  scenario('Raivo: account and timer are read, HOTP is refused');
  await resetState();
  const raivo = await importFile(fixtures.raivo);
  const raivoList = await storage.getAccounts();
  check('two accounts written', raivoList.length === 2);
  check('the HOTP one is counted', raivo.report?.unsupported === 1, JSON.stringify(raivo.report));
  const bank = find(raivoList, 'KRSXG5CTMVRXEZLU');
  check('`timer: "60"` is a 60-second period', bank?.period === 60, String(bank?.period));
  check('`digits: "8"` is eight digits', bank?.digits === 8, String(bank?.digits));
  check('the name comes from `account`', bank?.name === 'bob' && bank?.issuer === 'Bank', `${bank?.issuer}/${bank?.name}`);
  check('icon fields are not stored', onlyStoredFields(raivoList));
  checkRfc(raivoList, ['SHA1']);

  scenario('Aegis, unencrypted: every TOTP entry with its parameters and group');
  await resetState();
  const aegis = await importFile(fixtures.aegis);
  const aegisList = await storage.getAccounts();
  check('three TOTP accounts and the Steam one written', aegisList.length === 4, JSON.stringify(aegis.report ?? aegis.error?.message));
  check('the Steam one as Steam', aegisList.filter(a => a.type === 'steam').length === 1);
  check('HOTP counted as unsupported', aegis.report?.unsupported === 1, JSON.stringify(aegis.report));
  check('names and issuers', find(aegisList, RFC.SHA1.secret)?.name === 'alice@example.com' && find(aegisList, RFC.SHA1.secret)?.issuer === 'GitHub');
  check('the group is resolved from its uuid', find(aegisList, RFC.SHA1.secret)?.group === 'Work');
  checkRfc(aegisList, ['SHA1', 'SHA256', 'SHA512']);

  scenario('Aegis, encrypted: refused with a way forward, nothing written');
  await resetState();
  const aegisSealed = await importFile(fixtures.aegisEncrypted);
  check('rejected as another app\'s encryption', aegisSealed.error?.reason === 'encrypted' && aegisSealed.error?.app === 'Aegis', String(aegisSealed.error?.message));
  check('the message says to export without encryption', /Aegis.*encrypted.*Export it again/.test(aegisSealed.error ? importErrorMessage(aegisSealed.error) : ''));
  check('nothing written', (await storage.getAccounts()).length === 0);

  scenario('2FAS: account and issuer from `otp`, Steam kept, HOTP refused');
  await resetState();
  const twoFas = await importFile(fixtures.twoFas);
  const twoFasList = await storage.getAccounts();
  check('two TOTP accounts and the Steam one written', twoFasList.length === 3, JSON.stringify(twoFas.report ?? twoFas.error?.message));
  check('the Steam one as Steam', twoFasList.filter(a => a.type === 'steam').length === 1);
  check('HOTP counted as unsupported', twoFas.report?.unsupported === 1, JSON.stringify(twoFas.report));
  check('account name from otp.account', find(twoFasList, RFC.SHA1.secret)?.name === 'alice@example.com');
  check('issuer falls back to the service name', find(twoFasList, RFC.SHA256.secret)?.issuer === 'Bank');
  check('group resolved by id', find(twoFasList, RFC.SHA1.secret)?.group === 'Work');
  checkRfc(twoFasList, ['SHA1', 'SHA256']);

  scenario('2FAS, password-protected: refused with a way forward');
  await resetState();
  const twoFasSealed = await importFile(fixtures.twoFasEncrypted);
  check('rejected as encrypted by 2FAS', twoFasSealed.error?.reason === 'encrypted' && twoFasSealed.error?.app === '2FAS', String(twoFasSealed.error?.message ?? JSON.stringify(twoFasSealed.report)));

  scenario('Bitwarden JSON: the TOTP field of each login, as a link or a bare secret');
  await resetState();
  const bitwarden = await importFile(fixtures.bitwarden);
  const bitwardenList = await storage.getAccounts();
  check('two TOTP accounts and the Steam one written', bitwardenList.length === 3, JSON.stringify(bitwarden.report ?? bitwarden.error?.message));
  check('logins without TOTP are neither imported nor counted', bitwarden.report?.unreadable === 0);
  check('a steam:// code is imported as Steam', bitwarden.report?.unsupported === 0 && bitwardenList.filter(a => a.type === 'steam').length === 1, JSON.stringify(bitwarden.report));
  check('the otpauth link is read', find(bitwardenList, RFC.SHA1.secret)?.name === 'alice@example.com' && find(bitwardenList, RFC.SHA1.secret)?.digits === 8);
  check('a bare secret takes its name from the username', find(bitwardenList, RFC.SHA256.secret)?.name === 'bob@example.com' && find(bitwardenList, RFC.SHA256.secret)?.issuer === 'Bank');
  checkRfc(bitwardenList, ['SHA1']);
  await resetState();
  const bitwardenSealed = await importFile(fixtures.bitwardenEncrypted);
  check('an encrypted Bitwarden export is refused as such', bitwardenSealed.error?.reason === 'encrypted' && bitwardenSealed.error?.app === 'Bitwarden', String(bitwardenSealed.error?.message));

  scenario('FreeOTP+: the secret arrives as signed bytes');
  await resetState();
  const freeOtp = await importFile(fixtures.freeOtpPlus);
  const freeOtpList = await storage.getAccounts();
  check('two TOTP accounts written, the HOTP one counted', freeOtpList.length === 2 && freeOtp.report?.unsupported === 1, JSON.stringify(freeOtp.report ?? freeOtp.error?.message));
  check('negative bytes are read as the bytes they are', !!find(freeOtpList, 'JBSWY3DPEHPK3PXP'), JSON.stringify(freeOtpList.map(a => a.secret)));
  check('issuerExt and label', find(freeOtpList, RFC.SHA1.secret)?.issuer === 'GitHub' && find(freeOtpList, RFC.SHA1.secret)?.name === 'alice@example.com');
  checkRfc(freeOtpList, ['SHA1']);

  scenario('An Authy-style dump of {name, uri}');
  await resetState();
  const authy = await importFile(fixtures.authyDump);
  const authyList = await storage.getAccounts();
  check('both TOTP links imported', authyList.length === 2, JSON.stringify(authy.report ?? authy.error?.message));
  check('the HOTP link is counted as unsupported', authy.report?.unsupported === 1);
  const twitch = find(authyList, 'KRSXG5CTMVRXEZLU');
  check('seven digits and a ten-second period survive', twitch?.digits === 7 && twitch?.period === 10, JSON.stringify(twitch));
  checkRfc(authyList, ['SHA1']);

  scenario('A file of nothing but counter-based tokens says that, not "unreadable"');
  await resetState();
  const onlyHotp = await importFile([(fixtures.raivo as any[])[2]]);
  check('rejected as unsupported', onlyHotp.error?.reason === 'only-unsupported', String(onlyHotp.error?.reason));

  scenario('Importing the same file twice says nothing new was added');
  await resetState();
  const ours = [{ id: 'a', name: 'alice', issuer: 'GitHub', secret: RFC.SHA1.secret, algorithm: 'SHA1', digits: 8, period: 30, createdAt: 1 }];
  await importFile({ version: '2.0', exportDate: '2026-09-19T00:00:00.000Z', accountCount: 1, accounts: ours });
  const again = await importFile({ version: '2.0', exportDate: '2026-09-19T00:00:00.000Z', accountCount: 1, accounts: ours });
  const againMessage = again.report ? EI.importResultMessage(again.report, 'en') : '';
  check('nothing added', again.report?.added === 0);
  check('not "Import successful!"', !/successful/i.test(againMessage) && /already in your list/.test(againMessage), againMessage);
  check('and not shown in green', again.report ? EI.importResultKind(again.report) === 'info' : false);

  scenario('One file holding the same secret twice writes it once');
  await resetState();
  const twice = await importFile([
    { id: 'x1', name: 'one', issuer: 'A', secret: RFC.SHA1.secret, createdAt: 1 },
    { id: 'x2', name: 'two', issuer: 'A', secret: RFC.SHA1.secret.toLowerCase(), createdAt: 2 },
  ]);
  check('one record on disk', (await storage.getAccounts()).length === 1);
  check('the second counted as already here', twice.report?.added === 1 && twice.report?.alreadyHere === 1, JSON.stringify(twice.report));

  scenario('A pasted list of links is not reported as a QR import');
  await resetState();
  const uriImport = await import('@/utils/uri-import');
  const qr = await import('@/utils/qr-parser');
  const pasted = await uriImport.importURIList(
    qr.buildOTPAuthURL({ name: 'a', issuer: 'B', secret: RFC.SHA1.secret, algorithm: 'SHA1', digits: 8, period: 30 }),
    'en'
  , USER_ADD);
  check('it says what was added', /1 account/.test(pasted.message), pasted.message);
  check('and never mentions a QR code', !/QR/.test(pasted.message), pasted.message);

  scenario('An image the browser cannot decode is reported in the user\'s language');
  const i18n = await import('@/utils/i18n');
  await i18n.loadLanguage('de');
  const decodeFailure = new DOMException('The source image could not be decoded.', 'InvalidStateError');
  const inGerman = EI.qrImportErrorMessage(decodeFailure, 'de');
  check('not the browser\'s English sentence', !/source image/.test(inGerman), inGerman);
  check('the translated "could not open the image"', /Bild/.test(inGerman), inGerman);
  check('a storage failure is not called an image problem', !/Bild/.test(EI.qrImportErrorMessage(new Error('QUOTA_BYTES quota exceeded'), 'de')));
  await i18n.loadLanguage('en');
}

// A Google Authenticator export with HOTP entries among the TOTP ones used to
// report only what was added, and the user took that as the whole export.
export async function runSkippedNote(): Promise<void> {
  const { describeImport } = await import('@/utils/import-message');
  scenario('A QR import names the entries it could not add');
  check('the skipped entries are mentioned',
    describeImport({ added: 8, skipped: 0, total: 8, unsupported: 2 }, 'en').includes('2 more'));
  check('and nothing is added when there are none',
    describeImport({ added: 8, skipped: 0, total: 8 }, 'en') === describeImport({ added: 8, skipped: 0, total: 8, unsupported: 0 }, 'en'));
}
