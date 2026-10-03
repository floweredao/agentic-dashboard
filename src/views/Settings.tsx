import { useEffect, useState } from "react";
import { Bell, BellRing, MessageSquareReply, Newspaper, Send, SquareCheck } from "lucide-react";
import type { ReactNode } from "react";
import type { PushDevice, PushKinds } from "../../shared/contracts";
import { errorMessage } from "../api";
import { BackButton, SidebarOpen } from "../components/primitives";
import { config } from "../config";
import { choosePreference, getPreference, localeNames, preferences, strings, systemLocale } from "../i18n";
import type { Preference } from "../i18n";
import { deviceState, disablePush, enablePush, pushSupport, syncPushLocale, testPush } from "../push";
import { useDashboard } from "../state";
import { viewTitles } from "../router";

type KindText = { readonly label: string; readonly note: string };
const text = strings({
  en: {
    language: "Language",
    system: "Follow the system",
    systemNote: (name: string) => `This device: ${name}`,
    languageNote: "Saved on this device only. The page reloads in the chosen language.",
    kinds: {
      digest: { label: "New digest", note: "When an agent posts a digest, with its headlines" },
      review: { label: "Needs review", note: "When an agent marks a task as needing review" },
      reply: { label: "Replies", note: "When an agent replies to your comment" },
    } satisfies Record<keyof PushKinds, KindText>,
    turnedOff: "Notifications are off on this device.",
    denied: "Notifications are blocked. Allow notifications for this site in your browser or device settings.",
    unsupported: "Notifications can't be turned on in this browser.",
    unavailable: "Couldn't reach this browser's push service. Try turning it on again in a moment.",
    turnedOn: "This device will get notifications.",
    kindFailed: "Couldn't change the notification kinds. Turn notifications off and on again.",
    notOn: "Notifications aren't on for this device yet.",
    testSent: "Sent a test notification.",
    testRejected: (status: string) => `The push service refused it (${status}). Turn notifications off and on again.`,
    noConnection: "no connection",
    homeScreenOnly: "Only available in the web app added to the home screen",
    noPush: "This browser doesn't support web push",
    blocked: "Blocked · allow notifications in the browser settings",
    checking: "Checking", on: "On · notifications go to this device", off: "Off",
    iosNotice: "On iOS, notifications only work in a web app added to the home screen (iOS 16.4 or later). Open the home-screen web app and turn them on here.",
    device: "This device", receive: "Get notifications on this device", test: "Test notification", testNote: "Send one to this device now", send: "Send",
    kindsHeading: "Notifications to get",
    howHeading: "Getting notifications on iOS",
    steps: [
      "On iOS 16.4 or later, open this dashboard in the browser.",
      "Use Share → Add to Home Screen to install it as a web app.",
      "Open the web app from the home screen, turn on notifications here and choose Allow when asked.",
      "Notifications are turned on per device, and each device picks its own kinds.",
    ],
  },
  ko: {
    language: "언어",
    system: "시스템 설정 따르기",
    systemNote: (name: string) => `지금 이 기기: ${name}`,
    languageNote: "이 기기에만 저장하고, 고른 언어로 페이지를 다시 불러와요.",
    kinds: {
      digest: { label: "다이제스트 도착", note: "에이전트가 다이제스트를 올리면 헤드라인과 함께" },
      review: { label: "확인 필요", note: "에이전트가 할 일을 확인 필요로 바꾸면" },
      reply: { label: "답글", note: "내 코멘트에 에이전트가 답하면" },
    } satisfies Record<keyof PushKinds, KindText>,
    turnedOff: "이 기기의 알림을 껐어요.",
    denied: "알림이 차단돼 있어요. 브라우저나 기기 설정에서 이 사이트의 알림을 허용해 주세요.",
    unsupported: "이 브라우저에서는 알림을 켤 수 없어요.",
    unavailable: "이 브라우저의 푸시 서비스에 연결하지 못했어요. 잠시 뒤 다시 켜 주세요.",
    turnedOn: "이 기기에서 알림을 받아요.",
    kindFailed: "알림 종류를 바꾸지 못했어요. 알림을 꺼다가 다시 켜 주세요.",
    notOn: "이 기기는 아직 알림을 켜지 않았어요.",
    testSent: "테스트 알림을 보냈어요.",
    testRejected: (status: string) => `알림 서비스가 거절했어요(${status}). 알림을 껐다가 다시 켜 주세요.`,
    noConnection: "연결 실패",
    homeScreenOnly: "홈 화면에 추가한 앱에서만 켤 수 있어요",
    noPush: "이 브라우저는 웹 푸시를 지원하지 않아요",
    blocked: "알림이 차단됨 · 브라우저 설정에서 허용해 주세요",
    checking: "확인하는 중", on: "켜짐 · 이 기기로 알림을 보내요", off: "꺼짐",
    iosNotice: "iOS에서는 홈 화면에 추가한 웹 앱에서만 알림을 받을 수 있어요(iOS 16.4 이상). 홈 화면의 웹 앱을 열고 이 화면에서 켜 주세요.",
    device: "이 기기", receive: "이 기기에서 알림 받기", test: "테스트 알림", testNote: "지금 이 기기로 한 번 보내요", send: "보내기",
    kindsHeading: "받을 알림",
    howHeading: "iOS에서 받는 법",
    steps: [
      "iOS 16.4 이상에서 브라우저로 이 대시보드 주소를 열어요.",
      "공유 → 홈 화면에 추가를 눌러 웹 앱으로 만들어요.",
      "홈 화면의 웹 앱을 열고 여기서 알림 받기를 켠 뒤, 묻는 창에서 허용을 눌러요.",
      "알림은 기기마다 따로 켜고, 종류도 기기마다 고를 수 있어요.",
    ],
  },
});

const kindIcons: Record<keyof PushKinds, ReactNode> = {
  digest: <Newspaper size={18} aria-hidden="true" />,
  review: <SquareCheck size={18} aria-hidden="true" />,
  reply: <MessageSquareReply size={18} aria-hidden="true" />,
};

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

/** The language: follow the system, English or Korean, stored on this device; the only place the language changes. */
function LanguageChoice() {
  const t = text();
  const d = useDashboard();
  const chosen = getPreference();
  // The page reloads on a change, so a failed push update cannot be reported; the next load sends the language again.
  const change = async (preference: Preference) => {
    try { await syncPushLocale(d.csrfToken, preference === "system" ? systemLocale() : preference); }
    catch { /* the language changes regardless */ }
    choosePreference(preference);
  };
  const label = (preference: Preference) => preference === "system" ? t.system : localeNames[preference];
  return <section className="more-group" aria-labelledby="settings-language">
    <h2 id="settings-language" className="more-heading">{t.language}</h2>
    <fieldset className="settings-languages">
      <legend className="visually-hidden">{t.language}</legend>
      {preferences.map(preference => <label key={preference} className="language-option">
        <input type="radio" name="language" value={preference} checked={chosen === preference}
          onChange={() => void change(preference)} />
        <span className="language-option-text">
          <strong lang={preference === "system" ? undefined : preference}>{label(preference)}</strong>
          {preference === "system" && <span>{t.systemNote(localeNames[systemLocale()])}</span>}
        </span>
      </label>)}
    </fieldset>
    <p className="setting-note settings-language-note">{t.languageNote}</p>
  </section>;
}

/** Settings: the language for this device, then (when the server has push) this device's Web Push by kind, a test, and the iOS home-screen steps. */
export function SettingsPane() {
  return <div className="more-page settings-page">
    <header className="pane-head">
      <BackButton place="list" />
      <div className="pane-title-row"><SidebarOpen /><h1 className="pane-title">{viewTitles.settings}</h1></div>
    </header>
    <LanguageChoice />
    {config.features.push && <PushSettings />}
  </div>;
}

function PushSettings() {
  const t = text();
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
    if (!on) { await disablePush(d.csrfToken); setDevice(null); d.notify(t.turnedOff); return; }
    const result = await enablePush(d.csrfToken);
    if (result === "denied") { d.notify(t.denied, "error"); return; }
    if (result === "unsupported") { d.notify(t.unsupported, "error"); return; }
    if (result === "unavailable") { d.notify(t.unavailable, "error"); return; }
    setDevice(result);
    d.notify(t.turnedOn);
  });
  const choose = (key: keyof PushKinds, value: boolean) => run(async () => {
    if (!device) return;
    const result = await enablePush(d.csrfToken, { ...device.kinds, [key]: value });
    if (typeof result === "object") setDevice(result);
    else d.notify(t.kindFailed, "error");
  });
  const test = () => run(async () => {
    const result = await testPush(d.csrfToken);
    if (!result) { d.notify(t.notOn, "error"); return; }
    d.notify(result.delivered ? t.testSent : t.testRejected(String(result.status ?? t.noConnection)), result.delivered ? "info" : "error");
  });
  const on = device !== null && device !== undefined;
  const status = support === "ios-browser" ? t.homeScreenOnly
    : support === "unsupported" ? t.noPush
      : permission === "denied" ? t.blocked
        : device === undefined ? t.checking : on ? t.on : t.off;
  const kinds = (Object.keys(kindIcons) as (keyof PushKinds)[]).filter(key => key !== "digest" || config.features.digest);

  return <>
    {support === "ios-browser" && <p className="settings-notice" role="note">{t.iosNotice}</p>}
    <section className="more-group" aria-labelledby="settings-device">
      <h2 id="settings-device" className="more-heading">{t.device}</h2>
      <ul className="more-list">
        <Row icon={<Bell size={18} aria-hidden="true" />} label={t.receive} note={status}
          control={<Switch checked={on} label={t.receive} disabled={pending || support !== "supported" || device === undefined || (permission === "denied" && !on)} onChange={next => { void turn(next); }} />} />
        <Row icon={<BellRing size={18} aria-hidden="true" />} label={t.test} note={t.testNote}
          control={<button type="button" className="btn btn-outline" onClick={() => { void test(); }} disabled={pending || !on}><Send size={15} aria-hidden="true" />{t.send}</button>} />
      </ul>
    </section>
    <section className="more-group" aria-labelledby="settings-kinds">
      <h2 id="settings-kinds" className="more-heading">{t.kindsHeading}</h2>
      <ul className="more-list">
        {kinds.map(key => <Row key={key} icon={kindIcons[key]} label={t.kinds[key].label} note={t.kinds[key].note}
          control={<Switch checked={on && device.kinds[key]} label={t.kinds[key].label} disabled={pending || !on} onChange={next => { void choose(key, next); }} />} />)}
      </ul>
    </section>
    <section className="more-group" aria-labelledby="settings-ios">
      <h2 id="settings-ios" className="more-heading">{t.howHeading}</h2>
      <ol className="settings-steps">{t.steps.map(step => <li key={step}>{step}</li>)}</ol>
    </section>
  </>;
}
