// The paid path end to end, against the real thing: this extension built for
// a local API, the real server (../server) on a throwaway database with the
// Stripe sandbox behind it, and the real site (../site) for the success page.
//
//   npm run test:stack
//
// What e2e/ cannot see and this can: that the server's signed policy verifies
// in the extension, that the CORS and the sync contract agree, that the
// paywall prices are the server's catalog for the install's country and
// experiment variant, that Checkout is created in Stripe with the right price
// and currency, that a payment turns into a license the extension picks up,
// and that every step lands in the admin.
//
// What it does not do: press "Pay" on Stripe's page. Stripe guards it with
// hCaptcha against automated browsers, so the payment is delivered the way
// Stripe would deliver it — a checkout.session.completed event for the real
// session, signed with the webhook secret — and everything after that is real.
//
// Needs network (Stripe's sandbox API), a Stripe test key in
// ../server/.env.local, and no `next dev` already running in ../server or
// ../site (Next allows one per folder). To run against a stack you started
// yourself, set STACK_API, STACK_SITE and STACK_WEBHOOK_SECRET.

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e-stack',
  globalSetup: './e2e-stack/global-setup.ts',
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  retries: 0,
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
});
