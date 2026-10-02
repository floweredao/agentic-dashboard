import { config } from "./config";

export type Locale = "en" | "ko";
export const locales: readonly Locale[] = ["en", "ko"];
/** Each language's own name, for the language selector. */
export const localeNames: Readonly<Record<Locale, string>> = { en: "English", ko: "한국어" };
const STORAGE_KEY = "agentic:locale";
const tags: Readonly<Record<Locale, string>> = { en: "en-US", ko: "ko-KR" };

const isLocale = (value: unknown): value is Locale => value === "en" || value === "ko";

/** localStorage, or null where there is none (tests, a server render) or the browser blocks it (private modes throw on access). */
function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch (error) {
    if (error instanceof DOMException) return null;
    throw error;
  }
}

/** The stored choice, else Korean when the browser's first language is Korean, else the server default. */
export function detectLocale(): Locale {
  const stored = storage()?.getItem(STORAGE_KEY);
  if (isLocale(stored)) return stored;
  const languages = typeof navigator === "undefined" ? [] : navigator.languages ?? [navigator.language];
  if (languages[0]?.toLowerCase().startsWith("ko")) return "ko";
  return config.locale;
}

let current: Locale | null = null;

export const getLocale = (): Locale => current ??= detectLocale();

/** Use `locale` for this page without storing it (main.tsx after the config loads, and tests). */
export function applyLocale(locale: Locale) {
  current = locale;
  if (typeof document !== "undefined") document.documentElement.lang = locale;
}

/** Remember the owner's choice on this browser. */
export function setLocale(locale: Locale) {
  applyLocale(locale);
  storage()?.setItem(STORAGE_KEY, locale);
}

/** Switching language stores the choice and reloads, so every string and formatter picks it up. */
export function switchLocale(locale: Locale) {
  setLocale(locale);
  location.reload();
}

/** A file's colocated dictionary; call the returned function where the text is used to get the current language's entries. */
export function strings<T>(dictionary: { readonly en: T; readonly ko: T }): () => T {
  return () => dictionary[getLocale()];
}

/** BCP 47 tag for Intl formatters in the current language. */
export const localeTag = (): string => tags[getLocale()];

/** Formats an instant in the current language and the dashboard's time zone. */
export function formatDateTime(value: Date | string | number, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(localeTag(), { timeZone: config.timeZone, ...options }).format(new Date(value));
}

/** Month and day, e.g. "October 2" / "10월 2일". */
export const formatMonthDay = (value: Date | string | number) => formatDateTime(value, { month: "long", day: "numeric" });

/** Hours and minutes, e.g. "09:30 AM" / "오전 09:30". */
export const formatClock = (value: Date | string | number) => formatDateTime(value, { hour: "2-digit", minute: "2-digit" });
