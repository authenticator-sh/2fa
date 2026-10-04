// Which of our languages a browser or a stored choice means.
//
// Apart from the loader in i18n.ts, and importing nothing, because the service
// worker needs these answers too: i18n.ts brings the English table and the
// dynamic import every other language is loaded through, and neither belongs in
// a worker that wakes for every shortcut press — Chrome refuses `import()` in
// one outright. i18n.ts re-exports all of this, so pages import from there as
// before.

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

export const SUPPORTED_LANGUAGES: ReadonlySet<string> = new Set(languages.map((entry) => entry.code));

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
  return SUPPORTED_LANGUAGES.has(code) ? (code as Language) : 'en';
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
