// Cloud sync (utils/cloud-merge.ts, billing/cloud-backup.ts syncWithCloud):
// devices of one license reading each other's newest copies.
//
// What these scenarios hold it to: an account added, edited or deleted on one
// device reaches the others; the newer edit wins and both devices end up
// agreeing; a deletion removes only what was not changed after it, and an
// account re-added or restored afterwards stays; absence never deletes; two
// pre-sync records never overwrite each other; deletions from before a device
// started syncing stay on that device; a copy from an older build only adds;
// and the header's status says what happened.
//
// Each device here is a separate profile — its own local AND sync area, the
// way the Mac app and Chrome are — so Chrome sync carries nothing between them
// and whatever arrives came through the cloud.

import { readFileSync } from 'node:fs';
import { areas, check, flush, resetState, scenario, USER_ADD } from './harness';
import { planCloudMerge, type MergeInput } from '@/utils/cloud-merge';
import type { Account } from '@/types';

const KEY = JSON.parse(readFileSync(new URL('./fixtures/billing-test-key.json', import.meta.url), 'utf8'));

const b64url = (bytes: Uint8Array | string): string =>
  Buffer.from(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

let privateKey: CryptoKey | null = null;
async function sign(payload: Record<string, unknown>): Promise<string> {
  privateKey ??= await crypto.subtle.importKey('jwk', KEY.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const h = b64url(JSON.stringify({ alg: 'ES256', kid: KEY.kid, typ: 'JWT' }));
  const p = b64url(JSON.stringify(payload));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, new TextEncoder().encode(`${h}.${p}`)));
  return `${h}.${p}.${b64url(sig)}`;
}

const nowSec = () => Math.floor(Date.now() / 1000);

async function grantPro(iid: string): Promise<void> {
  const token = await sign({
    typ: 'ent',
    v: 1,
    lid: 'lic_1',
    kind: 'life',
    features: ['unlimited_accounts', 'cloud_backup'],
    until: null,
    key_hint: 'STVWX',
    sub: iid,
    iat: nowSec(),
    exp: nowSec() + 3600,
  });
  await chrome.storage.local.set({ billingEntitlement: token });
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const secretOf = (n: number) => `JBSWY3DPEHPK3P${ALPHABET[n % 32]}${ALPHABET[Math.floor(n / 32) % 32]}`;

const account = (n: number, extra: Partial<Account> = {}): Account => ({
  id: `acc${n}`,
  name: `person${n}@example.com`,
  issuer: `Issuer${n}`,
  secret: secretOf(n),
  algorithm: 'SHA1',
  digits: 6,
  period: 30,
  createdAt: 1_000 + n,
  ...extra,
});

/** Lets the stamps of two steps differ: the devices share one clock here, a millisecond apart is a tie. */
const tick = () => new Promise(resolve => setTimeout(resolve, 3));

/** The server's side, with a device tag on each copy as listBackups gives it. */
function fakeServer() {
  const copies: { id: string; iid: string; kid: string; data: string; at: number }[] = [];
  const holders = new Set<string>();
  let current: { kid: string; auth: string } | null = null;
  let seq = 0;
  let down = false;
  const lists: string[] = [];
  const gets: string[] = [];
  const handler = (async (url: string, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(String(init?.body ?? '{}'));
    const answer = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (down) return answer({ error: 'internal' }, 500);
    if (!holders.has(body.iid)) return answer({ error: 'no_license' }, 404);
    switch (path) {
      case '/v1/backup/upload': {
        if (!current) {
          if (!body.claim) return answer({ error: 'backup_off' }, 409);
          current = { kid: body.kid, auth: body.auth };
        } else if (current.kid !== body.kid || current.auth !== body.auth) {
          return answer({ error: 'backup_wrong_code' }, 409);
        }
        const copy = { id: `bkp_${++seq}`, iid: body.iid, kid: body.kid, data: body.data, at: Date.now() * 1000 + seq };
        copies.push(copy);
        return answer({ id: copy.id, created_at: copy.at });
      }
      case '/v1/backup/list':
        lists.push(body.iid);
        return answer({
          kid: current?.kid ?? null,
          backups: [...copies].reverse().map(c => ({
            id: c.id,
            created_at: c.at,
            bytes: c.data.length,
            kid: c.kid,
            this_device: c.iid === body.iid,
            device: `dev-${c.iid.slice(0, 8)}`,
          })),
        });
      case '/v1/backup/get': {
        gets.push(body.id);
        if (!current || current.auth !== body.auth) return answer({ error: 'backup_wrong_code' }, 409);
        const copy = copies.find(c => c.id === body.id);
        return copy ? answer({ id: copy.id, created_at: copy.at, kid: copy.kid, data: copy.data }) : answer({ error: 'backup_not_found' }, 404);
      }
    }
    return answer({ error: 'bad_request' }, 400);
  }) as typeof fetch;
  return {
    copies,
    holders,
    handler,
    lists,
    gets,
    /** "Start over" on some other device: the license has another code. */
    restart() {
      current = { kid: 'another-code-kid', auth: 'another-auth' };
    },
    set down(value: boolean) {
      down = value;
    },
  };
}

// ─── The merge alone ───────────────────────────────────────────────────────

function plan(input: Partial<MergeInput> & Pick<MergeInput, 'local' | 'remotes'>) {
  const seedKey = (secret: string) => secret.replace(/\s+/g, '').toUpperCase();
  return planCloudMerge({
    localDeleted: {},
    seedKey,
    hashOf: key => `h:${key}`,
    usedIds: new Set(),
    ...input,
  });
}

const h = (n: number) => `h:${secretOf(n)}`;

function mergeAlone(): void {
  scenario('The merge: the newer edit wins, and keeps this device’s id');
  {
    const here = account(1, { name: 'old', updatedAt: 5_000 });
    const there = account(1, { id: 'other-id', name: 'new', group: 'Work', updatedAt: 6_000 });
    const result = plan({ local: [here], remotes: [{ accounts: [there], deleted: {} }] });
    const merged = result?.accounts[0];
    check('the name and group come over', merged?.name === 'new' && merged.group === 'Work');
    check('the id and creation time stay this device’s', merged?.id === 'acc1' && merged.createdAt === here.createdAt);
    check('with the edit’s own stamp', merged?.updatedAt === 6_000);
    check('counted as an update', result?.updated === 1 && result.added === 0 && result.removed.length === 0);

    const older = plan({ local: [account(1, { name: 'mine', updatedAt: 7_000 })], remotes: [{ accounts: [there], deleted: {} }] });
    check('an older edit from elsewhere changes nothing', older === null);
  }

  scenario('The merge: two records from before sync never overwrite each other');
  {
    const here = account(1, { name: 'Work', createdAt: 1_000 });
    const there = account(1, { name: 'Mail', createdAt: 9_000 });
    check('neither name wins on age alone', plan({ local: [here], remotes: [{ accounts: [there], deleted: {} }] }) === null);
    const edited = plan({ local: [here], remotes: [{ accounts: [{ ...there, updatedAt: 9_500 }], deleted: {} }] });
    check('an edit made since sync does', edited?.accounts[0].name === 'Mail');
  }

  scenario('The merge: a deletion removes only what it is newer than');
  {
    const local = [account(1, { updatedAt: 5_000 }), account(2, { updatedAt: 9_000 }), account(3, { updatedAt: 8_000 })];
    const result = plan({ local, remotes: [{ accounts: [], deleted: { [h(1)]: 6_000, [h(2)]: 6_000, [h(3)]: 8_000 } }] });
    check('the account deleted after its last edit goes', result?.removed.map(r => r.account.id).join() === 'acc1');
    check('with the moment of the deletion', result?.removed[0].at === 6_000);
    check('one edited after the deletion stays', result?.accounts.some(a => a.id === 'acc2') === true);
    check('a tie keeps the account, on every device alike', result?.accounts.some(a => a.id === 'acc3') === true);
    const legacy = plan({ local: [account(4)], remotes: [{ accounts: [], deleted: { [h(4)]: 6_000 } }] });
    check('a record from before sync is removed by a deletion newer than its creation', legacy?.removed.length === 1);
  }

  scenario('The merge: absence never deletes');
  {
    const local = [account(1, { updatedAt: 5_000 }), account(2)];
    check('a copy without this device’s accounts changes nothing', plan({ local, remotes: [{ accounts: [], deleted: {} }] }) === null);
    check('nor an empty list of copies', plan({ local, remotes: [] }) === null);
  }

  scenario('The merge: an account this device lacks is added, unless deleted after it');
  {
    const result = plan({
      local: [account(1)],
      remotes: [{ accounts: [account(2, { updatedAt: 5_000 }), account(3, { updatedAt: 5_000 }), account(4, { updatedAt: 5_000 })], deleted: {} }],
      localDeleted: { [h(3)]: 6_000, [h(4)]: 4_000 },
    });
    const ids = result?.accounts.map(a => a.id) ?? [];
    check('the new one comes in, at the top', ids[0] === 'acc2');
    check('one this device deleted afterwards does not', !ids.includes('acc3'));
    check('one re-added there after this device’s deletion does', ids.includes('acc4'));
    check('this device’s own stays', ids.includes('acc1'));
    check('counted', result?.added === 2);
  }

  scenario('The merge: an id taken here is not reused for another seed');
  {
    const result = plan({ local: [account(1)], remotes: [{ accounts: [account(2, { id: 'acc1', updatedAt: 5 })], deleted: {} }], usedIds: new Set(['acc1-synced']) });
    const ids = result?.accounts.map(a => a.id) ?? [];
    check('two accounts, two ids', ids.length === 2 && new Set(ids).size === 2 && !ids.includes('acc1-synced'));
  }

  scenario('The merge: the same seed spelled two ways is one account, merged once');
  {
    const here = account(1, { updatedAt: 5_000 });
    const there = { ...here, id: 'x', secret: secretOf(1).toLowerCase().replace(/(.{4})/g, '$1 ').trim() };
    check('no update, no duplicate', plan({ local: [here], remotes: [{ accounts: [there], deleted: {} }] }) === null);
  }

  scenario('The merge: Steam Guard is never flattened back to six digits by an edit');
  {
    const here = account(1, { type: 'steam', digits: 5, updatedAt: 5_000 });
    const there = account(1, { name: 'Renamed', updatedAt: 6_000 });
    const merged = plan({ local: [here], remotes: [{ accounts: [there], deleted: {} }] })?.accounts[0];
    check('the rename comes over', merged?.name === 'Renamed');
    check('and the account stays Steam', merged?.type === 'steam' && merged.digits === 5);
  }

  scenario('The merge: deletions older than this device’s sync leave its own accounts, and still keep others out');
  {
    const result = plan({
      local: [account(1)],
      remotes: [{ accounts: [account(2, { updatedAt: 1_500 })], deleted: { [h(1)]: 5_000, [h(2)]: 5_000 } }],
      removalSince: 9_000,
    });
    check('its own account stays', result === null || result.accounts.some(a => a.id === 'acc1'));
    check('one it never had is not added', result === null || !result.accounts.some(a => a.secret === secretOf(2)));
  }

  scenario('The merge: a seed deleted here mid-sync is not added back');
  {
    const result = plan({ local: [], remotes: [{ accounts: [account(1, { updatedAt: 5 })], deleted: {} }], skipAdd: key => key === secretOf(1) });
    check('left out', result === null);
  }

  scenario('The merge: two devices with conflicting edits end up agreeing');
  {
    const a = [account(1, { name: 'A-name', updatedAt: 5_000 }), account(2, { group: 'A', updatedAt: 9_000 })];
    const b = [account(1, { name: 'B-name', updatedAt: 6_000 }), account(2, { group: 'B', updatedAt: 9_000 })];
    const onA = plan({ local: a, remotes: [{ accounts: b, deleted: {} }] })?.accounts ?? a;
    const onB = plan({ local: b, remotes: [{ accounts: a, deleted: {} }] })?.accounts ?? b;
    const view = (list: Account[]) => JSON.stringify(list.map(x => [x.secret, x.name, x.group ?? null, x.updatedAt]).sort());
    check('the same list on both', view(onA) === view(onB), `${view(onA)} vs ${view(onB)}`);
    check('the newer name', onA.find(x => x.id === 'acc1')?.name === 'B-name');
    check('and a second round changes nothing', plan({ local: onA, remotes: [{ accounts: onB, deleted: {} }] }) === null);
  }
}

// ─── Devices ───────────────────────────────────────────────────────────────

export async function run(): Promise<void> {
  mergeAlone();

  const storage = await import('@/utils/storage');
  const state = await import('@/billing/state');
  const cloud = await import('@/billing/cloud-backup');
  const { clearKeyCache } = await import('@/utils/vault');
  const realFetch = globalThis.fetch;

  /** Each device a profile of its own: local and sync set aside together. */
  const devices = new Map<string, { local: Record<string, unknown>; sync: Record<string, unknown> }>();
  let currentDevice = 'A';
  const switchTo = async (name: string) => {
    await flush();
    devices.set(currentDevice, { local: { ...areas.local }, sync: { ...areas.sync } });
    for (const area of [areas.local, areas.sync]) for (const k of Object.keys(area)) delete area[k];
    const next = devices.get(name);
    Object.assign(areas.local, next?.local ?? { syncObserved: true });
    Object.assign(areas.sync, next?.sync ?? {});
    storage.resetQuarantine();
    clearKeyCache();
    currentDevice = name;
  };

  const setUp = async () => {
    await resetState();
    devices.clear();
    currentDevice = 'A';
    const server = fakeServer();
    globalThis.fetch = server.handler;
    const install = await state.ensureInstall({ reason: 'install' });
    server.holders.add(install.id);
    await grantPro(install.id);
    return server;
  };

  const newDevice = async (server: ReturnType<typeof fakeServer>, name: string) => {
    await switchTo(name);
    const install = await state.ensureInstall({ reason: 'install' });
    server.holders.add(install.id);
    await grantPro(install.id);
  };

  const freshCode = async () => {
    const code = await cloud.pendingBackupCode();
    await cloud.dropPendingBackupCode();
    return code;
  };

  /** What the popup does on opening, minus the screen: read the others, then send. */
  const open = async () => {
    const outcome = await cloud.syncWithCloud({ force: true });
    await cloud.cloudBackupIfDue(await storage.getAccounts());
    await flush();
    return outcome;
  };

  const names = async () => (await storage.getAccounts()).map(a => a.name).sort();
  const has = async (n: number) => (await storage.getAccounts()).some(a => a.secret === secretOf(n));

  /** A turned on, B joined with the code: the starting point of most scenarios. */
  const twoDevices = async (onA: Account[]) => {
    const server = await setUp();
    await storage.addMultipleAccounts(onA, USER_ADD);
    const code = await freshCode();
    await cloud.enableCloudBackup(code);
    await tick();
    await newDevice(server, 'B');
    await cloud.adoptBackupCode(code);
    await open();
    return { server, code };
  };

  try {
    scenario('An account added on one device appears on the other');
    {
      await twoDevices([account(1), account(2)]);
      check('B took A’s accounts when it joined', (await has(1)) && (await has(2)));
      await tick();
      await storage.addAccount(account(3, { id: 'b3' }), USER_ADD);
      await open();
      await switchTo('A');
      check('A has not seen it before opening', !(await has(3)));
      check('opening reads the other device', (await open()) === 'merged');
      check('and A has it now', await has(3));
      check('opening again changes nothing', (await open()) === 'unchanged');
    }

    scenario('A rename, a group move and a pin travel');
    {
      await twoDevices([account(1), account(2)]);
      await switchTo('A');
      await tick();
      const [first] = (await storage.getAccounts()).filter(a => a.secret === secretOf(1));
      await storage.updateAccount(first.id, { name: 'Renamed on A' });
      const [second] = (await storage.getAccounts()).filter(a => a.secret === secretOf(2));
      await storage.moveToGroup([second.id], 'Work');
      await storage.updateAccount(second.id, { pinned: true });
      await open();
      await switchTo('B');
      await open();
      const list = await storage.getAccounts();
      check('the new name on B', list.find(a => a.secret === secretOf(1))?.name === 'Renamed on A');
      const moved = list.find(a => a.secret === secretOf(2));
      check('the group and the pin on B', moved?.group === 'Work' && moved.pinned === true);
      await switchTo('A');
      check('and A, reading B’s copy back, changes nothing', (await open()) === 'unchanged');
    }

    scenario('A deletion on one device removes the account on the other, and it stays gone');
    {
      await twoDevices([account(1), account(2), account(3)]);
      await tick();
      const target = (await storage.getAccounts()).find(a => a.secret === secretOf(2))!;
      await storage.deleteAccount(target.id);
      await open();
      await switchTo('A');
      await open();
      check('gone on A', !(await has(2)));
      check('the rest stay', (await has(1)) && (await has(3)));
      await switchTo('B');
      await open();
      check('A’s copy, sent after the merge, does not bring it back to B', !(await has(2)));
      await switchTo('A');
      await open();
      check('nor does anything bring it back to A', !(await has(2)));
    }

    scenario('Several accounts deleted at once go everywhere');
    {
      await twoDevices([account(1), account(2), account(3), account(4)]);
      await tick();
      const ids = (await storage.getAccounts()).filter(a => a.secret !== secretOf(1)).map(a => a.id);
      await storage.deleteAccounts(ids);
      await open();
      await switchTo('A');
      await open();
      check('only the one kept is left on A', JSON.stringify(await names()) === JSON.stringify(['person1@example.com']));
    }

    scenario('An account edited after it was deleted elsewhere survives — and comes back to the device that deleted it');
    {
      await twoDevices([account(1), account(2)]);
      await tick();
      const onB = (await storage.getAccounts()).find(a => a.secret === secretOf(2))!;
      await storage.deleteAccount(onB.id);
      await open();
      await switchTo('A');
      await tick();
      // A renames it before reading B's deletion: the newer act wins.
      const onA = (await storage.getAccounts()).find(a => a.secret === secretOf(2))!;
      await storage.updateAccount(onA.id, { name: 'Still wanted' });
      await open();
      check('kept on A', await has(2));
      await switchTo('B');
      await open();
      check('back on B, with the newer name', (await storage.getAccounts()).find(a => a.secret === secretOf(2))?.name === 'Still wanted');
    }

    scenario('An account deleted, then added back, stays added on every device');
    {
      await twoDevices([account(1), account(2)]);
      await tick();
      const target = (await storage.getAccounts()).find(a => a.secret === secretOf(2))!;
      await storage.deleteAccount(target.id);
      await open();
      await switchTo('A');
      await open();
      check('gone on A first', !(await has(2)));
      await tick();
      await storage.addAccount(account(2, { id: 'readded', createdAt: Date.now() }), USER_ADD);
      await open();
      await switchTo('B');
      await open();
      check('the re-scanned account reaches B despite B’s deletion', await has(2));
      await switchTo('A');
      check('and A keeps it', (await open()) !== 'failed' && (await has(2)));
    }

    scenario('Restoring a copy by hand brings back an account deleted elsewhere, for good');
    {
      const { server } = await twoDevices([account(1), account(2)]);
      // The first copy A made held both accounts.
      const firstCopy = server.copies[0].id;
      await tick();
      const target = (await storage.getAccounts()).find(a => a.secret === secretOf(2))!;
      await storage.deleteAccount(target.id);
      await open();
      await switchTo('A');
      await open();
      check('deleted on A by sync', !(await has(2)));
      await tick();
      const restored = await cloud.restoreCloudBackup(firstCopy);
      check('the restore adds it', restored.added === 1 && (await has(2)));
      await cloud.cloudBackupIfDue(await storage.getAccounts());
      check('the next sync does not delete it again', (await open()) !== 'failed' && (await has(2)));
      await switchTo('B');
      await open();
      check('and B gets it back too', await has(2));
    }

    scenario('Deletions from before a device started syncing stay on that device');
    {
      const server = await setUp();
      await storage.addMultipleAccounts([account(1), account(2)], USER_ADD);
      const code = await freshCode();
      await cloud.enableCloudBackup(code);
      await tick();
      // B is an older install: it deleted account 2 long before sync existed.
      await newDevice(server, 'B');
      await storage.addMultipleAccounts([account(1), account(2)], USER_ADD);
      const target = (await storage.getAccounts()).find(a => a.secret === secretOf(2))!;
      await storage.deleteAccount(target.id);
      await tick();
      await cloud.adoptBackupCode(code);
      await open();
      check('B took it back when it joined — the copies are what it joins', await has(2));
      await switchTo('A');
      await open();
      check('A keeps it: the old deletion did not travel', await has(2));
    }

    scenario('A copy from a build before sync only adds');
    {
      const { server, code } = await twoDevices([account(1), account(2)]);
      await switchTo('A');
      // What an older build sends: no stamps, no deletions — and missing an account A has.
      const keys = await cloud.deriveBackupKeys(code);
      const { encryptJson } = await import('@/utils/crypto');
      const old = { format: 'authenticator-cloud-backup', v: 1, kid: keys.kid, createdAt: Date.now(), accounts: [account(1, { name: 'Old name' }), account(9)], held: [] };
      const data = await encryptJson(old, keys.enc);
      server.copies.push({ id: 'bkp_old', iid: 'ffffffff-0000-4000-8000-000000000000', kid: keys.kid, data, at: Date.now() * 1000 + 999_999 });
      server.holders.add('ffffffff-0000-4000-8000-000000000000');
      await open();
      check('its new account comes in', await has(9));
      check('its missing one is not taken away', await has(2));
      check('its unstamped name does not replace this one', (await storage.getAccounts()).find(a => a.secret === secretOf(1))?.name === 'person1@example.com');
    }

    scenario('Three devices: what one does reaches both others');
    {
      const { server, code } = await twoDevices([account(1), account(2)]);
      await newDevice(server, 'C');
      await cloud.adoptBackupCode(code);
      await open();
      check('C joined with both', (await has(1)) && (await has(2)));
      await switchTo('B');
      await tick();
      await storage.addAccount(account(5, { id: 'b5' }), USER_ADD);
      const gone = (await storage.getAccounts()).find(a => a.secret === secretOf(1))!;
      await storage.deleteAccount(gone.id);
      await open();
      for (const name of ['C', 'A']) {
        await switchTo(name);
        await open();
        check(`${name} has B’s new account and not the deleted one`, (await has(5)) && !(await has(1)) && (await has(2)));
      }
      // Each device reads each other device's newest copy: C's, sent after it
      // merged B, carries the same, and nothing flips back and forth.
      for (const name of ['B', 'C', 'A']) {
        await switchTo(name);
        check(`${name} settles`, (await open()) === 'unchanged');
      }
    }

    scenario('A deletion on a device whose clock is behind still wins over what it deletes');
    {
      await twoDevices([account(1)]);
      await switchTo('A');
      // A's clock ten minutes ahead of B's: A stamps everything later.
      areas.local.clockHighWater = Date.now() + 10 * 60_000;
      await storage.addAccount(account(2, { id: 'a2', createdAt: Date.now() }), USER_ADD);
      await open();
      await switchTo('B');
      await open();
      check('B has A’s account', await has(2));
      const target = (await storage.getAccounts()).find(a => a.secret === secretOf(2))!;
      await storage.deleteAccount(target.id);
      await open();
      await switchTo('A');
      await open();
      check('gone on A', !(await has(2)));
      await tick();
      const first = (await storage.getAccounts()).find(a => a.secret === secretOf(1))!;
      await storage.updateAccount(first.id, { name: 'edited on A' });
      await open();
      await switchTo('B');
      await open();
      check('and A’s next copy does not bring it back to B', !(await has(2)));
      check('while A’s edit arrives', (await storage.getAccounts()).find(a => a.secret === secretOf(1))?.name === 'edited on A');
    }

    scenario('A device joining keeps its own accounts that another device deleted before it joined');
    {
      const server = await setUp();
      await storage.addMultipleAccounts([account(1), account(2)], USER_ADD);
      const code = await freshCode();
      await cloud.enableCloudBackup(code);
      await tick();
      const target = (await storage.getAccounts()).find(a => a.secret === secretOf(2))!;
      await storage.deleteAccount(target.id);
      await open();
      await tick();
      await newDevice(server, 'B');
      await storage.addMultipleAccounts([account(2)], USER_ADD);
      await tick();
      await cloud.adoptBackupCode(code);
      await open();
      check('B keeps it', await has(2));
      check('and gets the rest', await has(1));
    }

    scenario('Two devices with one install id — an iPad set up from the iPhone’s backup — still sync');
    {
      const { server } = await twoDevices([account(1)]);
      await switchTo('A');
      await open();
      // The twin: A's whole profile, copied.
      devices.set('A', { local: { ...areas.local }, sync: { ...areas.sync } });
      devices.set('A2', { local: JSON.parse(JSON.stringify(areas.local)), sync: {} });
      await switchTo('A2');
      await tick();
      await storage.addAccount(account(7, { id: 'twin7' }), USER_ADD);
      await open();
      check('the twin sent its copy', server.copies.length > 0);
      await switchTo('A');
      await open();
      check('A gets the twin’s account', await has(7));
    }

    scenario('After "start over" on another device, the header asks for the new code');
    {
      const { server } = await twoDevices([account(1)]);
      server.restart();
      check('the read stops', (await cloud.syncWithCloud({ force: true })) === 'skipped');
      check('and the status is a problem, not off', (await cloud.readCloudSyncStatus()).state === 'error');
    }

    scenario('A list that only changed by merging is sent later, not at once');
    {
      const { server } = await twoDevices([account(1)]);
      // B has sent a copy of its own: the first one always goes out.
      await storage.addAccount(account(3, { id: 'b3' }), USER_ADD);
      await open();
      await switchTo('A');
      await tick();
      await storage.addAccount(account(4, { id: 'a4' }), USER_ADD);
      await open();
      await switchTo('B');
      const before = server.copies.length;
      await open();
      check('B has it', await has(4));
      check('and sent nothing for it', server.copies.length === before);
      await tick();
      await storage.addAccount(account(5, { id: 'b5' }), USER_ADD);
      await open();
      check('its own change goes out at once', server.copies.length === before + 1);
    }

    scenario('A copy from a later build is not marked read, to be read after an update');
    {
      const { server, code } = await twoDevices([account(1)]);
      const keys = await cloud.deriveBackupKeys(code);
      const { encryptJson } = await import('@/utils/crypto');
      const future = { format: 'authenticator-cloud-backup', v: 2, kid: keys.kid, createdAt: Date.now(), accounts: [], held: [] };
      server.copies.push({ id: 'bkp_future', iid: 'eeeeeeee-0000-4000-8000-000000000000', kid: keys.kid, data: await encryptJson(future, keys.enc), at: Date.now() * 1000 + 888_888 });
      await open();
      await open();
      check('asked for each time', server.gets.filter(id => id === 'bkp_future').length === 2);
    }

    scenario('With password protection on: nothing while locked, then a deletion that sticks under Chrome sync');
    {
      const PASSWORD = 'correct horse battery staple';
      const vault = await import('@/utils/vault');
      await twoDevices([account(1), account(2)]);
      await switchTo('A');
      await (await storage.prepareVault(PASSWORD)).commit();
      await open();
      await switchTo('B');
      await tick();
      const target = (await storage.getAccounts()).find(a => a.secret === secretOf(2))!;
      await storage.deleteAccount(target.id);
      await open();
      await switchTo('A');
      await vault.lock();
      check('locked: nothing is read', (await cloud.syncWithCloud({ force: true })) === 'skipped');
      check('nor shown as a problem', (await cloud.readCloudSyncStatus()).state === 'off');
      await vault.unlockWithPassword(PASSWORD);
      check('unlocked: read and merged', (await cloud.syncWithCloud({ force: true })) === 'merged');
      check('gone under the vault', !(await has(2)));
      const stored = JSON.stringify(areas.local.authenticator_accounts ?? []);
      check('and nothing went to disk in the clear', !stored.includes(secretOf(1)) && !stored.includes('person1@example.com'));
      await flush();
      check('a read that merges Chrome sync back in does not return it', !(await has(2)));
      await open();
      check('nor the next sync', !(await has(2)) && (await has(1)));
    }

    scenario('The header’s status');
    {
      const server = await setUp();
      check('off until cloud backup is on', (await cloud.readCloudSyncStatus()).state === 'off');
      await storage.addMultipleAccounts([account(1)], USER_ADD);
      await cloud.enableCloudBackup(await freshCode());
      const ok = await cloud.readCloudSyncStatus();
      check('on: synced, with when', ok.state === 'ok' && typeof ok.at === 'number');
      server.down = true;
      check('a read that fails says so', (await cloud.syncWithCloud({ force: true })) === 'failed');
      check('and the status turns to a problem', (await cloud.readCloudSyncStatus()).state === 'error');
      server.down = false;
      await cloud.syncWithCloud({ force: true });
      check('a read that works clears it', (await cloud.readCloudSyncStatus()).state === 'ok');
      let seen = 0;
      const stop = cloud.onCloudSyncActivity(() => seen++);
      await cloud.syncWithCloud({ force: true });
      stop();
      check('a sync is announced as it starts and ends', seen === 2);
    }

    scenario('Opening the list often reads the others at most once a minute');
    {
      const server = await setUp();
      await storage.addMultipleAccounts([account(1)], USER_ADD);
      await cloud.enableCloudBackup(await freshCode());
      const before = server.lists.length;
      await cloud.syncWithCloud();
      await cloud.syncWithCloud();
      await cloud.syncWithCloud();
      check('one list request for three opens', server.lists.length - before === 1, String(server.lists.length - before));
      await cloud.syncWithCloud({ force: true });
      check('asked for explicitly, it reads again', server.lists.length - before === 2);
    }

    scenario('Without Pro, nothing is asked');
    {
      const server = await setUp();
      await chrome.storage.local.remove('billingEntitlement');
      check('skipped', (await cloud.syncWithCloud({ force: true })) === 'skipped' && server.lists.length === 0);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
}
