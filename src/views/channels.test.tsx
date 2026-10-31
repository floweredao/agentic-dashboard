import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { applyLocale } from "../i18n";
import { channelsFor, setChannelKeys } from "../model";
import { DashboardContext } from "../state";
import { fakeDashboard } from "../test-dashboard";
import { AgentUsage, ChannelsView } from "./Channels";

afterEach(() => { applyLocale("ko"); setChannelKeys(channelsFor([], [])); });
const agent = (lastUsedAt: string | null, revokedAt: string | null = null) => ({ name: "omo", createdAt: "2026-09-01T00:00:00Z", lastUsedAt, revokedAt });
const text = (node: React.ReactNode) => renderToStaticMarkup(node).replace(/<[^>]+>/g, "");

test("an agent's channel card says when it was last used, or that it was removed", () => {
  applyLocale("en");
  const threeHoursAgo = new Date(Date.now() - 3 * 3_600_000 - 60_000).toISOString();
  expect(text(<AgentUsage agent={agent(threeHoursAgo)} />)).toBe("Last used 3h ago");
  expect(text(<AgentUsage agent={agent(null)} />)).toBe("Last used None");
  expect(text(<AgentUsage agent={agent(threeHoursAgo, "2026-09-10T00:00:00Z")} />)).toBe("Removed");
  expect(renderToStaticMarkup(<AgentUsage agent={undefined} />)).toBe("");
});

test("the same card is Korean when the language is Korean", () => {
  expect(text(<AgentUsage agent={agent(null)} />)).toBe("마지막 사용 없음");
  expect(text(<AgentUsage agent={agent(null, "2026-09-10T00:00:00Z")} />)).toBe("연결 해제됨");
});

test("the agent registration command names its argument in the page's language", () => {
  setChannelKeys(channelsFor([], []));
  const render = () => text(<DashboardContext.Provider value={fakeDashboard([], { view: "channels" })}><ChannelsView /></DashboardContext.Provider>);
  applyLocale("en");
  expect(render()).toContain("No agents yet. Register one with bun run agents add &lt;name&gt; and give it the key that command prints.");
  applyLocale("ko");
  expect(render()).toContain("아직 에이전트가 없어요. 다음 명령으로 등록하고 bun run agents add &lt;이름&gt; 출력된 키를 에이전트에 넣어 주세요.");
});
