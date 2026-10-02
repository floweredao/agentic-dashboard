import { useEffect, useState } from "react";
import { Bell, BellRing, MessageSquareReply, Newspaper, Send, SquareCheck } from "lucide-react";
import type { ReactNode } from "react";
import type { PushDevice, PushKinds } from "../../shared/contracts";
import { errorMessage } from "../api";
import { BackButton } from "../components/primitives";
import { deviceState, disablePush, enablePush, pushSupport, testPush } from "../push";
import { useDashboard } from "../state";

const KINDS: readonly { readonly key: keyof PushKinds; readonly label: string; readonly note: string; readonly icon: ReactNode }[] = [
  { key: "briefing", label: "브리핑 도착", note: "아침·저녁 브리핑이 올라오면 헤드라인과 함께", icon: <Newspaper size={18} aria-hidden="true" /> },
  { key: "review", label: "확인 필요", note: "에이전트가 할 일을 확인 필요로 바꾸면", icon: <SquareCheck size={18} aria-hidden="true" /> },
  { key: "reply", label: "답글", note: "내 코멘트에 에이전트가 답하면", icon: <MessageSquareReply size={18} aria-hidden="true" /> },
];

export function Switch({ checked, disabled, label, onChange }: {
  readonly checked: boolean; readonly disabled?: boolean; readonly label: string; readonly onChange: (next: boolean) => void;
}) {
  return <button type="button" role="switch" className="switch" aria-checked={checked} aria-label={label} disabled={disabled}
    onClick={() => onChange(!checked)}><span className="switch-thumb" aria-hidden="true" /></button>;
}

function Row({ icon, label, note, control }: { readonly icon: ReactNode; readonly label: string; readonly note: string; readonly control: ReactNode }) {
  return <li className="setting-row">
    <span className="more-icon">{icon}</span>
    <span className="more-text"><span className="more-label">{label}</span><span className="setting-note">{note}</span></span>
    {control}
  </li>;
}

/** 알림 설정: this device's Web Push, by kind, with a test notification and the iPhone home-screen steps. */
export function SettingsPane() {
  const d = useDashboard();
  const support = pushSupport();
  const [permission, setPermission] = useState(() => typeof Notification === "undefined" ? "default" : Notification.permission);
  const [device, setDevice] = useState<PushDevice | null | undefined>(undefined);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (support !== "supported") { setDevice(null); return; }
    deviceState().then(setDevice, () => setDevice(null));
  }, [support]);
  const run = async (work: () => Promise<void>) => {
    setPending(true);
    try { await work(); } catch (error) { d.notify(await errorMessage(error), "error"); }
    finally { setPending(false); if (typeof Notification !== "undefined") setPermission(Notification.permission); }
  };
  const turn = (on: boolean) => run(async () => {
    if (!on) { await disablePush(d.csrfToken); setDevice(null); d.notify("이 기기의 알림을 껐어요."); return; }
    const result = await enablePush(d.csrfToken);
    if (result === "denied") { d.notify("알림이 차단돼 있어요. 브라우저나 iPhone 설정에서 Agentic Dashboard 알림을 허용해 주세요.", "error"); return; }
    if (result === "unsupported") { d.notify("이 브라우저에서는 알림을 켤 수 없어요.", "error"); return; }
    if (result === "unavailable") { d.notify("이 브라우저의 푸시 서비스에 연결하지 못했어요. 잠시 뒤 다시 켜 주세요.", "error"); return; }
    setDevice(result);
    d.notify("이 기기에서 알림을 받아요.");
  });
  const choose = (key: keyof PushKinds, value: boolean) => run(async () => {
    if (!device) return;
    const result = await enablePush(d.csrfToken, { ...device.kinds, [key]: value });
    if (typeof result === "object") setDevice(result);
    else d.notify("알림 종류를 바꾸지 못했어요. 알림을 꺼다가 다시 켜 주세요.", "error");
  });
  const test = () => run(async () => {
    const result = await testPush(d.csrfToken);
    if (!result) { d.notify("이 기기는 아직 알림을 켜지 않았어요.", "error"); return; }
    d.notify(result.delivered ? "테스트 알림을 보냈어요." : `알림 서비스가 거절했어요(${result.status ?? "연결 실패"}). 알림을 껐다가 다시 켜 주세요.`, result.delivered ? "info" : "error");
  });
  const on = device !== null && device !== undefined;
  const status = support === "ios-browser" ? "홈 화면에 추가한 앱에서만 켤 수 있어요"
    : support === "unsupported" ? "이 브라우저는 웹 푸시를 지원하지 않아요"
      : permission === "denied" ? "알림이 차단됨 · 브라우저 설정에서 허용해 주세요"
        : device === undefined ? "확인하는 중" : on ? "켜짐 · 이 기기로 알림을 보내요" : "꺼짐";

  return <div className="more-page settings-page">
    <header className="pane-head">
      <BackButton place="list" />
      <div className="pane-title-row"><h1 className="pane-title">알림 설정</h1></div>
    </header>
    {support === "ios-browser" && <p className="settings-notice" role="note">
      iPhone에서는 Safari의 공유 → 홈 화면에 추가로 만든 Agentic Dashboard 앱에서만 알림을 받을 수 있어요(iOS 16.4 이상). 홈 화면 앱을 열고 이 화면에서 켜 주세요.
    </p>}
    <section className="more-group" aria-labelledby="settings-device">
      <h2 id="settings-device" className="more-heading">이 기기</h2>
      <ul className="more-list">
        <Row icon={<Bell size={18} aria-hidden="true" />} label="이 기기에서 알림 받기" note={status}
          control={<Switch checked={on} label="이 기기에서 알림 받기" disabled={pending || support !== "supported" || device === undefined || (permission === "denied" && !on)} onChange={next => { void turn(next); }} />} />
        <Row icon={<BellRing size={18} aria-hidden="true" />} label="테스트 알림" note="지금 이 기기로 한 번 보내요"
          control={<button type="button" className="btn btn-outline" onClick={() => { void test(); }} disabled={pending || !on}><Send size={15} aria-hidden="true" />보내기</button>} />
      </ul>
    </section>
    <section className="more-group" aria-labelledby="settings-kinds">
      <h2 id="settings-kinds" className="more-heading">받을 알림</h2>
      <ul className="more-list">
        {KINDS.map(kind => <Row key={kind.key} icon={kind.icon} label={kind.label} note={kind.note}
          control={<Switch checked={on && device.kinds[kind.key]} label={kind.label} disabled={pending || !on} onChange={next => { void choose(kind.key, next); }} />} />)}
      </ul>
    </section>
    <section className="more-group" aria-labelledby="settings-iphone">
      <h2 id="settings-iphone" className="more-heading">iPhone에서 받는 법</h2>
      <ol className="settings-steps">
        <li>iOS 16.4 이상에서 Safari로 Agentic Dashboard 주소를 열어요.</li>
        <li>공유 버튼 → 홈 화면에 추가를 눌러 앱으로 만들어요.</li>
        <li>홈 화면의 Agentic Dashboard를 열고 여기서 알림 받기를 켠 뒤, 묻는 창에서 허용을 눌러요.</li>
        <li>알림은 기기마다 따로 켜고, 종류도 기기마다 고를 수 있어요.</li>
      </ol>
    </section>
  </div>;
}
