// Unlocking the vault with a passkey.
//
// The WebAuthn ceremony itself cannot run under Node and is not what these
// scenarios are about. What matters here is the wrapper it produces: PRF hands
// back 32 deterministic bytes, and everything that can lose someone's 2FA seeds
// lives in how those bytes are turned into a third way to unwrap the master key.
//
// The invariant under test, and the reason the feature is acceptable at all: a
// passkey is always ADDITIVE. Password and recovery code keep working, so a
// wiped phone or a password manager that dropped the credential costs
// convenience and never data.

import { areas, check, flush, resetState, scenario, throwsNamed } from './harness';

const PASSWORD = 'correct horse battery staple';

const ACCOUNTS: any[] = [
  { id: 'a1', name: 'alice@example.com', issuer: 'GitHub', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, createdAt: 1 },
  { id: 'a2', name: 'bob@example.com', issuer: 'Google', secret: 'KRSXG5CTMVRXEZLU', algorithm: 'SHA256', digits: 8, period: 60, createdAt: 2 },
];

/** Stands in for a real authenticator: stable bytes for one credential. */
function fakePrfOutput(seed: number): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (seed * 31 + i * 7) % 256;
  return bytes;
}

export async function run(): Promise<void> {
  const storage = await import('@/utils/storage');
  const vault = await import('@/utils/vault');

  const PRF = fakePrfOutput(1);
  const OTHER_PRF = fakePrfOutput(2);
  const SALT = 'c2FsdHNhbHRzYWx0c2FsdHNhbHRzYWx0c2FsdHNhbHQ=';
  const CRED = 'Y3JlZGVudGlhbC1pZC1ieXRlcw==';

  scenario('A passkey is added to an unlocked vault and opens it again');
  await resetState();
  await storage.saveAccounts(ACCOUNTS);
  const prepared = await storage.prepareVault(PASSWORD);
  const recoveryCode = prepared.recoveryCode;
  await prepared.commit();
  await flush();

  const masterKey = await vault.getMasterKeyBytes();
  check('the vault is unlocked after setup', masterKey !== null);
  await vault.attachPasskey(masterKey!, CRED, SALT, PRF, 'MacBook');
  await flush();

  const registered = await vault.getVaultPasskey();
  check('the wrapper is stored', registered !== null);
  check('with its label', registered?.label === 'MacBook');
  check('and its credential id', registered?.credentialId === CRED);

  await vault.lock();
  check('locking still locks', !(await vault.isUnlocked()));

  const reopened = await vault.unlockWithPasskey(PRF);
  check('the passkey unwraps the same master key',
    JSON.stringify([...reopened]) === JSON.stringify([...masterKey!]));
  check('and the accounts decrypt', (await storage.getAccounts()).length === 2);

  // The whole point of the two-level key: the passkey wraps the master key, it
  // does not become it. Anything else would make every account unreadable the
  // moment the passkey changed.
  scenario('The master key never appears in the metadata');
  const metaJson = JSON.stringify(areas.local.vault_meta);
  const mkBase64 = Buffer.from(masterKey!).toString('base64');
  check('the key itself is not stored', !metaJson.includes(mkBase64));
  check('nor is the PRF output', !metaJson.includes(Buffer.from(PRF).toString('base64')));

  scenario('A different passkey is refused and costs nothing');
  await vault.lock();
  check('the wrong PRF output is rejected',
    await throwsNamed('WrongPasswordError', () => vault.unlockWithPasskey(OTHER_PRF)));
  check('the vault is still locked, not broken', !(await vault.isUnlocked()));
  const byPassword = await vault.unlockWithPassword(PASSWORD);
  check('the password still opens it', byPassword !== null);
  check('and the accounts are intact', (await storage.getAccounts()).length === 2);

  // If a passkey could replace the password rather than join it, a lost
  // credential would be a lost vault. It cannot: both other wrappers stay.
  scenario('Adding a passkey never removes the password or the recovery code');
  const meta = await vault.getVaultMeta();
  check('the password wrapper is still there', typeof meta?.wrappedByPassword === 'string');
  check('the recovery wrapper is still there', typeof meta?.wrappedByRecovery === 'string');
  await vault.lock();
  const byRecovery = await vault.unlockWithRecoveryCode(recoveryCode);
  check('the recovery code still opens it', byRecovery !== null);

  // The password wrapper is rebuilt on a password change; the master key is
  // not. So the passkey has to keep working — if it did not, every password
  // change would silently break passkey unlock until someone noticed.
  scenario('A password change leaves the passkey working');
  await vault.changePassword(PASSWORD, 'a different long password');
  await flush();
  await vault.lock();
  const afterChange = await vault.unlockWithPasskey(PRF);
  check('the passkey still unwraps the master key',
    JSON.stringify([...afterChange]) === JSON.stringify([...masterKey!]));
  check('and the old password no longer works',
    await throwsNamed('WrongPasswordError', () => vault.unlockWithPassword(PASSWORD)));

  scenario('A recovery-code reset also leaves the passkey working');
  await vault.lock();
  const freshRecovery = await vault.resetPasswordWithRecoveryCode(recoveryCode, 'third password here');
  await flush();
  check('a new recovery code is issued', /^[A-Z2-9]{5}(-[A-Z2-9]{5})+$/.test(freshRecovery));
  await vault.lock();
  check('the passkey survives the reset', (await vault.getVaultPasskey()) !== null);
  const afterReset = await vault.unlockWithPasskey(PRF);
  check('and still unwraps the master key',
    JSON.stringify([...afterReset]) === JSON.stringify([...masterKey!]));

  scenario('Removing the passkey leaves the vault fully openable');
  await vault.detachPasskey();
  await flush();
  check('the wrapper is gone', (await vault.getVaultPasskey()) === null);
  await vault.lock();
  check('unlocking by passkey now fails cleanly',
    await throwsNamed('Error', () => vault.unlockWithPasskey(PRF)));
  const stillFine = await vault.unlockWithPassword('third password here');
  check('the current password opens it', stillFine !== null);
  check('every account is still readable', (await storage.getAccounts()).length === 2);
  check('removing it twice is not an error', await vault.detachPasskey().then(() => true, () => false));

  // The ceremony runs in a page of its own, which is a separate JS context. With
  // auto-lock set to "every open" the session is deliberately never persisted,
  // so without an explicit hand-off registering a passkey is impossible on that
  // setting and unlocking with one silently does nothing. Both were reproduced
  // before the hand-off existed.
  scenario('The key crosses contexts exactly once, even on auto-lock "every open"');
  await resetState();
  await storage.saveAccounts(ACCOUNTS);
  const zeroLock = await storage.prepareVault(PASSWORD);
  await zeroLock.commit();
  await flush();
  await vault.setAutoLockMinutes(0);
  await vault.unlockWithPassword(PASSWORD);
  await flush();
  check('auto-lock 0 still keeps the session out of storage',
    !('vault_session' in areas.session), 'keys: ' + JSON.stringify(Object.keys(areas.session)));

  const keyToPass = await vault.getMasterKeyBytes();
  await vault.stageKeyHandoff(keyToPass!);
  await flush();
  check('a staged key is visible to another context', 'vault_handoff' in areas.session);

  const adopted = await vault.consumeKeyHandoff();
  check('the other context receives the same key',
    adopted !== null && JSON.stringify([...adopted]) === JSON.stringify([...keyToPass!]));
  check('and adopting it counts as unlocked', await vault.isUnlocked());
  check('the staged copy is gone after one read', !('vault_handoff' in areas.session));
  check('a second read finds nothing', (await vault.consumeKeyHandoff()) === null);

  scenario('Locking clears a staged key, and a stale one is refused');
  await vault.stageKeyHandoff(keyToPass!);
  await flush();
  await vault.lock();
  await flush();
  check('lock removes the staged key too', !('vault_handoff' in areas.session));
  check('so it cannot be adopted afterwards', (await vault.consumeKeyHandoff()) === null);
  check('and the vault really is locked', !(await vault.isUnlocked()));

  // An old staged copy must expire rather than sit in memory as a way in.
  areas.session.vault_handoff = {
    mk: Buffer.from(keyToPass!).toString('base64'),
    stagedAt: Date.now() - 10 * 60 * 1000,
  };
  check('a ten-minute-old hand-off is refused', (await vault.consumeKeyHandoff()) === null);
  check('and is removed rather than left behind', !('vault_handoff' in areas.session));
  check('the vault stays locked', !(await vault.isUnlocked()));

  // A user reported the popup sitting on its lock screen with the vault already
  // unlocked behind it, until the extension was closed and reopened. The popup
  // only read the lock state on mount, so a ceremony in another window was
  // invisible to it. These are the two halves of the fix.
  scenario('An unlock in another context announces itself');
  check('a staged key is recognised as a session change',
    vault.affectsVaultSession('session', { vault_handoff: {} }));
  check('so is the session entry itself',
    vault.affectsVaultSession('session', { vault_session: {} }));
  check('an unrelated session key is ignored',
    !vault.affectsVaultSession('session', { something_else: {} }));
  check('and so is the same key in another area — local writes are not unlocks',
    !vault.affectsVaultSession('local', { vault_handoff: {} }));

  const seen: string[] = [];
  const listener = (changes: Record<string, unknown>, areaName: string) => {
    if (vault.affectsVaultSession(areaName, changes)) seen.push(Object.keys(changes).join(','));
  };
  chrome.storage.onChanged.addListener(listener);

  await vault.stageKeyHandoff(keyToPass!);
  await flush();
  check('staging a key actually fires an event a live popup can hear',
    seen.length > 0, 'events: ' + JSON.stringify(seen));

  seen.length = 0;
  await vault.consumeKeyHandoff();
  await flush();
  check('consuming it fires one too, so the popup re-reads and finds it unlocked',
    seen.length > 0, 'events: ' + JSON.stringify(seen));
  chrome.storage.onChanged.removeListener(listener);
  await vault.lock();
  await vault.setAutoLockMinutes(15);

  // A synced passkey opens the vault on a second device, but only if the
  // wrapper travelled with the metadata — the same reason the wrapped password
  // key has to sync.
  scenario('The wrapper travels with the vault metadata');
  await resetState();
  await storage.saveAccounts(ACCOUNTS);
  const second = await storage.prepareVault(PASSWORD);
  await second.commit();
  await flush();
  const mk2 = await vault.getMasterKeyBytes();
  await vault.attachPasskey(mk2!, CRED, SALT, PRF, 'Phone');
  await flush();
  check('the synced copy carries the passkey wrapper',
    typeof (areas.sync.vault_meta as any)?.passkey?.wrapped === 'string');
  check('the credential id is there too',
    (areas.sync.vault_meta as any)?.passkey?.credentialId === CRED);
}
