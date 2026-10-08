// Cloud backup (billing/cloud-backup.ts): end-to-end encrypted copies of the
// accounts on our server, for Pro.
//
// What these scenarios hold the code to: nothing about the accounts reaches
// the server in a form it can read; the code is never kept in the clear while
// password protection is on, from the moment it is turned on; a license has
// one code at a time, and a browser holding an old one — after "turn off" or
// "start over" elsewhere — forgets it instead of uploading under it; restoring
// only adds, needs the right code, and works with the license key after Pro
// has ended; and records this device cannot read travel in the copy too.
//
// The server here plays the real contract (server/src/lib/backup.ts): one
// license, the current code's kid and auth, claim, backup_off and
// backup_wrong_code.

import { readFileSync } from 'node:fs';
import { areas, check, flush, resetState, scenario, throwsNamed, USER_ADD } from './harness';

const KEY = JSON.parse(readFileSync(new URL('./fixtures/billing-test-key.json', import.meta.url), 'utf8'));
const PASSWORD = 'correct horse battery staple';
const LICENSE_KEY = '2FA-ABCDE-FGHJK-MNPQR-STVWX';

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

const now = () => Math.floor(Date.now() / 1000);

async function grantPro(iid: string, features: string[] = ['unlimited_accounts', 'cloud_backup']): Promise<void> {
  const token = await sign({ typ: 'ent', v: 1, lid: 'lic_1', kind: 'life', features, until: null, key_hint: 'STVWX', sub: iid, iat: now(), exp: now() + 3600 });
  await chrome.storage.local.set({ billingEntitlement: token });
}

const account = (n: number) => ({
  id: `acc${n}`,
  name: `person${n}@secret-mail.example`,
  issuer: `Issuer${n}`,
  secret: `JBSWY3DPEHPK3P${'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[n % 32]}${'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[Math.floor(n / 32) % 32]}`,
  algorithm: 'SHA1' as const,
  digits: 6,
  period: 30,
  createdAt: n,
});

interface Stored {
  id: string;
  iid: string;
  kid: string;
  data: string;
  at: number;
}

/** One license (LICENSE_KEY) held by every install in `holders`; the server's side of the contract. */
function fakeServer() {
  const copies: Stored[] = [];
  const bodies: string[] = [];
  const holders = new Set<string>();
  let current: { kid: string; auth: string } | null = null;
  let down = false;
  let seq = 0;
  const handler = (async (url: string, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const raw = String(init?.body ?? '{}');
    const body = JSON.parse(raw);
    bodies.push(raw);
    const answer = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (down) return answer({ error: 'internal' }, 500);
    const byKey = typeof body.key === 'string';
    if (byKey && body.key.replace(/-/g, '').toUpperCase() !== LICENSE_KEY.replace(/-/g, '')) return answer({ error: 'invalid_key' }, 404);
    if (!byKey && !holders.has(body.iid)) return answer({ error: 'no_license' }, 404);
    switch (path) {
      case '/v1/backup/upload': {
        if (!current) {
          if (!body.claim) return answer({ error: 'backup_off' }, 409);
          current = { kid: body.kid, auth: body.auth };
        } else if (current.kid !== body.kid || current.auth !== body.auth) {
          return answer({ error: 'backup_wrong_code' }, 409);
        }
        const copy = { id: `bkp_${++seq}`, iid: body.iid, kid: body.kid, data: body.data, at: Date.now() + seq };
        copies.push(copy);
        return answer({ id: copy.id, created_at: copy.at });
      }
      case '/v1/backup/list':
        return answer({
          kid: current?.kid ?? null,
          backups: [...copies].reverse().map(c => ({ id: c.id, created_at: c.at, bytes: c.data.length, kid: c.kid, this_device: c.iid === body.iid })),
        });
      case '/v1/backup/get': {
        if (!current) return answer({ error: 'backup_not_found' }, 404);
        if (current.auth !== body.auth) return answer({ error: 'backup_wrong_code' }, 409);
        const copy = copies.find(c => c.id === body.id);
        return copy ? answer({ id: copy.id, created_at: copy.at, kid: copy.kid, data: copy.data }) : answer({ error: 'backup_not_found' }, 404);
      }
      case '/v1/backup/delete': {
        if (current && current.auth !== body.auth) return answer({ error: 'backup_wrong_code' }, 409);
        const deleted = copies.length;
        copies.length = 0;
        current = null;
        return answer({ deleted });
      }
      case '/v1/backup/reset': {
        const deleted = copies.length;
        copies.length = 0;
        current = null;
        return answer({ deleted });
      }
    }
    return answer({ error: 'bad_request' }, 400);
  }) as typeof fetch;
  return {
    copies,
    bodies,
    holders,
    handler,
    get current() {
      return current;
    },
    set down(value: boolean) {
      down = value;
    },
  };
}

export async function run(): Promise<void> {
  const storage = await import('@/utils/storage');
  const vault = await import('@/utils/vault');
  const state = await import('@/billing/state');
  const cloud = await import('@/billing/cloud-backup');
  const realFetch = globalThis.fetch;

  /** This browser's local area, set aside and brought back: two browsers sharing one sync area. */
  const devices = new Map<string, Record<string, unknown>>();
  let currentDevice = 'A';
  const switchTo = async (name: string) => {
    await flush();
    devices.set(currentDevice, { ...areas.local });
    for (const k of Object.keys(areas.local)) delete areas.local[k];
    Object.assign(areas.local, devices.get(name) ?? { syncObserved: true });
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
    return { server, install };
  };

  /** Another browser of the same person: own local area and install, the same sync area and license. */
  const secondDevice = async (server: ReturnType<typeof fakeServer>, name = 'B') => {
    await switchTo(name);
    const install = await state.ensureInstall({ reason: 'install' });
    server.holders.add(install.id);
    await grantPro(install.id);
    return install;
  };

  /** A code as the setup screen would show one, without keeping it pending. */
  const freshCode = async () => {
    const code = await cloud.pendingBackupCode();
    await cloud.dropPendingBackupCode();
    return code;
  };

  try {
    scenario('The recovery code alone decides the keys');
    {
      const code = await freshCode();
      const a = await cloud.deriveBackupKeys(code);
      const b = await cloud.deriveBackupKeys(code.toLowerCase().replace(/-/g, ' '));
      const other = await cloud.deriveBackupKeys(await freshCode());
      check('the same code, however typed, gives the same key id and proof', a.kid === b.kid && a.auth === b.auth && /^[0-9a-f]{16}$/.test(a.kid));
      check('another code gives others', a.kid !== other.kid && a.auth !== other.auth);
      check('the proof is 32 bytes, as the server expects', /^[A-Za-z0-9+/]{43}=$/.test(a.auth));
    }

    scenario('A code being written down survives the popup closing');
    {
      await resetState();
      const first = await cloud.pendingBackupCode();
      check('the same code until it is confirmed or dropped', (await cloud.pendingBackupCode()) === first);
      await cloud.dropPendingBackupCode();
      check('a new one after', (await cloud.pendingBackupCode()) !== first);
      await cloud.dropPendingBackupCode();
    }

    scenario('Without Pro, or with Pro that lacks it, or never turned on, nothing is sent');
    {
      const { server, install } = await setUp();
      await storage.addMultipleAccounts([account(1)], USER_ADD);
      await chrome.storage.local.remove('billingEntitlement');
      check('no license: skipped', (await cloud.cloudBackupIfDue(await storage.getAccounts())) === 'skipped');
      await grantPro(install.id, ['unlimited_accounts']);
      check('a license from before cloud backup: skipped', (await cloud.cloudBackupIfDue(await storage.getAccounts())) === 'skipped');
      await grantPro(install.id);
      check('Pro but never turned on: skipped', (await cloud.cloudBackupIfDue(await storage.getAccounts())) === 'skipped');
      check('and the server heard nothing', server.bodies.length === 0);
    }

    scenario('Turning it on claims the license and sends a copy the server cannot read');
    {
      const { server } = await setUp();
      await storage.addMultipleAccounts([account(1), account(2)], USER_ADD);
      const code = await cloud.pendingBackupCode();
      await cloud.enableCloudBackup(code);
      const keys = await cloud.deriveBackupKeys(code);
      check('one copy, and the license now has this code', server.copies.length === 1 && server.current?.kid === keys.kid);
      const sent = server.bodies.join('\n');
      check('no account name, issuer or secret in anything sent', !/secret-mail\.example|Issuer1|JBSWY3DPEHPK3P/.test(sent));
      check('and never the code', !sent.includes(code) && !sent.includes(code.replace(/-/g, '')));
      check('the code is kept here', (await cloud.readCode()).kind === 'ready');
      check('the code on screen is let go once it is on', (await cloud.pendingBackupCode()) !== code);
      await cloud.dropPendingBackupCode();
      check('an unchanged list is not sent again', (await cloud.cloudBackupIfDue(await storage.getAccounts())) === 'unchanged' && server.copies.length === 1);
      await storage.addMultipleAccounts([account(3)], USER_ADD);
      check('a changed one is', (await cloud.cloudBackupIfDue(await storage.getAccounts())) === 'uploaded' && server.copies.length === 2);
      check('an empty list never is', (await cloud.cloudBackupIfDue([])) === 'skipped' && server.copies.length === 2);
    }

    scenario('Turning it on while the server is down keeps nothing, and the same code works on the retry');
    {
      const { server } = await setUp();
      await storage.addMultipleAccounts([account(1)], USER_ADD);
      const code = await cloud.pendingBackupCode();
      server.down = true;
      check('the failure is reported', await throwsNamed('BillingApiError', () => cloud.enableCloudBackup(code)));
      check('no code kept: "on" is never shown without the server knowing', (await cloud.readCode()).kind === 'none');
      check('the code on screen is still the same', (await cloud.pendingBackupCode()) === code);
      server.down = false;
      await cloud.enableCloudBackup(code);
      check('on with that code', server.current?.kid === (await cloud.deriveBackupKeys(code)).kid);
    }

    scenario('A code reaches sync only once the server has taken it');
    {
      const { server } = await setUp();
      await storage.addMultipleAccounts([account(1)], USER_ADD);
      const code = await cloud.pendingBackupCode();
      server.down = true;
      await cloud.enableCloudBackup(code).catch(() => {});
      check('a failed turn-on leaves nothing in sync for another profile to adopt', !areas.sync.cloudBackupCode);
      server.down = false;
      await cloud.enableCloudBackup(code);
      check('once taken, sync has it', !!areas.sync.cloudBackupCode);
    }

    scenario('A second browser with accounts the copies lack sends them as soon as it takes the code');
    {
      const { server } = await setUp();
      await storage.addMultipleAccounts([account(1)], USER_ADD);
      const code = await freshCode();
      await cloud.enableCloudBackup(code);
      await secondDevice(server);
      for (const k of Object.keys(areas.sync)) delete areas.sync[k];
      await storage.addMultipleAccounts([account(7)], USER_ADD);
      await cloud.adoptBackupCode(code);
      check('its own account is in the cloud now, not at its next change', server.copies.length === 2);

      // A browser holding only what the copies already have sends nothing.
      await switchTo('D');
      await state.ensureInstall({ reason: 'install' }).then(i => {
        server.holders.add(i.id);
        return grantPro(i.id);
      });
      await storage.addMultipleAccounts([account(7)], USER_ADD);
      await cloud.adoptBackupCode(code);
      check('nothing new: nothing sent', server.copies.length === 2);
    }

    scenario('A failing server is not asked again on every open');
    {
      const { server } = await setUp();
      await storage.addMultipleAccounts([account(1)], USER_ADD);
      await cloud.enableCloudBackup(await freshCode());
      server.down = true;
      await storage.addMultipleAccounts([account(2)], USER_ADD);
      check('the failure is reported', (await cloud.cloudBackupIfDue(await storage.getAccounts())) === 'failed');
      check('and remembered for the status line', (await cloud.readUploadState()).failedAt !== null);
      check('the next open waits', (await cloud.cloudBackupIfDue(await storage.getAccounts())) === 'skipped');
      check('the code is kept through a plain failure', (await cloud.readCode()).kind === 'ready');
      server.down = false;
      const later = Date.now() + 16 * 60_000;
      check('a quarter of an hour later it tries again', (await cloud.cloudBackupIfDue(await storage.getAccounts(), later)) === 'uploaded');
    }

    scenario('Records this device cannot read travel in the copy, and are reported when it comes back');
    {
      const { server } = await setUp();
      await storage.addMultipleAccounts([account(1)], USER_ADD);
      // Ciphertext of a vault this device never had: held, never dropped.
      const foreign = { id: 'foreign1', fp: 'ZmFrZQ==', enc: 'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA==', v: 'another-vault' };
      const stored = (await chrome.storage.local.get('authenticator_accounts')).authenticator_accounts as unknown[];
      await chrome.storage.local.set({ authenticator_accounts: [...stored, foreign] });
      const code = await freshCode();
      await cloud.enableCloudBackup(code);
      const copyId = server.copies[0].id;

      await secondDevice(server);
      await cloud.adoptBackupCode(code);
      const result = await cloud.restoreCloudBackup(copyId);
      const records = (await chrome.storage.local.get('authenticator_accounts')).authenticator_accounts as Array<{ id: string }>;
      // (Here sync already brought it; the copy adds nothing on top.)
      check('the readable account is here', records.some(r => r.id === 'acc1'));
      // Like the automatic copies: ciphertext of a vault this device does not
      // have is counted and named to the person ("needs a different password"),
      // not written as junk — and it is in the copy, for a browser that has it.
      check('the held record was in the copy, and is reported', result.unreadable === 1);
    }

    scenario('Another browser takes the code: the newest copy is merged in first, then the whole list is sent');
    {
      const { server } = await setUp();
      await storage.addMultipleAccounts([account(1), account(2)], USER_ADD);
      const code = await freshCode();
      await cloud.enableCloudBackup(code);
      const copyId = server.copies[0].id;

      await secondDevice(server);
      for (const k of Object.keys(areas.sync)) delete areas.sync[k];
      await storage.addMultipleAccounts([account(5)], USER_ADD);
      check('no code here yet', (await cloud.readCode()).kind === 'none');
      check('a wrong code is refused', await throwsNamed('WrongBackupCodeError', async () => cloud.adoptBackupCode(await freshCode())));
      const merged = await cloud.adoptBackupCode(code.toLowerCase());
      const names = (await storage.getAccounts()).map(a => a.id).sort().join(',');
      check('the newest copy is merged in as the code is taken', merged?.added === 2 && names === 'acc1,acc2,acc5', names);
      // acc5 is in no copy: the list sent is the copy's and this browser's together.
      check('and the whole list is sent — the first copy stays', server.copies.length === 2 && server.copies[0].id === copyId);
      check('an unchanged list stays unsent', (await cloud.cloudBackupIfDue(await storage.getAccounts())) === 'unchanged');
      check('restoring the copy again adds nothing', (await cloud.restoreCloudBackup(copyId)).added === 0);
    }

    scenario('A new computer with one account typed in does not make that one account the newest copy');
    {
      const { server } = await setUp();
      await storage.addMultipleAccounts([account(1), account(2), account(3)], USER_ADD);
      const code = await freshCode();
      await cloud.enableCloudBackup(code);
      await secondDevice(server);
      for (const k of Object.keys(areas.sync)) delete areas.sync[k];
      await storage.addMultipleAccounts([account(2)], USER_ADD);
      await cloud.adoptBackupCode(code);
      check('nothing is sent: the copy already held that account', server.copies.length === 1);
      check('and the three accounts are here', (await storage.getAccounts()).length === 3);
      await storage.addMultipleAccounts([account(4)], USER_ADD);
      check('the next change sends all four', (await cloud.cloudBackupIfDue(await storage.getAccounts())) === 'uploaded' && server.copies.length === 2);
    }

    scenario('One license, one code: a second browser cannot turn on another');
    {
      const { server } = await setUp();
      await storage.addMultipleAccounts([account(1)], USER_ADD);
      const code = await freshCode();
      await cloud.enableCloudBackup(code);
      await secondDevice(server);
      for (const k of Object.keys(areas.sync)) delete areas.sync[k];
      await storage.addMultipleAccounts([account(2)], USER_ADD);
      check('a new code is refused', await throwsNamed('WrongBackupCodeError', async () => cloud.enableCloudBackup(await freshCode())));
      check('nothing kept, nothing sent', (await cloud.readCode()).kind === 'none' && server.copies.length === 1);
      check('the license keeps its code', server.current?.kid === (await cloud.deriveBackupKeys(code)).kid);
    }

    scenario('Turned off in one browser, the other stops and forgets — sync does not bring it back');
    {
      const { server } = await setUp();
      await storage.addMultipleAccounts([account(1)], USER_ADD);
      const code = await freshCode();
      await cloud.enableCloudBackup(code);
      const kid = (await cloud.deriveBackupKeys(code)).kid;
      await secondDevice(server);
      await storage.addMultipleAccounts([account(2)], USER_ADD);
      check('B took the code from sync', (await cloud.readCode()).kind === 'ready');

      await switchTo('A');
      const deleted = await cloud.disableCloudBackup();
      check('A: every copy deleted, the license has no code', deleted === 1 && server.copies.length === 0 && server.current === null);
      check('A: the code is gone here and from sync', !areas.local.cloudBackupCode && !areas.sync.cloudBackupCode);

      await switchTo('B');
      // B still holds it locally and puts it back in sync where none is.
      await state.reassertSyncedFacts();
      await storage.addMultipleAccounts([account(3)], USER_ADD);
      check('B: its next upload is refused and reported', (await cloud.cloudBackupIfDue(await storage.getAccounts())) === 'failed');
      check('B: and it forgot the code', (await cloud.readCode()).kind === 'none');
      check('B: and took it out of sync', !areas.sync.cloudBackupCode);
      check('B: nothing was stored on the server', server.copies.length === 0 && server.current === null);
      // Another profile putting the old code back in sync is not believed.
      await chrome.storage.sync.set({ cloudBackupCode: { c: code.replace(/-/g, '') } });
      check('B: the refused code is not adopted again', (await cloud.readCode()).kind === 'none');
      check('B: refused for that kid', (await cloud.readUploadState()).rejectedKid === kid);
    }

    scenario('Turning off needs the code; an install id alone cannot wipe the copies');
    {
      const { server } = await setUp();
      await storage.addMultipleAccounts([account(1)], USER_ADD);
      await cloud.enableCloudBackup(await freshCode());
      await secondDevice(server);
      for (const k of Object.keys(areas.sync)) delete areas.sync[k];
      check('without the code here, turning off is refused before asking', await throwsNamed('WrongBackupCodeError', () => cloud.disableCloudBackup()));
      check('the copies are still there', server.copies.length === 1);
    }

    scenario('Lost the code: the license key starts over, and the old code is refused everywhere');
    {
      const { server } = await setUp();
      await storage.addMultipleAccounts([account(1)], USER_ADD);
      const old = await freshCode();
      await cloud.enableCloudBackup(old);
      await secondDevice(server);
      for (const k of Object.keys(areas.sync)) delete areas.sync[k];
      await storage.addMultipleAccounts([account(2)], USER_ADD);
      check('B: reset by license key', (await cloud.resetCloudBackup(LICENSE_KEY)) === 1 && server.current === null);
      const fresh = await freshCode();
      await cloud.enableCloudBackup(fresh);
      check('B: on with a new code', server.current?.kid === (await cloud.deriveBackupKeys(fresh)).kid);

      await switchTo('A');
      await storage.addMultipleAccounts([account(3)], USER_ADD);
      check('A: its old code is refused', (await cloud.cloudBackupIfDue(await storage.getAccounts())) === 'failed');
      check('A: nothing landed under the old code', server.copies.every(c => c.kid === server.current?.kid));
      // Sync carries B's new code: A forgot the old one and takes the new.
      const adopted = await cloud.readCode();
      check('A: the new code from sync, not the refused one', adopted.kind === 'ready' && adopted.kid === (await cloud.deriveBackupKeys(fresh)).kid);
      // Without sync there is nothing to adopt: A asks for the current code.
      await chrome.storage.local.remove('cloudBackupCode');
      await chrome.storage.sync.remove('cloudBackupCode');
      check('A: with nothing in sync, it asks', (await cloud.readCode()).kind === 'none');
      await cloud.adoptBackupCode(fresh);
      check('A: the new code is taken', (await cloud.readCode()).kind === 'ready');
    }

    scenario('Checking the code against the server keeps a code the server agrees with');
    {
      const { server } = await setUp();
      await storage.addMultipleAccounts([account(1)], USER_ADD);
      await cloud.enableCloudBackup(await freshCode());
      await cloud.reconcileCloudBackupCode();
      check('the code stays', (await cloud.readCode()).kind === 'ready' && server.current !== null);
    }

    scenario('Pro ended: a new browser restores with the license key and the code');
    {
      await setUp();
      await storage.addMultipleAccounts([account(1), account(2)], USER_ADD);
      const code = await freshCode();
      await cloud.enableCloudBackup(code);
      await switchTo('C');
      for (const k of Object.keys(areas.sync)) delete areas.sync[k];
      await state.ensureInstall({ reason: 'install' });
      // Not a holder, no entitlement: the lapsed license on a new computer.
      check('without the key, nothing to see', await throwsNamed('BillingApiError', () => cloud.listCloudBackups()));
      check('a wrong key is refused', await throwsNamed('BillingApiError', () => cloud.listCloudBackups('2FA-AAAAA-AAAAA-AAAAA-AAAAA')));
      const list = await cloud.listCloudBackups(LICENSE_KEY);
      check('the key finds the copies and the current code', list.copies.length === 1 && list.kid === (await cloud.deriveBackupKeys(code)).kid);
      const result = await cloud.restoreCloudBackup(list.copies[0].id, { typed: code, licenseKey: LICENSE_KEY });
      check('and they come back', result.added === 2);
    }

    scenario('Password protection seals the code the moment it is turned on, and opens it when turned off');
    {
      const { server } = await setUp();
      await storage.addMultipleAccounts([account(1)], USER_ADD);
      const code = await freshCode();
      await cloud.enableCloudBackup(code);
      const bare = code.replace(/-/g, '');
      check('in the clear without a vault', JSON.stringify(areas.local.cloudBackupCode).includes(bare));

      await (await storage.prepareVault(PASSWORD)).commit();
      const everywhere = () => JSON.stringify(areas.local) + JSON.stringify(areas.sync);
      check('sealed by turning it on, before anything reads it: not in the clear, local or sync', !everywhere().includes(bare));
      check(
        'wrapped under this vault, here and in sync',
        typeof (areas.local.cloudBackupCode as any)?.w === 'string' && typeof (areas.sync.cloudBackupCode as any)?.w === 'string'
      );

      await vault.lock();
      check('locked: unknown', (await cloud.readCode()).kind === 'locked');
      check('and nothing is sent', (await cloud.cloudBackupIfDue([account(9)] as any)) === 'skipped');
      await vault.unlockWithPassword(PASSWORD);
      const back = await cloud.readCode();
      check('unlocked: the same code', back.kind === 'ready' && back.code === bare);

      await storage.disableVault(PASSWORD);
      const after = await cloud.readCode();
      check('turned off: the code is readable again, backups go on', after.kind === 'ready' && after.code === bare);
      await storage.addMultipleAccounts([account(2)], USER_ADD);
      check('and the next change is sent', (await cloud.cloudBackupIfDue(await storage.getAccounts())) === 'uploaded' && server.copies.length === 2);
    }

    scenario('A read woken by turning protection off does not seal the code under the vault that is going');
    {
      await setUp();
      await storage.addMultipleAccounts([account(1)], USER_ADD);
      const code = await freshCode();
      await cloud.enableCloudBackup(code);
      const bare = code.replace(/-/g, '');
      await (await storage.prepareVault(PASSWORD)).commit();

      // The settings screen re-reads the code on every storage event; the one
      // that matters is the write putting it back in the clear.
      const local = chrome.storage.local as unknown as { set: (items: Record<string, unknown>) => Promise<void> };
      const realSet = local.set;
      let racing: Promise<unknown> | null = null;
      local.set = async function (this: unknown, items: Record<string, unknown>) {
        await realSet.call(chrome.storage.local, items);
        const written = items.cloudBackupCode as { c?: string } | undefined;
        if (!racing && written && typeof written.c === 'string') racing = cloud.readCode();
      };
      try {
        await storage.disableVault(PASSWORD);
        await racing;
      } finally {
        local.set = realSet;
      }
      check('the racing read happened', racing !== null);
      const after = await cloud.readCode();
      check('the code is still readable once protection is off', after.kind === 'ready' && after.code === bare, after.kind);
      check('and stored in the clear, here and in sync', (areas.local.cloudBackupCode as any)?.c === bare && (areas.sync.cloudBackupCode as any)?.c === bare);
    }

    scenario('A code this profile cannot open is taken from sync when sync holds a readable one');
    {
      await setUp();
      await storage.addMultipleAccounts([account(1)], USER_ADD);
      const code = await freshCode();
      await cloud.enableCloudBackup(code);
      const bare = code.replace(/-/g, '');
      // Wrapped under a vault that no longer exists here.
      await chrome.storage.local.set({ cloudBackupCode: { w: 'AAAA', v: 'gone-vault' } });
      await chrome.storage.sync.set({ cloudBackupCode: { c: bare } });
      const found = await cloud.readCode();
      check('readable from sync', found.kind === 'ready' && found.code === bare, found.kind);
      check('and kept here again', (areas.local.cloudBackupCode as any)?.c === bare);
    }

    scenario('Password protection seals a readable code in sync too, even one that is not this profile’s');
    {
      await setUp();
      await storage.addMultipleAccounts([account(1)], USER_ADD);
      await cloud.enableCloudBackup(await freshCode());
      const theirs = 'ABCDEABCDEABCDEABCDE';
      await chrome.storage.sync.set({ cloudBackupCode: { c: theirs } });
      await (await storage.prepareVault(PASSWORD)).commit();
      check('neither code readable anywhere', !(JSON.stringify(areas.local) + JSON.stringify(areas.sync)).includes(theirs));
      // And a readable code is never put into an empty sync under a vault.
      await chrome.storage.sync.remove('cloudBackupCode');
      await chrome.storage.local.set({ cloudBackupCode: { c: theirs } });
      await state.reassertSyncedFacts();
      check('re-asserting skips a readable code where there is a vault', !areas.sync.cloudBackupCode);
    }

    scenario('Reading the code for a status line does not keep the vault open');
    {
      await setUp();
      await storage.addMultipleAccounts([account(1)], USER_ADD);
      await cloud.enableCloudBackup(await freshCode());
      await (await storage.prepareVault(PASSWORD)).commit();
      const session = async () => ((await chrome.storage.session.get('vault_session')) as any).vault_session?.lastActivity ?? null;
      const before = await session();
      await new Promise(r => setTimeout(r, 5));
      await cloud.readCode();
      check('the idle clock is where it was', before !== null && (await session()) === before, `${before}`);
    }

    scenario('Sync is only filled, never overwritten, by a browser re-asserting its code');
    {
      await setUp();
      await storage.addMultipleAccounts([account(1)], USER_ADD);
      await cloud.enableCloudBackup(await freshCode());
      const theirs = { c: 'ABCDEABCDEABCDEABCDE' };
      await chrome.storage.sync.set({ cloudBackupCode: theirs });
      await state.reassertSyncedFacts();
      check('another profile’s value is left alone', JSON.stringify(areas.sync.cloudBackupCode) === JSON.stringify(theirs));
      await chrome.storage.sync.remove('cloudBackupCode');
      await state.reassertSyncedFacts();
      check('an empty place is filled', !!areas.sync.cloudBackupCode);
    }

    scenario('Turning sync off takes the code off Google, and on puts it back');
    {
      await setUp();
      await storage.addMultipleAccounts([account(1)], USER_ADD);
      await cloud.enableCloudBackup(await freshCode());
      await storage.setSyncEnabled(false);
      await flush();
      check('removed from sync', !areas.sync.cloudBackupCode);
      check('still here', (await cloud.readCode()).kind === 'ready');
      await storage.setSyncEnabled(true);
      await flush();
      check('back in sync', !!areas.sync.cloudBackupCode);
    }

    scenario('"Back up now" with nothing to back up says so instead of sending an empty copy');
    {
      const { server } = await setUp();
      await storage.addMultipleAccounts([account(1)], USER_ADD);
      await cloud.enableCloudBackup(await freshCode());
      await storage.deleteAccount((await storage.getAccounts())[0].id);
      check('refused', await throwsNamed('NothingToBackUpError', () => cloud.backupNow()));
      check('nothing sent', server.copies.length === 1);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
}
