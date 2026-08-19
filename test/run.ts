// Test entry point: `npm test`.
//
// No framework — these are end-to-end scenarios against real WebCrypto with a
// mocked browser, and a runner that prints them in order is easier to trust
// than a framework's abstractions when the thing under test is "did we just
// lose the user's 2FA seeds".

import { failureCount, installMocks } from './harness';

installMocks();

const suites = [
  ['totp and parsers', () => import('./totp.test')],
  ['vault', () => import('./vault.test')],
  ['data-loss', () => import('./dataloss.test')],
  ['suggestions', () => import('./suggestions.test')],
  ['quick fill', () => import('./quick-fill.test')],
  ['quick fill in the page', () => import('./quick-fill-page.test')],
  ['groups', () => import('./groups.test')],
  ['recovery', () => import('./recovery.test')],
  ['review prompt', () => import('./review-prompt.test')],
  ['time sync', () => import('./time-sync.test')],
  ['wrong clocks', () => import('./clock.test')],
  ['upgrade from 1.11.0', () => import('./upgrade.test')],
  ['vault metadata', () => import('./vault-meta.test')],
  ['passkey unlock', () => import('./passkey.test')],
  ['credential exchange format', () => import('./cxf.test')],
  ['shared vectors', () => import('./parity.test')],
  ['language detection', () => import('./i18n.test')],
] as const;

for (const [name, load] of suites) {
  console.log(`\n=== ${name} ===`);
  const suite = await load();
  await suite.run();
}

const failures = failureCount();
console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
