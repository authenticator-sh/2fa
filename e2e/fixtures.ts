// What every e2e test starts from: a fresh Chromium profile with the built
// extension loaded unpacked, and nothing else.
//
// Launched with channel 'chromium' so headless is Chromium's new headless
// mode — the old headless shell has no extension support at all, and a test
// that silently ran without the extension would pass for the wrong reason.

import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test as base, type BrowserContext, type Page, type Worker } from '@playwright/test';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
export const EXTENSION_DIR = resolve(ROOT, process.env.E2E_EXTENSION_DIR ?? '.e2e-build');

/** The key from the "where do I find it" help, and every TOTP tutorial. */
export const SECRET = 'JBSWY3DPEHPK3PXP';

/**
 * A second, third… key. The app refuses a seed it already holds (a duplicate is
 * the same account), so tests that need several rows need several seeds.
 */
export function otherSecret(index: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  return Array.from({ length: 16 }, (_, i) => alphabet[(index * 7 + i * 13 + 3) % 32]).join('');
}

interface Fixtures {
  context: BrowserContext;
  serviceWorker: Worker;
  extensionId: string;
  /** Uncaught exceptions on extension pages, collected for the whole test. */
  pageErrors: string[];
}

export const test = base.extend<Fixtures>({
  pageErrors: async ({}, use) => {
    await use([]);
  },

  context: async ({ pageErrors }, use) => {
    const profile = mkdtempSync(join(tmpdir(), 'authenticator-e2e-'));
    const context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: !process.env.HEADED,
      args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
    });
    // Nothing leaves the machine. The popup's clock check, the welcome tab the
    // install opens and the banner images would otherwise make the result
    // depend on hosts this suite does not own; with them refused, the clock
    // check falls back to the local clock, which is what the code assertions
    // compute against anyway.
    await context.route(/^https?:\/\//, (route) => route.abort());
    context.on('page', (page) => {
      page.on('pageerror', (error) => {
        if (page.url().startsWith('chrome-extension://')) pageErrors.push(`${page.url()}: ${error.message}`);
      });
    });

    await use(context);

    await context.close();
    rmSync(profile, { recursive: true, force: true });
  },

  serviceWorker: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker');
    await use(worker);
  },

  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host);
  },
});

export { expect };

/**
 * Open one of the extension's pages in a tab.
 *
 * popup.html in a tab is the popup: the page tells its mode from its own file
 * name (utils/open-mode.ts), not from how it was opened.
 */
export async function openPage(context: BrowserContext, extensionId: string, file: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${file}`);
  return page;
}

export const cards = (page: Page) => page.getByTestId('account-card');

/** The names on the rows, top to bottom. The name is the row's first truncating span. */
export async function cardNames(page: Page): Promise<string[]> {
  return cards(page).evaluateAll((rows) =>
    rows.map((row) => row.querySelector('span.truncate')?.textContent?.trim() ?? '')
  );
}

/**
 * Add an account through the form, the way a user does it.
 *
 * With no accounts the way in is the first-run chooser; after that it is the
 * floating button.
 */
export async function addAccountByHand(page: Page, name: string, secret = SECRET): Promise<void> {
  const before = await cards(page).count();
  const fab = page.getByRole('button', { name: 'Add Account', exact: true });
  if (before === 0 && !(await fab.isVisible())) {
    await page.getByRole('button', { name: 'I have a secret key' }).click();
  } else {
    await fab.click();
  }

  const dialog = page.getByRole('dialog', { name: 'Add Account' });
  await expect(dialog).toBeVisible();
  // The form opens on the QR tab; typing a key is the other one.
  await dialog.getByRole('button', { name: 'Manual', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Manual', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByLabel('Account Name').fill(name);
  await dialog.getByLabel('Secret Key').fill(secret);
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(cards(page)).toHaveCount(before + 1);
}

/** Delete through the row's button and the confirmation, as a user would. */
export async function deleteByHand(page: Page, name: string): Promise<void> {
  const row = cards(page).filter({ hasText: name });
  await row.hover();
  await row.getByRole('button', { name: 'Delete account' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Delete account' });
  await confirm.getByRole('button', { name: 'Delete account' }).click();
  await expect(confirm).toBeHidden();
}

/** What chrome.storage.local holds for the account list, read in the extension. */
export async function storedAccounts(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(async () => {
    const { authenticator_accounts: stored } = await chrome.storage.local.get('authenticator_accounts');
    return Array.isArray(stored) ? stored : [];
  });
}

/**
 * RFC 6238 with the defaults the form uses (SHA-1, 6 digits, 30 s), computed
 * here with node:crypto — deliberately not with the extension's own code, which
 * is what is under test.
 */
export function totp(secret: string, timeMs: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret.replace(/=+$/, '').toUpperCase()) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  }
  const key = Buffer.from(bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(timeMs / 1000 / 30)));
  const mac = createHmac('sha1', key).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const value = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(value).padStart(6, '0');
}
