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

  scenario('A count takes the form its language gives it');
  {
    const ru = (await import('@/utils/locales/ru')).default;
    const ar = (await import('@/utils/locales/ar')).default;
    const en = (await import('@/utils/locales/en')).default;
    const say = (table: Record<string, string>, lang: 'ru' | 'ar' | 'en', key: string, n: number) =>
      i18n.formatMessage(table[key], lang, [n]);

    const ruCases: Array<[number, string]> = [
      [1, '1 аккаунт'],
      [2, '2 аккаунта'],
      [5, '5 аккаунтов'],
      [21, '21 аккаунт'],
      [11, '11 аккаунтов'],
      [22, '22 аккаунта'],
    ];
    for (const [n, expected] of ruCases) {
      const got = say(ru, 'ru', 'restore.count', n);
      check(`ru ${n} → «${expected}»`, got === expected, got);
    }

    const categories = [0, 1, 2, 3, 11, 100].map((n) => i18n.pluralCategory('ar', n)).join(',');
    check('ar 0/1/2/3/11/100 are zero/one/two/few/many/other', categories === 'zero,one,two,few,many,other', categories);
    const arForms = [0, 1, 2, 3, 11, 100].map((n) => say(ar, 'ar', 'restore.count', n));
    check('and each gets a different Arabic form', new Set(arForms).size === 6, arForms.join(' | '));
    check('ar 3 is the plural with the number', arForms[3].includes('3 حسابات'), arForms[3]);

    check('en 1 → singular', say(en, 'en', 'restore.count', 1) === '1 account');
    check('en 7 → plural', say(en, 'en', 'restore.count', 7) === '7 accounts');
  }

  scenario('Plural blocks are read safely');
  {
    const text = 'Saved {0, plural, one {# link} other {# links}}. {1, plural, one {# account was} other {# accounts were}} left out of {2}.';
    check('two counts in one sentence, each with its own form', i18n.formatMessage(text, 'en', [1, 3, 'Work']) === 'Saved 1 link. 3 accounts were left out of Work.');
    check(
      'an argument is never read as syntax',
      i18n.formatMessage('Added to {0}', 'en', ['{0, plural, one {x} other {y}}']) === 'Added to {0, plural, one {x} other {y}}'
    );
    check('nor as a placeholder for the next one', i18n.formatMessage('{0} and {1}', 'en', ['{1}', 'b']) === '{1} and b');
    check('"$&" in a group name is inserted literally', i18n.formatMessage('Into {0}', 'en', ['Work $& Home']) === 'Into Work $& Home');
    check('a count that is not a number takes "other"', i18n.formatMessage('{0, plural, one {# day} other {# days}}', 'en', ['?']) === '? days');
    let threw = false;
    try {
      i18n.parsePluralBlocks('{0, plural, one {# x}');
    } catch {
      threw = true;
    }
    check('an unfinished block is refused by the parser', threw);
    check('and formatting it does not throw', typeof i18n.formatMessage('{0, plural, one {# x}', 'en', [1]) === 'string');
  }

  scenario('Every table counts correctly in its own language');
  {
    const en = (await import('@/utils/locales/en')).default as unknown as Record<string, string>;
    const pluralKeys = Object.keys(en).filter((key) => i18n.parsePluralBlocks(en[key]).length > 0);
    check('English marks its counted strings', pluralKeys.length >= 30, String(pluralKeys.length));

    const problems: string[] = [];
    for (const { code } of i18n.languages) {
      const table = (await import(`../src/utils/locales/${code}.ts`)).default as Record<string, string>;
      const required = new Intl.PluralRules(code).resolvedOptions().pluralCategories;
      for (const [key, value] of Object.entries(table)) {
        let blocks: ReturnType<typeof i18n.parsePluralBlocks>;
        try {
          blocks = i18n.parsePluralBlocks(value);
        } catch (error) {
          problems.push(`${code} ${key}: ${(error as Error).message}`);
          continue;
        }
        for (const block of blocks) {
          const missing = required.filter((category) => !(category in block.forms));
          if (missing.length) problems.push(`${code} ${key} {${block.arg}} lacks ${missing.join('/')}`);
          const extra = Object.keys(block.forms).filter((category) => !required.includes(category as Intl.LDMLPluralRule));
          if (extra.length) problems.push(`${code} ${key} {${block.arg}} has ${extra.join('/')}, not a category of ${code}`);
        }
        // "account(s)", "аккаунт(ов)", "kont(o)": the workaround the blocks
        // replace. Korean particles like 을(를) are the language's own
        // convention and are left alone.
        if (/[\p{L}]\([\p{L}]{1,4}\)/u.test(value.replace(/[\uac00-\ud7af]\(/g, ''))) {
          problems.push(`${code} ${key}: still spells a plural as x(s)`);
        }
      }
      // A language with more than one form must choose one wherever English does.
      if (required.length > 1) {
        for (const key of pluralKeys) {
          if (i18n.parsePluralBlocks(table[key] ?? '').length === 0) problems.push(`${code} ${key}: no plural block`);
        }
      }
    }
    check('every block has the forms its language needs, and only those', problems.length === 0, problems.slice(0, 10).join('; '));
  }
}
