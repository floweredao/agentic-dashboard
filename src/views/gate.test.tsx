import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { OwnerGate, tailscaleOrigin } from "./Channels";

const noop = () => {};

async function scan(markup: string, selector: string, attribute?: string) {
  const found: (string | null)[] = [];
  await new HTMLRewriter().on(selector, {
    element(element) { found.push(attribute ? element.getAttribute(attribute) : element.tagName); },
  }).transform(new Response(markup)).text();
  return found;
}

test("local gate links to the Tailscale address with the current route and folds the token login", async () => {
  const markup = renderToStaticMarkup(<OwnerGate origin="http://127.0.0.1:4310" hash="#/library?type=research" onToken={noop} />);
  expect(await scan(markup, "a.btn-primary", "href")).toEqual([`${tailscaleOrigin}/#/library?type=research`]);
  expect(await scan(markup, "details button")).toHaveLength(1);
  expect(await scan(markup, "details[open]")).toHaveLength(0);
});

test("Tailscale gate retries identity instead of linking to itself", async () => {
  const markup = renderToStaticMarkup(<OwnerGate origin={tailscaleOrigin} hash="" onToken={noop} />);
  expect(await scan(markup, "a.btn-primary")).toHaveLength(0);
  expect(await scan(markup, "button.btn-primary")).toHaveLength(1);
  expect(await scan(markup, "details button")).toHaveLength(1);
});
