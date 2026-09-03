// Where the toolbar icon opens the app, and what each surface is sized by.
//
// The three modes ship publicly for the first time in 1.13.0, and the parts
// that decide them are pure: which page is which host, which stored value is a
// mode at all, which bounds are worth restoring, and which tab has a site
// worth suggesting against. A wrong answer in any of them is an icon that
// opens the wrong thing — or nothing.

import { check, scenario } from './harness';

export async function run(): Promise<void> {
  const openMode = await import('@/utils/open-mode');
  const popout = await import('@/utils/popout');
  const size = await import('@/utils/popup-size');

  scenario('Every host page maps to its own mode');
  {
    const cases: Array<[string, string]> = [
      ['/popup.html', 'popup'],
      ['/window.html', 'window'],
      ['/sidepanel.html', 'sidepanel'],
      // Anything else is the popup: the scanner and the passkey page borrow
      // the same shell, and a surface we cannot name must not be sized as a
      // window the user can drag.
      ['/scan.html', 'popup'],
      ['/', 'popup'],
    ];
    for (const [path, expected] of cases) {
      const got = openMode.detectHost(path);
      check(`${path} → ${expected}`, got === expected, got);
    }

    // The pages the modes name have to be the pages that exist.
    const named = Object.values(openMode.HOST_PAGES);
    check(
      'and each mode names a page that maps back to it',
      named.every((page) => openMode.detectHost(`/${page}`) !== undefined),
      named.join(', ')
    );
  }

  scenario('A stored mode is only honoured when it is one we ship');
  {
    for (const value of ['popup', 'window', 'sidepanel']) {
      check(`${value} is kept`, openMode.readOpenMode(value) === value);
    }
    for (const value of ['SIDEPANEL', 'panel', '', null, undefined, 3, {}]) {
      check(`${JSON.stringify(value) ?? 'undefined'} is refused`, openMode.readOpenMode(value) === null);
    }
  }

  scenario('Only the popup is sized by the preset');
  {
    const small = size.popupSizeStyle('small');
    check('the popup takes the preset', JSON.stringify(size.rootSizeStyle('popup', 'small')) === JSON.stringify(small));
    for (const host of ['window', 'sidepanel'] as const) {
      const style = size.rootSizeStyle(host, 'small');
      check(
        `${host} fills what it is given instead`,
        style.width === '100vw' && style.height === '100vh',
        JSON.stringify(style)
      );
    }
  }

  scenario('A site is suggested only for a page that has one');
  {
    check('https', popout.siteOfUrl('https://github.com/login') === 'github.com');
    check('http', popout.siteOfUrl('http://example.org/a?b=c') === 'example.org');
    // "extensions" is the hostname of chrome://extensions, and it used to be
    // handed to the floating window in its URL as if it were a site.
    for (const url of [
      'chrome://extensions',
      'file:///Users/a/page.html',
      'about:blank',
      'chrome-extension://abc/popup.html',
      'not a url',
      undefined,
    ]) {
      check(`${String(url)} has none`, popout.siteOfUrl(url) === undefined, String(popout.siteOfUrl(url)));
    }
  }

  scenario('Remembered window bounds survive only if they still make sense');
  {
    const kept = popout.readPopoutBounds({ width: 480, height: 620, left: 100, top: 40 });
    check('a sane rectangle is kept', kept.width === 480 && kept.height === 620 && kept.left === 100);

    const rounded = popout.readPopoutBounds({ width: 480.6, height: 620.2, left: 10.9, top: 40.4 });
    check('fractions are rounded', rounded.width === 481 && rounded.left === 11, JSON.stringify(rounded));

    for (const value of [
      null,
      undefined,
      'wide',
      { width: 10, height: 620 },
      { width: 480, height: 10 },
      { width: Number.NaN, height: 620 },
      { width: 480 },
    ]) {
      const fallback = popout.readPopoutBounds(value);
      check(
        `${JSON.stringify(value) ?? 'undefined'} falls back to the default size`,
        fallback.width >= 320 && fallback.height >= 320,
        JSON.stringify(fallback)
      );
    }
  }
}
