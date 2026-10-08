// The free limit in a real browser: a policy signed by the (test) billing
// key arrives, the add screen opens as always and says nothing of a limit,
// Add meets the paywall once the account is typed, and a license key turns
// Pro on and lets that same account through.
//
// The billing server is played by route handlers answering on the address the
// e2e build is pointed at (package.json build:e2e), signing with the test key
// under test/fixtures — so the extension verifies real signatures, exactly as
// it does against the production server. Everything else stays cut off, as
// in the rest of the suite; the other specs, which never see a policy, are
// the proof that no server means no limit.

import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import type { BrowserContext, Page, Route, Worker } from '@playwright/test';
import { addAccountByHand, cards, deleteByHand, expect, openPage, otherSecret, test } from './fixtures';

const API = 'http://127.0.0.1:3199';
const KEY = JSON.parse(readFileSync(new URL('../test/fixtures/billing-test-key.json', import.meta.url), 'utf8'));
const GOOD_KEY = '2FA-ABCDE-FGHJK-MNPQR-STVWX';

const b64url = (data: Uint8Array | string) =>
  Buffer.from(typeof data === 'string' ? Buffer.from(data, 'utf8') : data)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

let signingKey: webcrypto.CryptoKey | null = null;
async function sign(payload: Record<string, unknown>): Promise<string> {
  signingKey ??= await webcrypto.subtle.importKey('jwk', KEY.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const h = b64url(JSON.stringify({ alg: 'ES256', kid: KEY.kid, typ: 'JWT' }));
  const p = b64url(JSON.stringify(payload));
  const s = new Uint8Array(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signingKey, new TextEncoder().encode(`${h}.${p}`)));
  return `${h}.${p}.${b64url(s)}`;
}

interface MockState {
  freeLimit: number | null;
  /** Prices in dollars that Checkout converts (no exact local price for the install's country). */
  approx?: boolean;
  licensed: Set<string>;
  syncs: Array<Record<string, unknown>>;
  /** Addresses a lost key was asked for, in order. */
  recovers?: string[];
  /** The yearly price the policy shows, in cents (14.99 by default). */
  yearAmount?: number;
  /** Checkouts asked for, in order. */
  checkouts?: Array<{ plan: string; trigger: unknown }>;
  /** The next checkout is refused: the price moved to this many cents since the last policy. */
  priceMovesTo?: number;
  /** No plans in the policy: a country where no one can pay. */
  noPlans?: boolean;
  /** Cloud backup copies the server holds, oldest first (one license for every install here). */
  backups?: Array<{ id: string; iid: string; kid: string; data: string; at: number }>;
  /** The license's current backup code, as the server keeps it (kid and auth); null = off. */
  backupKey?: { kid: string; auth: string } | null;
}

async function mockBilling(context: BrowserContext, state: MockState): Promise<void> {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  const now = () => Math.floor(Date.now() / 1000);
  const entitlement = (iid: string) =>
    sign({ typ: 'ent', v: 1, lid: 'lic_e2e', kind: 'life', features: ['unlimited_accounts', 'cloud_backup'], until: null, key_hint: 'VWX', sub: iid, iat: now(), exp: now() + 86_400 });

  // Registered after the fixture's catch-all abort, so it is consulted first.
  await context.route(`${API}/**`, async (route: Route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const path = new URL(request.url()).pathname;
    const body = request.postDataJSON() as Record<string, unknown>;
    const json = (status: number, data: unknown) =>
      route.fulfill({ status, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

    if (path === '/v1/sync') {
      state.syncs.push(body);
      const iid = String(body.iid);
      const policy = await sign({
        typ: 'policy',
        v: 1,
        pid: `pol_e2e_${state.freeLimit}`,
        sub: iid,
        iat: now(),
        free_limit: state.freeLimit,
        warn_at: state.freeLimit === null ? null : Math.max(0, state.freeLimit - 1),
        paywall: { copy: 'default', plans: state.noPlans ? [] : ['pro_year', 'pro_life'], default_plan: 'pro_year', trial_days: 0, promo_codes: false },
        prices: state.noPlans
          ? {}
          : {
              pro_year: { kind: 'sub', interval: 'year', pass_days: null, amount: state.yearAmount ?? 1499, currency: 'usd', exp: 2, approx: !!state.approx },
              pro_life: { kind: 'life', interval: null, pass_days: null, amount: 2999, currency: 'usd', exp: 2, approx: !!state.approx },
            },
        ui: { pro_in_settings: false, import_partial: true },
        exps: [],
      });
      const events = Array.isArray(body.events) ? (body.events as Array<{ id: string }>) : [];
      return json(200, {
        policy,
        entitlement: state.licensed.has(iid) ? await entitlement(iid) : null,
        revoke: null,
        ack: events.map((e) => e.id),
        next_sync_s: 86_400,
        server_time: Date.now(),
      });
    }
    if (path === '/v1/license/activate') {
      const iid = String(body.iid);
      const key = String(body.key).toUpperCase().replace(/[\s-]/g, '');
      if (key !== GOOD_KEY.replace(/-/g, '')) return json(404, { error: 'invalid_key' });
      state.licensed.add(iid);
      return json(200, { entitlement: await entitlement(iid) });
    }
    if (path === '/v1/license/recover') {
      (state.recovers ??= []).push(String(body.email));
      return json(200, { ok: true });
    }
    if (path === '/v1/checkout') {
      const checkouts = (state.checkouts ??= []);
      checkouts.push({ plan: String(body.plan), trigger: body.trigger });
      if (state.priceMovesTo !== undefined) {
        state.yearAmount = state.priceMovesTo;
        state.priceMovesTo = undefined;
        return json(409, { error: 'price_changed' });
      }
      return json(200, { url: `${API}/checkout/cs_test_${checkouts.length}`, checkout_id: `co_${checkouts.length}` });
    }
    if (path.startsWith('/v1/backup/')) {
      const backups = (state.backups ??= []);
      const iid = String(body.iid);
      // The license key finds the license's copies from an install that holds none (a new profile).
      const byKey = typeof body.key === 'string' && body.key.toUpperCase().replace(/[\s-]/g, '') === GOOD_KEY.replace(/-/g, '');
      if (!state.licensed.has(iid) && !byKey) return json(404, { error: 'no_license' });
      if (path === '/v1/backup/upload') {
        const kid = String(body.kid);
        const auth = String(body.auth);
        if (!state.backupKey) {
          if (!body.claim) return json(409, { error: 'backup_off' });
          state.backupKey = { kid, auth };
        } else if (state.backupKey.kid !== kid || state.backupKey.auth !== auth) {
          return json(409, { error: 'backup_wrong_code' });
        }
        const copy = { id: `bkp_${backups.length + 1}`, iid, kid, data: String(body.data), at: Date.now() };
        backups.push(copy);
        return json(200, { id: copy.id, created_at: copy.at });
      }
      if (path === '/v1/backup/list') {
        return json(200, {
          kid: state.backupKey?.kid ?? null,
          backups: [...backups].reverse().map((b) => ({ id: b.id, created_at: b.at, bytes: b.data.length, kid: b.kid, this_device: b.iid === iid })),
        });
      }
      if (path === '/v1/backup/get') {
        if (!state.backupKey) return json(404, { error: 'backup_not_found' });
        if (state.backupKey.auth !== String(body.auth)) return json(409, { error: 'backup_wrong_code' });
        const copy = backups.find((b) => b.id === body.id);
        return copy ? json(200, { id: copy.id, created_at: copy.at, kid: copy.kid, data: copy.data }) : json(404, { error: 'backup_not_found' });
      }
      if (path === '/v1/backup/delete') {
        if (state.backupKey && state.backupKey.auth !== String(body.auth)) return json(409, { error: 'backup_wrong_code' });
        const deleted = backups.length;
        backups.length = 0;
        state.backupKey = null;
        return json(200, { deleted });
      }
    }
    // The Checkout page itself: anything will do.
    if (path.startsWith('/checkout/')) return route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Checkout</title>' });
    return json(404, { error: 'bad_request' });
  });
}

/** Makes the popup check in now, as it would on its first open of the day. */
async function syncNow(page: Page): Promise<void> {
  // The service worker checks in at startup too, and Playwright's routes do not
  // reach it: its request fails, and it can record that failure (and a 15-minute
  // back-off) just after this cleared the record. So clear and reload until the
  // page's own check-in has landed.
  await expect
    .poll(
      async () => {
        const has = await page.evaluate(async () => !!(await chrome.storage.local.get('billingPolicy')).billingPolicy);
        if (!has) {
          await page.evaluate(() => chrome.storage.local.remove('billingLastSync'));
          await page.reload();
        }
        return has;
      },
      { timeout: 20_000, intervals: [250, 1000, 2000] },
    )
    .toBe(true);
}

/**
 * Types an account into the add screen and presses Add, with no room left.
 * Nothing on the way mentions the limit; the paywall opens over the form.
 */
/**
 * What the action popup does as Checkout opens: the browser closes it the
 * moment the new tab takes focus. A popup.html opened in a tab would live on,
 * so here the tab is opened and the page removed, and nothing that would have
 * run after the tab opened ever does.
 */
async function closeWhenCheckoutOpens(page: Page): Promise<void> {
  await page.evaluate(() => {
    const create = chrome.tabs.create.bind(chrome.tabs);
    Object.defineProperty(chrome.tabs, 'create', {
      configurable: true,
      writable: true,
      value: (properties: chrome.tabs.CreateProperties) => {
        void create(properties);
        void chrome.tabs.getCurrent().then((tab) => {
          if (tab?.id !== undefined) void chrome.tabs.remove(tab.id);
        });
        return new Promise(() => {});
      },
    });
  });
}

/** The install id, as the extension minted it. */
async function installId(page: Page): Promise<string> {
  return page.evaluate(async () => ((await chrome.storage.local.get('billingInstall')).billingInstall as { id: string }).id);
}

/**
 * Opens the popup again and checks in until `done` holds. The service worker's
 * own check-in, which Playwright's routes cannot answer, may just have used up
 * the spacing between forced syncs; the popup's next one goes through.
 */
async function reopenUntil(context: BrowserContext, extensionId: string, done: (page: Page) => Promise<boolean>): Promise<Page> {
  const page = await openPage(context, extensionId, 'popup.html');
  await expect
    .poll(
      async () => {
        if (await done(page)) return true;
        await page.evaluate(() => chrome.storage.local.remove('billingLastSync'));
        await page.reload();
        return false;
      },
      { timeout: 20_000, intervals: [500, 1000, 2000] },
    )
    .toBe(true);
  return page;
}

/** Every billing event this install has recorded: still queued, or already received by the server. */
async function eventsSeen(worker: Worker, state: MockState): Promise<string[]> {
  const queued = (await worker.evaluate(async () => (await chrome.storage.local.get('billingEvents')).billingEvents ?? [])) as Array<{ n: string; p?: { result?: string } }>;
  const sent = state.syncs.flatMap((s) => (Array.isArray(s.events) ? (s.events as Array<{ n: string; p?: { result?: string } }>) : []));
  return [...queued, ...sent].map((e) => (e.p?.result ? `${e.n}:${e.p.result}` : e.n));
}

async function addOverLimit(page: Page, name: string, secret: string) {
  await page.getByRole('button', { name: 'Add Account', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add Account' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/free account/)).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Manual', exact: true }).click();
  await dialog.getByLabel('Account Name').fill(name);
  await dialog.getByLabel('Secret Key').fill(secret);
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  const paywall = page.getByRole('dialog', { name: 'Protect every account you sign in to' });
  await expect(paywall).toBeVisible();
  return { dialog, paywall };
}

test.afterEach(({ pageErrors }) => {
  expect(pageErrors, 'uncaught exceptions on extension pages').toEqual([]);
});

test('at the limit, Add opens the paywall; a license key turns Pro on and the typed account goes in', async ({ context, extensionId }) => {
  const state: MockState = { freeLimit: 1, licensed: new Set(), syncs: [] };
  await mockBilling(context, state);

  const page = await openPage(context, extensionId, 'popup.html');
  await syncNow(page);

  // What left the machine: the count, never the accounts.
  const lastSync = state.syncs[state.syncs.length - 1]!;
  expect(Object.keys(lastSync).sort()).toEqual(
    ['accounts', 'browser_lang', 'dark', 'events', 'has_key', 'iid', 'installed_at', 'key_hint', 'legacy', 'legacy_src', 'lid', 'open_mode', 'opens', 'pid', 'style', 'sync', 'ui_lang', 'vault', 'ver'].sort()
  );

  await addAccountByHand(page, 'first@example.com', otherSecret(1));

  const { dialog, paywall } = await addOverLimit(page, 'second@example.com', otherSecret(2));
  // A single blocked add is not counted at the person: no "holds 1, you have 1".
  await expect(paywall.getByText(/free plan holds/)).toHaveCount(0);
  // What Pro gives, as the buyer gains it. No seat count, and no trust line under the button (both gone 2026-10-08).
  for (const benefit of ['As many accounts as you need', "We can't see your keys", 'Encrypted backup in the cloud']) await expect(paywall.getByText(benefit)).toBeVisible();
  await expect(paywall.getByText(/up to 5 browsers|never leave your browser/)).toHaveCount(0);
  await expect(paywall.getByRole('radio', { name: /Yearly/ })).toHaveAttribute('aria-checked', 'true');
  await expect(paywall.getByRole('radio', { name: /Yearly/ })).toContainText('$14.99 / year');
  // The button that pays names what it charges: in a short window it is on
  // screen while the plans are not.
  await expect(paywall.getByRole('button', { name: /^Continue/ })).toContainText('$14.99 / year');

  // The existing account is still there, untouched, behind the paywall.
  expect(await cards(page).count()).toBe(1);

  await paywall.getByRole('button', { name: 'I have a license key' }).click();
  const keyField = paywall.getByRole('textbox', { name: 'I have a license key' });
  await keyField.fill('2FA-WRONG-WRONG-WRONG-WRONG');
  await paywall.getByRole('button', { name: 'Activate' }).click();
  await expect(paywall.getByRole('alert')).toHaveText('That key was not recognised. Check it and try again.');

  await keyField.fill(GOOD_KEY.toLowerCase());
  await paywall.getByRole('button', { name: 'Activate' }).click();
  await expect(paywall).toBeHidden();

  // Pro is on: the account typed before the paywall goes in without typing it again.
  await expect(dialog).toBeHidden();
  await expect(cards(page)).toHaveCount(2);
  await expect(page.getByText('second@example.com')).toBeVisible();

  // And it holds after a reload, from the signed token alone.
  await page.reload();
  await expect(cards(page)).toHaveCount(2);
  await addAccountByHand(page, 'third@example.com', otherSecret(3));
});

test('closing the paywall adds nothing and leaves every account working', async ({ context, extensionId }) => {
  const state: MockState = { freeLimit: 1, licensed: new Set(), syncs: [] };
  await mockBilling(context, state);
  const page = await openPage(context, extensionId, 'popup.html');
  await syncNow(page);
  await addAccountByHand(page, 'only@example.com', otherSecret(4));

  const { dialog, paywall } = await addOverLimit(page, 'more@example.com', otherSecret(6));
  // The check-in on open has just run; the one the close makes is a day later here.
  await page.evaluate(() => chrome.storage.local.remove('billingLastSync'));
  const syncsBefore = state.syncs.length;
  await paywall.getByRole('button', { name: 'Close' }).click();
  await expect(paywall).toBeHidden();
  // Back on the add screen with what was typed, nothing saved.
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Account Name')).toHaveValue('more@example.com');
  await dialog.getByRole('button', { name: 'Back' }).click();
  await expect(dialog).toBeHidden();
  await expect(cards(page)).toHaveCount(1);
  await expect(page.getByTestId('account-code')).toHaveText(/^\d{3} \d{3}$/);

  // The events of that visit reach the server as the paywall closes, not with tomorrow's check-in.
  await expect
    .poll(() => state.syncs.slice(syncsBefore).flatMap((s) => (s.events as Array<{ n: string; p?: { result?: string } }>) ?? []).map((e) => (e.p?.result ? `${e.n}:${e.p.result}` : e.n)))
    .toEqual(expect.arrayContaining(['limit_blocked', 'paywall_view', 'paywall_close:closed']));
  // And nothing was kept for later: closing is not buying.
  expect(await page.evaluate(async () => Object.keys(await chrome.storage.session.get('billingHeldAdd')))).toEqual([]);
});

test('in the popup Checkout closes the page; the account typed before it goes in by itself once Pro is on', async ({ context, extensionId, serviceWorker }) => {
  const state: MockState = { freeLimit: 1, licensed: new Set(), syncs: [] };
  await mockBilling(context, state);
  const page = await openPage(context, extensionId, 'popup.html');
  await syncNow(page);
  await addAccountByHand(page, 'first@example.com', otherSecret(30));
  const iid = await installId(page);

  const { paywall } = await addOverLimit(page, 'second@example.com', otherSecret(31));
  await closeWhenCheckoutOpens(page);
  const gone = page.waitForEvent('close');
  await paywall.getByRole('button', { name: /^Continue/ }).click();
  await gone;
  expect(state.checkouts).toEqual([{ plan: 'pro_year', trigger: 'form' }]);

  // Written before the tab opened, the only time a popup can: the close says how it closed.
  await expect
    .poll(() => eventsSeen(serviceWorker, state))
    .toEqual(expect.arrayContaining(['limit_blocked', 'paywall_view', 'plan_select', 'checkout_open', 'paywall_close:checkout']));

  // Paid. The next time the popup opens, the purchase is found and the account is there, untyped.
  state.licensed.add(iid);
  const popup = await reopenUntil(context, extensionId, async (p) => (await cards(p).count()) === 2);
  await expect(popup.getByText('second@example.com', { exact: true })).toBeVisible();
  // The "has been added" toast shows in whichever window finished the add —
  // with Pro arriving through the worker that can be one reopenUntil already
  // closed — so what is checked is the outcome: added, and nothing still held.
  expect(await popup.evaluate(async () => Object.keys(await chrome.storage.session.get('billingHeldAdd')))).toEqual([]);

  // Once.
  await popup.reload();
  await expect(cards(popup)).toHaveCount(2);
  await expect(popup.getByText(/has been added/)).toHaveCount(0);
});

test('a kept account waits for Pro, says so once, and can be let go', async ({ context, extensionId }) => {
  const state: MockState = { freeLimit: 1, licensed: new Set(), syncs: [] };
  await mockBilling(context, state);
  const page = await openPage(context, extensionId, 'popup.html');
  await syncNow(page);
  await addAccountByHand(page, 'first@example.com', otherSecret(32));
  const iid = await installId(page);
  const { paywall } = await addOverLimit(page, 'second@example.com', otherSecret(33));
  await closeWhenCheckoutOpens(page);
  const gone = page.waitForEvent('close');
  await paywall.getByRole('button', { name: /^Continue/ }).click();
  await gone;

  // Back without paying.
  const popup = await openPage(context, extensionId, 'popup.html');
  await expect(popup.getByText('second@example.com will be added as soon as Pro is on.')).toBeVisible();
  await popup.getByRole('button', { name: "Don't add" }).click();
  await popup.reload();
  await expect(cards(popup)).toHaveCount(1);
  await expect(popup.getByText(/will be added as soon as Pro is on/)).toHaveCount(0);

  // Pro comes later after all: what was let go stays gone.
  state.licensed.add(iid);
  const after = await reopenUntil(context, extensionId, async (p) =>
    p.evaluate(async () => !!(await chrome.storage.local.get('billingEntitlement')).billingEntitlement)
  );
  await after.waitForTimeout(500);
  await expect(cards(after)).toHaveCount(1);
});

test('a price that changed since the paywall opened is shown, never charged in silence', async ({ context, extensionId }) => {
  const state: MockState = { freeLimit: 1, licensed: new Set(), syncs: [] };
  await mockBilling(context, state);
  const page = await openPage(context, extensionId, 'popup.html');
  await syncNow(page);
  await addAccountByHand(page, 'first@example.com', otherSecret(34));
  const { paywall } = await addOverLimit(page, 'second@example.com', otherSecret(35));
  const continueButton = paywall.getByRole('button', { name: /^Continue/ });
  await expect(continueButton).toContainText('$14.99 / year');

  state.priceMovesTo = 1999;
  await continueButton.click();
  await expect(paywall.getByRole('alert')).toHaveText('The price has been updated. Check it and press Continue again.');
  // The new price, from a fresh policy, on the plan and on the button.
  await expect(paywall.getByRole('radio', { name: /Yearly/ })).toContainText('$19.99 / year');
  await expect(continueButton).toContainText('$19.99 / year');
  expect(state.checkouts).toHaveLength(1);
  expect(context.pages().some((p) => p.url().includes('/checkout/'))).toBe(false);

  // Pressed again, at the price on screen: Checkout opens. (Its tab, made by
  // the extension, starts loading before the routes reach it, so what it shows
  // is not the point; that it was asked for and the paywall made way is.)
  const tab = context.waitForEvent('page');
  await continueButton.click();
  await tab;
  await expect(paywall).toBeHidden();
  await expect(page.getByText('Checkout is open in a new tab.', { exact: false })).toBeVisible();
  expect(state.checkouts).toHaveLength(2);
});

test('asking for a lost key by email is answered where the form was, with nothing left to press again', async ({ context, extensionId }) => {
  const state: MockState = { freeLimit: 1, licensed: new Set(), syncs: [] };
  await mockBilling(context, state);
  const page = await openPage(context, extensionId, 'popup.html');
  // The popup's own size: the form opens below everything else on the screen.
  await page.setViewportSize({ width: 400, height: 600 });
  await syncNow(page);
  await addAccountByHand(page, 'only@example.com', otherSecret(5));

  const { paywall } = await addOverLimit(page, 'more@example.com', otherSecret(6));
  await paywall.getByRole('button', { name: 'Restore a purchase' }).click();
  await paywall.getByRole('textbox', { name: 'Restore a purchase' }).fill('buyer@example.com');
  await paywall.getByRole('button', { name: 'Send' }).click();

  // It used to be printed above the form, off screen in a popup, and the
  // button stayed: it looked as if nothing had happened, so it was pressed again.
  const sent = paywall.getByRole('status');
  await expect(sent).toContainText('If that email bought Pro, the key is on its way.');
  await expect(sent).toContainText('buyer@example.com');
  await expect(sent).toBeInViewport({ ratio: 0.95 });
  await expect(paywall.getByRole('button', { name: 'Send' })).toHaveCount(0);
  expect(state.recovers).toEqual(['buyer@example.com']);
});

test('dollar prices that Checkout will convert carry no note, like exact ones (owner, 2026-10-04)', async ({ context, extensionId }) => {
  for (const approx of [true, false]) {
    const state: MockState = { freeLimit: 1, approx, licensed: new Set(), syncs: [] };
    await context.unrouteAll({ behavior: 'ignoreErrors' });
    await context.route(/^https?:\/\//, (route) => route.abort());
    await mockBilling(context, state);
    const page = await openPage(context, extensionId, 'popup.html');
    await page.evaluate(() => chrome.storage.local.remove(['billingPolicy', 'billingLastSync']));
    await syncNow(page);
    if ((await cards(page).count()) === 0) await addAccountByHand(page, 'only@example.com', otherSecret(20));
    const { paywall } = await addOverLimit(page, `more-${approx}@example.com`, otherSecret(approx ? 21 : 22));
    await expect(paywall.getByRole('radio', { name: /Yearly/ })).toContainText('$14.99');
    await expect(paywall.getByText(/US dollars|your own currency/)).toHaveCount(0);
    await page.close();
  }
});

test('with no limit in the policy, there is no paywall at all', async ({ context, extensionId }) => {
  const state: MockState = { freeLimit: null, licensed: new Set(), syncs: [] };
  await mockBilling(context, state);
  const page = await openPage(context, extensionId, 'popup.html');
  await syncNow(page);
  for (let i = 1; i <= 4; i++) await addAccountByHand(page, `u${i}@example.com`, otherSecret(10 + i));
  await expect(cards(page)).toHaveCount(4);
});

test('cloud backup: turning it on asks for the code back, sends a copy we cannot read, and restores it', async ({ context, extensionId }) => {
  const state: MockState = { freeLimit: null, licensed: new Set(), syncs: [] };
  await mockBilling(context, state);

  const page = await openPage(context, extensionId, 'popup.html');
  await syncNow(page);
  const iid = await page.evaluate(async () => ((await chrome.storage.local.get('billingInstall')).billingInstall as { id: string }).id);
  state.licensed.add(iid);
  await page.evaluate(() => chrome.storage.local.remove('billingLastSync'));
  await page.reload();
  await expect.poll(() => page.evaluate(async () => !!(await chrome.storage.local.get('billingEntitlement')).billingEntitlement)).toBe(true);

  await addAccountByHand(page, 'backed-up@example.com', otherSecret(4));
  await page.getByRole('button', { name: 'Settings' }).click();

  const row = page.getByText('Cloud backup', { exact: true });
  await expect(row).toBeVisible();
  await page.getByRole('button', { name: 'Turn on cloud backup' }).click();

  const dialog = page.getByRole('dialog', { name: 'Your backup recovery code' });
  await expect(dialog).toBeVisible();
  const code = (await dialog.locator('code').innerText()).trim();
  expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/);

  // Typed wrong, nothing is turned on and nothing is sent.
  await dialog.getByRole('textbox').fill('AAAAA-AAAAA-AAAAA-AAAAA');
  await dialog.getByRole('button', { name: 'Turn on cloud backup' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('That does not match the code above.');
  expect(state.backups ?? []).toHaveLength(0);

  await dialog.getByRole('textbox').fill(code.toLowerCase());
  await dialog.getByRole('button', { name: 'Turn on cloud backup' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('On · last copy today')).toBeVisible();
  await expect(page.getByText(/^Today, .+ · this browser$/)).toBeVisible();

  // The server got one copy, and nothing in it it could read.
  expect(state.backups).toHaveLength(1);
  const sent = JSON.stringify(state.backups);
  expect(sent).not.toContain('backed-up@example.com');
  expect(sent).not.toContain(otherSecret(4));
  expect(sent).not.toContain(code.replace(/-/g, ''));

  // Lose the account here, then put it back from the cloud.
  await page.getByRole('button', { name: 'Settings' }).click();
  await deleteByHand(page, 'backed-up@example.com');
  await expect(cards(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByText(/^Today, .+ · this browser$/).locator('xpath=ancestor::li').getByRole('button', { name: 'Restore' }).click();
  await page.getByRole('button', { name: 'Restore' }).last().click();
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByText('backed-up@example.com')).toBeVisible();
});

test('cloud backup without Pro: every install sees "Turn on", and it opens the paywall about the backup — not where nothing can be bought', async ({ context, extensionId }) => {
  const state: MockState = { freeLimit: null, licensed: new Set(), syncs: [] };
  await mockBilling(context, state);

  const page = await openPage(context, extensionId, 'popup.html');
  await syncNow(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  // No limit and Pro not offered in Settings — an install from before the paywall, say.
  await expect(page.getByRole('region', { name: 'Pro' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Turn on cloud backup' }).click();

  const paywall = page.getByRole('dialog', { name: 'Keep your codes, even if you lose this computer' });
  await expect(paywall).toBeVisible();
  await expect(paywall.getByText('Pro keeps an encrypted copy of your accounts in the cloud', { exact: false })).toBeVisible();
  await expect(paywall.getByText(/account limit/)).toHaveCount(0);

  // Where no one can pay, the server offers no plans, and there is no row to press.
  state.noPlans = true;
  await page.keyboard.press('Escape');
  await page.evaluate(() => chrome.storage.local.remove(['billingLastSync', 'billingPolicy']));
  await syncNow(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByText('Backup & Restore')).toBeVisible();
  // Restoring with a license key stays: getting copies back never depends on buying.
  await expect(page.getByRole('button', { name: 'Restore from cloud backup with your license key' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Turn on cloud backup' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Cloud backup' })).toHaveCount(0);
});

test('the cloud backup banner over Settings counts its views, opens the backup paywall, and once closed stays closed', async ({ context, extensionId, serviceWorker }) => {
  const state: MockState = { freeLimit: null, licensed: new Set(), syncs: [] };
  await mockBilling(context, state);

  const page = await openPage(context, extensionId, 'popup.html');
  await syncNow(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  const banner = page.getByRole('region', { name: 'Cloud backup' });
  await expect(banner).toBeVisible();
  await banner.getByRole('button', { name: /Keep your codes, even if you lose this computer/ }).click();

  const paywall = page.getByRole('dialog', { name: 'Keep your codes, even if you lose this computer' });
  await expect(paywall).toBeVisible();
  await expect(paywall.getByText(/account limit/)).toHaveCount(0);
  await page.keyboard.press('Escape');

  const seen = async () => {
    const queued = (await serviceWorker.evaluate(async () => (await chrome.storage.local.get('billingEvents')).billingEvents ?? [])) as Array<{ n: string; p?: Record<string, unknown> }>;
    const sent = state.syncs.flatMap((s) => (Array.isArray(s.events) ? (s.events as Array<{ n: string; p?: Record<string, unknown> }>) : []));
    return [...queued, ...sent];
  };
  await expect.poll(async () => (await seen()).filter((e) => e.n === 'backup_banner_view').length).toBe(1);
  await expect.poll(async () => (await seen()).some((e) => e.n === 'paywall_view' && e.p?.trigger === 'backup_banner')).toBe(true);

  // Every Settings opening it shows in is a view of its own.
  await page.reload();
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(banner).toBeVisible();
  await expect.poll(async () => (await seen()).filter((e) => e.n === 'backup_banner_view').length).toBe(2);

  await banner.getByRole('button', { name: 'Close' }).click();
  await expect(banner).toHaveCount(0);
  await expect.poll(async () => (await seen()).some((e) => e.n === 'backup_banner_close')).toBe(true);
  await page.reload();
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByText('Backup & Restore')).toBeVisible();
  await expect(banner).toHaveCount(0);
  // The row's own "Turn on" stays.
  await expect(page.getByRole('button', { name: 'Turn on cloud backup' })).toBeVisible();
});

test('a new profile restored with the license key gets the accounts, and Pro with them', async ({ context, extensionId }) => {
  const state: MockState = { freeLimit: null, licensed: new Set(), syncs: [] };
  await mockBilling(context, state);

  // The first browser: Pro, one account, cloud backup on.
  const page = await openPage(context, extensionId, 'popup.html');
  await syncNow(page);
  const iid = await page.evaluate(async () => ((await chrome.storage.local.get('billingInstall')).billingInstall as { id: string }).id);
  state.licensed.add(iid);
  await page.evaluate(() => chrome.storage.local.remove('billingLastSync'));
  await page.reload();
  await expect.poll(() => page.evaluate(async () => !!(await chrome.storage.local.get('billingEntitlement')).billingEntitlement)).toBe(true);
  await addAccountByHand(page, 'carried@example.com', otherSecret(6));
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Turn on cloud backup' }).click();
  const dialog = page.getByRole('dialog', { name: 'Your backup recovery code' });
  await expect(dialog.locator('code')).toHaveText(/^[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  const code = (await dialog.locator('code').innerText()).trim();
  await dialog.getByRole('textbox').fill(code);
  await dialog.getByRole('button', { name: 'Turn on cloud backup' }).click();
  await expect(dialog).toBeHidden();
  expect(state.backups).toHaveLength(1);

  // A new profile: nothing of the first one is here — no install, no license, no accounts, no code.
  await page.evaluate(async () => {
    await chrome.storage.local.clear();
    await chrome.storage.sync.clear();
  });
  await page.reload();
  await syncNow(page);
  await expect(cards(page)).toHaveCount(0);
  expect(await page.evaluate(async () => !!(await chrome.storage.local.get('billingEntitlement')).billingEntitlement)).toBe(false);

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Restore from cloud backup with your license key' }).click();
  await page.getByRole('textbox', { name: 'I have a license key' }).fill(GOOD_KEY);
  await page.getByRole('textbox', { name: 'Backup recovery code' }).fill(code);
  await page.getByRole('button', { name: 'Find copies' }).click();
  await page.getByText(/^Today, .+ · another browser$/).locator('xpath=ancestor::li').getByRole('button', { name: 'Restore' }).click();
  await page.getByRole('button', { name: 'Restore' }).last().click();

  // The accounts, and the license typed to find them: Pro is on here too, and this browser keeps the code.
  await expect.poll(() => page.evaluate(async () => !!(await chrome.storage.local.get('billingEntitlement')).billingEntitlement)).toBe(true);
  await expect.poll(() => page.evaluate(async () => !!(await chrome.storage.local.get('cloudBackupCode')).cloudBackupCode)).toBe(true);
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByText('carried@example.com')).toBeVisible();
});
