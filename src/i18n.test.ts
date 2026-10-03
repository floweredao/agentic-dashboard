import { afterEach, expect, test } from "bun:test";
import { config, configure } from "./config";
import { choosePreference, getPreference, localeNames, preferences, STORAGE_KEY, systemLocale } from "./i18n";

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
