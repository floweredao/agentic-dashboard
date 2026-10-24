import { RecordInputSchema } from "../shared/contracts";
import { strings } from "./i18n";

const text = strings({
  en: { title: "Your first dashboard record", body: "Keep the result, not the chat.\n\nAsk your agent to save a conclusion, its sources and the next action here. You can review it, add a comment and return to it later.",
    summary: "One place to read the results your agents save." },
  ko: { title: "첫 대시보드 기록", body: "채팅보다 결과를 남겨요.\n\n에이전트에게 결론, 근거와 다음 할 일을 여기에 저장해 달라고 요청해 보세요. 읽고 코멘트를 남긴 뒤 나중에 다시 찾아볼 수 있어요.",
    summary: "내 에이전트가 저장한 결과를 한곳에서 읽어요." },
});
export function sampleRecord() {
  const t = text();
  return RecordInputSchema.parse({ kind: "note", title: t.title, body: t.body, tags: ["sample"],
    fields: { summary: t.summary } });
}
