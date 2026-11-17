/**
 * The interface language and clock style, decided once when the page loads.
 *
 * The choice is a preference kept on the server (`language`, `time_format`)
 * and mirrored in localStorage, so the right language paints before the
 * workspace has loaded. Changing either reloads the page: every string and
 * formatter is then built once, in one language, with no half-translated
 * screens. Nothing here imports the strings, so the strings can import it.
 */

export type Locale = 'en' | 'ko' | 'ja';
export type LanguagePref = 'auto' | Locale;
export type TimeFormatPref = 'auto' | '12h' | '24h';

export const LOCALES: Locale[] = ['en', 'ko', 'ja'];

const LANGUAGE_KEY = 'language';
const TIME_KEY = 'time_format';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    if (value === 'auto') localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage may be unavailable (private windows); the choice still holds for this page.
  }
}

export function languagePref(value: unknown): LanguagePref {
  return typeof value === 'string' && (LOCALES as string[]).includes(value) ? (value as Locale) : 'auto';
}

export function timeFormatPref(value: unknown): TimeFormatPref {
  return value === '12h' || value === '24h' ? value : 'auto';
}

function browserLanguages(): string[] {
  const list = typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language];
  return list.filter(Boolean).map((tag) => tag.toLowerCase());
}

/** The language a preference resolves to: an explicit choice, else the first browser language we have. */
export function resolveLocale(pref: LanguagePref): Locale {
  if (pref !== 'auto') return pref;
  for (const tag of browserLanguages()) {
    const base = tag.split('-')[0] as Locale;
    if (LOCALES.includes(base)) return base;
  }
  return 'en';
}

export const LOCALE: Locale = resolveLocale(languagePref(read(LANGUAGE_KEY)));
export const TIME_FORMAT: TimeFormatPref = timeFormatPref(read(TIME_KEY));

/**
 * The tag dates and numbers are formatted with. When the browser already asks
 * for this language (say en-GB, ko-KR or ja-JP), its regional variant is kept;
 * otherwise the plain language tag is used, so an English screen in a Korean
 * browser does not show Korean dates.
 */
export const INTL_LOCALE: string = browserLanguages().find((tag) => tag.split('-')[0] === LOCALE) ?? LOCALE;

/** `hour12` for Intl: undefined lets the locale decide (12-hour in en-US, 오전/오후 in ko, 24-hour in ja). */
export const HOUR12: boolean | undefined = TIME_FORMAT === 'auto' ? undefined : TIME_FORMAT === '12h';

if (typeof document !== 'undefined') document.documentElement.lang = LOCALE;

/**
 * Apply language and clock preferences that arrived from the server (boot, or a
 * change made in Preferences). Remembers them for the next load; returns true
 * when this page now shows the wrong ones and the caller should reload.
 */
export function rememberDisplayPrefs(prefs: { language?: unknown; time_format?: unknown }): boolean {
  const language = languagePref(prefs.language);
  const time = timeFormatPref(prefs.time_format);
  write(LANGUAGE_KEY, language);
  write(TIME_KEY, time);
  return resolveLocale(language) !== LOCALE || time !== TIME_FORMAT;
}
