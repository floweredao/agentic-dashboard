import { afterAll, afterEach, expect, test } from "bun:test";
import { findKoreanOutsideDictionaries, uiFiles } from "../scripts/i18n-check";
import { config, configure } from "./config";
import { applyLocale, choosePreference, dictionaries, getPreference, localeNames, preferences, STORAGE_KEY, systemLocale } from "./i18n";

const hangul = /[가-힣]/;
// Importing modules must not change the language the other test files run in.
afterAll(() => applyLocale("ko"));

function values(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "function") return values(value("1", "2", "3"));
  if (Array.isArray(value)) return value.flatMap(values);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(values);
  return [];
}

function shape(value: unknown): unknown {
  if (typeof value === "function") return "function";
  if (Array.isArray(value)) return value.map(shape);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, shape(child)]));
  }
  return typeof value;
}

test("imports every non-test source module", async () => {
  const files = await Array.fromAsync(new Bun.Glob("src/**/*.{ts,tsx}").scan());
  // main.tsx is the entry point: it renders into the page and picks the language, so it is not imported here.
  const modules = files.filter(file => !/\.test\.tsx?$/.test(file) && !/(^|\/)test-[^/]*\.ts$/.test(file) && file !== "src/main.tsx");
  await Promise.all(modules.map(file => import(new URL(`../${file}`, import.meta.url).href)));
});

test("every registered dictionary has matching English and Korean shapes without Hangul in English", () => {
  expect(dictionaries.length).toBeGreaterThan(10);
  for (const dictionary of dictionaries) {
    expect(shape(dictionary.ko)).toEqual(shape(dictionary.en));
    expect(values(dictionary.en).filter(value => hangul.test(value))).toEqual([]);
  }
});

test("UI source contains no Korean text outside Korean dictionaries", async () => {
  const files = await uiFiles();
  const findings = (await Promise.all(files.map(async file => findKoreanOutsideDictionaries(file, await Bun.file(file).text())))).flat();
  expect(findings).toEqual([]);
});

const realLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const realLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
const defaultLocale = config.locale;
afterEach(() => {
  configure({ locale: defaultLocale });
  for (const [name, descriptor] of [["localStorage", realLocalStorage], ["location", realLocation]] as const) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

function fakeBrowser() {
  const store = new Map<string, string>();
  let reloads = 0;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); },
  } });
  Object.defineProperty(globalThis, "location", { configurable: true, value: { reload: () => { reloads += 1; } } });
  return { store, reloads: () => reloads };
}

test("systemLocale prefers the first supported language and falls back to the server's default language", () => {
  expect(systemLocale(["ko-KR"])).toBe("ko");
  expect(systemLocale(["en-US"])).toBe("en");
  expect(systemLocale(["ja-JP", "ko-KR"])).toBe("ko");
  configure({ locale: "ko" });
  expect(systemLocale(["ja-JP"])).toBe("ko");
  expect(systemLocale([])).toBe("ko");
  configure({ locale: "en" });
  expect(systemLocale(["ja-JP"])).toBe("en");
  expect(systemLocale([])).toBe("en");
});

test("the language choice is system, English or Korean, and follows the system until one is stored", () => {
  expect(preferences).toEqual(["system", "en", "ko"]);
  expect(localeNames).toEqual({ en: "English", ko: "한국어" });
  const browser = fakeBrowser();
  expect(getPreference()).toBe("system");
  browser.store.set(STORAGE_KEY, "unknown");
  expect(getPreference()).toBe("system");
  choosePreference("ko");
  expect(browser.store.get(STORAGE_KEY)).toBe("ko");
  expect(getPreference()).toBe("ko");
  choosePreference("system");
  expect(getPreference()).toBe("system");
  expect(browser.reloads()).toBe(2);
  expect(STORAGE_KEY).toBe("agentic:locale");
});
