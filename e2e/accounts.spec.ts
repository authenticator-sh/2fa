// The account list in a real browser: what the popup draws against what
// chrome.storage.local holds, across a reload, across two windows, and through
// a delete that is taken back.

import {
  SECRET,
  addAccountByHand,
  cardNames,
  cards,
  deleteByHand,
  expect,
  openPage,
  otherSecret,
  storedAccounts,
  test,
  totp,
} from './fixtures';

test.afterEach(({ pageErrors }) => {
  expect(pageErrors, 'uncaught exceptions on extension pages').toEqual([]);
});

test('an account added by hand survives a reload, and the popup shows what storage holds', async ({
  context,
  extensionId,
}) => {
  const page = await openPage(context, extensionId, 'popup.html');
  await addAccountByHand(page, 'e2e@example.com');

  await page.reload();
  await expect(cards(page)).toHaveCount(1);

  // Storage, read inside the extension — not through the UI under test.
  const stored = await storedAccounts(page);
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ name: 'e2e@example.com', secret: SECRET });
  expect(await cardNames(page)).toEqual(stored.map((account) => account.name));

  // The code on screen is the RFC 6238 code for now. The row redraws once a
  // second, so what it shows may be up to a tick old — and a read that
  // straddles the end of a 30 s slot legitimately sees either side of it.
  const code = page.getByTestId('account-code');
  await expect(code).toHaveText(/^\d{3} \d{3}$/);
  const before = Date.now();
  const shown = (await code.innerText()).replace(/\s/g, '');
  const after = Date.now();
  const acceptable = new Set([totp(SECRET, before - 1500), totp(SECRET, before), totp(SECRET, after)]);
  expect([...acceptable], `code on screen at ${new Date(before).toISOString()}`).toContain(shown);
});

test('a delete in one window reaches the other, and stays deleted after both reload', async ({
  context,
  extensionId,
}) => {
  const popup = await openPage(context, extensionId, 'popup.html');
  await addAccountByHand(popup, 'keep@example.com', otherSecret(1));
  await addAccountByHand(popup, 'drop@example.com', otherSecret(2));

  const panel = await openPage(context, extensionId, 'sidepanel.html');
  await expect(cards(panel)).toHaveCount(2);

  await deleteByHand(popup, 'drop@example.com');
  await expect(cards(popup)).toHaveCount(1);
  // No reload: the side panel has to hear about it on its own.
  await expect(cards(panel)).toHaveCount(1);
  await expect(cards(panel).filter({ hasText: 'drop@example.com' })).toHaveCount(0);

  await Promise.all([popup.reload(), panel.reload()]);
  for (const page of [popup, panel]) {
    await expect(cards(page)).toHaveCount(1);
    expect(await cardNames(page)).toEqual(['keep@example.com']);
  }
  expect((await storedAccounts(popup)).map((account) => account.name)).toEqual(['keep@example.com']);
});

test('Undo puts a deleted account back where it was', async ({ context, extensionId }) => {
  const page = await openPage(context, extensionId, 'popup.html');
  const names = ['first@example.com', 'middle@example.com', 'last@example.com'];
  for (const [index, name] of names.entries()) {
    await addAccountByHand(page, name, otherSecret(index + 1));
  }
  const order = await cardNames(page);
  expect(order).toHaveLength(3);
  expect([...order].sort()).toEqual([...names].sort());

  const target = order[1];
  await deleteByHand(page, target);
  await expect(cards(page)).toHaveCount(2);

  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(cards(page)).toHaveCount(3);
  await expect.poll(() => cardNames(page)).toEqual(order);

  await page.reload();
  await expect(cards(page)).toHaveCount(3);
  expect(await cardNames(page)).toEqual(order);
  expect((await storedAccounts(page)).map((account) => account.name)).toEqual(order);
});

test('a list of otpauth:// links goes in straight from the first-run guide', async ({ context, extensionId }) => {
  const page = await openPage(context, extensionId, 'popup.html');

  await page.getByRole('button', { name: 'I have a backup file or otpauth:// links' }).click();
  // The branch ends in the paste box itself, not in a pointer to Settings.
  await page.getByRole('button', { name: 'Paste links', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: 'Paste otpauth:// links' });
  await dialog.getByRole('textbox').fill(
    [
      `otpauth://totp/GitHub:one@example.com?secret=${otherSecret(11)}&issuer=GitHub`,
      `otpauth://totp/Proton:two@example.com?secret=${otherSecret(12)}&issuer=Proton`,
    ].join('\n')
  );
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();

  await expect(cards(page)).toHaveCount(2);
  expect((await storedAccounts(page)).map((account) => account.secret).sort()).toEqual([otherSecret(11), otherSecret(12)].sort());
});

// The tab is only captured when asked, and here nothing grants the capture
// (no toolbar click), so what is checked is that the button is the scan itself
// and that a miss leaves the dialog open on its hint and its other ways in.
test('the first-run guide scans the page at once, and a miss stays in the add dialog', async ({ context, extensionId }) => {
  const page = await openPage(context, extensionId, 'popup.html');

  await page.getByRole('button', { name: 'Scan the QR code on this page' }).click();

  const dialog = page.getByRole('dialog', { name: 'Add Account' });
  // Opened as a tab here, with no click on the icon: no activeTab, and the
  // message says how to get it rather than blaming the page.
  await expect(dialog.getByRole('alert')).toHaveText(/can read a page only when you open it from its icon/);
  await expect(dialog.getByRole('button', { name: 'Choose Image' })).toBeVisible();
});

test('"turning on 2FA" ends in the scan, with the key form beside it', async ({ context, extensionId }) => {
  const page = await openPage(context, extensionId, 'popup.html');

  await page.getByRole('button', { name: "I'm turning on 2-factor authentication right now" }).click();
  await expect(page.getByRole('button', { name: 'Scan QR from screen', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'No QR code? Type the key instead' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add Account' });
  await expect(dialog.getByRole('button', { name: 'Manual', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('a site asking for a code nobody set up has its own way in', async ({ context, extensionId }) => {
  const page = await openPage(context, extensionId, 'popup.html');

  await page.getByRole('button', { name: "A site asks for a code, but I don't have one" }).click();
  await expect(page.getByText(/backup codes the site gave you/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Scan QR from screen', exact: true })).toBeVisible();

  // Back lands on the chooser again.
  await page.getByText('Back', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Scan the QR code on this page' })).toBeVisible();
});

test('the phone branch offers a picture of the code beside the camera', async ({ context, extensionId }) => {
  const page = await openPage(context, extensionId, 'popup.html');

  await page.getByRole('button', { name: 'In Google Authenticator on my phone' }).click();
  await expect(page.getByRole('button', { name: 'Scan QR with camera' })).toBeVisible();

  await page.getByRole('button', { name: 'No camera? Use a picture of the QR code' }).click();
  // Not the next page to open: the install's welcome tab may be that.
  await expect.poll(() => context.pages().some(tab => tab.url().includes('scan.html?mode=image'))).toBe(true);
});

test('"I have a secret key" opens the form where a key is typed', async ({ context, extensionId }) => {
  const page = await openPage(context, extensionId, 'popup.html');

  await page.getByRole('button', { name: 'I have a secret key' }).click();

  // No steps in between, and not the QR tab the form otherwise opens on.
  const dialog = page.getByRole('dialog', { name: 'Add Account' });
  await expect(dialog.getByRole('button', { name: 'Manual', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByLabel('Account Name').fill('key@example.com');
  await dialog.getByLabel('Secret Key').fill(SECRET);
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();

  await expect(cards(page)).toHaveCount(1);
  expect((await storedAccounts(page))[0]).toMatchObject({ name: 'key@example.com', secret: SECRET });
});
