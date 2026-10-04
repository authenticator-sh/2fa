// End-to-end suite: the built extension, loaded unpacked into real Chromium.
//
//   npm run test:e2e
//
// The unit suite (npm test) runs the real modules against a mocked chrome.*,
// and there are things a mock cannot tell you: that Chrome accepts the
// package, that the service worker starts without throwing, that a write in
// one window reaches another through the real storage.onChanged, that what the
// popup draws is what storage holds. This is where those are checked.
//
// It loads .e2e-build/, never dist/ — dist/ is the last release build and the
// checksums are made from it. `npm run test:e2e` builds .e2e-build/ first.

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  // Every test launches its own browser with its own fresh profile, so tests
  // could run side by side; one at a time keeps a slow CI runner from turning
  // the one-second TOTP tick into a race.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // A flaky pass is still a failure worth seeing: no retries.
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    trace: 'retain-on-failure',
  },
});
