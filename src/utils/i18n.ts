// Translation loader.
//
// The strings themselves live one file per language in locales/. Vite emits
// each as its own chunk, so the popup parses ~13 KB for the active language
// instead of ~265 KB for all twenty. That matters because the extension is
// downloaded once as a single package but the popup is opened thousands of
// times, and it cannot paint until its JavaScript has been parsed and run.
//
// English is imported statically: it is the fallback for any key a translation
// is missing, and it guarantees there is always something to render before the
// active locale's chunk has loaded.

import en from './locales/en';
import type { TranslationKey, TranslationStrings } from './i18n-keys';
import { detectLanguage, SUPPORTED_LANGUAGES as SUPPORTED, type Language } from './language';

export type { TranslationKey, TranslationStrings };
export { detectLanguage, languages, matchLanguage, type Language } from './language';

/**
 * The language a page opens in: the stored choice, else the browser's.
 *
 * Every page has to apply the same rule, and the passkey window did not — it
 * followed the browser alone, so someone who had picked Russian in the popup of
 * an English Chrome got an English window in the middle of an unlock. A stored
 * value we do not ship (an older build's code, a hand-edited profile) counts as
 * no choice rather than as a language nothing can render.
 */
export function resolveLanguage(stored: unknown): Language {
  if (typeof stored === 'string' && SUPPORTED.has(stored)) return stored as Language;
  return detectLanguage();
}

/**
 * Languages written right to left.
 *
 * Without `dir`, the document lays out left-to-right and Arabic gets a
 * left-to-right paragraph direction. Purely Arabic runs still read correctly —
 * the bidi algorithm handles those — but anything mixed comes out wrong:
 * "قيّمنا على متجر Chrome الإلكتروني" places its three runs in the wrong visual
 * order, and trailing punctuation lands at the start of the line.
 */
const RTL_LANGUAGES: ReadonlySet<Language> = new Set<Language>(['ar']);

export function isRTL(language: Language): boolean {
  return RTL_LANGUAGES.has(language);
}

/**
 * Put the active language on <html>, along with its writing direction.
 *
 * `dir` mirrors the whole layout, which is why every physical spacing and
 * position utility in the UI is a logical one (`ms-`/`me-`, `ps-`/`pe-`,
 * `start-`/`end-`, `text-start`): in a left-to-right language they resolve
 * identically, and in Arabic they flip with everything else instead of leaving
 * the odd control stranded on the wrong side.
 *
 * `lang` matters on its own too — it picks the font stack and hyphenation, and
 * tells a screen reader which language to pronounce.
 */
export function applyDocumentLanguage(language: Language): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = language;
  document.documentElement.dir = isRTL(language) ? 'rtl' : 'ltr';
}

const loaded: Partial<Record<Language, TranslationStrings>> = { en };
let active: TranslationStrings = en;
let activeLanguage: Language = 'en';

/**
 * Load a language's chunk and make it the one `t()` reads from.
 *
 * Await this before rendering in a non-English language; until it resolves
 * `t()` returns English rather than raw keys, so an early paint is still
 * readable.
 */
export async function loadLanguage(language: Language): Promise<void> {
  if (loaded[language]) {
    active = loaded[language]!;
    activeLanguage = language;
    return;
  }

  try {
    // Vite turns this template into one chunk per matching file, all shipped
    // inside the extension package — nothing is fetched over the network.
    const module = await import(`./locales/${language}.ts`);
    loaded[language] = module.default as TranslationStrings;
    active = loaded[language]!;
    activeLanguage = language;
  } catch (error) {
    // A missing or corrupt chunk must not blank the UI.
    console.error(`Failed to load translations for "${language}"`, error);
  }
}

/**
 * Activate a table the caller already holds, without the dynamic import.
 *
 * For the service worker: Chrome refuses `import()` there outright
 * ("import() is disallowed on ServiceWorkerGlobalScope"), so loadLanguage
 * failed on every wake and the right-click item and the in-page notices were
 * English for everyone. The worker imports its tables statically instead.
 */
export function activateLanguageTable(language: Language, strings: TranslationStrings): void {
  loaded[language] = strings;
  active = strings;
  activeLanguage = language;
}

export function getActiveLanguage(): Language {
  return activeLanguage;
}

/** The CLDR categories a plural block may name. */
export const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;
export type PluralCategory = (typeof PLURAL_CATEGORIES)[number];

export interface PluralBlock {
  /** Which argument the block counts: the N of `{N, plural, …}`. */
  arg: number;
  forms: Partial<Record<PluralCategory, string>>;
  /** Where the block starts and ends in the string, end exclusive. */
  start: number;
  end: number;
}

const PLURAL_HEAD = /\{(\d+),\s*plural,/y;
const PLURAL_FORM = /\s*(zero|one|two|few|many|other)\s*\{/y;

/**
 * Every `{N, plural, one {…} other {…}}` block in a string.
 *
 * The subset of ICU MessageFormat the tables need and nothing more: a block
 * picks one form by the number in argument N, `#` inside the form stands for
 * that number, and a form may carry the ordinary `{1}` placeholders. A block
 * rather than one key per form, because some sentences count two things — "3
 * links saved, 1 account left out" — and in Russian each noun takes its own
 * form. "аккаунт(ов)" was the workaround, and it read as a form nobody fills in.
 *
 * Throws on a block it cannot read; the test over every table calls this, so a
 * broken translation fails there and not in front of a user.
 */
export function parsePluralBlocks(text: string): PluralBlock[] {
  const blocks: PluralBlock[] = [];
  for (let i = text.indexOf('{'); i !== -1; i = text.indexOf('{', i + 1)) {
    PLURAL_HEAD.lastIndex = i;
    const head = PLURAL_HEAD.exec(text);
    if (!head) continue;

    const forms: PluralBlock['forms'] = {};
    let at = PLURAL_HEAD.lastIndex;
    for (;;) {
      while (text[at] === ' ') at++;
      if (text[at] === '}') {
        at++;
        break;
      }
      PLURAL_FORM.lastIndex = at;
      const form = PLURAL_FORM.exec(text);
      if (!form) throw new Error(`Unreadable plural form at "${text.slice(at, at + 20)}"`);
      at = PLURAL_FORM.lastIndex;
      const start = at;
      let depth = 1;
      while (at < text.length && depth > 0) {
        if (text[at] === '{') depth++;
        else if (text[at] === '}') depth--;
        at++;
      }
      if (depth > 0) throw new Error('Unbalanced braces in a plural block');
      forms[form[1] as PluralCategory] = text.slice(start, at - 1);
    }
    if (forms.other === undefined) throw new Error('A plural block needs an "other" form');
    blocks.push({ arg: Number(head[1]), forms, start: i, end: at });
    i = at - 1;
  }
  return blocks;
}

const pluralRules = new Map<Language, Intl.PluralRules>();

/** The plural category a number takes in a language — cached, it is asked on every render. */
export function pluralCategory(language: Language, count: number): PluralCategory {
  let rules = pluralRules.get(language);
  if (!rules) {
    try {
      rules = new Intl.PluralRules(language);
    } catch {
      rules = new Intl.PluralRules('en');
    }
    pluralRules.set(language, rules);
  }
  return rules.select(count) as PluralCategory;
}

/**
 * Fill a table string: plural blocks first, then the plain placeholders.
 *
 * In that order so an argument can never be read as syntax — a group named
 * "{0, plural, …}" is inserted as text, after every block has been decided.
 */
export function formatMessage(text: string, language: Language, args: (string | number)[]): string {
  let blocks: PluralBlock[] = [];
  try {
    blocks = parsePluralBlocks(text);
  } catch (error) {
    console.error('Unreadable plural block in a translation:', error);
  }

  let resolved = text;
  for (const block of blocks.reverse()) {
    const count = Number(args[block.arg]);
    const category = Number.isFinite(count) ? pluralCategory(language, count) : 'other';
    // A form the table left out falls back to "other" rather than to nothing:
    // a half-translated sentence still beats an empty toast.
    const form = (block.forms[category] ?? block.forms.other ?? '').replace(/#/g, () => String(args[block.arg] ?? ''));
    resolved = resolved.slice(0, block.start) + form + resolved.slice(block.end);
  }

  // One pass over the placeholders the table wrote, not one replace per
  // argument: an argument is user-typed text — a group name, an account name —
  // and replacing in turn let a group called "{1}" pick up the next argument.
  // The replacement goes through a function so `$&`, `` $` ``, `$'` and `$1`
  // inside it are inserted literally; as a plain string a group called
  // "Work $& Home" made replace() splice the match back in, while "A$'B"
  // silently deleted text.
  return resolved.replace(/\{(\d+)\}/g, (match, index: string) =>
    Number(index) < args.length ? String(args[Number(index)]) : match
  );
}

// `language` is kept in the signature so every call site stays unchanged and
// components still re-render when it changes; the active table is module state
// because `t()` has to remain synchronous.
export function getTranslation(
  _language: Language,
  key: TranslationKey,
  ...args: (string | number)[]
): string {
  // The table that supplied the text decides the plural rules: a key missing
  // from the active table comes back in English, and must be counted in it.
  const own = active[key];
  const text = own || en[key] || key;
  return formatMessage(text, own ? activeLanguage : 'en', args);
}

export function createT(language: Language) {
  return (key: TranslationKey, ...args: (string | number)[]): string =>
    getTranslation(language, key, ...args);
}
