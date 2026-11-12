// The Share screen: temporary access by link, and moving an account to another
// app as a QR code.

import { addAccountByHand, cards, expect, openPage, test } from './fixtures';

test.afterEach(({ pageErrors }) => {
  expect(pageErrors, 'uncaught exceptions on extension pages').toEqual([]);
});

test("the Share screen shows an account's QR, and Escape closes only the QR", async ({ context, extensionId }) => {
  const page = await openPage(context, extensionId, 'popup.html');
  await addAccountByHand(page, 'qr@example.com');

  await cards(page).first().hover();
  await page.getByTitle('Share').first().click();

  const dialog = page.getByRole('dialog', { name: 'Share' });
  await expect(dialog.getByText('Temporary access by link')).toBeVisible();
  await dialog.getByRole('button', { name: /Show QR code/ }).click();

  const overlay = page.getByTestId('qr-overlay');
  await expect(overlay).toBeVisible();
  await expect(overlay.locator('svg[role=img]')).toBeVisible();
  await expect(overlay.getByText('qr@example.com')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(overlay).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Temporary access by link')).toBeVisible();
});
