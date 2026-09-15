// The Product Hunt launch banner: when it may appear, and when it stops.
//
// It ships days before the launch inside a build nobody can recall, so the date
// arithmetic is the whole feature — a window off by a day is a banner shown to
// 150k people for a launch that has not started, or never shown at all.

import { areas, check, resetState, scenario } from './harness';

const HOUR = 60 * 60 * 1000;
const LAUNCH = '2026-10-06T00:01:00-07:00';
const START = Date.parse(LAUNCH);

export async function run(): Promise<void> {
  const ph = await import('@/utils/product-hunt');

  scenario('No launch date, no window');
  check('null is off', !ph.launchWindowOpen(null, START));
  check('an unreadable date is off rather than always on', !ph.launchWindowOpen('next tuesday', START));

  // The banner says "today": the window is the Product Hunt day and not a
  // minute of the next one.
  scenario('The window is the launch day, in Pacific time');
  check('not an hour before', !ph.launchWindowOpen(LAUNCH, START - HOUR));
  check('open from 00:01 PT', ph.launchWindowOpen(LAUNCH, START));
  check('still open twenty hours in', ph.launchWindowOpen(LAUNCH, START + 20 * HOUR));
  check('closed once the day is over', !ph.launchWindowOpen(LAUNCH, START + 24 * HOUR));

  scenario('Only people who use the extension are asked');
  await resetState();
  areas.local.openCount = 2;
  check('not after two opens', !(await ph.productHuntDue(LAUNCH, START + HOUR)));
  areas.local.openCount = 3;
  check('yes at three', await ph.productHuntDue(LAUNCH, START + HOUR));

  // Rating stops the open counter, so without this the most loyal users — the
  // ones who rated early, from the "What's New" modal — would never be asked.
  scenario('Having rated counts, though rating froze the counter');
  await resetState();
  areas.local.openCount = 1;
  areas.local.reviewDismissed = true;
  check('asked anyway', await ph.productHuntDue(LAUNCH, START + HOUR));

  scenario('It stays until answered, and an answer is final for that launch');
  await resetState();
  areas.local.openCount = 40;
  check('still up on a later open', await ph.productHuntDue(LAUNCH, START + 2 * HOUR));
  await ph.dismissProductHunt(LAUNCH);
  check('gone once answered', !(await ph.productHuntDue(LAUNCH, START + 3 * HOUR)));
  const next = '2027-03-02T00:01:00-08:00';
  check('a later launch is a new question', await ph.productHuntDue(next, Date.parse(next) + HOUR));

  // The offset is typed by hand, and Pacific time is -07:00 in summer and
  // -08:00 from November: a launch date copied from a summer example into a
  // winter launch would put the banner up an hour late and take it down an hour
  // late. This compares whatever date is set against the real Pacific offset for
  // that day, so the mistake fails the build instead of reaching 150k popups.
  scenario('The launch date that ships is written in Pacific time');
  if (ph.PRODUCT_HUNT_LAUNCH === null) {
    check('no launch set, nothing to check', true);
  } else {
    const written = /([+-]\d{2}:\d{2})$/.exec(ph.PRODUCT_HUNT_LAUNCH)?.[1] ?? '(none)';
    const pacific = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', timeZoneName: 'longOffset' })
      .formatToParts(new Date(Date.parse(ph.PRODUCT_HUNT_LAUNCH)))
      .find((part) => part.type === 'timeZoneName')
      ?.value.replace('GMT', '');
    check(
      `${ph.PRODUCT_HUNT_LAUNCH} carries the Pacific offset for that day`,
      written === pacific,
      `written ${written}, Pacific is ${pacific}`
    );
  }

  scenario('Answering with no launch set writes nothing');
  await resetState();
  await ph.dismissProductHunt(null);
  check('storage untouched', areas.local.productHuntDoneFor === undefined);
}
