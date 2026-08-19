// Which language the extension opens in.
//
// Twenty translated interfaces shipped behind a dropdown that nothing pointed
// at, so every install started in English — including for the people least able
// to read it, who are exactly the ones a translation is for. The rule now: a
// stored choice always wins, and without one the browser decides.

import { check, scenario } from './harness';

export async function run(): Promise<void> {
  const i18n = await import('@/utils/i18n');

  scenario('A browser language maps to the closest interface we ship');
  {
    const cases: Array<[string | null | undefined, string]> = [
      ['ru', 'ru'],
      ['ru-RU', 'ru'],
      ['RU-ru', 'ru'],
      ['en-GB', 'en'],
      ['pt-BR', 'pt'],   // one Portuguese file serves both
      ['pt-PT', 'pt'],
      ['es-419', 'es'],  // Latin American Spanish, region as a numeric code
      ['zh-CN', 'zh'],
      ['zh-TW', 'zh'],   // Simplified is closer than English
      ['zh-Hant-HK', 'zh'],
      ['in', 'id'],      // the pre-1989 code Chrome still reports for Indonesian
      ['in-ID', 'id'],
      ['nb-NO', 'en'],   // Norwegian: not translated, so English rather than a guess
      ['he', 'en'],
      ['', 'en'],
      [null, 'en'],
      [undefined, 'en'],
      ['not a language tag', 'en'],
    ];

    for (const [tag, expected] of cases) {
      const got = i18n.matchLanguage(tag);
      check(`${JSON.stringify(tag)} → ${expected}`, got === expected, got);
    }
  }

  scenario('Every language we ship recognises itself');
  {
    const wrong = i18n.languages.filter((entry) => i18n.matchLanguage(entry.code) !== entry.code);
    check('all twenty round-trip', wrong.length === 0, wrong.map((entry) => entry.code).join(', '));

    // The regional form of each, which is what a browser actually reports.
    const regional = i18n.languages.filter(
      (entry) => i18n.matchLanguage(`${entry.code}-${entry.code.toUpperCase()}`) !== entry.code
    );
    check('and their regional variants too', regional.length === 0, regional.map((e) => e.code).join(', '));
  }

  scenario('Detection reads the browser, and never throws');
  {
    const chromeGlobal = (globalThis as any).chrome;

    (globalThis as any).chrome = { ...chromeGlobal, i18n: { getUILanguage: () => 'de-DE' } };
    check('a German browser opens in German', i18n.detectLanguage() === 'de');

    (globalThis as any).chrome = { ...chromeGlobal, i18n: { getUILanguage: () => 'sw-KE' } };
    check('an untranslated one falls back to English', i18n.detectLanguage() === 'en');

    // chrome.i18n is absent in some contexts and can throw in others. Neither
    // may be the reason a popup fails to open.
    (globalThis as any).chrome = chromeGlobal;
    check('no chrome.i18n at all is survivable', i18n.detectLanguage() === 'en');

    (globalThis as any).chrome = {
      ...chromeGlobal,
      i18n: {
        getUILanguage: () => {
          throw new Error('unavailable');
        },
      },
    };
    check('and neither is one that throws', i18n.detectLanguage() === 'en');

    (globalThis as any).chrome = chromeGlobal;
  }
}
