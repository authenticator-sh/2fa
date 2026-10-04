// The paid path through the whole system (playwright.stack.config.ts).
//
// The database is seeded by ../server/scripts/e2e-seed.ts: tier-1 installs get
// a limit of 2 and one of two price variants (current, or $24.99 / $49.99 /
// $4.99); the rest of the world has no limit. The tests run in order and share
// the installs they make: the key bought in the first is typed into the second
// browser, and the refund at the end takes the first one's Pro away.

import { expect, test } from '@playwright/test';
import {
  addAccount,
  addOverLimit,
  admin,
  adminText,
  cards,
  deliver,
  entitled,
  install,
  keyOnSuccessPage,
  newSecret,
  openCheckout,
  payLifetime,
  policyOf,
  syncNow,
  type Install,
  type Policy,
} from './stack';

test.describe.configure({ mode: 'serial' });

const PRICES = {
  control: { year: 1499, life: 3999, month: 299, plans: ['pro_year', 'pro_life', 'pro_month'] },
  higher: { year: 2499, life: 5999, month: 499, plans: ['pro_year_2499', 'pro_life_5999', 'pro_month_499'] },
} as const;

/** The tier-1 price variant an install was given. */
function variantOf(policy: Policy): keyof typeof PRICES {
  const offer = policy.exps.find((e) => e.layer === 'offer');
  expect(offer?.id).toBe('tier1-prices');
  return offer!.var as keyof typeof PRICES;
}

const shared: { buyer?: Install; key?: string; paymentIntent?: string; sessionId?: string } = {};

test.afterAll(async () => {
  await shared.buyer?.close();
});

test('a tier-1 install meets the limit on Add, sees its variant’s prices, pays, and is Pro — every step in the admin', async () => {
  const us = await install('US');
  shared.buyer = us;
  const { page } = us;

  const policy = await policyOf(page);
  expect(policy.free_limit).toBe(2);
  expect(policy.exps.find((e) => e.layer === 'limit')).toMatchObject({ id: 'tier1-limit', var: 'limit_2' });
  const variant = variantOf(policy);
  const p = PRICES[variant];
  expect(policy.paywall.plans).toEqual(p.plans);
  // US: dollars, exact.
  for (const id of p.plans) expect(policy.prices[id]).toMatchObject({ currency: 'usd', approx: false });

  await addAccount(page, 'one@example.com');
  await addAccount(page, 'two@example.com');

  const { dialog, paywall } = await addOverLimit(page, 'three@example.com');
  await expect(paywall.getByRole('radio', { name: /Yearly/ })).toContainText(`$${(p.year / 100).toFixed(2)} / year`);
  await expect(paywall.getByRole('radio', { name: /Lifetime/ })).toContainText(`$${(p.life / 100).toFixed(2)}, once`);
  await expect(paywall.getByRole('radio', { name: /Monthly/ })).toContainText(`$${(p.month / 100).toFixed(2)} / month`);
  expect(await cards(page).count()).toBe(2);

  // Closing it leaves the typed account on the form, and nothing added.
  await paywall.getByRole('button', { name: 'Close' }).click();
  await expect(paywall).toBeHidden();
  await expect(dialog.getByLabel('Account Name')).toHaveValue('three@example.com');
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(paywall).toBeVisible();

  // Lifetime, through Checkout: the session Stripe holds is the plan, the price and the install.
  await paywall.getByRole('radio', { name: /Lifetime/ }).click();
  const session = await openCheckout(page, paywall);
  shared.sessionId = session.id;
  const lifePlan = p.plans[1];
  expect(session).toMatchObject({
    mode: 'payment',
    currency: 'usd',
    amount_total: p.life,
    client_reference_id: expect.stringMatching(/^co_/),
    metadata: { iid: us.iid, plan: lifePlan, trigger: 'form' },
  });
  expect(session.metadata.exps).toContain(`tier1-prices:${variant}`);
  expect(session.metadata.exps).toContain('tier1-limit:limit_2');
  expect(session.line_items.data[0].price.lookup_key).toBe(lifePlan);

  shared.paymentIntent = await payLifetime(session, { email: 'buyer-us@example.com', country: 'US' });

  // The success page shows the key…
  shared.key = await keyOnSuccessPage(us.context, session.id);

  // …and back in the popup the account typed before Checkout is there by
  // itself: it was kept as Checkout opened, and the check-in that finds the
  // purchase adds it. Nothing is typed again.
  await page.bringToFront();
  await syncNow(page);
  await expect(cards(page)).toHaveCount(3);
  await expect(page.getByText('three@example.com', { exact: true })).toBeVisible();
  expect(await entitled(page)).toBe(true);
  await page.reload();
  await expect(cards(page)).toHaveCount(3);
  await addAccount(page, 'four@example.com');
  await syncNow(page);

  const a = await admin(us.context);
  const installPage = await adminText(a, `/admin/installs/${us.iid}`);
  for (const event of ['install_first_seen', 'limit_blocked', 'paywall_view', 'paywall_close', 'plan_select', 'checkout_open', 'checkout_created', 'checkout_completed']) {
    expect(installPage, `install timeline lacks ${event}`).toContain(event);
  }
  expect(installPage).toContain('tier1-limit');
  expect(installPage).toContain('limit_2');
  expect(installPage).toContain(variant);
  expect(installPage).toContain('completed');
  expect(installPage).toContain(lifePlan);

  const experiment = await adminText(a, '/admin/experiments/tier1-prices');
  expect(experiment).toContain(variant);
  await a.close();
});

test('the key works in another browser — in Germany, where the prices were exact euros and Checkout charges euros', async () => {
  expect(shared.key, 'the purchase test must pass first').toBeTruthy();
  const de = await install('DE');
  try {
    const { page } = de;
    const policy = await policyOf(page);
    const p = PRICES[variantOf(policy)];
    expect(policy.free_limit).toBe(2);
    for (const id of p.plans) expect(policy.prices[id]).toMatchObject({ currency: 'eur', approx: false });
    const yearlyEur = policy.prices[p.plans[0]]!.amount;

    await addAccount(page, 'eins@example.com');
    await addAccount(page, 'zwei@example.com');
    let { paywall, secret: drei } = await addOverLimit(page, 'drei@example.com');
    await expect(paywall.getByRole('radio', { name: /Yearly/ })).toContainText(`€${(yearlyEur / 100).toFixed(2)} / year`);

    // The euro price on the paywall is the euro price on Checkout, whatever the buyer's IP says.
    const session = await openCheckout(page, paywall);
    expect(session).toMatchObject({ mode: 'subscription', currency: 'eur', metadata: { iid: de.iid, plan: p.plans[0] } });

    // Back without paying; then the key from the first browser, with the same
    // account typed again. (The one kept at Checkout is that same seed, so it
    // does not come in a second time once Pro is on.)
    await page.reload();
    ({ paywall } = await addOverLimit(page, 'drei@example.com', drei));
    await paywall.getByRole('button', { name: 'I have a license key' }).click();
    await paywall.getByRole('textbox', { name: 'I have a license key' }).fill(shared.key!);
    await paywall.getByRole('button', { name: 'Activate' }).click();
    await expect(paywall).toBeHidden();
    // The account typed before the paywall goes in. (Exact: the note that
    // the kept one is waiting for Pro names it too.)
    await expect(cards(page)).toHaveCount(3);
    await expect(page.getByText('drei@example.com', { exact: true })).toBeVisible();
    await syncNow(page);

    const a = await admin(de.context);
    const installPage = await adminText(a, `/admin/installs/${de.iid}`);
    for (const event of ['license_activate', 'license_activated', 'checkout_created']) expect(installPage, `lacks ${event}`).toContain(event);
    // One license, two devices: the buying install and this one.
    await a.getByRole('link', { name: /^lic_/ }).first().click();
    const devices = a.locator('section', { has: a.getByRole('heading', { name: 'Devices' }) });
    await expect(devices.locator(`a[href="/admin/installs/${shared.buyer!.iid}"]`)).toHaveCount(1);
    await expect(devices.locator(`a[href="/admin/installs/${de.iid}"]`)).toHaveCount(1);
    await a.close();
  } finally {
    await de.close();
  }
});

test('Canada pays in exact Canadian dollars: on the paywall and in Checkout, with no conversion note', async () => {
  const ca = await install('CA');
  try {
    const { page } = ca;
    const policy = await policyOf(page);
    const p = PRICES[variantOf(policy)];
    for (const id of p.plans) expect(policy.prices[id]).toMatchObject({ currency: 'cad', approx: false });
    const yearly = policy.prices[p.plans[0]]!.amount;
    await addAccount(page, 'one@example.ca');
    await addAccount(page, 'two@example.ca');
    const { paywall } = await addOverLimit(page, 'three@example.ca');
    await expect(paywall.getByRole('radio', { name: /Yearly/ })).toContainText(`CA$${(yearly / 100).toFixed(2)} / year`);
    await expect(paywall.getByText(/Prices are in US dollars/)).toHaveCount(0);
    const session = await openCheckout(page, paywall);
    expect(session).toMatchObject({ currency: 'cad', amount_total: yearly });
  } finally {
    await ca.close();
  }
});

test('Brazil, tier 3: R$29,90 a year in reais, on the paywall and in Checkout', async () => {
  const br = await install('BR');
  try {
    const { page } = br;
    const policy = await policyOf(page);
    expect(policy.exps).toEqual([]);
    // Tiers 2 and 3 sell a year and a lifetime: a month held at the $2.99 floor would make the year look like an error.
    expect(policy.paywall.plans).toEqual(['pro_year_t3', 'pro_life_t3']);
    expect(policy.prices.pro_year_t3).toMatchObject({ currency: 'brl', amount: 2990, approx: false });
    await addAccount(page, 'um@example.com.br');
    await addAccount(page, 'dois@example.com.br');
    const { paywall } = await addOverLimit(page, 'tres@example.com.br');
    await expect(paywall.getByRole('radio', { name: /Yearly/ })).toContainText('R$29.90 / year');
    await expect(paywall.getByRole('radio', { name: /Monthly/ })).toHaveCount(0);
    const session = await openCheckout(page, paywall);
    expect(session).toMatchObject({ currency: 'brl', amount_total: 2990, metadata: { plan: 'pro_year_t3' } });
  } finally {
    await br.close();
  }
});

test('a country no tier names pays tier-3 prices, and has no limit', async () => {
  const lk = await install('LK');
  try {
    const policy = await policyOf(lk.page);
    expect(policy.free_limit).toBeNull();
    expect(policy.exps).toEqual([]);
    expect(policy.paywall.plans).toEqual(['pro_year_t3', 'pro_life_t3']);
    // No rupee price: dollars, marked as converted at checkout.
    expect(policy.prices.pro_year_t3).toMatchObject({ currency: 'usd', amount: 599, approx: true });
    for (let i = 1; i <= 4; i++) await addAccount(lk.page, `lk${i}@example.com`);
    await expect(lk.page.getByRole('dialog', { name: /Pro/ })).toHaveCount(0);
  } finally {
    await lk.close();
  }
});

test('an import goes in whole, past the limit; the next account added by hand meets the paywall — in pounds in Britain', async () => {
  const gb = await install('GB');
  try {
    const { page } = gb;
    const policy = await policyOf(page);
    const p = PRICES[variantOf(policy)];
    for (const id of p.plans) expect(policy.prices[id]).toMatchObject({ currency: 'gbp', approx: false });
    await addAccount(page, 'first@example.co.uk');

    // Three links with one free slot left: all three go in, no paywall.
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Paste links' }).click();
    const links = ['alpha', 'beta', 'gamma'].map((n) => `otpauth://totp/Stack:${n}@example.co.uk?secret=${newSecret()}&issuer=Stack`).join('\n');
    await page.getByPlaceholder('otpauth://totp/…').fill(links);
    await page.getByRole('button', { name: 'Import', exact: true }).last().click();
    await expect(page.getByText(/3 accounts? (imported|added)/i).first()).toBeVisible();
    await expect(page.getByRole('dialog', { name: /Pro/ })).toHaveCount(0);
    // Settings names the plan, never "4 of 2".
    await expect(page.getByText('Free plan', { exact: true })).toBeVisible();
    await expect(page.getByText(/\bof 2\b/)).toHaveCount(0);

    await page.reload();
    await expect(cards(page)).toHaveCount(4);
    const { paywall } = await addOverLimit(page, 'fifth@example.co.uk');
    await expect(paywall.getByRole('radio', { name: /Yearly/ })).toContainText('£');
    await syncNow(page);

    const a = await admin(gb.context);
    const installPage = await adminText(a, `/admin/installs/${gb.iid}`);
    expect(installPage).toContain('limit_blocked');
    expect(installPage).toContain('paywall_view');
    // The whole import went in: no "take the free part" event in the timeline.
    expect(installPage).not.toMatch(/import_partial client/);
    await a.close();
  } finally {
    await gb.close();
  }
});

test('a refund takes Pro away again; every account stays and keeps its code', async () => {
  expect(shared.paymentIntent, 'the purchase test must pass first').toBeTruthy();
  const { page } = shared.buyer!;
  const amount = (await policyOf(page)).exps.some((e) => e.var === 'higher') ? PRICES.higher.life : PRICES.control.life;
  await deliver('charge.refunded', {
    id: `ch_stack_${Date.now()}`,
    object: 'charge',
    payment_intent: shared.paymentIntent,
    amount,
    amount_refunded: amount,
    refunded: true,
  });
  await syncNow(page);
  await expect.poll(() => entitled(page), { timeout: 30_000 }).toBe(false);
  await expect(cards(page)).toHaveCount(4);
  await expect(page.getByTestId('account-code').first()).toHaveText(/^\d{3} \d{3}$/);
  // Over the limit with four accounts: the next add meets the paywall again.
  await addOverLimit(page, 'five@example.com');
});
