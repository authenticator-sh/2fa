// The welcome page asks the extension to open itself (background/site-open.ts):
// it is answered from our own site, and only from it, and the popup it opens
// is a real one — the popup itself records that the page showed it, apart
// from the person's own first open.

import type { BrowserContext } from '@playwright/test';
import { expect, test } from './fixtures';

/** A stand-in for a page at `origin`, which asks the extension and writes down what came back. */
async function askingPage(context: BrowserContext, origin: string, extensionId: string) {
  await context.route(`${origin}/welcome**`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><pre id="out"></pre><script>
        const out = (line) => (document.getElementById('out').textContent += line + '\\n');
        const send = (message) => new Promise((resolve) => {
          if (!(window.chrome && chrome.runtime && chrome.runtime.sendMessage)) return resolve('no-runtime');
          chrome.runtime.sendMessage(${JSON.stringify(extensionId)}, message, (reply) => { void chrome.runtime.lastError; resolve(JSON.stringify(reply ?? null)); });
        });
        (async () => { out('ping ' + await send({ type: 'ping' })); out('open ' + await send({ type: 'open', auto: true })); })();
      </script>`,
    })
  );
  const page = await context.newPage();
  await page.goto(`${origin}/welcome`);
  return page.locator('#out');
}

test('our site opens the popup without a click, the popup really opens, and it is not counted as the person opening it', async ({ context, extensionId, serviceWorker }) => {
  const out = await askingPage(context, 'https://www.authenticator.sh', extensionId);
  await expect(out).toContainText('ping {"ok":true}');
  await expect(out).toContainText('open {"ok":true}');
  // Written by the popup page as it starts, not by the message handler — and
  // as the page's open, not the person's: no first open, the stage untouched.
  const onboarding = () =>
    serviceWorker.evaluate(() => chrome.storage.local.get('billingOnboarding').then((found) => found.billingOnboarding ?? {}));
  await expect.poll(async () => (await onboarding()).firstShown).toBe(true);
  expect(await onboarding()).toMatchObject({ stage: 'installed' });
  expect((await onboarding()).firstOpen).toBeUndefined();
});

test('any other site cannot reach the extension', async ({ context, extensionId }) => {
  const out = await askingPage(context, 'https://example.com', extensionId);
  await expect(out).toContainText('ping no-runtime');
});
