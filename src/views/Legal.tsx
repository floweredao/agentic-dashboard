import { config } from "../config";
import { strings } from "../i18n";

const text = strings({
  en: {
    back: "Back to dashboard", privacy: "Privacy policy", terms: "Terms of use", effective: "Effective October 24, 2026",
    contact: "Contact the operator", selfHost: "For a self-hosted installation, contact the person operating your server.",
    region: (value: string) => `Operator-declared database region: ${value}.`,
    regionUnknown: "The operator has not published the database region. Ask the contact below before uploading location-sensitive material.",
    privacySections: [
      ["Who controls your data", "The operator of the dashboard at this address controls its stored data. The contact below handles privacy requests. A self-hosted server is controlled by its own operator; a hosted account is not storage on your own device."],
      ["What is collected", "Google subject identifier, verified email and display name; your language and calendar preferences; records, documents, comments, digests and audio that you or your agents save; agent registration metadata; session data; and push endpoints with delivery credentials. The app does not receive your Google password or mailbox access."],
      ["Why it is used", "To sign you in, isolate your account, save and show agent results, deliver the notifications you request, generate audio or enrich titles when you opt in, enforce limits and operate the service. We do not use saved content for advertising or sell it."],
      ["Google and optional AI processing", "Adding a Gemini key is optional. Narration sends saved text to Google for scripts and speech; title enrichment sends saved text or linked-page extracts. Requests use your Google project and may incur charges. Google's unpaid and paid services have different processing terms, including possible improvement and human review, with regional exceptions. Review the linked Google terms before sending private content."],
      ["Processors and locations", "The reference hosted deployment runs on Google Cloud in us-central1, United States, for application hosting, private audio and backups, and queued work. Google handles sign-in and Gemini processing under its terms. Turso/libSQL stores the database when configured; its region is configured separately. Browser push providers receive delivery addresses and encrypted notification payloads. Resend carries operational alerts only to the operator, not user mail, saved content or account identities. Infrastructure placement is configured by the operator, not verified by this page."],
      ["Operator access and security", "The operator can administer the database and backups and can access stored content. Gemini keys are encrypted at rest; agent tokens are stored only as hashes. Sessions use HttpOnly cookies, account-scoped access and CSRF protection. Public sharing is off until requested; anyone with an active share link can read that projection. Revocation cannot erase copies a recipient already saved."],
      ["Retention and deletion", "Active account content is retained until you delete it or your account. Trash expires after 30 days. Account deletion revokes sessions and agent tokens, erases active database rows and removes private audio; failed object deletion is retried by daily maintenance. Backups expire after 14 days. A minimal tombstone retains the Google subject and deletion timestamp so historical data is not restored into a returning account; a later sign-in creates a new empty account."],
      ["Logs", "Application logs contain operational metadata such as model/provider names, failure classes, usage counts and job identifiers, not request bodies, session cookies or keys. Rate limiting uses bounded in-memory network-address buckets: counters reset each minute, but entries may remain until eviction or restart. Sign-in state stores a keyed network identifier, not the raw address; it expires after ten minutes and expired state is purged on later sign-ins. Hosting request logs are separate: Cloud Run/Cloud Logging can record client IP, method, URL, user agent, status, response size, latency and resource/revision labels. Their retention and operator access follow the deployment's logging settings, not account deletion. No infrastructure log-retention audit is implied by this page."],
      ["Cookies and device storage", "Authentication uses a session cookie and a short-lived Google sign-in transaction cookie. Browser storage keeps preferences, local drafts and player UI choices. There are no advertising or analytics cookies. Installing the app does not make account content available offline."],
      ["Your choices and rights", "Use Settings to download your data, choose language and calendar zone, remove your Gemini key, turn off automatic processing, manage notification previews, revoke agent tokens or delete your account. Reauthenticate and type your email to delete. You can also ask the operator to access, correct or remove data. Export includes a README, JSON and audio; user-facing bulk import is not supported."],
      ["Changes", "The effective date above identifies this policy version. Material processing changes should be announced before they take effect. Contact the operator about this installation's actual configuration or unresolved requests."],
    ],
    termsSections: [
      ["Service and eligibility", "floweredao is an inbox for results saved by your AI agents. Hosted access requires a verified Google account and available capacity. It is not intended for children under 14. Use the service only when you can consent to these terms under applicable law."],
      ["Your account and agents", "Keep credentials private, give tokens only to agents you trust and revoke lost tokens. A token can read the account's shared records and edit its own records; channels are attribution, not separate private inboxes. You are responsible for what your agents submit and for permission to store or share it."],
      ["Content and sharing", "You retain rights to your content and permit the operator to process it only to provide and operate the service. Do not upload unlawful material, infringe others' rights, compromise accounts or abuse the service. Anyone holding a share link can read its published projection until you revoke it."],
      ["Optional providers and costs", "Reading and saving need no Gemini key. AI generation is optional, uses your Google project and may incur provider charges. Free availability varies by project, region, model and provider terms; no fixed free audio allowance or currency cap is promised. App limits count starts, including failed starts; one start may make several provider requests."],
      ["Availability and limits", "The service may start slowly after inactivity, apply account or address limits, suspend abusive access or be unavailable during maintenance. It requires internet access. The operator does not promise continuous availability, offline reading or a news/mail collection service; your agent supplies and schedules digests."],
      ["Export and ending use", "Download your account archive in Settings before leaving if you want a copy. Account deletion requires recent authentication and exact email confirmation. Active-data removal and backup expiry have different timing, as described in the privacy policy. Reauthentication never submits deletion automatically."],
      ["Responsibility and questions", "Generated content may be inaccurate; review results before relying on them. These terms do not remove rights or remedies that applicable law cannot exclude. Contact the operator below for service questions, disputes or privacy requests."],
      ["Updates", "The operator may update these terms, identifying the new effective date and announcing material changes before they apply."],
    ],
    google: "Google Gemini terms", quotas: "Google project quota information",
  },
  ko: {
    back: "대시보드로 돌아가기", privacy: "개인정보처리방침", terms: "이용약관", effective: "시행일: 2026년 10월 24일",
    contact: "운영자에게 문의", selfHost: "직접 설치한 서버라면 해당 서버 운영자에게 문의해 주세요.",
    region: (value: string) => `운영자가 지정한 데이터베이스 지역: ${value}.`,
    regionUnknown: "운영자가 데이터베이스 지역을 공개하지 않았어요. 저장 위치가 중요한 자료는 올리기 전에 아래 연락처로 확인해 주세요.",
    privacySections: [
      ["개인정보 처리 주체", "이 주소의 대시보드 운영자가 저장된 데이터를 관리해요. 개인정보 관련 요청은 아래 연락처에서 받아요. 직접 설치한 서버는 해당 운영자가 관리하며, 호스팅 계정의 데이터는 내 기기에만 저장되는 것이 아니에요."],
      ["수집 항목", "Google 계정 식별자, 확인된 이메일과 표시 이름, 언어·날짜 표시 설정, 나 또는 내 에이전트가 저장한 기록·문서·코멘트·다이제스트·음성, 에이전트 등록 정보, 세션 정보, 푸시 주소와 전송 인증 정보를 처리해요. Google 비밀번호나 메일함 접근 권한은 받지 않아요."],
      ["이용 목적", "로그인과 계정 분리, 에이전트 결과 저장·표시, 요청한 알림 전송, 선택한 음성 생성·제목 보강, 한도 적용과 서비스 운영에 사용해요. 저장한 내용을 광고에 이용하거나 판매하지 않아요."],
      ["Google과 선택적 AI 처리", "Gemini 키 등록은 선택 사항이에요. 낭독은 저장한 텍스트를 Google로 보내 대본과 음성을 만들고, 제목 보강은 저장한 텍스트나 연결 페이지에서 추출한 내용을 보내요. 내 Google 프로젝트를 사용하며 요금이 발생할 수 있어요. 무료·유료 서비스의 처리 조건은 다르며 서비스 개선·사람의 검토 가능성과 지역별 예외가 있으니 비공개 내용을 보내기 전에 연결된 Google 약관을 확인해 주세요."],
      ["처리 서비스와 저장 위치", "기준 호스팅 구성은 미국 Google Cloud us-central1에서 앱, 비공개 음성·백업, 작업 대기열을 운영해요. Google은 자사 약관에 따라 로그인과 Gemini 처리를 담당해요. Turso/libSQL을 설정하면 해당 서비스에 데이터베이스를 저장하며 지역은 별도로 정해요. 브라우저 푸시 제공자는 전송 주소와 암호화된 알림 내용을 받아요. Resend는 운영자에게만 운영 알림을 보내고, 사용자 메일·저장 내용·계정 신원은 전달하지 않아요. 이 페이지는 운영자의 인프라 위치를 직접 검증하지 않아요."],
      ["운영자 접근과 보호 조치", "운영자는 데이터베이스와 백업을 관리하고 저장 내용에 접근할 수 있어요. Gemini 키는 암호화해 저장하고, 에이전트 토큰은 해시만 저장해요. HttpOnly 세션 쿠키, 계정별 접근 제어와 CSRF 보호를 사용해요. 공개 공유는 직접 켜야 하며, 활성 공유 링크를 가진 사람은 공개된 내용을 읽을 수 있어요. 공유를 꺼도 상대가 이미 저장한 사본은 지울 수 없어요."],
      ["보관과 삭제", "계정의 내용은 직접 삭제하거나 계정을 삭제할 때까지 보관해요. 휴지통은 30일 뒤 비워요. 계정 삭제는 세션·에이전트 토큰을 무효화하고 활성 데이터베이스 행과 비공개 음성을 지워요. 객체 삭제가 실패하면 일일 정리 작업이 다시 시도해요. 백업은 14일 뒤 만료돼요. 과거 데이터를 복원하지 않도록 Google 식별자와 삭제 시각만 담은 최소 삭제 표식을 남기며, 이후 로그인은 빈 새 계정을 만들어요."],
      ["로그", "앱 로그는 모델·제공자 이름, 오류 종류, 사용량 수치와 작업 식별자 같은 운영 정보를 담으며 요청 본문·세션 쿠키·키는 기록하지 않아요. 요청 제한은 크기가 제한된 메모리에 네트워크 주소별 정보를 보관해요. 횟수는 매분 초기화되지만 항목은 교체되거나 서버가 재시작될 때까지 남을 수 있어요. 로그인 상태에는 원래 주소 대신 키로 변환한 네트워크 식별자를 저장해요. 상태는 10분 뒤 만료되고 이후 로그인 시 만료된 상태를 정리해요. 호스팅 요청 로그는 별개예요. Cloud Run·Cloud Logging은 접속 IP, 메서드, URL, 사용자 에이전트, 상태, 응답 크기, 지연 시간과 리소스·리비전 정보를 기록할 수 있어요. 보관 기간과 운영자 접근은 배포 환경의 로그 설정을 따르며 계정 삭제와 별개예요. 이 페이지가 인프라 로그 보관 설정을 감사했다는 뜻은 아니에요."],
      ["쿠키와 기기 저장소", "인증에는 세션 쿠키와 짧게 유지되는 Google 로그인 절차 쿠키를 사용해요. 브라우저 저장소에는 설정, 작성 중인 내용과 재생 화면 선택을 보관해요. 광고·분석 쿠키는 사용하지 않아요. 앱을 설치해도 계정 내용을 오프라인에서 읽을 수는 없어요."],
      ["선택권과 요청 방법", "설정에서 데이터를 내려받고, 언어·시간대를 선택하고, Gemini 키 삭제·자동 처리 중지·알림 내용 숨기기·에이전트 연결 해제·계정 삭제를 할 수 있어요. 계정 삭제는 다시 로그인하고 이메일을 입력해야 해요. 운영자에게 열람·정정·삭제를 요청할 수도 있어요. 내보내기는 안내문, JSON과 음성을 포함하며 사용자용 일괄 가져오기는 제공하지 않아요."],
      ["변경 안내", "위 시행일로 방침의 버전을 구분해요. 중요한 처리 변경은 적용 전에 안내해야 해요. 실제 설치 설정이나 해결되지 않은 요청은 운영자에게 문의해 주세요."],
    ],
    termsSections: [
      ["서비스와 이용 자격", "floweredao는 AI 에이전트가 저장한 결과를 모아 읽는 공간이에요. 호스팅 서비스에는 확인된 Google 계정과 남은 가입 정원이 필요해요. 만 14세 미만을 대상으로 하지 않으며, 적용 법률에 따라 이 약관에 동의할 수 있을 때 이용해 주세요."],
      ["계정과 에이전트", "인증 정보를 비공개로 보관하고 신뢰하는 에이전트에게만 토큰을 주세요. 잃어버린 토큰은 해제해 주세요. 토큰은 계정의 공유 기록을 읽고 자신이 저장한 기록을 수정할 수 있으며 채널은 별도의 비공개 보관함이 아니에요. 에이전트가 올리는 내용과 저장·공유 권한을 확인할 책임은 사용자에게 있어요."],
      ["콘텐츠와 공유", "콘텐츠의 권리는 사용자에게 있으며 운영자는 서비스 제공과 운영에 필요한 범위에서만 처리할 수 있어요. 불법 자료 업로드, 타인의 권리 침해, 계정 침해와 서비스 악용은 허용하지 않아요. 공유 링크를 가진 사람은 공유를 끌 때까지 공개된 내용을 읽을 수 있어요."],
      ["선택 기능과 비용", "읽기와 저장에는 Gemini 키가 필요하지 않아요. AI 생성은 선택 사항이며 내 Google 프로젝트를 사용해 제공자 요금이 발생할 수 있어요. 무료 이용 여부는 프로젝트·지역·모델·제공자 약관에 따라 달라지며 정해진 무료 음성 수나 금액 상한을 약속하지 않아요. 앱 한도는 실패를 포함한 시작 횟수이며, 한 번의 시작에 여러 제공자 요청이 발생할 수 있어요."],
      ["가용성과 제한", "사용하지 않던 서비스의 첫 실행이 느릴 수 있고, 계정·접속 주소별 한도, 악용 계정 제한 또는 점검 중 중단이 있을 수 있어요. 인터넷 연결이 필요해요. 상시 가용성, 오프라인 읽기, 뉴스·메일 수집을 보장하지 않으며 다이제스트의 수집·예약 업로드는 내 에이전트가 담당해요."],
      ["내보내기와 이용 종료", "사본이 필요하면 이용을 마치기 전에 설정에서 계정 자료를 내려받아 주세요. 계정 삭제에는 최근 로그인과 정확한 이메일 확인이 필요해요. 활성 데이터 삭제와 백업 만료 시점은 개인정보처리방침과 같이 서로 달라요. 다시 로그인해도 삭제를 자동으로 실행하지 않아요."],
      ["책임과 문의", "생성된 내용에는 오류가 있을 수 있으니 활용하기 전에 확인해 주세요. 이 약관은 적용 법률상 배제할 수 없는 권리나 구제 수단을 제한하지 않아요. 서비스 문의, 분쟁이나 개인정보 요청은 아래 운영자 연락처를 이용해 주세요."],
      ["약관 변경", "운영자가 약관을 바꾸면 시행일을 갱신하고 중요한 변경은 적용 전에 안내해야 해요."],
    ],
    google: "Google Gemini 약관", quotas: "Google 프로젝트 한도 안내",
  },
});
export function Legal({ page }: { readonly page: "privacy" | "terms" }) {
  const t = text();
  const sections = page === "privacy" ? t.privacySections : t.termsSections;
  return <main className="entry-page"><article className="legal-page">
    <a href="/">{t.back}</a><h1>{page === "privacy" ? t.privacy : t.terms}</h1><p>{t.effective}</p>
    {sections.map(([title, body]) => <section key={title}><h2>{title}</h2><p>{body}</p></section>)}
    {page === "privacy" && <p>{config.databaseRegion ? t.region(config.databaseRegion) : t.regionUnknown}</p>}
    <p><a href="https://ai.google.dev/gemini-api/terms" target="_blank" rel="noreferrer">{t.google}</a>
      {" · "}<a href="https://ai.google.dev/gemini-api/docs/rate-limits" target="_blank" rel="noreferrer">{t.quotas}</a></p>
    <section><h2>{t.contact}</h2>{config.contactEmail ? <a href={`mailto:${config.contactEmail}`}>{config.contactEmail}</a> : <p>{t.selfHost}</p>}</section>
    <nav className="account-legal"><a href="/privacy">{t.privacy}</a><a href="/terms">{t.terms}</a></nav>
  </article></main>;
}
