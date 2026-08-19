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

export type { TranslationKey, TranslationStrings };

export type Language = 'en' | 'zh' | 'es' | 'hi' | 'ar' | 'pt' | 'ru' | 'ja' | 'de' | 'fr' | 'ko' | 'it' | 'tr' | 'vi' | 'pl' | 'nl' | 'id' | 'th' | 'uk' | 'sv';

export const languages: { code: Language; label: string; flag: string }[] = [
  { code: 'en', label: 'English', flag: '🇺🇸' },
  { code: 'zh', label: '中文', flag: '🇨🇳' },
  { code: 'es', label: 'Español', flag: '🇪🇸' },
  { code: 'hi', label: 'हिन्दी', flag: '🇮🇳' },
  { code: 'ar', label: 'العربية', flag: '🇸🇦' },
  { code: 'pt', label: 'Português', flag: '🇧🇷' },
  { code: 'ru', label: 'Русский', flag: '🇷🇺' },
  { code: 'ja', label: '日本語', flag: '🇯🇵' },
  { code: 'de', label: 'Deutsch', flag: '🇩🇪' },
  { code: 'fr', label: 'Français', flag: '🇫🇷' },
  { code: 'ko', label: '한국어', flag: '🇰🇷' },
  { code: 'it', label: 'Italiano', flag: '🇮🇹' },
  { code: 'tr', label: 'Türkçe', flag: '🇹🇷' },
  { code: 'vi', label: 'Tiếng Việt', flag: '🇻🇳' },
  { code: 'pl', label: 'Polski', flag: '🇵🇱' },
  { code: 'nl', label: 'Nederlands', flag: '🇳🇱' },
  { code: 'id', label: 'Bahasa Indonesia', flag: '🇮🇩' },
  { code: 'th', label: 'ไทย', flag: '🇹🇭' },
  { code: 'uk', label: 'Українська', flag: '🇺🇦' },
  { code: 'sv', label: 'Svenska', flag: '🇸🇪' },
];

const SUPPORTED: ReadonlySet<string> = new Set(languages.map((entry) => entry.code));

/**
 * Codes Chrome can still report that no longer match the tag we ship under.
 * `in` is the pre-1989 code for Indonesian and Chrome inherits it from Java's
 * locale table; without this, an Indonesian browser silently gets English.
 */
const LEGACY_CODES: Readonly<Record<string, Language>> = { in: 'id' };

/**
 * The best of our twenty languages for a BCP-47 tag, or English.
 *
 * Only the primary subtag is considered, because the region almost never
 * changes which of our files is right: `pt-BR` and `pt-PT` both want `pt`, and
 * every `es-419` variant wants `es`. The one place this is a genuine compromise
 * is Chinese — we ship Simplified only, so `zh-TW` and `zh-HK` are answered
 * with Simplified rather than with English, on the grounds that a reader of
 * Traditional can read it and a reader of English-by-default cannot.
 */
export function matchLanguage(tag: string | null | undefined): Language {
  if (!tag) return 'en';

  const primary = tag.toLowerCase().split(/[-_]/)[0];
  const code = LEGACY_CODES[primary] ?? primary;
  return SUPPORTED.has(code) ? (code as Language) : 'en';
}

/**
 * Which language to open in when the user has never picked one.
 *
 * Twenty translated interfaces were reachable only from a dropdown nobody had
 * a reason to open: every install started in English, including for the people
 * least able to read it. The browser already knows, and `chrome.i18n` needs no
 * permission to ask.
 *
 * Deliberately not persisted. A stored `language` means "the user chose this"
 * and always wins; its absence means "follow the browser", so someone who
 * changes their browser language — or an install that gains a translation in a
 * later release — is followed rather than frozen.
 */
export function detectLanguage(): Language {
  try {
    return matchLanguage(chrome?.i18n?.getUILanguage?.());
  } catch {
    // No chrome.i18n in this context (tests, a stripped build) — English is a
    // fine answer and this must never be the thing that stops the popup.
    return 'en';
  }
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

export function getActiveLanguage(): Language {
  return activeLanguage;
}

// `language` is kept in the signature so every call site stays unchanged and
// components still re-render when it changes; the active table is module state
// because `t()` has to remain synchronous.
export function getTranslation(
  _language: Language,
  key: TranslationKey,
  ...args: (string | number)[]
): string {
  let text = active[key] || en[key] || key;
  args.forEach((arg, i) => {
    // The replacement goes through a function so `$&`, `` $` ``, `$'` and `$1`
    // inside it are inserted literally. Arguments are user-typed values — group
    // names, account names — and as a plain string a group called "Work $& Home"
    // made replace() splice the match back in, while "A$'B" silently deleted
    // text.
    text = text.replace(`{${i}}`, () => String(arg));
  });
  return text;
}

export function createT(language: Language) {
  return (key: TranslationKey, ...args: (string | number)[]): string =>
    getTranslation(language, key, ...args);
}
