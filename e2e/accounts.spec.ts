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

  await page.getByRole('button', { name: 'In another app or a backup file' }).click();
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

  await page.getByRole('button', { name: "I'm turning on 2FA for a site" }).click();
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

test("a group's chip renames or deletes the group from its right-click menu, and the accounts stay", async ({
  context,
  extensionId,
}) => {
  const page = await openPage(context, extensionId, 'popup.html');
  await addAccountByHand(page, 'work1@example.com', otherSecret(1));
  await addAccountByHand(page, 'work2@example.com', otherSecret(2));
  await addAccountByHand(page, 'home@example.com', otherSecret(3));
  // Grouped in storage rather than through the form: what is under test is the
  // menu, and the popup follows a direct write as it follows any other.
  await page.evaluate(async () => {
    const { authenticator_accounts: stored } = await chrome.storage.local.get('authenticator_accounts');
    for (const account of stored) if (String(account.name).startsWith('work')) account.group = 'Work';
    await chrome.storage.local.set({ authenticator_accounts: stored });
  });

  const strip = page.locator('[data-ui="toolbar"]');
  const chip = (name: string) => strip.getByRole('button', { name: new RegExp(`^${name}\\s*\\d+$`) });
  await expect(chip('Work')).toBeVisible();

  // "All" and "No group" are not groups: nothing to rename, nothing to delete.
  await chip('All').click({ button: 'right' });
  await expect(page.getByRole('menu')).toHaveCount(0);

  await chip('Work').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename group' }).click();
  const prompt = page.getByRole('dialog', { name: 'Rename group' });
  await expect(prompt.getByRole('textbox')).toHaveValue('Work');
  await prompt.getByRole('textbox').fill('Job');
  await prompt.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(chip('Job')).toHaveText(/2$/);
  await expect(chip('Work')).toHaveCount(0);

  await chip('Job').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete group' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Delete group' });
  await expect(confirm).toContainText('The accounts and their codes stay');
  await confirm.getByRole('button', { name: 'Delete group' }).click();

  // The last group gone, the strip goes with it, and every account is still here.
  await expect(strip).toHaveCount(0);
  await expect(cards(page)).toHaveCount(3);
  const stored = await storedAccounts(page);
  expect(stored).toHaveLength(3);
  expect(stored.every((account) => !('group' in account))).toBe(true);
});

test('a strip with more groups than fit scrolls with the mouse wheel and with its arrows', async ({
  context,
  extensionId,
}) => {
  const page = await openPage(context, extensionId, 'popup.html');
  await page.setViewportSize({ width: 360, height: 600 });
  for (let index = 1; index <= 6; index++) await addAccountByHand(page, `user${index}@example.com`, otherSecret(index));
  await page.evaluate(async () => {
    const { authenticator_accounts: stored } = await chrome.storage.local.get('authenticator_accounts');
    stored.forEach((account: { group?: string }, index: number) => (account.group = `Group number ${index + 1}`));
    await chrome.storage.local.set({ authenticator_accounts: stored });
  });

  const scroller = page.locator('[data-ui="toolbar"] > div').first();
  const position = () => scroller.evaluate((element) => element.scrollLeft);
  await expect(page.locator('[data-ui="toolbar"]').getByRole('button', { name: /^Group number 6/ })).toBeAttached();
  expect(await position()).toBe(0);

  // A plain vertical wheel over the strip moves it sideways.
  await scroller.hover();
  await page.mouse.wheel(0, 200);
  await expect.poll(position).toBeGreaterThan(0);

  // Back to the start by the arrow, which then goes, its work done.
  const back = page.locator('[data-ui="toolbar"] > button').first();
  for (let i = 0; i < 5 && (await position()) > 0; i++) {
    await back.click();
    await page.waitForTimeout(400);
  }
  expect(await position()).toBe(0);
  await expect(page.locator('[data-ui="toolbar"] > button')).toHaveCount(1);
});

/** Put the named accounts into groups straight in storage — the popup follows the write. */
async function groupInStorage(page: import('@playwright/test').Page, groups: Record<string, string>) {
  await page.evaluate(async (byName) => {
    const { authenticator_accounts: stored } = await chrome.storage.local.get('authenticator_accounts');
    for (const account of stored) if (byName[account.name]) account.group = byName[account.name];
    await chrome.storage.local.set({ authenticator_accounts: stored });
  }, groups);
}

const chipIn = (page: import('@playwright/test').Page, name: string) =>
  page.locator('[data-ui="toolbar"]').getByRole('button', { name: new RegExp(`^${name}\\s*\\d+$`) });

test("an account's right-click menu moves it into a new group, and Undo takes it back", async ({ context, extensionId }) => {
  const page = await openPage(context, extensionId, 'popup.html');
  await addAccountByHand(page, 'one@example.com', otherSecret(1));
  await addAccountByHand(page, 'two@example.com', otherSecret(2));

  await cards(page).filter({ hasText: 'one@example.com' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to group' }).click();
  await page.getByRole('menuitem', { name: 'New group…' }).click();
  const prompt = page.getByRole('dialog', { name: 'New group' });
  await prompt.getByRole('textbox').fill('Work');
  await prompt.getByRole('button', { name: 'Create' }).click();

  await expect(chipIn(page, 'Work')).toHaveText(/1$/);
  expect((await storedAccounts(page)).find((a) => a.name === 'one@example.com')?.group).toBe('Work');

  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(chipIn(page, 'Work')).toHaveCount(0);
  expect((await storedAccounts(page)).every((a) => !('group' in a))).toBe(true);
});

test('"+" on the strip names a group and then picks its accounts', async ({ context, extensionId }) => {
  const page = await openPage(context, extensionId, 'popup.html');
  for (const [i, name] of ['a@example.com', 'b@example.com', 'c@example.com'].entries()) {
    await addAccountByHand(page, name, otherSecret(i + 1));
  }
  await groupInStorage(page, { 'a@example.com': 'Old' });
  await chipIn(page, 'Old').click();

  await page.getByRole('button', { name: 'New group' }).click();
  const prompt = page.getByRole('dialog', { name: 'New group' });
  await prompt.getByRole('textbox').fill('Banks');
  await prompt.getByRole('button', { name: 'Choose accounts' }).click();

  // The whole list, not the filter that was on.
  await expect(cards(page)).toHaveCount(3);
  const bar = page.locator('[data-ui="selection-bar"]');
  await expect(bar).toContainText('Choose accounts for “Banks”');
  await page.getByRole('checkbox', { name: 'b@example.com' }).click();
  await page.getByRole('checkbox', { name: 'c@example.com' }).click();
  await expect(bar).toContainText('Selected: 2');
  await bar.getByRole('button', { name: 'Move to “Banks”' }).click();

  await expect(bar).toHaveCount(0);
  await expect(chipIn(page, 'Banks')).toHaveText(/2$/);
  const stored = await storedAccounts(page);
  expect(stored.filter((a) => a.group === 'Banks').map((a) => a.name).sort()).toEqual(['b@example.com', 'c@example.com']);
});

test('a pinned account stays on top, and the order of the group chips is the one dragged', async ({ context, extensionId }) => {
  const page = await openPage(context, extensionId, 'popup.html');
  for (const [i, name] of ['first@example.com', 'second@example.com', 'third@example.com'].entries()) {
    await addAccountByHand(page, name, otherSecret(i + 1));
  }
  const before = await cardNames(page);
  const last = before[before.length - 1];
  await cards(page).filter({ hasText: last }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Pin to top' }).click();
  await expect.poll(async () => (await cardNames(page))[0]).toBe(last);
  await page.reload();
  await expect(cards(page)).toHaveCount(3);
  expect((await cardNames(page))[0]).toBe(last);

  await groupInStorage(page, { 'first@example.com': 'Alpha', 'second@example.com': 'Beta', 'third@example.com': 'Gamma' });
  await expect(chipIn(page, 'Gamma')).toBeVisible();
  await chipIn(page, 'Gamma').dragTo(chipIn(page, 'Alpha'));
  const order = () =>
    page.locator('[data-ui="toolbar"] [draggable="true"]').evaluateAll((chips) => chips.map((c) => c.textContent?.replace(/\d+$/, '').trim()));
  await expect.poll(order).toEqual(['Gamma', 'Alpha', 'Beta']);
  await page.reload();
  await expect.poll(order).toEqual(['Gamma', 'Alpha', 'Beta']);
});

test('the keyboard walks the list from the search box, and Enter there copies the first match', async ({ context, extensionId }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await openPage(context, extensionId, 'popup.html');
  await addAccountByHand(page, 'alpha@example.com', otherSecret(1));
  await addAccountByHand(page, 'beta@example.com', otherSecret(2));

  const search = page.getByRole('textbox', { name: /search/i });
  await search.fill('beta');
  await search.press('Enter');
  await expect(cards(page).filter({ hasText: 'beta@example.com' })).toContainText('Copied');

  await search.fill('');
  await search.press('ArrowDown');
  const focusedRow = () => page.evaluate(() => document.activeElement?.closest('[data-account-id]')?.getAttribute('data-account-id'));
  const ids = await cards(page).evaluateAll((rows) => rows.map((r) => r.getAttribute('data-account-id')));
  expect(await focusedRow()).toBe(ids[0]);
  await page.keyboard.press('ArrowDown');
  expect(await focusedRow()).toBe(ids[1]);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(search).toBeFocused();
});

test("an account's menu opens from the keyboard, under the row in focus", async ({ context, extensionId }) => {
  const page = await openPage(context, extensionId, 'popup.html');
  await addAccountByHand(page, 'keys@example.com', otherSecret(1));
  const search = page.getByRole('textbox', { name: /search/i });
  await search.focus();
  await search.press('ArrowDown');
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Pin to top' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
});

test('several selected accounts are deleted after a confirmation that counts them, and Undo brings all back in place', async ({ context, extensionId }) => {
  const page = await openPage(context, extensionId, 'popup.html');
  for (const [i, name] of ['one@example.com', 'two@example.com', 'three@example.com'].entries()) {
    await addAccountByHand(page, name, otherSecret(i + 1));
  }
  const order = await cardNames(page);

  await cards(page).filter({ hasText: 'one@example.com' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Select' }).click();
  await page.getByRole('checkbox', { name: 'three@example.com' }).click();
  await page.locator('[data-ui="selection-bar"]').getByRole('button', { name: 'Delete selected' }).click();

  const confirm = page.getByRole('alertdialog', { name: 'Delete the selected accounts?' });
  await expect(confirm).toContainText('one@example.com');
  await expect(confirm).toContainText('three@example.com');
  await confirm.getByRole('button', { name: 'Delete (2)' }).click();

  await expect(cards(page)).toHaveCount(1);
  expect((await storedAccounts(page)).map((a) => a.name)).toEqual(['two@example.com']);

  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(cards(page)).toHaveCount(3);
  await expect.poll(() => cardNames(page)).toEqual(order);
});
