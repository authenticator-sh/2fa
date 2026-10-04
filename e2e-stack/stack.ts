// What the stack tests do to the extension, Stripe and the admin.

import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { BUILD_DIR, readDotEnv, STATE_FILE, type StackState } from './global-setup';

export const stack: StackState = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
const STRIPE_KEY = readDotEnv(join(stack.serverDir, '.env.local')).STRIPE_SECRET_KEY ?? '';
if (!/^(sk|rk)_test_/.test(STRIPE_KEY)) throw new Error('the stack test talks to the Stripe sandbox only');

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** A fresh seed every time: a seed already in the list is a duplicate, not a new account. */
export const newSecret = () => Array.from(randomBytes(32), (b) => BASE32[b % 32]).join('');

export interface Install {
  context: BrowserContext;
  page: Page;
  extensionId: string;
  iid: string;
  close: () => Promise<void>;
}

/**
 * The extension installed in a fresh profile, in a country. The country is
 * what a local server reads from `x-debug-country` (it ignores the header in
 * production); every request to the API carries it.
 */
export async function install(country: string): Promise<Install> {
  const profile = mkdtempSync(join(tmpdir(), 'authenticator-stack-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: !process.env.HEADED,
    args: [`--disable-extensions-except=${BUILD_DIR}`, `--load-extension=${BUILD_DIR}`],
    viewport: { width: 420, height: 720 },
  });
  await context.route(`${stack.api}/**`, (route) =>
    route.continue({ headers: { ...route.request().headers(), 'x-debug-country': country } })
  );
  // The welcome and uninstall pages live on the production site.
  await context.route(/^https:\/\/(www\.)?authenticator\.sh\//, (route) => route.abort());

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await syncNow(page);
  const iid = await page.evaluate(async () => ((await chrome.storage.local.get('billingInstall')).billingInstall as { id: string }).id);
  return {
    context,
    page,
    extensionId,
    iid,
    close: async () => {
      await context.close();
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

async function lastSync(page: Page): Promise<number | null> {
  return page.evaluate(async () => {
    const last = (await chrome.storage.local.get('billingLastSync')).billingLastSync as { at: number; ok: boolean } | undefined;
    return last?.ok ? last.at : null;
  });
}

/** Makes the popup check in now — sending its queued events — and waits until it has. */
export async function syncNow(page: Page): Promise<void> {
  const before = await lastSync(page);
  await expect
    .poll(
      async () => {
        const at = await lastSync(page);
        if (at !== null && at !== before) return true;
        await page.evaluate(() => chrome.storage.local.remove('billingLastSync'));
        await page.reload();
        return false;
      },
      { timeout: 45_000, intervals: [500, 1000, 2000] }
    )
    .toBe(true);
}

const payload = (token: unknown) => JSON.parse(Buffer.from(String(token).split('.')[1]!, 'base64url').toString('utf8'));

export interface Policy {
  free_limit: number | null;
  paywall: { plans: string[]; default_plan: string };
  prices: Record<string, { amount: number; currency: string; approx: boolean }>;
  exps: { id: string; layer: string; var: string }[];
}

export async function policyOf(page: Page): Promise<Policy> {
  return payload(await page.evaluate(async () => (await chrome.storage.local.get('billingPolicy')).billingPolicy));
}

export async function entitled(page: Page): Promise<boolean> {
  return page.evaluate(async () => !!(await chrome.storage.local.get('billingEntitlement')).billingEntitlement);
}

export const cards = (page: Page) => page.getByTestId('account-card');

async function openAdd(page: Page): Promise<Locator> {
  const fab = page.getByRole('button', { name: 'Add Account', exact: true });
  const firstRun = page.getByRole('button', { name: "I'm turning on 2-factor authentication right now" });
  // Right after a reload neither is drawn yet; deciding before one is would pick wrong.
  await expect(fab.or(firstRun).first()).toBeVisible();
  if (!(await fab.isVisible())) await firstRun.click();
  await fab.click();
  const dialog = page.getByRole('dialog', { name: 'Add Account' });
  await expect(dialog).toBeVisible();
  // Nothing before the limit is met mentions it (owner's call, 2026-10-02).
  await expect(dialog.getByText(/free account/i)).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Manual', exact: true }).click();
  return dialog;
}

async function typeAccount(dialog: Locator, name: string, secret = newSecret()): Promise<void> {
  await dialog.getByLabel('Account Name').fill(name);
  await dialog.getByLabel('Secret Key').fill(secret);
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
}

/** Adds an account through the form; it must go in. */
export async function addAccount(page: Page, name: string): Promise<void> {
  const dialog = await openAdd(page);
  // Counted once the list is drawn (openAdd waits for it); the form lies over it, the rows stay.
  const before = await cards(page).count();
  await typeAccount(dialog, name);
  await expect(dialog).toBeHidden();
  await expect(cards(page)).toHaveCount(before + 1);
}

/**
 * Types an account with no room left: the paywall opens over the form. The
 * seed is returned, so the same account can be typed again — a different seed
 * is a different account.
 */
export async function addOverLimit(page: Page, name: string, secret = newSecret()): Promise<{ dialog: Locator; paywall: Locator; secret: string }> {
  const dialog = await openAdd(page);
  await typeAccount(dialog, name, secret);
  const paywall = page.getByRole('dialog', { name: /Pro|independent|limits|every account/i });
  await expect(paywall).toBeVisible();
  return { dialog, paywall, secret };
}

// ─── Stripe ──────────────────────────────────────────────────────────────────

export async function stripeApi<T = Record<string, any>>(path: string, form?: Record<string, string>): Promise<T> {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: form ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${STRIPE_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form ? new URLSearchParams(form) : undefined,
  });
  const body = (await res.json()) as T & { error?: { message: string } };
  if (!res.ok) throw new Error(`Stripe ${path}: ${body.error?.message}`);
  return body;
}

/** Opens Checkout from the paywall and returns the session as Stripe holds it; the Stripe tab is closed again. */
export async function openCheckout(page: Page, paywall: Locator): Promise<Record<string, any>> {
  const context = page.context();
  const before = new Set(context.pages());
  await paywall.getByRole('button', { name: /^Continue/ }).click();
  // The Checkout tab, not whatever else opens meanwhile; a refusal shows in the paywall instead.
  let tab: Page | undefined;
  await expect
    .poll(
      async () => {
        const alert = paywall.getByRole('alert');
        if (await alert.count()) throw new Error(`the paywall says: ${await alert.first().innerText()}`);
        tab = context.pages().find((p) => !before.has(p) && /checkout\.stripe\.com/.test(p.url()));
        return !!tab;
      },
      { timeout: 60_000, intervals: [250, 500, 1000] }
    )
    .toBe(true);
  const id = tab!.url().match(/cs_test_[A-Za-z0-9]+/)?.[0];
  if (!id) throw new Error(`no session id in ${tab!.url()}`);
  await tab!.close();
  return stripeApi(`checkout/sessions/${id}?expand[]=line_items`);
}

/** Delivers a Stripe event to the server's webhook, signed as Stripe signs it. */
export async function deliver(type: string, object: Record<string, unknown>): Promise<void> {
  const event = {
    id: `evt_stack_${randomBytes(8).toString('hex')}`,
    object: 'event',
    type,
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: { object },
  };
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', stack.webhookSecret).update(`${t}.${body}`).digest('hex');
  const res = await fetch(`${stack.api}/v1/stripe/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${v1}` }, body });
  expect(res.status, `webhook ${type}: ${await res.text()}`).toBe(200);
}

/**
 * The payment Stripe's page would take: the session as Stripe holds it, marked
 * paid by a card, delivered as checkout.session.completed. Lifetime only — a
 * subscription would need Stripe to have created one.
 */
export async function payLifetime(session: Record<string, any>, buyer: { email: string; country: string }): Promise<string> {
  expect(session.mode).toBe('payment');
  const paymentIntent = `pi_stack_${randomBytes(8).toString('hex')}`;
  await deliver('checkout.session.completed', {
    ...session,
    status: 'complete',
    payment_status: 'paid',
    payment_intent: paymentIntent,
    customer_details: { email: buyer.email, name: 'Stack Test', address: { country: buyer.country } },
  });
  return paymentIntent;
}

// ─── The success page and the admin ──────────────────────────────────────────

export const KEY_PATTERN = /2FA-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}/;

export async function keyOnSuccessPage(context: BrowserContext, sessionId: string): Promise<string> {
  const page = await context.newPage();
  await page.goto(`${stack.site}/pro/success?session_id=${sessionId}`);
  await expect(page.getByText(KEY_PATTERN).first()).toBeVisible({ timeout: 60_000 });
  const key = (await page.locator('body').innerText()).match(KEY_PATTERN)![0];
  await page.close();
  return key;
}

/** A page signed in to the local admin (development mode: password "admin"). */
export async function admin(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${stack.api}/admin/login`);
  await page.locator('input[name=password]').fill('admin');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/admin/login'));
  return page;
}

/** The text of an admin page, whitespace folded. */
export async function adminText(page: Page, path: string): Promise<string> {
  await page.goto(`${stack.api}${path}`);
  return (await page.locator('main').innerText()).replace(/\s+/g, ' ');
}
