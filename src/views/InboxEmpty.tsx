import { useState } from "react";
import { useDashboard } from "../state";
import { sampleRecord } from "../onboarding-sample";
import { strings } from "../i18n";
import { config } from "../config";
import { errorMessage } from "../api-errors";

const text = strings({
  en: { title: "Your inbox for AI-agent results", note: "Connect your own agent to keep conclusions, sources and next actions here. Reading and saving do not need a Gemini key.",
    connect: "Connect an agent", sample: "Try a sample", demo: "Use your own dashboard" },
  ko: { title: "AI 에이전트 결과를 모아 읽는 공간", note: "내 에이전트를 연결해 결론, 근거와 다음 할 일을 여기에 남겨 보세요. 읽기와 저장에는 Gemini 키가 필요하지 않아요.",
    connect: "에이전트 연결", sample: "예시 체험하기", demo: "내 대시보드 시작하기" },
});
export function DemoConversion() {
  return config.features.demo && config.demoHostedUrl ? <div className="onboarding-empty">
    <a className="btn btn-primary" href={config.demoHostedUrl}>{text().demo}</a>
  </div> : null;
}
export function InboxEmpty() {
  const d = useDashboard();
  const [pending, setPending] = useState(false);
  const [requestId] = useState(() => crypto.randomUUID());
  const t = text();
  return <section className="onboarding-empty"><h2>{t.title}</h2><p>{t.note}</p>
    <div className="account-actions"><a className="btn btn-primary" href="#/channels">{t.connect}</a>
      <button className="btn btn-outline" disabled={pending || config.features.demo} onClick={() => {
        setPending(true); void d.create(sampleRecord(), requestId).catch(async cause => d.notify(await errorMessage(cause), "error")).finally(() => setPending(false));
      }}>{t.sample}</button>
    </div>
  </section>;
}
