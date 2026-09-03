// Every way a list of otpauth:// links can reach the app, checked against each
// other rather than one at a time.
//
// There are three doors: the paste dialog, the file input in Settings, and the
// file input the first-run guide points at. They were not the same code, and
// the difference was invisible until someone walked through the third one with
// the .txt this extension had just written for them and was told it was not a
// backup file. What this suite pins down is that the doors agree.

import { check, resetState, scenario } from './harness';

const SECRET = 'JBSWY3DPEHPK3PXP';

export async function run(): Promise<void> {
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

  const first = await uriImport.importURIList(exported.text, 'en');
  check('both accounts land', first.added === 2, JSON.stringify(first));
  check('and it reports success', first.kind === 'success', first.kind);
  check('storage really holds them', (await storage.getAccounts()).length === 2);

  scenario('Importing the same list twice adds nothing the second time');
  const second = await uriImport.importURIList(exported.text, 'en');
  check('nothing new is written', second.added === 0, JSON.stringify(second));
  // Not an error: the file was read fine, the accounts were simply already here.
  check('and it is not reported as a failure', second.kind === 'info', second.kind);
  check('the list did not grow', (await storage.getAccounts()).length === 2);

  scenario('A file with nothing usable in it fails without writing');
  await resetState();
  const nothing = await uriImport.importURIList('not a link\nnor this one', 'en');
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
  const locked = await uriImport.importURIList(`${link('locked@x.com')}\n`, 'en');
  check('reported as an error', locked.kind === 'error', locked.kind);
  check('and nothing was written', locked.added === undefined, JSON.stringify(locked));
}
