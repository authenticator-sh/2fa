// When the extension is allowed to ask for a review, and — more importantly —
// when it has to stop asking.
//
// This runs against 100k installs on a 4.6-star listing. A prompt that reappears
// on every popup open does not produce reviews; it produces one-star reviews
// about the prompt.

import { areas, check, flush, resetState, scenario } from './harness';

export async function run(): Promise<void> {
  const review = await import('@/utils/review-prompt');
  const activeGroup = await import('@/utils/active-group');
  const storage = await import('@/utils/storage');

  scenario('The ask waits for enough use to have an opinion');
  await resetState();
  check('not on the first open', (await review.shouldShowReviewPrompt(1, 3)) === false);
  check('not at fourteen opens', (await review.shouldShowReviewPrompt(14, 3)) === false);
  check('yes at fifteen', (await review.shouldShowReviewPrompt(15, 3)) === true);

  scenario('Someone who never finished setup is never asked');
  await resetState();
  check('no accounts, no ask', (await review.shouldShowReviewPrompt(500, 0)) === false);

  // The card used to have no memory of having been shown: ignoring it — which is
  // what most people do, having come for a code — left it on screen every open,
  // for good.
  scenario('Ignoring the card three times stands it down');
  await resetState();
  check('first showing', (await review.shouldShowReviewPrompt(20, 3)) === true);
  check('second showing', (await review.shouldShowReviewPrompt(21, 3)) === true);
  check('third showing', (await review.shouldShowReviewPrompt(22, 3)) === true);
  check('and then it stops', (await review.shouldShowReviewPrompt(23, 3)) === false);
  check('it comes back much later', (await review.shouldShowReviewPrompt(200, 3)) === true);

  scenario('"Maybe later" is measured in opens, not days');
  await resetState();
  await review.snoozeReviewPrompt(20);
  check('quiet right after', (await review.shouldShowReviewPrompt(21, 3)) === false);
  check('still quiet at 69', (await review.shouldShowReviewPrompt(69, 3)) === false);
  check('back at 70', (await review.shouldShowReviewPrompt(70, 3)) === true);

  scenario('Rating retires the ask for good');
  await resetState();
  await chrome.storage.local.set({ reviewDismissed: true });
  check('never asked again', (await review.shouldShowReviewPrompt(9999, 5)) === false);
  const before = await review.recordOpen();
  const after = await review.recordOpen();
  check('and the open counter stops climbing', before === after, `${before} → ${after}`);

  // --- the group filter's storage --------------------------------------------
  // Group names are things like "Crypto" and "Work — Acme": metadata about which
  // services someone holds, which is exactly what the vault promises a stolen
  // profile will not reveal.

  scenario('Without a vault the filter is remembered across restarts');
  await resetState();
  await activeGroup.rememberActiveGroup('Work');
  check('it is on disk', areas.local.activeGroup === 'Work');
  check('and reads back', (await activeGroup.readActiveGroup()) === 'Work');

  scenario('The ungrouped filter is a real value, not "nothing"');
  await resetState();
  await activeGroup.rememberActiveGroup('');
  check('the empty string survives the round trip', (await activeGroup.readActiveGroup()) === '');

  scenario('With a vault the filter never touches the disk');
  await resetState();
  await storage.saveAccounts([
    { id: 'v1', name: 'a', issuer: 'A', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, createdAt: 1 },
  ] as any);
  await flush();
  const prepared = await storage.prepareVault('correct horse battery staple');
  await prepared.commit();
  await flush();
  await activeGroup.rememberActiveGroup('Crypto');
  check('nothing in local storage', areas.local.activeGroup === undefined);
  check('the whole local area is free of it', !JSON.stringify(areas.local).includes('Crypto'));
  check('it is held in session instead', areas.session.activeGroup === 'Crypto');
  check('and still reads back for the popup', (await activeGroup.readActiveGroup()) === 'Crypto');

  scenario('Turning the vault on scrubs a filter written before it');
  await resetState();
  await storage.saveAccounts([
    { id: 'v2', name: 'a', issuer: 'A', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, createdAt: 1 },
  ] as any);
  await activeGroup.rememberActiveGroup('Banking');
  await flush();
  check('it starts out on disk', areas.local.activeGroup === 'Banking');
  const prepared2 = await storage.prepareVault('correct horse battery staple');
  await prepared2.commit();
  await flush();
  check('and is gone once the vault is on', areas.local.activeGroup === undefined);

  scenario('Clearing the filter clears it everywhere');
  await resetState();
  await activeGroup.rememberActiveGroup('Work');
  await activeGroup.forgetActiveGroup();
  check('local is clean', areas.local.activeGroup === undefined);
  check('session is clean', areas.session.activeGroup === undefined);
  check('and it reads as no filter', (await activeGroup.readActiveGroup()) === null);
}
