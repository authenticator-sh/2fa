// Upgrading from 1.11.0 must not cost anyone anything.
//
// Every scenario here starts from storage laid out exactly the way 1.11.0 left
// it — including the shapes this release deliberately stopped writing — and
// then runs what the popup runs on its first open after the update. The bar is
// not "the new code works": it is that a user who updates overnight sees the
// same accounts, the same codes, the same vault, and the same preferences.
//
// The one intended difference is called out below: a clock correction written
// by 1.11.0 carried no timestamp, so its age is unknowable and it is dropped.
// That is the point of the release — a stale correction is what made codes
// wrong for people who fixed their clock after seeing our own warning.

import { areas, backupRows, check, flush, resetState, scenario, setBackupRows } from './harness';

const PASSWORD = 'correct horse battery staple';

const ACCOUNTS: any[] = [
  { id: 'a1', name: 'alice@example.com', issuer: 'GitHub', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, createdAt: 1 },
  { id: 'a2', name: 'bob@example.com', issuer: 'Google', secret: 'KRSXG5CTMVRXEZLU', algorithm: 'SHA256', digits: 8, period: 60, createdAt: 2 },
  { id: 'a3', name: 'vpn', issuer: 'vpn', secret: 'MFRGGZDFMZTWQ2LK', algorithm: 'SHA1', digits: 6, period: 30, createdAt: 3, group: 'Work' },
];

const DAY = 24 * 60 * 60 * 1000;

/** chrome.storage.local as 1.11.0 leaves it on a well-used profile. */
function seedProfileOf_1_11_0(overrides: Record<string, any> = {}): void {
  Object.assign(areas.local, {
    authenticator_accounts: ACCOUNTS,
    suggestionsEnabled: true,
    accountUsageByDomain: { 'github.com': { a1: 12 }, 'google.com': { a2: 3 } },
    activeGroup: 'Work',
    language: 'ru',
    syncObserved: true,
    syncFirstReadAt: Date.now() - 10 * 60_000,
    syncPushPending: false,
    backupReminder: { lastManualBackupDate: Date.now() - 3 * DAY, accountCountAtLastBackup: 3, snoozedUntil: null },
    vaultPrompt: { dismissedForever: false, snoozedUntil: null, timesShown: 1 },
    crossPromo: { firstOpenDate: Date.now() - 30 * DAY, dismissed: false },
    timeNoticeDismissedOffset: 300,
    // The shape 1.11.0 wrote: a bare number, no timestamp, no expiry.
    timeOffsetMs: 300_000,
    timeSyncCache: {
      result: { synced: true, confident: false, offsetMs: 0, offsetSeconds: 0 },
      cachedAt: Date.now() - 60_000,
    },
    ...overrides,
  });
}

export async function run(): Promise<void> {
  const storage = await import('@/utils/storage');
  const totp = await import('@/utils/totp');
  const vault = await import('@/utils/vault');
  const suggestions = await import('@/utils/suggestions');
  const reminder = await import('@/utils/backup-reminder');
  const autoBackup = await import('@/utils/auto-backup');
  const tombstones = await import('@/utils/tombstones');
  const qr = await import('@/utils/qr-parser');
  const timeSync = await import('@/utils/time-sync');

  scenario('A profile written by 1.11.0 opens unchanged');
  await resetState();
  {
    seedProfileOf_1_11_0();
    const accounts = await storage.getAccounts();
    check('every account is still there', accounts.length === 3, `${accounts.length}`);
    check('in the same order', accounts.map((a) => a.id).join(',') === 'a1,a2,a3');
    check('with their secrets intact', accounts[0].secret === 'JBSWY3DPEHPK3PXP');
    check('and their groups', accounts[2].group === 'Work');

    const code = totp.tryGenerateTOTP(accounts[0] as any);
    check('codes still generate', code !== null && /^\d{6}$/.test(code.code), String(code?.code));
    const eight = totp.tryGenerateTOTP(accounts[1] as any);
    check('including 8-digit, 60-second ones', eight !== null && /^\d{8}$/.test(eight.code) && eight.period === 60);
  }

  scenario("1.11.0's undated clock correction is dropped, not applied");
  await resetState();
  {
    seedProfileOf_1_11_0();
    totp.setTimeOffsetMs(0);
    await totp.loadTimeOffset();

    check('the correction is not carried over', totp.getTimeOffsetMs() === 0);
    check('and the undated record is gone', areas.local.timeOffsetMs === undefined);

    // Which means codes now match a plain clock again — the visible symptom of
    // the bug this release fixes.
    const account = (await storage.getAccounts())[0];
    const shown = totp.generateTOTP(account as any).code;
    const reference = totp.generateTOTP({ ...account, id: 'ref' } as any).code;
    check('and agree with an uncorrected clock', shown === reference, shown);
  }

  // The pairing 1.11.0 actually wrote: the correction and the measurement that
  // produced it, saved in the same call. Seeding only one of them is what let
  // the upgrade path look safe when it was not.
  scenario('A correction 1.11.0 measured minutes ago is not lost on the way in');
  await resetState();
  {
    const driftMs = -45_000; // 45 seconds slow: enough to be refused, too small to warn
    seedProfileOf_1_11_0({
      timeOffsetMs: driftMs,
      timeSyncCache: {
        result: { synced: true, confident: true, offsetMs: driftMs, offsetSeconds: -45 },
        cachedAt: Date.now() - 60_000,
      },
    });

    totp.setTimeOffsetMs(0);
    await totp.loadTimeOffset();
    check('the undated record is still discarded', totp.getTimeOffsetMs() === 0);

    // No network here on purpose: the reading is minutes old and cached, so the
    // correction has to come back without one.
    const status = await timeSync.getClockStatus();
    check('the fresh measurement is honoured', totp.getTimeOffsetMs() === driftMs, String(totp.getTimeOffsetMs()));
    check('and it is written back with a date this time', typeof (areas.local.timeOffsetMs as any)?.at === 'number');
    check('what Settings reports matches what codes use', status.corrected === (totp.getTimeOffsetMs() !== 0));
  }

  scenario('Preferences and dismissals survive');
  await resetState();
  {
    seedProfileOf_1_11_0();
    check('the language is untouched', areas.local.language === 'ru');
    check('suggestions stay on', await suggestions.areSuggestionsEnabled());
    check('the usage history still ranks without a vault',
      (await suggestions.getSuggestedAccountId('github.com', ACCOUNTS)) === 'a1');

    // A snooze set three days ago for seven days is still in force: the new
    // deadline check must not retire a legitimately pending one.
    areas.local.backupReminder = {
      lastManualBackupDate: null,
      accountCountAtLastBackup: 0,
      snoozedUntil: Date.now() + 4 * DAY,
    };
    check('a live backup snooze still suppresses', !(await reminder.shouldShowBackupReminder(5)));
  }

  scenario('A vault created before the update still opens');
  await resetState();
  {
    await storage.saveAccounts(ACCOUNTS);
    const prepared = await storage.prepareVault(PASSWORD);
    await prepared.commit();
    await flush();

    // What a browser restart leaves behind: local survives, the memory-backed
    // session does not. `lock()` is how that state is reached from inside a
    // single process — the module-scoped fallback that stands in for session
    // storage on Chrome < 102 cannot be un-imported here, and in a real browser
    // it dies with the page well before session storage does.
    await vault.lock();
    for (const key of Object.keys(areas.session)) delete areas.session[key];
    vault.clearKeyCache();
    check('the vault is locked, as it is after a restart', !(await vault.isUnlocked()));

    // The password from before the update still opens it.
    await vault.unlockWithPassword(PASSWORD);
    const accounts = await storage.getAccounts();
    check('the accounts decrypt', accounts.length === 3 && accounts[0].secret === 'JBSWY3DPEHPK3PXP');
    check('and the key is handed out inside the idle window', (await vault.getMasterKeyBytes()) !== null);
  }

  scenario('With a vault on, the usage history stops coming back');
  await resetState();
  {
    await storage.saveAccounts(ACCOUNTS);
    const prepared = await storage.prepareVault(PASSWORD);
    await prepared.commit();
    await flush();

    // 1.11.0 wrote it straight back after the vault scrubbed it.
    areas.local.accountUsageByDomain = { 'github.com': { a1: 9 } };

    await suggestions.recordAccountUsage('github.com', 'a1');
    check('the local copy is scrubbed', areas.local.accountUsageByDomain === undefined);
    check('and suggestions still work', (await suggestions.getSuggestedAccountId('github.com', ACCOUNTS)) === 'a1');
  }

  scenario('Sync keeps behaving for a profile that already syncs');
  await resetState();
  {
    seedProfileOf_1_11_0();
    areas.sync.authenticator_accounts_0 = ACCOUNTS;

    await storage.getStoredAccounts();
    await flush();
    check('a populated sync area stays trusted', areas.local.syncObserved === true);

    await storage.saveAccounts([...ACCOUNTS, { ...ACCOUNTS[0], id: 'a4', name: 'carol@example.com' }]);
    await flush();
    const pushed = (areas.sync.authenticator_accounts_0 as any[]) ?? [];
    check('and writes still reach it immediately', pushed.length === 4, `${pushed.length}`);
  }

  scenario('A sync area that has gone empty holds the push once');
  await resetState();
  {
    seedProfileOf_1_11_0(); // syncObserved: true
    // Signed out of Chrome: the area reads empty while this device still has
    // everything. 1.11.0 pushed straight over the cloud copy.
    await storage.getStoredAccounts();
    await flush();
    check('the latch is re-armed', areas.local.syncObserved === false);

    const stamp = areas.local.syncFirstReadAt as number;
    await storage.getStoredAccounts();
    await flush();
    check('and re-arming happens once, not on every read', areas.local.syncFirstReadAt === stamp);
  }

  scenario('Deletions recorded by 1.11.0 still suppress');
  await resetState();
  {
    seedProfileOf_1_11_0();
    await storage.deleteAccount('a1');
    await flush();

    // The deleted account is still in the sync copy, as it would be until the
    // sync write lands.
    areas.sync.authenticator_accounts_0 = ACCOUNTS;
    const merged = await storage.getStoredAccounts();
    check('the deleted account does not come back', !merged.some((a: any) => a.id === 'a1'), `${merged.length}`);

    const stillDeleted = await tombstones.deletedHere();
    check('and the marker is intact', await stillDeleted('JBSWY3DPEHPK3PXP'));
  }

  scenario('Snapshots written by 1.11.0 stay readable');
  await resetState();
  {
    const yesterday = Date.now() - 2 * DAY;
    setBackupRows([
      { id: `backup_${yesterday}`, accounts: ACCOUNTS, timestamp: yesterday, version: '1.11.0', accountCount: 3 },
    ]);

    const latest = await autoBackup.getLatestBackup();
    check('the old snapshot is found', latest?.version === '1.11.0');

    await autoBackup.autoBackup(ACCOUNTS);
    await flush();
    check('and a fresh one is added on schedule', backupRows.length === 2, `${backupRows.length}`);
  }

  scenario('QR links that worked before still work');
  await resetState();
  {
    const parsed = qr.parseOTPAuthURL('otpauth://totp/GitHub:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&algorithm=SHA1&digits=6&period=30');
    check('the label still splits the same way', parsed?.issuer === 'GitHub' && parsed?.name === 'alice@example.com', JSON.stringify(parsed));
    check('parameters survive', parsed?.digits === 6 && parsed?.period === 30 && parsed?.algorithm === 'SHA1');

    const bare = qr.parseOTPAuthURL('otpauth://totp/vpn?secret=MFRGGZDFMZTWQ2LK');
    check('a label with no issuer still parses', bare?.name === 'vpn' && bare?.issuer === 'Unknown');

    // New tolerance, nothing taken away — checked through parseQRCode, which is
    // what scanning, uploading, pasting and importing all actually call. Testing
    // parseOTPAuthURL alone is how an "uppercase links now work" fix shipped
    // once without reaching a single user.
    const shouty = qr.parseQRCode('OTPAUTH://TOTP/GitHub:alice@example.com?secret=JBSWY3DPEHPK3PXP');
    check('an uppercase scheme is accepted at the boundary',
      shouty?.type === 'single' && shouty.accounts[0].name === 'alice@example.com', JSON.stringify(shouty));

    const lower = qr.parseQRCode('otpauth://totp/GitHub:alice@example.com?secret=JBSWY3DPEHPK3PXP');
    check('and the lowercase form is unchanged', lower?.type === 'single' && lower.accounts[0].issuer === 'GitHub');

    let uppercaseHotp = 'accepted';
    try {
      qr.parseQRCode('OTPAUTH://HOTP/Acme?secret=JBSWY3DPEHPK3PXP&counter=1');
    } catch (error) {
      uppercaseHotp = (error as Error).name;
    }
    check('uppercase hotp is still refused as unsupported', uppercaseHotp === 'UnsupportedOTPTypeError', uppercaseHotp);
  }

  scenario('One unusable secret still costs exactly one row');
  await resetState();
  {
    seedProfileOf_1_11_0({
      authenticator_accounts: [...ACCOUNTS, { id: 'bad', name: 'broken', issuer: 'x', secret: 'A', algorithm: 'SHA1', digits: 6, period: 30, createdAt: 4 }],
    });
    const accounts = await storage.getAccounts();
    check('the record is still returned', accounts.length === 4);
    check('it no longer produces a confident wrong code', totp.tryGenerateTOTP(accounts[3] as any) === null);
    check('and the healthy ones are unaffected', totp.tryGenerateTOTP(accounts[0] as any) !== null);
  }
}
