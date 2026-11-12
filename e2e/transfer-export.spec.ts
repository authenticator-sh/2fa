// Moving accounts to Google Authenticator: choose them, then page through
// migration QR codes.

import { cards, expect, openPage, otherSecret, test } from './fixtures';

test.afterEach(({ pageErrors }) => {
  expect(pageErrors, 'uncaught exceptions on extension pages').toEqual([]);
});

test('export to Google Authenticator lets you choose accounts and pages through codes', async ({ context, extensionId }) => {
  const page = await openPage(context, extensionId, 'popup.html');

  // Imports are not held to the free limit; adding by hand may be.
  await page.getByRole('button', { name: 'In another app or a backup file' }).click();
  await page.getByRole('button', { name: 'Paste links', exact: true }).click();
  const paste = page.getByRole('dialog', { name: 'Paste otpauth:// links' });
  await paste.getByRole('textbox').fill(
    Array.from(
      { length: 11 },
      (_, i) => `otpauth://totp/Svc${i}:user${i}@example.com?secret=${otherSecret(i + 20)}&issuer=Svc${i}`
    ).join('\n')
  );
  await paste.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(cards(page)).toHaveCount(11);

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('button', { name: 'Choose accounts' }).click();

  const screen = page.getByRole('dialog', { name: 'To Google Authenticator' });
  await expect(screen.getByText('11 of 11 selected')).toBeVisible();

  await screen.getByRole('checkbox').first().uncheck();
  await expect(screen.getByText('10 of 11 selected')).toBeVisible();
  await screen.getByRole('button', { name: 'Next (10)' }).click();

  const overlay = page.getByTestId('qr-overlay');
  await expect(overlay.getByText('Accounts 1–10 of 10')).toBeVisible();
  await expect(overlay.getByRole('button', { name: 'Next', exact: true })).toBeHidden();
  await expect(overlay.getByText(/^1 of 1$/)).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(overlay).toBeHidden();

  await screen.getByRole('checkbox').first().check();
  await expect(screen.getByText('11 of 11 selected')).toBeVisible();
  await screen.getByRole('button', { name: 'Next (11)' }).click();
  await expect(overlay.getByText('1 of 2')).toBeVisible();
  await overlay.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(overlay.getByText('2 of 2')).toBeVisible();
  await expect(overlay.getByText('Scan every code in turn — 2 in total.')).toBeVisible();
  await page.keyboard.press('Escape');

  await screen.getByRole('button', { name: 'Clear all' }).click();
  await expect(screen.getByRole('button', { name: /^Next \(0\)$/ })).toBeDisabled();
});
