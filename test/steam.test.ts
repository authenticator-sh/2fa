// Steam Guard: its own code, and every door an account can come in or go out by.
//
// Until now every importer refused Steam entries on purpose, because a Steam
// secret stored as TOTP shows six healthy-looking digits Steam never accepts.
// Accepting them is only safe if the type survives every path — scan, paste,
// each importer, our own export read back, a restore — and if the formats that
// cannot carry it refuse it instead of flattening it into TOTP. That is what
// these scenarios pin down.

import { createHmac } from 'node:crypto';
import { check, resetState, scenario, USER_ADD } from './harness';
import fixtures from './fixtures/import-formats.json';

/** RFC 6238's SHA1 seed, ASCII "12345678901234567890". */
const SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

/**
 * Steam's algorithm written out independently of the extension: its own
 * Base32 decoder, node's HMAC, and the alphabet step. If the two ever
 * disagree, one of them is not Steam.
 */
function referenceSteamCode(base32: string, unixSeconds: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of base32) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map(byte => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(unixSeconds / 30)));
  const mac = createHmac('sha1', key).update(counter).digest();
  let value = mac.readUInt32BE(mac[19] & 0x0f) & 0x7fffffff;
  const steam = '23456789BCDFGHJKMNPQRTVWXY';
  let out = '';
  for (let i = 0; i < 5; i++) {
    out += steam[value % 26];
    value = Math.floor(value / 26);
  }
  return out;
}

/** RFC 4648 Base32, unpadded, written out independently of the extension. */
function referenceBase32(bytes: Buffer): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  return bits.match(/.{1,5}/g)!.map(chunk => alphabet[parseInt(chunk.padEnd(5, '0'), 2)]).join('');
}

const steamAccount = {
  id: 's1',
  name: 'gamer',
  issuer: 'Steam',
  secret: SEED,
  algorithm: 'SHA1' as const,
  digits: 5,
  period: 30,
  createdAt: 1,
  type: 'steam' as const,
};

export async function run(): Promise<void> {
  const totp = await import('@/utils/totp');
  const qr = await import('@/utils/qr-parser');
  const formats = await import('@/utils/import-formats');
  const backupFile = await import('@/utils/backup-file');
  const cxf = await import('@/utils/cxf');
  const share = await import('@/utils/share');
  const storage = await import('@/utils/storage');
  const uriImport = await import('@/utils/uri-import');

  scenario('Steam codes match an independent implementation of the algorithm');
  for (const seconds of [59, 1111111109, 1234567890, 1700000000, 2000000000]) {
    const got = totp.generateCodeAt(steamAccount, seconds * 1000);
    const want = referenceSteamCode(SEED, seconds);
    check(`T=${seconds}`, got === want, `${got} vs ${want}`);
  }

  scenario('A Steam code is five characters from Steam\'s alphabet, never digits alone');
  {
    const codes = Array.from({ length: 200 }, (_, i) => totp.generateCodeAt(steamAccount, i * 30_000));
    check('always five characters', codes.every(code => code.length === 5), codes.find(c => c.length !== 5));
    check('only Steam\'s alphabet', codes.every(code => /^[23456789BCDFGHJKMNPQRTVWXY]{5}$/.test(code)));
  }

  scenario('Stored parameters cannot change a Steam code');
  {
    const at = 1234567890 * 1000;
    const odd = { ...steamAccount, digits: 8, period: 60, algorithm: 'SHA512' as const };
    check('digits, period and algorithm are ignored', totp.generateCodeAt(odd, at) === totp.generateCodeAt(steamAccount, at));
    check('the countdown is Steam\'s 30 seconds', totp.totpParams(odd).period === 30 && totp.totpParams(odd).digits === 5);
  }

  scenario('An account without a type is still plain TOTP');
  {
    const plain = { ...steamAccount, type: undefined, digits: 8 };
    check('RFC 6238 T=59 still 94287082', totp.generateCodeAt(plain, 59_000) === '94287082', totp.generateCodeAt(plain, 59_000));
  }

  scenario('Steam links are read in both spellings other apps write');
  {
    const aegis = qr.parseOTPAuthURL(`otpauth://steam/Steam:gamer?secret=${SEED}&issuer=Steam&digits=5`);
    check('otpauth://steam/ is Steam', aegis?.type === 'steam', JSON.stringify(aegis));
    check('with Steam\'s parameters', aegis?.digits === 5 && aegis?.period === 30 && aegis?.algorithm === 'SHA1');
    check('and the account name', aegis?.name === 'gamer', aegis?.name);

    const keepass = qr.parseOTPAuthURL(`otpauth://totp/Steam:gamer?secret=${SEED}&issuer=Steam&encoder=steam&digits=6`);
    check('encoder=steam is Steam, whatever digits says', keepass?.type === 'steam' && keepass.digits === 5, JSON.stringify(keepass));

    const bare = qr.parseOTPAuthURL(`otpauth://steam/gamer?secret=${SEED}`);
    check('no issuer is filled in as Steam', bare?.issuer === 'Steam', bare?.issuer);

    // What Steam itself issues, and what a maFile's `uri` field holds. Steam has
    // no six-digit codes, so reading this as TOTP could only ever be wrong.
    const issued = qr.parseOTPAuthURL(`otpauth://totp/Steam:gamer?secret=${SEED}&issuer=Steam`);
    check('a TOTP link issued by Steam is Steam', issued?.type === 'steam' && issued.digits === 5, JSON.stringify(issued));
    const labelOnly = qr.parseOTPAuthURL(`otpauth://totp/steam:gamer?secret=${SEED}`);
    check('Steam named only in the label counts too', labelOnly?.type === 'steam', JSON.stringify(labelOnly));
    const lookalike = qr.parseOTPAuthURL(`otpauth://totp/SteamVR%20Forum:gamer?secret=${SEED}&issuer=SteamVR%20Forum`);
    check('an issuer merely containing Steam stays TOTP', lookalike?.type === undefined, JSON.stringify(lookalike));
    const account = qr.parseOTPAuthURL(`otpauth://totp/Acme:steam?secret=${SEED}&issuer=Acme`);
    check('an account called steam stays TOTP', account?.type === undefined, JSON.stringify(account));

    check('HOTP is still refused', (() => {
      try {
        qr.parseOTPAuthURL(`otpauth://hotp/x?secret=${SEED}&counter=1`);
        return false;
      } catch (error) {
        return error instanceof qr.UnsupportedOTPTypeError;
      }
    })());
  }

  scenario('A Steam account survives the text export and comes back as Steam');
  {
    const link = qr.buildOTPAuthURL(steamAccount);
    check('written with Steam\'s own scheme', link.startsWith('otpauth://steam/'), link);
    const back = qr.parseOTPAuthURL(link);
    check('read back as Steam', back?.type === 'steam' && back.secret === SEED && back.name === 'gamer', JSON.stringify(back));

    const plainLink = qr.buildOTPAuthURL({ ...steamAccount, type: undefined, digits: 6 });
    check('a TOTP account is still written as totp', plainLink.startsWith('otpauth://totp/'), plainLink);
  }

  scenario('Other apps\' backups: Steam entries are imported as Steam');
  {
    const steamFrom = (name: string, file: unknown) => {
      const plan = formats.planImport(formats.readImportFile(file));
      const steam = plan.usable.filter(account => account.type === 'steam');
      check(`${name}: one Steam account`, steam.length === 1, JSON.stringify(plan.usable.map(a => [a.issuer, a.type])));
      check(`${name}: with Steam's parameters`, steam[0]?.digits === 5 && steam[0]?.period === 30 && steam[0]?.algorithm === 'SHA1');
      return plan;
    };

    const aegis = steamFrom('Aegis', fixtures.aegis);
    check('Aegis: its HOTP entry is still refused', aegis.unsupported === 1, String(aegis.unsupported));
    steamFrom('2FAS', fixtures.twoFas);
    steamFrom('andOTP', fixtures.andOtp);
    const bitwarden = steamFrom('Bitwarden (steam://)', fixtures.bitwarden);
    const bwSteam = bitwarden.usable.find(account => account.type === 'steam');
    check('Bitwarden: the secret is what followed steam://', bwSteam?.secret === 'KRSXG5CTMVRXEZLU', bwSteam?.secret);
    check('Bitwarden: the username is the name', bwSteam?.name === 'gamer', bwSteam?.name);
  }

  scenario('A Steam Desktop Authenticator maFile is read, Base64 secret and all');
  {
    const sharedSecret = Buffer.from('12345678901234567890').toString('base64');
    const maFile = {
      shared_secret: sharedSecret,
      serial_number: '1234567890',
      revocation_code: 'R12345',
      account_name: 'gamer',
      identity_secret: 'not-kept',
      Session: { SteamID: 76561198000000000 },
    };
    const plan = formats.planImport(formats.readImportFile(maFile));
    const account = plan.usable[0];
    check('one Steam account', plan.usable.length === 1 && account?.type === 'steam', JSON.stringify(plan));
    check('the Base64 secret became our Base32', account?.secret === SEED, account?.secret);
    check('named after the Steam login', account?.name === 'gamer' && account?.issuer === 'Steam');
    check('nothing else from the file rides along', !('identity_secret' in (account ?? {})) && !('revocation_code' in (account ?? {})));

    const broken = formats.readImportFile({ ...maFile, shared_secret: 'short' });
    check('an unusable shared_secret is unreadable, not a card', formats.planImport({ ...broken, entries: [...broken.entries, { secret: SEED }] }).unreadable === 1);

    check('the manual form\'s converter agrees', formats.base64ToBase32(sharedSecret) === SEED);
    check('and refuses what is not Base64 of a key', formats.base64ToBase32('abc') === '' && formats.base64ToBase32('not base64!') === '');
  }

  scenario('a pasted Steam key is read by its length, not by whether it passes as Base32');
  {
    // Base64 with none of + / 0 1 8 9 in it is also valid Base32 once
    // uppercased. About one maFile key in fourteen looks like this, and it used
    // to be stored as if it were Base32.
    const ambiguous = 'bImTRVfbDwOp5JZJvbOyUo7RAJc=';
    const want = referenceBase32(Buffer.from(ambiguous, 'base64'));
    check('the key really is ambiguous', totp.validateSecret(ambiguous));
    check('read as Base64', formats.steamSecretToBase32(ambiguous) === want, formats.steamSecretToBase32(ambiguous));
    check('without its padding too', formats.steamSecretToBase32(ambiguous.replace(/=$/, '')) === want);

    check('a Base32 key stays as it is', formats.steamSecretToBase32(SEED) === SEED);
    check('in lower case too', formats.steamSecretToBase32(SEED.toLowerCase()) === SEED);
    check('grouped with spaces too', formats.steamSecretToBase32(SEED.replace(/(.{4})/g, '$1 ')) === SEED);
    check('the plainly Base64 one still converts', formats.steamSecretToBase32(Buffer.from('12345678901234567890').toString('base64')) === SEED);
    check('nothing usable gives nothing', formats.steamSecretToBase32('not a key!') === '');

    let seen = 0;
    let wrong = 0;
    for (let i = 0; i < 3000; i++) {
      const bytes = Buffer.from(Array.from({ length: 20 }, () => Math.floor(Math.random() * 256)));
      const base64 = bytes.toString('base64');
      if (totp.validateSecret(base64)) seen++;
      if (formats.steamSecretToBase32(base64) !== referenceBase32(bytes)) wrong++;
    }
    check('3000 random maFile keys all convert correctly', wrong === 0, `${wrong} wrong, ${seen} of them ambiguous`);

    const { checkReplacementSecret } = await import('@/utils/secret-edit');
    const replaced = checkReplacementSecret(ambiguous, 's1', [], 'steam');
    check('replacing a Steam key reads Base64 the same way', 'secret' in replaced && replaced.secret === want, JSON.stringify(replaced));
    const plainReplaced = checkReplacementSecret(SEED.toLowerCase(), 't1', []);
    check('a TOTP key is not reinterpreted', 'secret' in plainReplaced && plainReplaced.secret === SEED, JSON.stringify(plainReplaced));
  }

  scenario('Our own backup keeps the type, and a restore brings it back');
  {
    await resetState();
    const plain = { ...steamAccount, id: 't1', type: undefined, secret: 'JBSWY3DPEHPK3PXP', digits: 6 };
    delete (plain as any).type;
    await storage.addMultipleAccounts([steamAccount, plain], USER_ADD);

    const exported = JSON.parse(backupFile.buildPlainBackupFile(await storage.getAccounts()));
    check('the export writes type: steam', exported.accounts.some((a: any) => a.type === 'steam'));
    check('and nothing for TOTP', exported.accounts.filter((a: any) => 'type' in a).length === 1);

    await resetState();
    await storage.importAccounts(JSON.stringify(exported), USER_ADD);
    const back = await storage.getAccounts();
    check('both come back', back.length === 2, String(back.length));
    check('Steam is still Steam', back.find(a => a.secret === SEED)?.type === 'steam');
    check('TOTP is still TOTP', back.find(a => a.secret === 'JBSWY3DPEHPK3PXP')?.type === undefined);

    await resetState();
    const restored = await storage.restoreFromSnapshot(exported.accounts);
    check('an automatic copy restores it too', restored.added === 2, JSON.stringify(restored));
    check('as Steam', (await storage.getAccounts()).find(a => a.secret === SEED)?.type === 'steam');
  }

  // The same secret is behind both codes, so dedupe by secret alone called a
  // Steam entry "already here" and kept the TOTP card every build before
  // Steam support made of it — six digits Steam never accepts.
  scenario('Importing a Steam entry over the TOTP card of the same secret makes it Steam');
  {
    await resetState();
    const asTotp = { ...steamAccount, id: 'old', name: 'my steam', group: 'Games', digits: 6 };
    delete (asTotp as any).type;
    const other = { ...asTotp, id: 'other', name: 'mail', group: undefined, secret: 'JBSWY3DPEHPK3PXP' };
    await storage.saveAccounts([asTotp, other] as any);

    const report = await storage.importAccountList([{ ...steamAccount, id: 'fromfile', name: 'gamer' }], USER_ADD);
    const after = await storage.getAccounts();
    const card = after.find(a => a.secret === SEED);
    check('no second card', after.length === 2, String(after.length));
    check('the card is Steam now', card?.type === 'steam' && card?.digits === 5, JSON.stringify(card));
    check('with its own name, group and place', card?.id === 'old' && card?.name === 'my steam' && card?.group === 'Games' && after[0] === card);
    check('reported as updated, not as already here', report.updated === 1 && report.added === 0 && report.alreadyHere === 0, JSON.stringify(report));
    const { describeFileImport } = await import('@/utils/import-message');
    const message = describeFileImport(report, 'en');
    check('and the message says so', message.includes('Steam Guard') && !message.includes('nothing was added'), message);

    const again = await storage.importAccountList([{ ...steamAccount, id: 'fromfile' }], USER_ADD);
    check('a second import changes nothing', again.updated === 0 && again.alreadyHere === 1, JSON.stringify(again));

    // A scan takes the same door.
    await resetState();
    await storage.saveAccounts([asTotp] as any);
    const scanned = await storage.addMultipleAccounts([{ ...steamAccount, id: 'scanned' }], USER_ADD);
    check('a scan upgrades it too', scanned.updated === 1 && scanned.skipped === 0, JSON.stringify(scanned));
    check('in place', (await storage.getAccounts())[0]?.type === 'steam');
  }

  scenario('A TOTP entry never turns a Steam card back into TOTP');
  {
    await resetState();
    await storage.saveAccounts([steamAccount] as any);
    const asTotp = { ...steamAccount, id: 'fromfile', digits: 6 };
    delete (asTotp as any).type;
    const report = await storage.importAccountList([asTotp], USER_ADD);
    const card = (await storage.getAccounts())[0];
    check('still Steam', card?.type === 'steam' && card?.digits === 5, JSON.stringify(card));
    check('counted as already here', report.alreadyHere === 1 && report.updated === 0, JSON.stringify(report));
    check('a single add says it was already here', (await storage.addAccount({ ...asTotp, id: 'x' } as any, USER_ADD)) === false);
  }

  scenario('A text export with a Steam line imports as Steam');
  {
    await resetState();
    const file = backupFile.buildURIBackupFile([steamAccount]);
    const outcome = await uriImport.importURIList(file.text, 'en', USER_ADD);
    check('added', outcome.added === 1, JSON.stringify(outcome));
    check('as Steam', (await storage.getAccounts())[0]?.type === 'steam');
  }

  scenario('CXF cannot say Steam, so Steam accounts are left out rather than flattened');
  {
    const plain = { ...steamAccount, id: 't2', secret: 'JBSWY3DPEHPK3PXP', digits: 6 };
    delete (plain as any).type;
    const items = JSON.parse(cxf.buildCxfFile([steamAccount, plain])).accounts[0].items;
    check('only the TOTP account is written', items.length === 1, String(items.length));
    check('and it is the TOTP one', items[0].credentials[0].secret === 'JBSWY3DPEHPK3PXP');
    check('the caller can count what was left out', cxf.cxfExportable([steamAccount, plain]).length === 1);
  }

  scenario('A Steam code is never packed into a share link');
  {
    let refused = false;
    try {
      await share.buildShareLink({ account: steamAccount, durationSec: 300 });
    } catch (error) {
      refused = error instanceof share.ShareError;
    }
    check('refused with a ShareError', refused);
  }
}
