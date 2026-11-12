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
  // Focus starts on the screen's own way out, not back behind it on Export.
  const back = screen.getByRole('button', { name: 'Back' });
  await expect(back).toBeFocused();

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

  // The button that opened the screen went with the export window, so focus
  // returns to Export rather than dropping to the page.
  await back.click();
  await expect(screen).toBeHidden();
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeFocused();
});

test('an account Google Authenticator cannot carry is named, not ticked and not counted', async ({ context, extensionId }) => {
  const page = await openPage(context, extensionId, 'popup.html');

  await page.getByRole('button', { name: 'In another app or a backup file' }).click();
  await page.getByRole('button', { name: 'Paste links', exact: true }).click();
  const paste = page.getByRole('dialog', { name: 'Paste otpauth:// links' });
  await paste.getByRole('textbox').fill(
    [
      `otpauth://totp/One:one@example.com?secret=${otherSecret(40)}&issuer=One`,
      `otpauth://totp/Slow:slow@example.com?secret=${otherSecret(41)}&issuer=Slow&period=60`,
      `otpauth://totp/Two:two@example.com?secret=${otherSecret(42)}&issuer=Two`,
    ].join('\n')
  );
  await paste.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(cards(page)).toHaveCount(3);

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('button', { name: 'Choose accounts' }).click();

  const screen = page.getByRole('dialog', { name: 'To Google Authenticator' });
  const slow = screen.getByRole('checkbox', { name: /slow@example\.com/ });
  await expect(slow).toBeDisabled();
  await expect(slow).not.toBeChecked();
  await expect(screen.getByRole('listitem').filter({ hasText: 'slow@example.com' })).toContainText("60s period isn't supported");
  await expect(screen.getByText('2 of 2 selected')).toBeVisible();
  await expect(screen.getByRole('button', { name: 'Next (2)' })).toBeEnabled();
});
