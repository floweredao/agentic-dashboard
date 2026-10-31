import { strings } from "../i18n";
import { config } from "../config";
import { PushSettings } from "./Settings";

const text = strings({
  en: { title: "Use it on your phone", ios: "iPhone or iPad: open this address in Safari, choose Share, then Add to Home Screen.",
    android: "Android: open this address in Chrome, open the browser menu, then Install app or Add to Home screen.",
    reopen: "Open the installed app and sign in again if asked. On iOS, install and reopen first; then enable notifications below.",
    internet: "Internet required. Installing the app does not make saved records available offline.",
    privacy: "Notifications can show saved titles and excerpts on your lock screen. Choose Hide notification content before enabling them.",
    later: "You can replay these steps in Settings. Notifications are optional and configured per device." },
  ko: { title: "휴대폰에서 사용하기", ios: "iPhone·iPad: Safari에서 이 주소를 열고 공유 → 홈 화면에 추가를 선택해 주세요.",
    android: "Android: Chrome에서 이 주소를 열고 브라우저 메뉴 → 앱 설치 또는 홈 화면에 추가를 선택해 주세요.",
    reopen: "설치한 앱을 열고 필요하면 다시 로그인해 주세요. iOS에서는 설치한 앱을 먼저 연 뒤 아래에서 알림을 켜 주세요.",
    internet: "인터넷 연결이 필요해요. 앱을 설치해도 저장한 기록을 오프라인에서 읽을 수는 없어요.",
    privacy: "알림 제목과 내용이 잠금 화면에 보일 수 있어요. 원하지 않으면 알림을 켜기 전에 알림 내용 숨기기를 선택해 주세요.",
    later: "설정에서 이 안내를 다시 볼 수 있어요. 알림은 선택 사항이며 기기마다 따로 설정해요." },
});
export function PhoneSetup() {
  const t = text();
  return <section className="more-group account-stack" aria-labelledby="phone-setup-title">
    <h2 id="phone-setup-title" className="more-heading">{t.title}</h2>
    <ul className="phone-steps"><li>{t.ios}</li><li>{t.android}</li><li>{t.reopen}</li></ul>
    <p>{t.internet}</p><p className="setting-note">{t.privacy}</p>
    {config.features.push && <PushSettings />}
    <p className="setting-note">{t.later}</p>
  </section>;
}
