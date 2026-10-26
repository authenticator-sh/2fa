// The optional per-account group, checked along the paths where an extra field
// is normally lost: encryption (which rebuilds the object from a rest spread),
// export/import (which validates a fixed set of keys), and the update merge
// (where clearing a field and never setting one have to end up identical).

import { areas, check, flush, resetState, scenario, USER_ADD } from './harness';

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
  await storage.importAccounts(exported, USER_ADD);
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
  await storage.importAccounts(JSON.stringify(legacy), USER_ADD);
  await flush();
  const fromLegacy = await storage.getAccounts();
  check('all accounts import', fromLegacy.length === 3, `got ${fromLegacy.length}`);
  check('they are ungrouped', fromLegacy.every(a => a.group === undefined));

  scenario('Renaming a group moves every account in it, and only those');
  await resetState();
  await storage.saveAccounts([...ACCOUNTS, { ...ACCOUNTS[0], id: 'a4', secret: 'GEZDGNBVGY3TQOJQ', group: 'Work ' }]);
  const renamed = await storage.renameGroup('Work', ' Job ');
  await flush();
  const afterRename = await storage.getAccounts();
  check('all three members moved, the padded one too', renamed.length === 3, `moved ${renamed.length}`);
  check('they carry the new, trimmed name', afterRename.filter(a => a.group === 'Job').length === 3);
  check('no account is left under the old name', !afterRename.some(a => a.group?.trim() === 'Work'));
  check('the ungrouped one is untouched', afterRename.find(a => a.id === 'a3')?.group === undefined);
  check('secrets are unchanged', afterRename.find(a => a.id === 'a2')?.secret === 'KRSXG5CTMVRXEZLU');

  scenario('Renaming onto an existing group merges the two');
  await storage.updateAccount('a3', { group: 'Home' });
  await storage.renameGroup('Home', 'Job');
  await flush();
  check('the account joined the other group', (await storage.getAccounts()).every(a => a.group === 'Job'));

  scenario('Deleting a group leaves its accounts ungrouped, not deleted');
  await resetState();
  await storage.saveAccounts(ACCOUNTS);
  const ungrouped = await storage.renameGroup('Work', undefined);
  await flush();
  const afterDelete = await storage.getAccounts();
  check('both members moved', ungrouped.length === 2, `moved ${ungrouped.length}`);
  check('every account is still there', afterDelete.length === 3, `got ${afterDelete.length}`);
  check('none of them has a group', afterDelete.every(a => a.group === undefined));
  const raw = (areas.local.authenticator_accounts as any[]).find(a => a.id === 'a1');
  check('the key is removed from storage rather than blanked', !('group' in raw), JSON.stringify(raw));

  scenario('A group emptied meanwhile is not written at all');
  check('nothing moves', (await storage.renameGroup('Work', 'Job')).length === 0);

  scenario('Moving accounts into a group, and taking it back');
  await resetState();
  await storage.saveAccounts(ACCOUNTS);
  await storage.reorderGroups(['Work']);
  const moved = await storage.moveToGroup(['a1', 'a3'], 'Home');
  await flush();
  let now = await storage.getAccounts();
  check('both went into the group', now.filter(a => a.group === 'Home').length === 2);
  check('the one already elsewhere left its rank behind', now.find(a => a.id === 'a1')?.groupRank === undefined);
  check('the account not asked about stayed', now.find(a => a.id === 'a2')?.group === 'Work');
  check('where each was is reported', moved.length === 2 && moved.find(p => p.id === 'a1')?.group === 'Work' && moved.find(p => p.id === 'a3')?.group === undefined);
  await storage.restoreGroupPlacements(moved);
  await flush();
  now = await storage.getAccounts();
  check('undo puts the grouped one back, rank and all', now.find(a => a.id === 'a1')?.group === 'Work' && now.find(a => a.id === 'a1')?.groupRank === 0);
  check('and the ungrouped one back out of any group', now.find(a => a.id === 'a3')?.group === undefined);
  const raw3 = (areas.local.authenticator_accounts as any[]).find(a => a.id === 'a3');
  check('with no blank keys left in storage', !('group' in raw3) && !('groupRank' in raw3), JSON.stringify(raw3));

  scenario('Moving to where an account already is writes nothing');
  check('no change reported', (await storage.moveToGroup(['a2'], 'Work')).length === 0);

  scenario('The group order is kept on the accounts and survives a rename');
  await resetState();
  await storage.saveAccounts([...ACCOUNTS, { ...ACCOUNTS[2], id: 'a4', secret: 'GEZDGNBVGY3TQOJQ', group: 'Alpha' }]);
  await storage.reorderGroups(['Work', 'Alpha']);
  await storage.renameGroup('Work', 'Zulu');
  await flush();
  const { groupsInOrder } = await import('@/utils/list-view');
  check('a renamed group keeps its place, ahead of one that sorts before it', groupsInOrder(await storage.getAccounts(), 'en').map(g => g.name).join() === 'Zulu,Alpha');
  await storage.updateAccount('a4', { group: 'Zulu' });
  await flush();
  check('an edit that moves an account drops its old rank', (await storage.getAccounts()).find(a => a.id === 'a4')?.groupRank === undefined);

  scenario('Pinned and group order come back from an export');
  await resetState();
  await storage.saveAccounts(ACCOUNTS.map((a, i) => (i === 0 ? { ...a, pinned: true, groupRank: 2 } : a)));
  const withExtras = await storage.exportAccounts();
  await resetState();
  await storage.importAccounts(withExtras, USER_ADD);
  await flush();
  const back = (await storage.getAccounts()).find(a => a.id === 'a1');
  check('the pin', back?.pinned === true);
  check('the group rank', back?.groupRank === 2);
}
