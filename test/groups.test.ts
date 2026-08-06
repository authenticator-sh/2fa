// The optional per-account group, checked along the paths where an extra field
// is normally lost: encryption (which rebuilds the object from a rest spread),
// export/import (which validates a fixed set of keys), and the update merge
// (where clearing a field and never setting one have to end up identical).

import { areas, check, flush, resetState, scenario } from './harness';

const PASSWORD = 'correct horse battery staple';

const ACCOUNTS: any[] = [
  { id: 'a1', name: 'alice@example.com', issuer: 'GitHub', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, createdAt: 1, group: 'Work' },
  { id: 'a2', name: 'bob@example.com', issuer: 'Google', secret: 'KRSXG5CTMVRXEZLU', algorithm: 'SHA1', digits: 6, period: 30, createdAt: 2, group: 'Work' },
  { id: 'a3', name: 'vpn', issuer: 'vpn', secret: 'MFRGGZDFMZTWQ2LK', algorithm: 'SHA1', digits: 6, period: 30, createdAt: 3 },
];

export async function run(): Promise<void> {
  const storage = await import('@/utils/storage');

  scenario('A group survives a plain save and read');
  await resetState();
  await storage.saveAccounts(ACCOUNTS);
  await flush();
  const stored = await storage.getAccounts();
  check('the group is read back', stored.find(a => a.id === 'a1')?.group === 'Work');
  check('an account without one stays ungrouped', stored.find(a => a.id === 'a3')?.group === undefined);

  // encodeAccounts rebuilds each record as `{ id, ...secretFields }`, so a new
  // field is carried automatically — and lands inside the ciphertext, where it
  // belongs: "Work" is metadata about the user, not a label safe to store plain.
  scenario('A group survives the vault round trip and is not left in the clear');
  const prepared = await storage.prepareVault(PASSWORD);
  await prepared.commit();
  await flush();
  check('the group name is not readable on disk', !JSON.stringify(areas.local.authenticator_accounts).includes('Work'));
  const decrypted = await storage.getAccounts();
  check('and comes back after decryption', decrypted.find(a => a.id === 'a1')?.group === 'Work');
  await storage.disableVault(PASSWORD);
  await flush();

  scenario('Clearing a group removes the field rather than storing a blank');
  await resetState();
  await storage.saveAccounts(ACCOUNTS);
  await storage.updateAccount('a1', { group: undefined });
  await flush();
  const cleared = (areas.local.authenticator_accounts as any[]).find(a => a.id === 'a1');
  check('the key is gone from storage', !('group' in cleared), JSON.stringify(cleared));
  check('the account itself is untouched', cleared.secret === 'JBSWY3DPEHPK3PXP');

  scenario('Setting a group does not disturb the other fields');
  await storage.updateAccount('a3', { group: 'Personal' });
  await flush();
  const grouped = (await storage.getAccounts()).find(a => a.id === 'a3');
  check('the group is set', grouped?.group === 'Personal');
  check('the secret is unchanged', grouped?.secret === 'MFRGGZDFMZTWQ2LK');
  check('nothing else was dropped', grouped?.period === 30 && grouped?.digits === 6);

  scenario('Groups round-trip through export and import');
  await resetState();
  await storage.saveAccounts(ACCOUNTS);
  const exported = await storage.exportAccounts();
  await resetState();
  await storage.importAccounts(exported);
  await flush();
  const imported = await storage.getAccounts();
  check('every account came back', imported.length === 3, `got ${imported.length}`);
  check('the group came with it', imported.find(a => a.id === 'a1')?.group === 'Work');
  check('the ungrouped one is still ungrouped', imported.find(a => a.id === 'a3')?.group === undefined);

  // Files written by 1.9.x and by every other authenticator have no group field
  // at all; they must import as ungrouped rather than be rejected.
  scenario('A backup from before groups still imports');
  await resetState();
  const legacy = ACCOUNTS.map(({ group, ...rest }) => rest);
  await storage.importAccounts(JSON.stringify(legacy));
  await flush();
  const fromLegacy = await storage.getAccounts();
  check('all accounts import', fromLegacy.length === 3, `got ${fromLegacy.length}`);
  check('they are ungrouped', fromLegacy.every(a => a.group === undefined));
}
