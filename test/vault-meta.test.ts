// Which copy of the vault metadata wins, and why it cannot be the wall clock.
//
// The metadata holds the master key wrapped under the password. When a password
// is changed on one device, every other device has to adopt that copy — or the
// old password goes on opening the vault there, which is a live backdoor on
// every device that missed the change.
//
// "Newer" was decided by `updatedAt`, a raw Date.now() from whichever machine
// wrote it. A device whose clock runs ahead therefore outranks every later
// change made anywhere else, permanently.

import { areas, check, flush, resetState, scenario } from './harness';

const OLD_PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'the one they changed it to';
const YEAR = 365 * 24 * 60 * 60 * 1000;

const ACCOUNTS: any[] = [
  { id: 'a1', name: 'alice@example.com', issuer: 'GitHub', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, createdAt: 1 },
];

export async function run(): Promise<void> {
  const storage = await import('@/utils/storage');
  const vault = await import('@/utils/vault');

  scenario('A password changed elsewhere wins over a device with a fast clock');
  await resetState();
  {
    await storage.saveAccounts(ACCOUNTS);
    const prepared = await storage.prepareVault(OLD_PASSWORD);
    await prepared.commit();
    await flush();

    // Whatever this device last wrote, stamped by a clock that runs a year fast.
    const ahead = { ...(areas.local.vault_meta as any), updatedAt: Date.now() + YEAR };
    areas.local.vault_meta = ahead;

    // Another device, with a correct clock, changes the password and syncs it.
    // Built here by re-wrapping the same vault, which is exactly what
    // changePassword does — the point is only that its stamp is lower.
    await vault.lock();
    areas.local.vault_meta = areas.sync.vault_meta;
    await vault.changePassword(OLD_PASSWORD, NEW_PASSWORD);
    await flush();
    const changedElsewhere = areas.sync.vault_meta as any;
    check('the other device really did change it', changedElsewhere.wrappedByPassword !== ahead.wrappedByPassword);
    check('and stamped it earlier than our fast clock', changedElsewhere.updatedAt < ahead.updatedAt);

    // Back on the fast-clocked device: its own stale copy is still local.
    areas.local.vault_meta = ahead;
    vault.clearKeyCache();
    await vault.lock();

    const winner = await vault.getVaultMeta();
    check('the change is adopted', winner?.wrappedByPassword === changedElsewhere.wrappedByPassword);

    let newWorks = false;
    try {
      await vault.unlockWithPassword(NEW_PASSWORD);
      newWorks = true;
    } catch {
      newWorks = false;
    }
    check('the new password opens the vault', newWorks);

    await vault.lock();
    vault.clearKeyCache();
    let oldStillWorks = false;
    try {
      await vault.unlockWithPassword(OLD_PASSWORD);
      oldStillWorks = true;
    } catch {
      oldStillWorks = false;
    }
    check('and the old one no longer does', !oldStillWorks);
  }

  // The other direction, which the counter must not break: a device still on an
  // older version writes no counter at all, and its password change has to be
  // adopted here anyway. Refusing it would leave this device's old password
  // working — the same backdoor, entered from the other side.
  scenario('A password changed from an older version is adopted too');
  await resetState();
  {
    await storage.saveAccounts(ACCOUNTS);
    const prepared = await storage.prepareVault(OLD_PASSWORD);
    await prepared.commit();
    await flush();

    await vault.changePassword(OLD_PASSWORD, NEW_PASSWORD);
    await flush();
    const withCounter = areas.sync.vault_meta as any;
    check('this device keeps a counter', typeof withCounter.rev === 'number');

    // What an older version puts in sync: the same vault, re-wrapped, stamped
    // later, and carrying no counter because that version has none to write.
    const { rev: _dropped, ...noCounter } = withCounter;
    areas.sync.vault_meta = { ...noCounter, updatedAt: Date.now() + 60_000, wrappedByPassword: withCounter.wrappedByPassword };
    areas.local.vault_meta = { ...withCounter, wrappedByPassword: 'stale-wrapping-from-before' };

    const winner = await vault.getVaultMeta();
    check('the counterless copy still wins on its clock',
      winner?.wrappedByPassword === withCounter.wrappedByPassword && (winner as any).rev === undefined,
      JSON.stringify({ rev: (winner as any)?.rev }));
  }
}
