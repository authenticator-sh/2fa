// The free limit and everything around it.
//
// The rules these scenarios hold the code to are the invariants in
// MONETIZATION.md §1: the limit only ever stops an ADDITION; restoring,
// syncing and undoing are never limited; nothing is limited until the server
// has signed a policy; a token this build cannot verify for this install is
// as good as absent; and what leaves the machine is a closed list of fields
// with no account in it.

import { readFileSync } from 'node:fs';
import { areas, check, flush, resetState, scenario, USER_ADD } from './harness';

const KEY = JSON.parse(readFileSync(new URL('./fixtures/billing-test-key.json', import.meta.url), 'utf8'));

const b64url = (bytes: Uint8Array | string): string =>
  Buffer.from(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

let privateKey: CryptoKey | null = null;
async function sign(payload: Record<string, unknown>, header: Record<string, unknown> = {}): Promise<string> {
  privateKey ??= await crypto.subtle.importKey('jwk', KEY.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const h = b64url(JSON.stringify({ alg: 'ES256', kid: KEY.kid, typ: 'JWT', ...header }));
  const p = b64url(JSON.stringify(payload));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, new TextEncoder().encode(`${h}.${p}`)));
  return `${h}.${p}.${b64url(sig)}`;
}

const now = () => Math.floor(Date.now() / 1000);

function policyPayload(iid: string, freeLimit: number | null, extra: Record<string, unknown> = {}) {
  return {
    typ: 'policy',
    v: 1,
    pid: `pol_${freeLimit}`,
    sub: iid,
    iat: now(),
    free_limit: freeLimit,
    warn_at: freeLimit === null ? null : freeLimit - 1,
    paywall: { copy: 'default', plans: ['pro_year'], default_plan: 'pro_year', trial_days: 0, promo_codes: false },
    prices: { pro_year: { kind: 'sub', interval: 'year', pass_days: null, amount: 1499, currency: 'usd', exp: 2, approx: false } },
    ui: { pro_in_settings: false, import_partial: true },
    exps: [],
    ...extra,
  };
}

function entitlementPayload(iid: string, expSeconds: number) {
  return { typ: 'ent', v: 1, lid: 'lic_1', kind: 'life', features: ['unlimited_accounts'], until: null, key_hint: 'ABCD', sub: iid, iat: now(), exp: expSeconds };
}

const account = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `acc${n}`,
  name: `person${n}@secret-mail.example`,
  issuer: `Issuer${n}`,
  // Distinct valid Base32 secrets.
  secret: `JBSWY3DPEHPK3P${'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[n % 32]}${'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[Math.floor(n / 32) % 32]}`,
  algorithm: 'SHA1' as const,
  digits: 6,
  period: 30,
  createdAt: n,
  ...extra,
});

function clearBilling(): void {
  for (const key of Object.keys(areas.local)) if (key.startsWith('billing')) delete areas.local[key];
  for (const key of Object.keys(areas.sync)) if (key.startsWith('billing')) delete areas.sync[key];
}

export async function run(): Promise<void> {
  const storage = await import('@/utils/storage');
  const gate = await import('@/billing/gate');
  const state = await import('@/billing/state');
  const jws = await import('@/billing/jws');
  const events = await import('@/billing/events');
  const sync = await import('@/billing/sync');
  const opens = await import('@/billing/opens');
  const legacy = await import('@/billing/legacy');
  const format = await import('@/billing/format');
  const syncPref = await import('@/utils/sync-preference');

  // ─── Tokens ──────────────────────────────────────────────────────────────

  scenario('A token is believed only if a trusted key signed it for this install');
  {
    const iid = '11111111-1111-4111-8111-111111111111';
    const token = await sign(policyPayload(iid, 5));
    check('a valid token verifies', (await jws.verifyToken(token, iid)) !== null);
    check('a token for another install does not', (await jws.verifyToken(token, '22222222-2222-4222-8222-222222222222')) === null);
    const [h, p, s] = token.split('.');
    const forged = `${h}.${b64url(JSON.stringify({ ...policyPayload(iid, 1000) }))}.${s}`;
    check('an edited payload does not', (await jws.verifyToken(forged, iid)) === null);
    check('an unknown key id does not', (await jws.verifyToken(await sign(policyPayload(iid, 5), { kid: 'other' }), iid)) === null);
    check('alg none does not', (await jws.verifyToken(`${b64url(JSON.stringify({ alg: 'none', kid: KEY.kid }))}.${p}.`, iid)) === null);
    check('garbage does not', (await jws.verifyToken('not.a.token', iid)) === null && (await jws.verifyToken(42, iid)) === null);
  }

  // ─── The gate itself ────────────────────────────────────────────────────

  scenario('No policy means no limit; a policy, a license and a lapsed license each read correctly');
  {
    await resetState();
    clearBilling();
    check('no install record: ungated', gate.remainingSlots(await state.loadGate(), 1000) === Infinity);

    const install = await state.ensureInstall({ reason: 'install' });
    check('installed without a policy yet: ungated', gate.remainingSlots(await state.loadGate(), 1000) === Infinity);

    await chrome.storage.local.set({ billingPolicy: await sign(policyPayload(install.id, 3)) });
    const limited = await state.loadGate();
    check('a signed policy limits', gate.remainingSlots(limited, 2) === 1 && gate.remainingSlots(limited, 5) === 0);

    await chrome.storage.local.set({ billingEntitlement: await sign(entitlementPayload(install.id, now() + 3600)) });
    check('a valid license lifts it', gate.remainingSlots(await state.loadGate(), 99) === Infinity);

    await chrome.storage.local.set({ billingEntitlement: await sign(entitlementPayload(install.id, now() - 10)) });
    check('an expired license does not', gate.remainingSlots(await state.loadGate(), 3) === 0);

    await chrome.storage.local.set({ billingEntitlement: await sign(entitlementPayload('33333333-3333-4333-8333-333333333333', now() + 3600)) });
    check("another install's license does not", gate.remainingSlots(await state.loadGate(), 3) === 0);

    await chrome.storage.local.set({ billingPolicy: 'garbage' });
    check('an unreadable policy is no policy, not a lock-out', gate.remainingSlots(await state.loadGate(), 1000) === Infinity);

    await chrome.storage.local.remove('billingEntitlement');
    await chrome.storage.local.set({ billingPolicy: await sign(policyPayload(install.id, 3)) });
    check('a policy that does not mention imports lets them in free', (await state.loadGate()).policy?.import_free === true);
    await chrome.storage.local.set({ billingPolicy: await sign(policyPayload(install.id, 3, { ui: { pro_in_settings: false, import_partial: true, import_free: false } })) });
    check('one that says no counts them', (await state.loadGate()).policy?.import_free === false);
  }

  scenario('Imports go in free while the policy says so; an account added by hand meets the limit');
  {
    await resetState();
    clearBilling();
    const add = await import('@/billing/add');
    const install = await state.ensureInstall({ reason: 'install' });
    const originOf = (trigger: Parameters<typeof add.addWithLimit>[0], options?: { import?: boolean }) =>
      add.addWithLimit(trigger, async (origin) => origin.kind, options);

    await chrome.storage.local.set({ billingPolicy: await sign(policyPayload(install.id, 2)) });
    check('a backup or another app\'s file', (await originOf('file')) === 'import');
    check('a list of links', (await originOf('uri')) === 'import');
    check('a Google Authenticator export', (await originOf('migration')) === 'import');
    check('the scan page, for an export', (await originOf('scan', { import: true })) === 'import');
    check('the scan page, for one code', (await originOf('scan', { import: false })) === 'user');
    check('the form', (await originOf('form')) === 'user');
    check('one QR code', (await originOf('qr')) === 'user');

    const imported = await add.addWithLimit('uri', (origin) => storage.addMultipleAccounts([account(1), account(2), account(3), account(4)], origin));
    check('four imported over a limit of two, no paywall', imported?.added === 4 && (await storage.getAccounts()).length === 4);
    let refused = false;
    try {
      await storage.addAccount(account(5), { kind: 'user', gate: await state.loadGate() });
    } catch (e) {
      refused = e instanceof gate.AccountLimitError && e.count === 4 && e.limit === 2;
    }
    check('then the next one added by hand meets the limit', refused);

    await chrome.storage.local.set({ billingPolicy: await sign(policyPayload(install.id, 2, { ui: { pro_in_settings: false, import_partial: true, import_free: false } })) });
    check('with imports counted, an import is the person\'s add like any other', (await originOf('file')) === 'user');
  }

  scenario('admit: what fits, what the person chose, and what never counts');
  {
    const g = { policy: { free_limit: 5, warn_at: 4, import_free: true }, entitled: false };
    check('fits', gate.admit({ kind: 'user', gate: g }, 3, 2) === 2);
    check('undo always fits', gate.admit({ kind: 'undo' }, 50, 1) === 1);
    check('a free import always fits, however far over the limit', gate.admit({ kind: 'import' }, 4, 30) === 30);
    check('nothing new always fits', gate.admit({ kind: 'user', gate: g }, 50, 0) === 0);
    check('take keeps only what fits', gate.admit({ kind: 'user', gate: g, take: 10 }, 3, 7) === 2);
    check('take 0 keeps no new account, and does not throw', gate.admit({ kind: 'user', gate: g, take: 0 }, 5, 3) === 0);
    let threw: unknown = null;
    try {
      gate.admit({ kind: 'user', gate: g }, 4, 3);
    } catch (e) {
      threw = e;
    }
    check(
      'too many throws with the numbers the paywall needs',
      threw instanceof gate.AccountLimitError && threw.remaining === 1 && threw.wouldAdd === 3 && threw.count === 4 && threw.limit === 5,
    );
  }

  // ─── Storage enforces it, and only for additions ─────────────────────────

  scenario('Storage refuses the addition before writing, and lets undo, restore and sync through');
  {
    await resetState();
    clearBilling();
    const limit2 = { kind: 'user' as const, gate: { policy: { free_limit: 2, warn_at: 1, import_free: true }, entitled: false } };
    await storage.addAccount(account(1), limit2);
    await storage.addAccount(account(2), limit2);
    let refused = false;
    try {
      await storage.addAccount(account(3), limit2);
    } catch (e) {
      refused = e instanceof gate.AccountLimitError;
    }
    check('the third account is refused', refused);
    check('and nothing was written', (await storage.getAccounts()).length === 2);

    check('a seed already here is not a new account', (await storage.addAccount(account(1), limit2)) === false);

    await storage.deleteAccount('acc2');
    await storage.addAccount(account(3), limit2);
    check('deleting frees a slot', (await storage.getAccounts()).length === 2);
    await storage.deleteAccount('acc3');
    await storage.addAccount(account(4), limit2);
    // Now at the limit; undoing the delete of acc3 is not an addition by the person.
    check('undo of a delete is never limited', (await storage.addAccount(account(3), { kind: 'undo' })) === true);
    check('three accounts after the undo', (await storage.getAccounts()).length === 3);

    // A signed policy of one, three accounts already here, and a snapshot with
    // two more: restore has no origin to limit, by construction.
    const install = await state.ensureInstall({ reason: 'install' });
    await chrome.storage.local.set({ billingPolicy: await sign(policyPayload(install.id, 1)) });
    const restored = await storage.restoreFromSnapshot([account(30) as any, account(31) as any]);
    check('restoring a snapshot is never limited', restored.added === 2 && (await storage.getAccounts()).length === 5);
  }

  scenario('An import that does not fit is refused whole, or cut to the first K the person chose');
  {
    await resetState();
    clearBilling();
    const origin = { kind: 'user' as const, gate: { policy: { free_limit: 5, warn_at: 4, import_free: true }, entitled: false } };
    await storage.addMultipleAccounts([account(1), account(2)], USER_ADD);
    const batch = [account(1), account(10), account(11), account(12), account(13), account(14)];
    let error: any = null;
    try {
      await storage.addMultipleAccounts(batch, origin);
    } catch (e) {
      error = e;
    }
    check('refused, counting only the new ones', error instanceof gate.AccountLimitError && error.wouldAdd === 5 && error.remaining === 3);
    check('nothing written', (await storage.getAccounts()).length === 2);

    const partial = await storage.addMultipleAccounts(batch, { ...origin, take: 3 });
    const ids = (await storage.getAccounts()).map(a => a.id);
    check('exactly the first three new ones', partial.added === 3 && partial.leftOut === 2 && ids.join() === 'acc1,acc2,acc10,acc11,acc12');

    let full: unknown = null;
    try {
      await storage.importAccountList([account(20), account(21)], origin);
    } catch (e) {
      full = e;
    }
    check('a full list refuses a file import', full instanceof gate.AccountLimitError && (full as any).remaining === 0);
    const chosen = await storage.importAccountList([account(20), account(21)], { ...origin, take: 5 });
    check('and a choice of how many adds none of them', chosen.added === 0 && chosen.leftOut === 2);
    check('still five', (await storage.getAccounts()).length === 5);
  }

  scenario('A blocked import still brings its improvements to accounts already here');
  {
    await resetState();
    clearBilling();
    const origin = { kind: 'user' as const, gate: { policy: { free_limit: 2, warn_at: 1, import_free: true }, entitled: false } };
    await storage.addMultipleAccounts([account(1), account(2)], USER_ADD);
    const file = [{ ...account(1), type: 'steam', digits: 5 }, account(40)];
    let error: any = null;
    try {
      await storage.importAccountList(file, origin);
    } catch (e) {
      error = e;
    }
    check('refused, and the error knows one account would have been improved', error instanceof gate.AccountLimitError && error.updated === 1 && error.wouldAdd === 1);
    check('nothing written yet', (await storage.getAccounts()).every(a => a.type !== 'steam'));
    const only = await storage.importAccountList(file, { ...origin, take: 0 });
    const list = await storage.getAccounts();
    check('take 0 writes the improvement and no new account', only.updated === 1 && only.added === 0 && list.length === 2 && list[0].type === 'steam');
  }

  scenario('A purchase still being confirmed is asked about before the paywall opens again');
  {
    await resetState();
    clearBilling();
    const add = await import('@/billing/add');
    const bridge = await import('@/billing/bridge');
    const install = await state.ensureInstall({ reason: 'install' });
    await chrome.storage.local.set({ billingPolicy: await sign(policyPayload(install.id, 1)) });
    await storage.addAccount(account(1), USER_ADD);

    let paywalls = 0;
    const unsubscribe = bridge.subscribePaywall(request => {
      if (!request) return;
      paywalls++;
      request.resolve('closed');
    });
    const realFetch = globalThis.fetch;
    let syncs = 0;
    const entitlement = await sign(entitlementPayload(install.id, now() + 3600));
    const policy = await sign(policyPayload(install.id, 1));
    globalThis.fetch = (async (url: string) => {
      if (String(url).endsWith('/v1/sync')) syncs++;
      return new Response(JSON.stringify({ policy, entitlement, revoke: null, ack: [], next_sync_s: 86400, server_time: Date.now() }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const blocked = await add.addWithLimit('form', origin => storage.addAccount(account(2), origin));
      check('without a purchase under way the paywall opens and nothing is asked', blocked === null && paywalls === 1 && syncs === 0);

      // Hours, not minutes: a confirmation that takes a while must not end in a second purchase.
      await chrome.storage.local.set({ billingPendingCheckout: { id: 'chk_1', at: Date.now() - 5 * 3_600_000, plan: 'pro_year' } });
      const added = await add.addWithLimit('form', origin => storage.addAccount(account(2), origin));
      check('with one opened five hours ago, the server is asked first and the add goes through', added === true && syncs === 1 && paywalls === 1);
      check('two accounts', (await storage.getAccounts()).length === 2);
    } finally {
      globalThis.fetch = realFetch;
      unsubscribe();
    }
  }

  scenario('Accounts arriving through sync are never limited');
  {
    await resetState();
    clearBilling();
    await storage.addMultipleAccounts([account(1), account(2), account(3)], USER_ADD);
    await flush();
    const syncCopy = JSON.parse(JSON.stringify(areas.sync));
    await resetState();
    Object.assign(areas.sync, syncCopy);
    const install = await state.ensureInstall({ reason: 'install' });
    await chrome.storage.local.set({ billingPolicy: await sign(policyPayload(install.id, 1)) });
    check('all three synced accounts are there despite a limit of one', (await storage.getAccounts()).length === 3);
  }

  // ─── Who predates the paywall ───────────────────────────────────────────

  scenario('Legacy: updated from before billing, pre-existing data, the sync marker, a backup file');
  {
    await resetState();
    clearBilling();
    const fresh = await state.ensureInstall({ reason: 'install' });
    check('a fresh install is not legacy', !fresh.legacy && fresh.installedAt !== null);

    clearBilling();
    const updated = await state.ensureInstall({ reason: 'update', previousVersion: '1.13.3' });
    check('an update from 1.13.3 is legacy', updated.legacy && updated.legacySrc === 'update');
    check('and tells the other profiles through sync', areas.sync.billingLegacy === true);

    clearBilling();
    const laterUpdate = await state.ensureInstall({ reason: 'update', previousVersion: '1.14.0' });
    check('an update from a billing version is not', !laterUpdate.legacy);

    // A 1.14 install rolled back to 1.13.x and updated again: its record is days
    // old, so the "update from before billing" is not about this person.
    clearBilling();
    await state.ensureInstall({ reason: 'install' });
    const stored = areas.local[state.BILLING_KEYS.install] as { createdAt: number };
    stored.createdAt -= 3 * 86_400_000;
    const reupdated = await state.ensureInstall({ reason: 'update', previousVersion: '1.13.3' });
    check('a new install updated again after a rollback stays new', !reupdated.legacy);

    clearBilling();
    areas.local.lastSeenWhatsNewVersion = '1.13.3';
    const lazy = await state.ensureInstall();
    check('created lazily over old data: legacy', lazy.legacy && lazy.legacySrc === 'existing-data');
    delete areas.local.lastSeenWhatsNewVersion;

    clearBilling();
    areas.sync.billingLegacy = true;
    const marked = await state.ensureInstall({ reason: 'install' });
    check('the sync marker makes a new computer legacy', marked.legacy && marked.legacySrc === 'sync-marker');

    clearBilling();
    areas.sync.billingLegacy = true;
    await syncPref.setSyncPreference(false);
    const syncOff = await state.ensureInstall({ reason: 'install' });
    check('but not while sync is off here', !syncOff.legacy);
    await syncPref.setSyncPreference(true);

    const again = await state.markLegacy('backup-file');
    check('markLegacy turns it on once', again.legacy && again.legacySrc === 'backup-file');
    check('and never off', (await state.markLegacy('update')).legacySrc === 'backup-file');

    const ours = { version: '2.0', accountCount: 0, accounts: [] };
    check('our file from before 1.14 (no appVersion) predates it, whatever its date', legacy.backupPredatesBilling({ ...ours, exportDate: '2027-01-01T00:00:00Z' }));
    check('an encrypted one too', legacy.backupPredatesBilling({ format: 'authenticator-encrypted-backup', v: 1, exportDate: '2027-01-01T00:00:00Z' }));
    check('a file marked legacy does', legacy.backupPredatesBilling({ ...ours, exportDate: '2027-01-01T00:00:00Z', appVersion: '1.14.0', legacy: true }));
    check('a file from 1.14 on does not', !legacy.backupPredatesBilling({ ...ours, exportDate: '2026-09-01T00:00:00Z', appVersion: '1.14.0' }));
    check('a file naming an older version does', legacy.backupPredatesBilling({ ...ours, exportDate: '2027-01-01T00:00:00Z', appVersion: '1.13.3' }));
    check('an unreadable version falls back to the date', !legacy.backupPredatesBilling({ ...ours, exportDate: '2027-01-01T00:00:00Z', appVersion: 'x' }));
    check('a bare date says nothing', !legacy.backupPredatesBilling({ exportDate: '2026-09-01T00:00:00Z' }));
    const exported = JSON.parse((await import('@/utils/backup-file')).buildPlainBackupFile([]));
    check('exports now name the version that wrote them', exported.appVersion === chrome.runtime.getManifest().version, exported.appVersion);
    check('another app\'s file says nothing', !legacy.backupPredatesBilling([{ secret: 'x' }]) && !legacy.backupPredatesBilling(null));
  }

  scenario('The sync marker keeps where legacy came from, and comes back when sync is turned on again');
  {
    await resetState();
    clearBilling();
    await state.ensureInstall({ reason: 'install' });
    await state.markLegacy('backup-file');
    check('a backup-file legacy says so in sync', areas.sync.billingLegacy === 'backup-file');

    clearBilling();
    areas.sync.billingLegacy = 'backup-file';
    const fromFile = await state.ensureInstall({ reason: 'install' });
    check('and another profile reads it as such', fromFile.legacy && fromFile.legacySrc === 'backup-file');

    clearBilling();
    areas.sync.billingLegacy = true;
    await state.ensureInstall({ reason: 'install' });
    await state.writeLegacyMarker('backup-file');
    check('a stronger marker is never weakened', areas.sync.billingLegacy === true);

    clearBilling();
    const install = await state.ensureInstall({ reason: 'update', previousVersion: '1.13.3' });
    await chrome.storage.local.set({ billingEntitlement: await sign(entitlementPayload(install.id, now() + 3600)) });
    await state.writeSyncedLicenseKey('2FA-AAAA-BBBB-CCCC-DDDD-EEEE');
    check('marker and key in sync', areas.sync.billingLegacy === true && areas.sync.billingLicenseKey === '2FA-AAAA-BBBB-CCCC-DDDD-EEEE');
    await storage.setSyncEnabled(false);
    check('turning sync off takes both', !('billingLegacy' in areas.sync) && !('billingLicenseKey' in areas.sync));
    await storage.setSyncEnabled(true);
    check('turning it on puts both back', areas.sync.billingLegacy === true && areas.sync.billingLicenseKey === '2FA-AAAA-BBBB-CCCC-DDDD-EEEE');

    delete areas.sync.billingLegacy;
    await state.reassertSyncedFacts();
    check('as does the next check-in after another profile took them', areas.sync.billingLegacy === true);

    await state.writeSyncedLicenseKey(null);
    await state.reassertSyncedFacts();
    check('a key removed from this device is not put back', !('billingLicenseKey' in areas.sync) && !('billingKey' in areas.local));
  }

  // ─── What leaves the machine ────────────────────────────────────────────

  scenario('The sync request is a closed list of fields, and no account is in it');
  {
    await resetState();
    clearBilling();
    await storage.addMultipleAccounts([account(1), account(2)], USER_ADD);
    const install = await state.ensureInstall({ reason: 'install' });
    await events.track('limit_blocked', { source: 'manual', count: 2, limit: 2, secret_name: 'person1@secret-mail.example' + 'x'.repeat(100) });
    await events.track('not_an_event' as any, { x: 1 });
    const body = await sync.buildSyncRequest(install);
    const keys = Object.keys(body).sort().join(',');
    check(
      'exactly the documented fields',
      keys === 'accounts,browser_lang,events,has_key,iid,installed_at,key_hint,legacy,legacy_src,lid,open_mode,opens,pid,sync,ui_lang,vault,ver',
      keys,
    );
    check('the count, not the accounts', body.accounts === 2);
    check('the language on screen, even when none was picked', body.ui_lang === 'en', String(body.ui_lang));
    await chrome.storage.local.set({ language: 'de' });
    check('or the one picked', (await sync.buildSyncRequest(install)).ui_lang === 'de');
    await chrome.storage.local.remove('language');
    const text = JSON.stringify(body);
    // The one account-looking string is the prop this test put in an event on
    // purpose; strip it and nothing about the accounts may remain.
    const withoutProbe = text.replace(/"secret_name":"[^"]*"/, '');
    check('no account name anywhere', !withoutProbe.includes('secret-mail.example'));
    check('no issuer', !text.includes('Issuer1') && !text.includes('JBSWY3DPEHPK3P'));
    check('an unknown event name is never queued', body.events.every(e => e.n !== ('not_an_event' as any)));
    const prop = body.events[0]?.p?.secret_name;
    check('string props are cut to 64 characters', typeof prop === 'string' && prop.length === 64);
  }

  scenario('A call to the API is a simple request, so the browser sends no preflight');
  {
    const api = await import('@/billing/api');
    const realFetch = globalThis.fetch;
    let sent: RequestInit | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      sent = init;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    try {
      await api.post('/v1/sync', { iid: 'x' });
    } finally {
      globalThis.fetch = realFetch;
    }
    const headers = new Headers(sent?.headers);
    check('the body is text/plain, not application/json', headers.get('content-type') === 'text/plain', String(headers.get('content-type')));
    check('and no other header is set', [...headers.keys()].join(',') === 'content-type', [...headers.keys()].join(','));
    check('the body is still the JSON', sent?.body === '{"iid":"x"}');
  }

  scenario('Opens go out as a count per day, and only what the server took is taken off');
  {
    await resetState();
    clearBilling();
    const install = await state.ensureInstall({ reason: 'install' });
    const DAY = 86_400_000;
    const today = Date.parse('2026-10-04T10:00:00Z');
    await opens.countOpen(today - DAY);
    await opens.countOpen(today);
    await opens.countOpen(today + 60_000);
    const sent = (await sync.buildSyncRequest(install)).opens;
    check('a count per UTC day, oldest first', JSON.stringify(sent) === JSON.stringify([{ d: '2026-10-03', n: 1 }, { d: '2026-10-04', n: 2 }]), JSON.stringify(sent));
    // Opened again while the request was out: that one is still owed.
    await opens.countOpen(today + 120_000);
    await opens.ackOpens(sent);
    const left = await opens.peekOpens();
    check('what came in during the sync stays', JSON.stringify(left) === JSON.stringify([{ d: '2026-10-04', n: 1 }]), JSON.stringify(left));
    await opens.countOpen(today + 20 * DAY);
    check('days past two weeks are dropped', (await opens.peekOpens()).every(o => o.d >= '2026-10-11'));
  }

  scenario('The response is stored only if it verifies; no license from the server means none here');
  {
    await resetState();
    clearBilling();
    const install = await state.ensureInstall({ reason: 'install' });
    await events.track('paywall_view', { trigger: 'plus' });
    const queued = await events.peekEvents();
    await sync.applySyncResponse(install, {
      policy: await sign(policyPayload(install.id, 4)),
      entitlement: await sign(entitlementPayload(install.id, now() + 3600)),
      revoke: null,
      ack: queued.map(e => e.id),
      next_sync_s: 86400,
    });
    check('policy stored', (await state.readPolicy(install.id))?.free_limit === 4);
    check('license stored', (await state.readEntitlement(install.id)) !== null);
    check('acknowledged events removed', (await events.peekEvents()).length === 0);

    const forged = await sync.applySyncResponse(install, { policy: 'forged.token.here', entitlement: null, revoke: 'lic_1', ack: [], next_sync_s: 86400 });
    check('an unverifiable policy leaves the last good one', !forged && (await state.readPolicy(install.id))?.free_limit === 4);
    check('and its "no license" is not believed either', (await state.readEntitlement(install.id)) !== null);

    await sync.applySyncResponse(install, { policy: await sign(policyPayload(install.id, 4)), entitlement: null, revoke: 'lic_1', ack: [], next_sync_s: 86400 });
    check('a signed response without a license removes it', (await state.readEntitlement(install.id)) === null);
  }

  scenario('A sync answer that is not our API changes nothing and never throws');
  {
    await resetState();
    clearBilling();
    const install = await state.ensureInstall({ reason: 'install' });
    await chrome.storage.local.set({
      billingPolicy: await sign(policyPayload(install.id, 4)),
      billingEntitlement: await sign(entitlementPayload(install.id, now() + 3600)),
    });
    const realFetch = globalThis.fetch;
    const answer = (body: string) =>
      (async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    try {
      for (const [label, body] of [
        ['an HTML error page', '<html>502</html>'],
        ['an empty object', '{}'],
        ['null', 'null'],
        ['a policy without the rest', JSON.stringify({ policy: 'x' })],
      ] as const) {
        globalThis.fetch = answer(body);
        let outcome: string;
        try {
          outcome = await sync.syncBilling({ force: true, urgent: true });
        } catch {
          outcome = 'threw';
        }
        check(`${label}: a failed sync`, outcome === 'failed', outcome);
        check(`${label}: the license is still here`, (await state.readEntitlement(install.id)) !== null);
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  scenario('The key of a purchase made here is kept and offered to the other profiles');
  {
    await resetState();
    clearBilling();
    const install = await state.ensureInstall({ reason: 'install' });
    check('asks for the key while it has none', (await sync.buildSyncRequest(install)).has_key === false);
    await sync.applySyncResponse(install, {
      policy: await sign(policyPayload(install.id, 4)),
      entitlement: await sign(entitlementPayload(install.id, now() + 3600)),
      revoke: null,
      key: '2FA-ABCDE-FGHJK-MNPQR-STVWX',
      ack: [],
      next_sync_s: 86400,
    });
    check('kept here', areas.local.billingKey === '2FA-ABCDE-FGHJK-MNPQR-STVWX');
    check('and in sync for the other profiles', areas.sync.billingLicenseKey === '2FA-ABCDE-FGHJK-MNPQR-STVWX');
    check('and says so next time', (await sync.buildSyncRequest(install)).has_key === true);

    await syncPref.setSyncPreference(false);
    await state.writeSyncedLicenseKey(null);
    check('removing it with sync off leaves the sync area alone', areas.sync.billingLicenseKey === '2FA-ABCDE-FGHJK-MNPQR-STVWX' && !('billingKey' in areas.local));
    await syncPref.setSyncPreference(true);
  }

  scenario('Paywall text from the server is used only when it is plain, short and well-formed');
  {
    const read = (text: unknown) => state.readPolicyPayload(policyPayload('11111111-1111-4111-8111-111111111111', 5, { paywall: { ...policyPayload('x', 5).paywall, text } }))?.paywall.text;
    const good = read({ lang: 'de', title: 'Unbegrenzt Konten', body: 'Pro hebt das Kontolimit auf.' });
    check('a well-formed text is kept', good?.lang === 'de' && good.title === 'Unbegrenzt Konten');
    check('no text means the shipped one', read(undefined) === null);
    check('a missing body is ignored', read({ lang: 'de', title: 'x' }) === null);
    check('an overlong title is ignored', read({ lang: 'de', title: 'x'.repeat(81), body: 'ok' }) === null);
    check('a language that is not a code is ignored', read({ lang: '../x', title: 'a', body: 'b' }) === null);
    check('control characters become spaces', read({ lang: 'en', title: 'a\nb', body: 'c' })?.title === 'a b');
  }

  scenario('The event queue stays bounded');
  {
    await resetState();
    clearBilling();
    for (let i = 0; i < 205; i++) await events.track('paywall_close', { i });
    const all = (areas.local.billingEvents as unknown[]) ?? [];
    check('at most 200 kept', all.length === 200);
    check('the oldest are dropped', (all[0] as any).p.i === 5);
  }

  scenario('Prices print in the reader\'s currency rules');
  {
    check('USD', format.formatMoney(1499, 'usd', 2, 'en') === '$14.99');
    check('JPY has no minor unit', format.formatMoney(2200, 'jpy', 0, 'en').includes('2,200'));
    check(
      'yearly saving against monthly',
      format.yearlySaving(
        { kind: 'sub', interval: 'year', pass_days: null, amount: 1499, currency: 'usd', exp: 2, approx: false },
        { kind: 'sub', interval: 'month', pass_days: null, amount: 299, currency: 'usd', exp: 2, approx: false },
      ) === 58,
    );
  }

  // ─── Fourteen days without the server ───────────────────────────────────

  scenario('Fourteen days without an answer from the server: no limit until the next one');
  {
    const DAY = 86_400_000;
    const t = Date.now();
    check('just heard: the policy stands', !gate.serverSilent(t, t));
    check('thirteen days: it stands', !gate.serverSilent(t - 13 * DAY, t));
    check('fourteen: it lapses', gate.serverSilent(t - 14 * DAY, t));
    check('a last answer in the future (clock moved back) counts as now', !gate.serverSilent(t + 365 * DAY, t));
    check('no time known is not silence', !gate.serverSilent(null, t));

    await resetState();
    clearBilling();
    const install = await state.ensureInstall({ reason: 'install' });
    await chrome.storage.local.set({ billingPolicy: await sign(policyPayload(install.id, 1)) });
    check('a policy with no recorded answer is as fresh as its signature', gate.remainingSlots(await state.loadGate(), 5) === 0);

    await chrome.storage.local.set({ billingVerifiedAt: t - 15 * DAY });
    check('fifteen days since the last answer: no limit', gate.remainingSlots(await state.loadGate(), 5) === Infinity);
    await storage.addMultipleAccounts([account(1), account(2)], USER_ADD);
    check('and an add goes through', (await storage.addAccount(account(3), { kind: 'user', gate: await state.loadGate() })) === true);
    await chrome.storage.local.set({ billingVerifiedAt: t - 13 * DAY });
    check('thirteen days: the limit stands', gate.remainingSlots(await state.loadGate(), 5) === 0);

    await chrome.storage.local.remove('billingVerifiedAt');
    await chrome.storage.local.set({ billingPolicy: await sign({ ...policyPayload(install.id, 1), iat: now() - 20 * 86_400 }) });
    check('no recorded answer and a policy signed 20 days ago: no limit', gate.remainingSlots(await state.loadGate(), 5) === Infinity);

    const realFetch = globalThis.fetch;
    const policy = await sign(policyPayload(install.id, 1));
    try {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ policy, entitlement: null, revoke: null, ack: [], next_sync_s: 86400, server_time: Date.now() }), { status: 200 })) as typeof fetch;
      await sync.syncBilling({ force: true, urgent: true });
      const heard = areas.local.billingVerifiedAt as number;
      check('a verified answer records when it came', Math.abs(heard - Date.now()) < 5000);
      check('and the limit stands again', gate.remainingSlots(await state.loadGate(), 5) === 0);

      await chrome.storage.local.set({ billingVerifiedAt: Date.now() + 365 * DAY });
      check('an answer recorded in the future keeps the limit (now, not later, is the start)', gate.remainingSlots(await state.loadGate(), 5) === 0);
      globalThis.fetch = (async () => {
        throw new TypeError('offline');
      }) as typeof fetch;
      check('a failed check-in', (await sync.syncBilling({ force: true, urgent: true })) === 'failed');
      check('counts the fourteen days from now, not from the future', Math.abs((areas.local.billingVerifiedAt as number) - Date.now()) < 5000);
      check('the policy itself is untouched', (await state.readPolicy(install.id))?.free_limit === 1);
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  // ─── A second purchase's key ────────────────────────────────────────────

  scenario('A second purchase brings its new key, and it replaces the old one here and in sync');
  {
    await resetState();
    clearBilling();
    const install = await state.ensureInstall({ reason: 'install' });
    check('no key held: no hint', (await sync.buildSyncRequest(install)).key_hint === null);
    check('hints are taken from the key as the server reads it', state.licenseKeyHint('2fa abcde-fghjk mnpqr.stvwo') === 'TVW0' && state.licenseKeyHint('not a key') === null);
    await state.writeSyncedLicenseKey('2FA-ABCDE-FGHJK-MNPQR-STVWX');
    const asked = await sync.buildSyncRequest(install);
    check('a key held: its last four, and has_key for an older server', asked.key_hint === 'TVWX' && asked.has_key === true);

    const NEW_KEY = '2FA-11111-22222-33333-4444Z';
    await sync.applySyncResponse(install, {
      policy: await sign(policyPayload(install.id, 4)),
      entitlement: await sign(entitlementPayload(install.id, now() + 3600)),
      revoke: null,
      key: NEW_KEY,
      ack: [],
      next_sync_s: 86400,
    });
    check('the newly bought key replaces the old one here', areas.local.billingKey === NEW_KEY);
    check('and in sync', areas.sync.billingLicenseKey === NEW_KEY);
    check('and the next request names it', (await sync.buildSyncRequest(install)).key_hint === '444Z');
    await state.reassertSyncedFacts();
    check('the daily check-in does not put the old one back', areas.sync.billingLicenseKey === NEW_KEY);
  }

  // ─── Legacy from accounts that came through sync ────────────────────────

  scenario('Legacy: accounts in Chrome sync made before billing — another computer that never ran 1.14');
  {
    const config = await import('@/billing/config');
    const cutoff = config.BILLING_RELEASE_DATE;
    // Before the release date and before any install made in this run.
    const before = Math.min(cutoff, Date.now()) - 86_400_000;
    const after = cutoff + 86_400_000;
    const plain = (id: string, createdAt?: number) => ({
      id,
      name: 'old@example.com',
      issuer: 'Old',
      secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      ...(createdAt === undefined ? {} : { createdAt }),
    });
    check('an account made before release', state.syncedAccountsPredate([plain('a1', before)], undefined, cutoff));
    check('one with no date at all', state.syncedAccountsPredate([plain('a2')], undefined, cutoff));
    check('not one made after', !state.syncedAccountsPredate([plain('a3', after)], undefined, cutoff));
    check(
      'not an old date on an account that came in after it (a CXF import keeps the other app\'s date)',
      !state.syncedAccountsPredate([plain(`cxf-${after}-0-0-abc123`, before)], undefined, cutoff),
    );
    check('but an old one with an old id', state.syncedAccountsPredate([plain(`${before}0x1y2z`, before)], undefined, cutoff));
    const sealed = { id: 's1', fp: 'fp', enc: 'v1.x.y', v: 'vault-1' };
    check('sealed accounts under a vault made before release', state.syncedAccountsPredate([sealed], { vaultId: 'vault-1', createdAt: before }, cutoff));
    check('not under a vault made after', !state.syncedAccountsPredate([sealed], { vaultId: 'vault-1', createdAt: after }, cutoff));
    check('not another vault\'s records', !state.syncedAccountsPredate([{ ...sealed, v: 'vault-2' }], { vaultId: 'vault-1', createdAt: before }, cutoff));
    check('nothing there says nothing', !state.syncedAccountsPredate([], undefined, cutoff) && !state.syncedAccountsPredate([null, 3, 'x'], null, cutoff));
    check('the worker reacts to account chunks and the vault, not to other keys', state.touchesSyncedAccounts({ authenticator_accounts_0: {} }) && state.touchesSyncedAccounts({ vault_meta: {} }) && !state.touchesSyncedAccounts({ billingLegacy: {} }));

    await resetState();
    clearBilling();
    areas.sync.authenticator_accounts_0 = [plain('old', before)];
    const fresh = await state.ensureInstall({ reason: 'install' });
    check('a fresh install over old synced accounts is legacy', fresh.legacy && fresh.legacySrc === 'sync-accounts');
    check('the request names the new source', (await sync.buildSyncRequest(fresh)).legacy_src === 'sync-accounts');
    // The worker checks in at install time, before a new computer's synced
    // accounts arrive: counting must not start sync's download window.
    delete areas.local.syncFirstReadAt;
    await sync.buildSyncRequest(fresh);
    check('a check-in does not start the sync download window', areas.local.syncFirstReadAt === undefined);
    check('the marker says what it is', areas.sync.billingLegacy === 'sync-accounts');
    await state.writeLegacyMarker('backup-file');
    check('a backup file does not weaken it', areas.sync.billingLegacy === 'sync-accounts');
    await state.writeLegacyMarker('update');
    check('an update strengthens it', areas.sync.billingLegacy === true);

    clearBilling();
    areas.sync.billingLegacy = 'sync-accounts';
    const marked = await state.ensureInstall({ reason: 'install' });
    check('another profile reads that marker as such', marked.legacy && marked.legacySrc === 'sync-accounts');

    await resetState();
    clearBilling();
    areas.sync.authenticator_accounts_0 = [plain('new', after)];
    check('accounts made after release do not', !(await state.ensureInstall({ reason: 'install' })).legacy);

    clearBilling();
    areas.sync.authenticator_accounts_0 = [plain('old', before)];
    await syncPref.setSyncPreference(false);
    check('nor do old ones while sync is off here', !(await state.ensureInstall({ reason: 'install' })).legacy);
    await syncPref.setSyncPreference(true);

    // The install's own accounts reach sync too. Before release day (or with
    // the clock behind) they are "made before the release date", and must not
    // make a new user an old one.
    await resetState();
    clearBilling();
    const mine = await state.ensureInstall({ reason: 'install' });
    areas.sync.authenticator_accounts_0 = [plain('mine', mine.createdAt + 1_000)];
    check('an install\'s own new account is not old, even before release day', !(await state.syncedAccountsPredateBilling(mine.createdAt, mine.createdAt + 30 * 86_400_000)));
    areas.sync.authenticator_accounts_0 = [plain('theirs', mine.createdAt - 60_000)];
    check('one made before the install came to be still is', await state.syncedAccountsPredateBilling(mine.createdAt, mine.createdAt + 30 * 86_400_000));
  }

  // ─── A blocked add, kept through Checkout ───────────────────────────────

  scenario('A blocked add that went to Checkout is kept in memory and added once Pro is on');
  {
    await resetState();
    clearBilling();
    const add = await import('@/billing/add');
    const bridge = await import('@/billing/bridge');
    const held = await import('@/billing/held-add');
    const install = await state.ensureInstall({ reason: 'install' });
    await chrome.storage.local.set({ billingPolicy: await sign(policyPayload(install.id, 1)) });
    await storage.addAccount(account(1), USER_ADD);

    // The paywall as the person uses it: Continue, Checkout opens.
    const unsubscribe = bridge.subscribePaywall(request => {
      if (!request) return;
      void (async () => {
        await request.beforeCheckout?.();
        request.resolve('checkout');
      })();
    });
    const typed = account(2);
    let result: boolean | null;
    try {
      result = await add.addWithLimit('form', origin => storage.addAccount(typed, origin), { hold: [typed] });
    } finally {
      unsubscribe();
    }
    check('the add itself stops at the paywall', result === null && (await storage.getAccounts()).length === 1);
    check('the account is kept in session storage', JSON.stringify(areas.session).includes(typed.secret));
    check('and nowhere on disk or in sync', !JSON.stringify(areas.local).includes(typed.secret) && !JSON.stringify(areas.sync).includes(typed.secret));
    check('without Pro nothing is added', (await held.finishHeldAdd()) === null && (await storage.getAccounts()).length === 1);
    check('and it waits', await held.isHeld([typed.id]));
    const told = await held.heldAddToMention();
    check('the person is told it is waiting — once', told?.[0]?.id === typed.id && (await held.heldAddToMention()) === null);

    await chrome.storage.local.set({ billingEntitlement: await sign(entitlementPayload(install.id, now() + 3600)) });
    const done = await held.finishHeldAdd();
    check('with Pro it goes in, through storage', done?.added === 1 && (await storage.getAccounts()).some(a => a.secret === typed.secret));
    check('once', (await held.finishHeldAdd()) === null && !(await held.isHeld([typed.id])) && !('billingHeldAdd' in areas.session));

    // Added meanwhile by hand: the same seed is not added twice.
    await held.holdBlockedAdd([account(3)]);
    await storage.addAccount({ ...account(3), id: 'typed-again' }, { kind: 'user', gate: await state.loadGate() });
    const again = await held.finishHeldAdd();
    check('a seed already in the list is not added again', again?.added === 0 && (await storage.getAccounts()).filter(a => a.secret === account(3).secret).length === 1);

    await held.holdBlockedAdd([account(4)]);
    (areas.session.billingHeldAdd as { at: number }).at = Date.now() - 25 * 3_600_000;
    check('after a day it is dropped, not added', (await held.finishHeldAdd()) === null && !(await storage.getAccounts()).some(a => a.id === 'acc4') && !('billingHeldAdd' in areas.session));

    await held.holdBlockedAdd([account(5)]);
    await held.dismissHeldAdd();
    check('dismissed, it is not added', (await held.finishHeldAdd()) === null && !(await storage.getAccounts()).some(a => a.id === 'acc5'));

    await held.holdBlockedAdd([account(6)]);
    await held.holdBlockedAdd([account(7)]);
    check('a later blocked add replaces the earlier one', (await held.isHeld(['acc7'])) && !(await held.isHeld(['acc6'])));
    await held.dismissHeldAdd();

    const closed = bridge.subscribePaywall(request => request?.resolve('closed'));
    try {
      await add.addWithLimit('form', origin => storage.addAccount(account(8), origin), { hold: [account(8)] });
    } finally {
      closed();
    }
    check('a paywall simply closed keeps nothing', !('billingHeldAdd' in areas.session));
  }

  scenario('Under password protection the kept account is sealed, and waits for the unlock');
  {
    await resetState();
    clearBilling();
    const vault = await import('@/utils/vault');
    const held = await import('@/billing/held-add');
    const PASSWORD = 'correct horse battery staple';
    await (await storage.prepareVault(PASSWORD)).commit();
    const install = await state.ensureInstall({ reason: 'install' });
    await held.holdBlockedAdd([account(9)]);
    const record = areas.session.billingHeldAdd as Record<string, unknown> | undefined;
    check('sealed with the vault\'s key: no secret, name or issuer readable', !!record?.sealed && !JSON.stringify(record).includes(account(9).secret) && !JSON.stringify(record).includes('Issuer9'));

    await chrome.storage.local.set({ billingEntitlement: await sign(entitlementPayload(install.id, now() + 3600)) });
    await vault.lock();
    check('locked, Pro on: it waits', (await held.finishHeldAdd()) === null && (await held.isHeld(['acc9'])));
    await vault.unlockWithPassword(PASSWORD);
    const done = await held.finishHeldAdd();
    check('unlocked: it goes in', done?.added === 1 && (await storage.getAccounts()).some(a => a.id === 'acc9'));
  }

  // ─── Checkout ───────────────────────────────────────────────────────────

  scenario('Checkout: a changed price is never retried, and what must outlive the popup is written before the tab opens');
  {
    await resetState();
    clearBilling();
    const actions = await import('@/billing/actions');
    const api = await import('@/billing/api');
    const install = await state.ensureInstall({ reason: 'install' });
    const policy = await sign(policyPayload(install.id, 1));
    const realFetch = globalThis.fetch;
    const realTabs = (chrome as any).tabs;
    const calls: string[] = [];
    let checkoutAnswer: () => Response = () => new Response('{}', { status: 500 });
    globalThis.fetch = (async (url: string) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      if (path === '/v1/checkout') return checkoutAnswer();
      return new Response(JSON.stringify({ policy, entitlement: null, revoke: null, ack: [], next_sync_s: 86400, server_time: Date.now() }), { status: 200 });
    }) as typeof fetch;
    const order: string[] = [];
    (chrome as any).tabs = {
      create: async () => {
        order.push(`tab:${'billingPendingCheckout' in areas.local}`);
        return {};
      },
    };
    try {
      checkoutAnswer = () => new Response(JSON.stringify({ error: 'price_changed' }), { status: 409 });
      let error: unknown = null;
      try {
        await actions.startCheckout('pro_year', 'form', { beforeOpen: async () => void order.push('before') });
      } catch (e) {
        error = e;
      }
      check('price_changed reaches the paywall', error instanceof api.BillingApiError && error.code === 'price_changed');
      check('with no second try, no tab and no pending purchase', calls.join() === '/v1/checkout' && order.length === 0 && !('billingPendingCheckout' in areas.local));

      calls.length = 0;
      let first = true;
      checkoutAnswer = () => {
        if (first) {
          first = false;
          return new Response(JSON.stringify({ error: 'unknown_install' }), { status: 404 });
        }
        return new Response(JSON.stringify({ url: 'https://checkout.stripe.com/c/pay/cs_test_1', checkout_id: 'co_1' }), { status: 200 });
      };
      await actions.startCheckout('pro_year', 'form', { beforeOpen: async () => void order.push('before') });
      check('an install the server has not seen yet is retried once, after a check-in', calls.join() === '/v1/checkout,/v1/sync,/v1/checkout', calls.join());
      check('the pending mark and the caller\'s writes come before the tab', order.join() === 'before,tab:true', order.join());
      const queued = (await events.peekEvents()).map(e => e.n);
      check('checkout_open is queued before the tab too', queued.includes('checkout_open'));
    } finally {
      globalThis.fetch = realFetch;
      (chrome as any).tabs = realTabs;
    }
  }

  scenario('A popup about to close hands its check-in to the service worker');
  {
    const realSend = (chrome.runtime as any).sendMessage;
    const sent: unknown[] = [];
    try {
      (chrome.runtime as any).sendMessage = (message: unknown) => {
        sent.push(message);
        return new Promise(() => {});
      };
      const started = Date.now();
      await sync.syncFromWorker();
      check('the worker is asked', sent.length === 1 && sync.isSyncRequestMessage(sent[0]));
      check('and one that does not answer holds the tab back a moment at most', Date.now() - started < 1000);
      (chrome.runtime as any).sendMessage = () => {
        throw new Error('Could not establish connection. Receiving end does not exist.');
      };
      let threw = false;
      try {
        await sync.syncFromWorker();
      } catch {
        threw = true;
      }
      check('no worker to ask is not an error', !threw);
    } finally {
      (chrome.runtime as any).sendMessage = realSend;
    }
  }

  // The server picks a copy variant by name, but the words ship with the build:
  // a variant missing from a language would show that reader a blank heading.
  scenario('Every paywall copy variant is written in every language');
  {
    const { COPY } = await import('@/components/Paywall');
    const { languages } = await import('@/utils/i18n');
    const en = (await import('@/utils/locales/en')).default as unknown as Record<string, string>;
    const keys = Object.values(COPY).flatMap(({ title, body }) => [title, body]);
    check('the variants the server tests are all here', ['default', 'support', 'private', 'everything'].every((name) => name in COPY));

    const missing: string[] = [];
    const untranslated: string[] = [];
    for (const { code } of languages) {
      const table = (await import(`../src/utils/locales/${code}.ts`)).default as Record<string, string>;
      for (const key of keys) {
        if (!table[key]?.trim()) missing.push(`${code} ${key}`);
        else if (code !== 'en' && table[key] === en[key]) untranslated.push(`${code} ${key}`);
      }
    }
    check('every title and body exists in every locale', missing.length === 0, missing.join(', '));
    check('and none is left in English', untranslated.length === 0, untranslated.join(', '));
  }
}
