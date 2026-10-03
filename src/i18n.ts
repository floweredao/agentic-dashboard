import { config } from "./config";

export type Locale = "en" | "ko";
/** What the person chose in Settings: a language, or `system` to follow this device's language. */
export type Preference = Locale | "system";
export const locales: readonly Locale[] = ["en", "ko"];
export const preferences: readonly Preference[] = ["system", "en", "ko"];
/** Each language's own name, for the language choice in Settings. */
export const localeNames: Readonly<Record<Locale, string>> = { en: "English", ko: "한국어" }; // i18n-allow: each language is named in itself
export const STORAGE_KEY = "agentic:locale";
const tags: Readonly<Record<Locale, string>> = { en: "en-US", ko: "ko-KR" };

const isPreference = (value: unknown): value is Preference => value === "system" || value === "en" || value === "ko";

/** localStorage, or null where there is none (tests, a server render) or the browser blocks it (private modes throw on access). */
function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch (error) {
    if (error instanceof DOMException) return null;
    throw error;
  }
}

/** The device's language: the first preferred language that is Korean or English, else the server's default language. */
export function systemLocale(languages: readonly string[] = typeof navigator === "undefined" ? [] : navigator.languages ?? [navigator.language]): Locale {
  for (const language of languages) {
    const tag = language.toLowerCase();
    if (tag.startsWith("ko")) return "ko";
    if (tag.startsWith("en")) return "en";
  }
  return config.locale;
}

/** The choice stored on this device; following the system when nothing (or something unknown) is stored. */
export function getPreference(): Preference {
  const stored = storage()?.getItem(STORAGE_KEY);
  return isPreference(stored) ? stored : "system";
}

/** The language the stored choice resolves to on this device. */
export function detectLocale(): Locale {
  const preference = getPreference();
  return preference === "system" ? systemLocale() : preference;
}

let current: Locale | null = null;

export const getLocale = (): Locale => current ??= detectLocale();

/** Use `locale` for this page without storing it (main.tsx after the config loads, and tests). */
export function applyLocale(locale: Locale) {
  current = locale;
  if (typeof document !== "undefined") document.documentElement.lang = locale;
}

/** Stores the choice on this device and reloads, so every string and formatter picks it up. */
export function choosePreference(preference: Preference) {
  storage()?.setItem(STORAGE_KEY, preference);
  location.reload();
}

/** While following the system, a change of the device language reloads the page in the new language. */
export function followSystemLanguage() {
  if (typeof window === "undefined") return;
  window.addEventListener("languagechange", () => {
    if (getPreference() === "system" && systemLocale() !== getLocale()) location.reload();
  });
}

export interface Dictionary { readonly en: unknown; readonly ko: unknown }
/** Every dictionary made with `strings`, so a test can check both languages have the same entries. */
export const dictionaries: Dictionary[] = [];

/**
 * A file's colocated dictionary; call the returned function where the text is used to get the current language's
 * entries. The English entries set the shape, so a missing or extra Korean entry fails the typecheck.
 */
export function strings<T>(dictionary: { readonly en: T; readonly ko: NoInfer<T> }): () => T {
  dictionaries.push(dictionary);
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
