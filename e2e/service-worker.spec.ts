// The service worker starts clean in real Chrome.
//
// The unit suite cannot see this: under Node the worker's imports all resolve
// and `import()` works, while Chrome refuses a dynamic import in a service
// worker outright — the failure that left the right-click item English in every
// language. Here the worker runs where it ships, and whatever it reports as an
// error on start fails the test.
//
// Chrome keeps an extension's errors (console.error, uncaught exceptions,
// unhandled rejections, manifest warnings) only while developer mode is on, and
// the profile starts with it off, so the worker that came up at launch went
// unwatched. The test turns developer mode on and reloads the extension: the
// worker then cold-starts again, top-level code and startup listeners and all,
// with Chrome recording. The record is read the way chrome://extensions reads
// it, through chrome.developerPrivate on that page.

import { expect, openPage, test } from './fixtures';

test('the service worker starts without errors', async ({ context, extensionId, serviceWorker }) => {
  const consoleErrors: string[] = [];
  context.on('console', (message) => {
    if (message.type() === 'error' && message.worker()) consoleErrors.push(message.text());
  });
  serviceWorker.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  const extensions = await context.newPage();
  await extensions.goto('chrome://extensions/');
  await extensions.evaluate(() =>
    (chrome as any).developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })
  );

  const restarted = context.waitForEvent('serviceworker');
  await extensions.evaluate((id) => (chrome as any).developerPrivate.reload(id, { failQuietly: true }), extensionId);
  const worker = await restarted;
  expect(new URL(worker.url()).host).toBe(extensionId);

  // Give the worker something to do beyond starting: the popup talks to it
  // and to the storage it watches.
  const popup = await openPage(context, extensionId, 'popup.html');
  await expect(popup.getByRole('button', { name: "I'm turning on 2-factor authentication right now" })).toBeVisible();
  // Startup work is asynchronous (settings reads, the context menu, the
  // badge); let it finish before reading the record.
  await expect
    .poll(() => worker.evaluate(() => chrome.contextMenus !== undefined), { timeout: 5_000 })
    .toBe(true);
  await popup.waitForTimeout(1_500);

  const info = await extensions.evaluate(
    (id) => (chrome as any).developerPrivate.getExtensionInfo(id),
    extensionId
  );
  const describe = (errors: any[]) =>
    errors.map((error) => `${error.message} @ ${error.source || error.contextUrl || '?'}`);
  expect(describe(info.manifestErrors), 'manifest errors').toEqual([]);
  expect(describe(info.runtimeErrors), 'service worker errors').toEqual([]);
  expect(consoleErrors, 'console errors from the worker').toEqual([]);
});
