import { useState } from "react";
import type { Account } from "../../shared/account";
import { finishOnboarding, savePreferences, verifyAgentSave } from "../profile-api";
import { errorMessage } from "../api-errors";
import { strings } from "../i18n";
import { config } from "../config";
import { AgentConnections } from "./AgentConnections";
import { GeminiSettings } from "./GeminiSettings";
import { AccountPreferences } from "./AccountPreferences";
import { AutoSettings } from "./AutoSettings";
import { PhoneSetup } from "./PhoneSetup";
import { sampleRecord } from "../onboarding-sample";

type Step = 0 | 1 | 2 | 3 | 4;
const next: Readonly<Record<Step, Step>> = { 0: 1, 1: 2, 2: 3, 3: 4, 4: 4 };
const previous: Readonly<Record<Step, Step>> = { 0: 0, 1: 0, 2: 1, 3: 2, 4: 3 };
const text = strings({
  en: {
    title: "Set up your dashboard", intro: "Your inbox for AI-agent results. Connect your own agent, then choose the optional extras.",
    step: (number: number) => `Step ${number} of 5`, steps: ["Language", "Your first agent save", "Digests", "Optional audio", "Phone setup"],
    back: "Back", next: "Continue", finish: "Finish setup", skip: "Skip for now", check: "Check agent save",
    agent: "Create a connection below, then ask your agent on your own computer to save one record. Copying a token or the browser's test button does not verify that computer.",
    verified: "Your agent's save is verified.", waiting: "No save from your own agent yet. Run the save command on your computer, then check again.",
    saved: "Save this example as record.json in the repository folder after connecting the CLI. Bun must be installed; the computer installer below can set it up.",
    source: "The public CLI gets the source from its connected token; you do not need a --source flag.",
    showDigests: "Show the Digest tab", digest: "Digests arrive when your agent uploads them. This is not a news or email subscription, and Google sign-in does not grant mailbox access.",
    schedule: "Your agent must collect the sources and schedule uploads separately. Save this example as digest.json, then upload it from a connected CLI.",
    directory: "For a briefing folder containing news.json and mail.json, use:",
    optional: "Reading and saving need no Gemini key. Audio and title enrichment send saved content to Google and may charge your Google project.",
    processing: "Google's unpaid and paid services have different data-use terms, including possible improvement/human review and regional exceptions. Review the terms before sending private content.",
    terms: "Google terms", quota: "Google project quotas", privacy: "Privacy", serviceTerms: "Terms", account: "Account settings",
    agentRequired: "Verify a save from your own agent before finishing setup.",
  },
  ko: {
    title: "대시보드 시작하기", intro: "AI 에이전트 결과를 모아 읽는 공간이에요. 내 에이전트를 연결한 뒤 선택 기능을 골라 주세요.",
    step: (number: number) => `5단계 중 ${number}단계`, steps: ["언어", "첫 에이전트 저장", "다이제스트", "선택 사항: 음성", "휴대폰 설정"],
    back: "이전", next: "계속", finish: "설정 마치기", skip: "지금은 건너뛰기", check: "에이전트 저장 확인",
    agent: "아래에서 연결을 만든 뒤 내 컴퓨터의 에이전트에게 기록 하나를 저장하도록 요청해 주세요. 토큰 복사나 브라우저의 시험 버튼만으로는 컴퓨터 연결을 확인할 수 없어요.",
    verified: "내 에이전트의 저장을 확인했어요.", waiting: "아직 내 에이전트가 저장한 기록이 없어요. 컴퓨터에서 저장 명령을 실행한 뒤 다시 확인해 주세요.",
    saved: "CLI를 연결한 뒤 저장소 폴더에 이 예시를 record.json으로 저장해 주세요. Bun이 필요하며, 아래 컴퓨터 연결 설치 프로그램으로 준비할 수 있어요.",
    source: "공개 CLI는 연결한 토큰에서 저장 주체를 확인하므로 --source 옵션이 필요하지 않아요.",
    showDigests: "다이제스트 탭 표시", digest: "에이전트가 올린 다이제스트를 보여 줘요. 뉴스·메일 구독 기능이 아니며 Google 로그인으로 메일함 권한을 얻지 않아요.",
    schedule: "소스 수집과 예약 실행은 에이전트에 따로 설정해 주세요. 예시를 digest.json으로 저장한 뒤 연결한 CLI에서 올려 주세요.",
    directory: "news.json과 mail.json이 있는 브리핑 폴더는 다음 명령으로 올려요.",
    optional: "키 없이도 기록을 읽고 저장할 수 있어요. 음성과 제목 보강은 저장한 내용을 Google로 보내며 내 Google 프로젝트에 요금이 발생할 수 있어요.",
    processing: "Google의 무료·유료 서비스는 데이터 이용 조건이 달라요. 서비스 개선·사람의 검토 가능성과 지역별 예외가 있으니 비공개 내용을 보내기 전에 약관을 확인해 주세요.",
    terms: "Google 약관", quota: "Google 프로젝트 한도", privacy: "개인정보처리방침", serviceTerms: "이용약관", account: "계정 설정",
    agentRequired: "내 에이전트가 기록을 저장했는지 확인한 뒤 설정을 마칠 수 있어요.",
  },
});
export function Welcome({ account, csrfToken, onAccount }: {
  readonly account: Account; readonly csrfToken: string; readonly onAccount: (account: Account) => void;
}) {
  const t = text();
  const [step, setStep] = useState<Step>(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const run = async (work: () => Promise<void>) => {
    setPending(true); setError(""); setMessage("");
    try { await work(); } catch (cause) { setError(await errorMessage(cause)); } finally { setPending(false); }
  };
  const body = (() => {
    switch (step) {
      case 0: return <AccountPreferences account={account} csrfToken={csrfToken} onAccount={onAccount} />;
      case 1: return <>
        <p>{t.agent}</p><AgentConnections saveVerified={account.agentSaveVerified} />
        <p className="setting-note">{t.saved}</p>
        <pre className="account-code">{JSON.stringify(sampleRecord(), null, 2)}</pre>
        <pre className="account-code">{`bun scripts/agent.ts --url '${location.origin}' --file record.json`}</pre>
        <p className="setting-note">{t.source}</p>
        <div><button className="btn btn-outline" disabled={pending} onClick={() => void run(async () => {
          const next = await verifyAgentSave(); onAccount(next); setMessage(next.agentSaveVerified ? t.verified : t.waiting);
        })}>{t.check}</button></div>
        {account.agentSaveVerified && <p role="status">{t.verified}</p>}
      </>;
      case 2: return <>
        <p>{t.digest}</p>
        <label className="account-check"><input type="checkbox" checked={account.features.digest} disabled={pending || !config.features.digest}
          onChange={event => { const digest = event.target.checked; void run(async () => onAccount(await savePreferences({ features: { ...account.features, digest } }, csrfToken))); }} />{t.showDigests}</label>
        <p className="setting-note">{t.schedule}</p>
        <pre className="account-code">{JSON.stringify({ date: "2026-10-24", slot: "morning", notify: false,
          sections: [{ key: "news", title: "News", kind: "articles", items: [{ key: "one", title: "Example", source: "Example",
            summary: "Your agent writes the summary.", url: "https://example.com/article" }] }] }, null, 2)}</pre>
        <pre className="account-code">{`bun scripts/agent.ts --url '${location.origin}' --digest digest.json`}</pre>
        <p className="setting-note">{t.directory}</p><pre className="account-code">bun scripts/agent.ts --briefing ./briefing</pre>
      </>;
      case 3: return <>
        <p>{t.optional}</p><p className="setting-note">{t.processing}</p>
        <div className="account-actions"><a href="https://ai.google.dev/gemini-api/terms" target="_blank" rel="noreferrer">{t.terms}</a>
          <a href="https://ai.google.dev/gemini-api/docs/rate-limits" target="_blank" rel="noreferrer">{t.quota}</a></div>
        <GeminiSettings />{config.features.narration && <AutoSettings />}
      </>;
      case 4: return <PhoneSetup />;
      default: { const unreachable: never = step; return unreachable; }
    }
  })();
  return <main className="entry-page"><div className="setup-page">
    <header className="setup-header"><p className="setup-progress">{t.step(step + 1)}</p><h1>{t.title}</h1><p>{t.intro}</p></header>
    <section className="setup-panel" aria-label={t.steps[step]}>{step !== 0 && <h2>{t.steps[step]}</h2>}{body}
      {message && <p role="status">{message}</p>}{error && <p role="alert" className="form-error">{error}</p>}
    </section>
    <footer className="setup-footer">
      <button className="btn btn-quiet" disabled={step === 0 || pending} onClick={() => { setStep(previous[step]); setError(""); setMessage(""); }}>{t.back}</button>
      {step < 4 ? <button className="btn btn-primary" disabled={pending || (step === 1 && !account.agentSaveVerified)}
        onClick={() => { setStep(next[step]); setError(""); setMessage(""); }}>{step === 3 ? t.skip : t.next}</button>
        : <button className="btn btn-primary" disabled={pending || !account.agentSaveVerified} onClick={() => void run(async () => {
          onAccount(await finishOnboarding(csrfToken)); location.assign("/");
        })}>{t.finish}</button>}
    </footer>
    {!account.agentSaveVerified && step === 4 && <p>{t.agentRequired}</p>}
    <nav className="account-legal"><a href="/account">{t.account}</a><a href="/privacy">{t.privacy}</a><a href="/terms">{t.serviceTerms}</a></nav>
  </div></main>;
}
