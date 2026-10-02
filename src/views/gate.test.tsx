import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { config, configure } from "../config";
import { applyLocale, detectLocale } from "../i18n";
import { OwnerGate } from "./Channels";

const noop = () => {};
const initial = { locale: config.locale, features: { ...config.features } };
afterEach(() => { configure(initial); applyLocale("ko"); });

async function scan(markup: string, selector: string, attribute?: string) {
  const found: (string | null)[] = [];
  await new HTMLRewriter().on(selector, {
    element(element) { found.push(attribute ? element.getAttribute(attribute) : element.tagName); },
  }).transform(new Response(markup)).text();
  return found;
}

test("the gate asks for the owner key from bun run setup and names no network product", async () => {
  const markup = renderToStaticMarkup(<OwnerGate onToken={noop} />);
  expect(await scan(markup, "button.btn-primary")).toHaveLength(1);
  expect(await scan(markup, "a")).toHaveLength(0);
  expect(markup).toContain("bun run setup");
  expect(markup).toContain("data/credentials.json");
  expect(markup).not.toContain("Tailscale");
  expect(markup).not.toContain("리버스 프록시");
});

test("with trusted login on, the gate adds that the reverse proxy did not identify the owner", () => {
  configure({ features: { trustedLogin: true } });
  expect(renderToStaticMarkup(<OwnerGate onToken={noop} />)).toContain("리버스 프록시가 소유자를 확인하지 못했어요.");
});

test("without a stored choice or a Korean browser the server default (English) is used, and the gate renders in English", () => {
  // Given: no stored choice, an English browser and the server's default language.
  configure({ locale: "en" });
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { languages: ["en-US"], language: "en-US" }, configurable: true });
  try { expect(detectLocale()).toBe("en"); }
  finally { if (original) Object.defineProperty(globalThis, "navigator", original); }
  applyLocale("en");
  const markup = renderToStaticMarkup(<OwnerGate onToken={noop} />);
  expect(markup).toContain("Sign in with the owner key");
  expect(markup).not.toMatch(/[\uAC00-\uD7A3]/);
});
