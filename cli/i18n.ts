export type Lang = "en" | "ko";

export const detectLang = (env: NodeJS.ProcessEnv = process.env): Lang =>
  /^ko/i.test(env["AGENTIC_DASHBOARD_LANG"] || env["LC_ALL"] || env["LC_MESSAGES"] || env["LANG"] || "") ? "ko" : "en";

export const en = {
  help: `Agentic Dashboard

  agentic-dashboard              first run: choose to host a dashboard or connect agents; later: start or show status
  agentic-dashboard setup        host the dashboard on this computer (port, data folder, owner key, access, start at login)
  agentic-dashboard start        run the dashboard in this terminal
  agentic-dashboard service install|uninstall|restart|status
  agentic-dashboard invite <name>   one-time connection code for an agent on another computer
  agentic-dashboard agents add|list|rotate|remove [name]
  agentic-dashboard owner-key    show the owner key
  agentic-dashboard connect      connect this computer's agents to a dashboard (address, code or key, skill files)
  agentic-dashboard agent ...    save, read and search records as the connected agent (see agent --help)
  agentic-dashboard skills install [--target claude-code|codex|omo|agents] [--force]
  agentic-dashboard status       what is set up here; never prints keys
  agentic-dashboard onboard      open the first-run choice again

Settings live in AGENTIC_DASHBOARD_HOME (default ~/.agentic-dashboard).`,
  notSetUp: "Agentic Dashboard isn't set up on this computer yet. In a terminal, run:\n  agentic-dashboard setup     to host the dashboard here\n  agentic-dashboard connect   to connect this computer's agents to a dashboard",
  onboardTitle: "Welcome to Agentic Dashboard. What do you want to do on this computer?",
  onboardHost: "Host the dashboard here (records, keys and the web app live on this computer)",
  onboardConnect: "Connect this computer's agents to a dashboard that runs elsewhere",
  choose: "Choose a number",
  chooseInvalid: "Enter one of the numbers shown.",
  setupIntro: "Setting up the dashboard on this computer. Press Enter to keep the value in brackets.",
  setupNeedTerminal: "setup asks a few questions; run it in a terminal, or pass --yes (with --port, --data-dir, --origin, --service or --no-service) to accept the defaults.",
  setupPort: "Port to listen on (127.0.0.1)",
  setupPortInvalid: "Enter a port number from 1 to 65535.",
  setupPortBusy: "Port {port} is already in use. Pick another port, or stop what uses it.",
  setupData: "Folder for records, keys and audio",
  setupAccess: "Where will you open the dashboard?",
  setupAccessLocal: "Only on this computer (http://127.0.0.1:{port})",
  setupAccessTailscale: "From my other devices through Tailscale (HTTPS inside my tailnet)",
  setupAccessProxy: "Through my own HTTPS reverse proxy or domain",
  setupTailscaleMissing: "Tailscale isn't installed or signed in here. Install it from https://tailscale.com/download and sign in; enter the address you'll use, or leave it empty for now.",
  setupOrigin: "Address people open, for example https://dashboard.example.com",
  setupOriginInvalid: "Enter a full http:// or https:// address.",
  setupTailscaleServe: "To publish it in your tailnet, run this once on this computer:\n  {command}\nOnly devices in your tailnet can reach it.",
  setupSaved: "Saved the settings in {path}.",
  setupOwnerCreated: "Created the owner key in {path} (readable only by you).",
  setupOwnerShow: "Owner key (sign in with it once, then keep it in your password manager):\n  {key}",
  setupOwnerHidden: "Show it any time with: agentic-dashboard owner-key",
  setupOwnerKept: "Kept the owner key in {path}. Show it with: agentic-dashboard owner-key",
  setupBuilding: "Building the web app (first time only)...",
  setupBuildFailed: "The web app build failed; fix the error above and run agentic-dashboard setup again.",
  setupService: "Start the dashboard automatically when you log in?",
  setupServiceInstalled: "Installed the background service ({path}). Log: {log}",
  setupServiceUnsupported: "Starting at login is built in on macOS and Linux only; run agentic-dashboard start yourself.",
  setupRunning: "The dashboard is running: open {url}",
  setupNotRunning: "The service didn't answer yet; check agentic-dashboard service status and the log {log}.",
  setupStartNow: "Start the dashboard now in this terminal?",
  setupStartLater: "Start it any time with: agentic-dashboard start   (then open {url})",
  setupNext: "Next, give each agent its own key. For an agent on another computer, run this here and follow what it prints:\n  agentic-dashboard invite <name>\nFor agents on this computer: agentic-dashboard connect",
  startDefaults: "No settings yet; using the defaults (port 4310, data in {data}). Run agentic-dashboard setup to change them.",
  inviteIssued: "Connection code for the agent \"{agent}\": {code}\nIt works once, until {time}.",
  inviteRemote: "On the agent's computer, run:\n  {command}",
  inviteInstalled: "If agentic-dashboard is already installed there:\n  {command}",
  inviteLoopback: "{url} only works on this computer. For other computers, publish the dashboard (agentic-dashboard setup, for example through Tailscale) and use that address.",
  inviteUsage: "Usage: agentic-dashboard invite <name>   (lowercase letters, digits and dashes, for example laptop-codex)",
  invalidName: "Invalid agent name: {detail}",
  connectUrl: "Dashboard address",
  connectNeedUrl: "Pass the dashboard address with --url, or run connect in a terminal.",
  connectUnreachable: "Couldn't reach a dashboard at {url} ({detail}). Check the address and that this computer can reach it (for example that Tailscale is on).",
  connectFound: "Found {name} at {url}.",
  connectAlready: "This computer is already connected to {url} as \"{agent}\". Connect again?",
  connectCode: "Connection code from 'agentic-dashboard invite' on the dashboard host (leave empty to enter an agent name and key instead)",
  connectBadCode: "That connection code is unknown, already used or expired. Issue a new one on the dashboard host: agentic-dashboard invite <name>",
  connectAgent: "Agent name (as registered on the dashboard)",
  connectKey: "Agent key (hidden while you type)",
  connectNeedKey: "Without a terminal, pass --code, or --agent with the key on standard input (--key-stdin).",
  connectBadKey: "The dashboard refused this key (HTTP {status}). Check it, or use a connection code instead.",
  connectConnected: "Connected as \"{agent}\"; the key works.",
  connectKeychain: "Stored the key in the system keychain (service agentic-dashboard).",
  connectKeyFile: "Stored the key in {path} (readable only by you).",
  connectKeychainFailed: "The system keychain isn't available ({detail}); storing the key in a file readable only by you instead.",
  connectDone: "Done. Try: {command}",
  skillsAsk: "Install the dashboard skill for {list}?",
  skillsNone: "No agent tools found (Claude Code, Codex, OmO or ~/.agents). Install the skill later with: agentic-dashboard skills install --target claude-code|codex|omo|agents",
  skillsInstalled: "Installed the skill for {label}: {path}",
  skillsSkipped: "Kept {path}: agentic-dashboard didn't write it (use --force to replace it).",
  skillsNeedConnect: "Connect this computer first: agentic-dashboard connect",
  skillsUnknownTarget: "Unknown target {target}; use claude-code, codex, omo or agents.",
  statusServer: "Dashboard on this computer: port {port}, data in {data}, address {url}, background service {service}",
  statusNoServer: "Dashboard on this computer: not set up (agentic-dashboard setup)",
  statusClient: "Agents on this computer: connected to {url} as \"{agent}\" (key in {store}): {state}",
  statusNoClient: "Agents on this computer: not connected (agentic-dashboard connect)",
  stateWorking: "working",
  stateUnreachable: "dashboard unreachable",
  stateRefused: "key refused (HTTP {status})",
  stateNoKey: "key missing",
  stateRunning: "running",
  stateStopped: "installed, not running",
  stateNotInstalled: "not installed",
  stateUnsupported: "not available on this system",
  storeKeychain: "the system keychain",
  serviceUsage: "Usage: agentic-dashboard service install|uninstall|restart|status",
  serviceState: "Background service {label}: {state}",
  serviceRemoved: "Removed the background service.",
  serviceRestarted: "Restarted the background service.",
  ownerKey: "Owner key ({path}):\n  {key}",
  alreadyRunning: "The dashboard runs as a background service: open {url}. See agentic-dashboard status.",
  unknownCommand: "Unknown command {command}. See agentic-dashboard help.",
  yesNo: "[Y/n]",
  noYes: "[y/N]",
} as const;
export type MessageKey = keyof typeof en;

export const ko: Record<MessageKey, string> = {
  help: `Agentic Dashboard

  agentic-dashboard              처음: 대시보드를 여기서 돌릴지, 에이전트를 연결할지 고르기. 그다음: 시작하거나 상태 보기
  agentic-dashboard setup        이 컴퓨터에서 대시보드 돌리기(포트, 데이터 폴더, 소유자 키, 접속 방법, 로그인 때 자동 시작)
  agentic-dashboard start        이 터미널에서 대시보드 실행
  agentic-dashboard service install|uninstall|restart|status
  agentic-dashboard invite <이름>   다른 컴퓨터의 에이전트용 1회용 연결 코드
  agentic-dashboard agents add|list|rotate|remove [이름]
  agentic-dashboard owner-key    소유자 키 보기
  agentic-dashboard connect      이 컴퓨터의 에이전트를 대시보드에 연결(주소, 코드나 키, 스킬 파일)
  agentic-dashboard agent ...    연결된 에이전트로 기록 저장·읽기·검색(agent --help 참고)
  agentic-dashboard skills install [--target claude-code|codex|omo|agents] [--force]
  agentic-dashboard status       여기 설정된 것 보기(키는 출력하지 않아요)
  agentic-dashboard onboard      처음 선택 화면 다시 열기

설정은 AGENTIC_DASHBOARD_HOME(기본 ~/.agentic-dashboard)에 있어요.`,
  notSetUp: "이 컴퓨터에는 아직 Agentic Dashboard 설정이 없어요. 터미널에서 실행하세요:\n  agentic-dashboard setup     여기서 대시보드 돌리기\n  agentic-dashboard connect   이 컴퓨터의 에이전트를 대시보드에 연결",
  onboardTitle: "Agentic Dashboard를 시작해요. 이 컴퓨터에서 무엇을 할까요?",
  onboardHost: "여기서 대시보드 돌리기(기록, 키, 웹 앱이 이 컴퓨터에 있어요)",
  onboardConnect: "다른 곳에서 돌아가는 대시보드에 이 컴퓨터의 에이전트 연결하기",
  choose: "번호를 고르세요",
  chooseInvalid: "보이는 번호 중 하나를 입력하세요.",
  setupIntro: "이 컴퓨터에 대시보드를 설정해요. 괄호 안 값을 그대로 쓰려면 Enter를 누르세요.",
  setupNeedTerminal: "setup은 몇 가지를 물어봐요. 터미널에서 실행하거나, 기본값으로 진행하려면 --yes(와 --port, --data-dir, --origin, --service 또는 --no-service)를 붙이세요.",
  setupPort: "사용할 포트(127.0.0.1)",
  setupPortInvalid: "1부터 65535 사이의 포트 번호를 입력하세요.",
  setupPortBusy: "{port} 포트를 이미 쓰고 있어요. 다른 포트를 고르거나 그 프로그램을 멈추세요.",
  setupData: "기록, 키, 오디오를 둘 폴더",
  setupAccess: "대시보드를 어디서 열 건가요?",
  setupAccessLocal: "이 컴퓨터에서만(http://127.0.0.1:{port})",
  setupAccessTailscale: "Tailscale로 내 다른 기기에서(tailnet 안의 HTTPS)",
  setupAccessProxy: "내 HTTPS 리버스 프록시나 도메인으로",
  setupTailscaleMissing: "여기에 Tailscale이 없거나 로그인돼 있지 않아요. https://tailscale.com/download 에서 설치하고 로그인하세요. 쓸 주소를 입력하거나, 지금은 비워 두세요.",
  setupOrigin: "열 때 쓰는 주소(예: https://dashboard.example.com)",
  setupOriginInvalid: "http:// 또는 https://로 시작하는 전체 주소를 입력하세요.",
  setupTailscaleServe: "tailnet에 공개하려면 이 컴퓨터에서 한 번 실행하세요:\n  {command}\n내 tailnet의 기기만 접속할 수 있어요.",
  setupSaved: "설정을 {path}에 저장했어요.",
  setupOwnerCreated: "소유자 키를 {path}에 만들었어요(나만 읽을 수 있어요).",
  setupOwnerShow: "소유자 키(한 번 로그인한 뒤 비밀번호 관리자에 보관하세요):\n  {key}",
  setupOwnerHidden: "언제든 이 명령으로 볼 수 있어요: agentic-dashboard owner-key",
  setupOwnerKept: "소유자 키는 {path}에 있는 것을 그대로 써요. 보기: agentic-dashboard owner-key",
  setupBuilding: "웹 앱을 빌드하고 있어요(처음 한 번만)...",
  setupBuildFailed: "웹 앱 빌드에 실패했어요. 위 오류를 고친 뒤 agentic-dashboard setup을 다시 실행하세요.",
  setupService: "로그인할 때 대시보드를 자동으로 시작할까요?",
  setupServiceInstalled: "백그라운드 서비스를 설치했어요({path}). 로그: {log}",
  setupServiceUnsupported: "로그인 때 자동 시작은 macOS와 Linux에서만 돼요. agentic-dashboard start로 직접 실행하세요.",
  setupRunning: "대시보드가 돌아가고 있어요. 여세요: {url}",
  setupNotRunning: "서비스가 아직 응답하지 않아요. agentic-dashboard service status와 로그 {log}를 확인하세요.",
  setupStartNow: "지금 이 터미널에서 대시보드를 시작할까요?",
  setupStartLater: "언제든 이 명령으로 시작하세요: agentic-dashboard start   (그다음 {url} 열기)",
  setupNext: "다음으로 에이전트마다 키를 따로 주세요. 다른 컴퓨터의 에이전트라면 여기서 이 명령을 실행하고 나온 안내를 따르세요:\n  agentic-dashboard invite <이름>\n이 컴퓨터의 에이전트라면: agentic-dashboard connect",
  startDefaults: "아직 설정이 없어서 기본값(포트 4310, 데이터 {data})으로 실행해요. 바꾸려면 agentic-dashboard setup을 실행하세요.",
  inviteIssued: "에이전트 \"{agent}\"의 연결 코드: {code}\n{time}까지 한 번만 쓸 수 있어요.",
  inviteRemote: "에이전트를 쓸 컴퓨터에서 실행하세요:\n  {command}",
  inviteInstalled: "그 컴퓨터에 agentic-dashboard가 이미 있다면:\n  {command}",
  inviteLoopback: "{url}은 이 컴퓨터에서만 열려요. 다른 컴퓨터에서 쓰려면 대시보드를 공개하고(agentic-dashboard setup, 예: Tailscale) 그 주소를 쓰세요.",
  inviteUsage: "사용법: agentic-dashboard invite <이름>   (영문 소문자, 숫자, 대시. 예: laptop-codex)",
  invalidName: "에이전트 이름이 올바르지 않아요: {detail}",
  connectUrl: "대시보드 주소",
  connectNeedUrl: "대시보드 주소를 --url로 주거나, 터미널에서 connect를 실행하세요.",
  connectUnreachable: "{url}에서 대시보드를 찾지 못했어요({detail}). 주소와 이 컴퓨터에서 접속할 수 있는지(예: Tailscale이 켜져 있는지) 확인하세요.",
  connectFound: "{url}에서 대시보드를 찾았어요({name}).",
  connectAlready: "이 컴퓨터는 이미 {url}에 \"{agent}\"로 연결돼 있어요. 다시 연결할까요?",
  connectCode: "대시보드 컴퓨터에서 'agentic-dashboard invite'로 받은 연결 코드(비워 두면 에이전트 이름과 키를 직접 입력해요)",
  connectBadCode: "모르는 코드이거나, 이미 썼거나, 만료된 코드예요. 대시보드 컴퓨터에서 새로 받으세요: agentic-dashboard invite <이름>",
  connectAgent: "에이전트 이름(대시보드에 등록된 이름)",
  connectKey: "에이전트 키(입력하는 동안 보이지 않아요)",
  connectNeedKey: "터미널이 없을 때는 --code를 주거나, --agent와 함께 키를 표준 입력으로 주세요(--key-stdin).",
  connectBadKey: "대시보드가 이 키를 거절했어요(HTTP {status}). 키를 확인하거나 연결 코드를 쓰세요.",
  connectConnected: "\"{agent}\"로 연결했어요. 키가 잘 돼요.",
  connectKeychain: "키를 시스템 키체인(서비스 agentic-dashboard)에 저장했어요.",
  connectKeyFile: "키를 {path}에 저장했어요(나만 읽을 수 있어요).",
  connectKeychainFailed: "시스템 키체인을 쓸 수 없어요({detail}). 대신 나만 읽을 수 있는 파일에 저장해요.",
  connectDone: "끝났어요. 이렇게 써 보세요: {command}",
  skillsAsk: "{list}에 대시보드 스킬을 설치할까요?",
  skillsNone: "에이전트 도구(Claude Code, Codex, OmO, ~/.agents)를 찾지 못했어요. 나중에 이렇게 설치하세요: agentic-dashboard skills install --target claude-code|codex|omo|agents",
  skillsInstalled: "{label}에 스킬을 설치했어요: {path}",
  skillsSkipped: "{path}는 agentic-dashboard가 만든 파일이 아니라서 그대로 뒀어요(바꾸려면 --force).",
  skillsNeedConnect: "먼저 이 컴퓨터를 연결하세요: agentic-dashboard connect",
  skillsUnknownTarget: "모르는 대상 {target}이에요. claude-code, codex, omo, agents 중에서 고르세요.",
  statusServer: "이 컴퓨터의 대시보드: 포트 {port}, 데이터 {data}, 주소 {url}, 백그라운드 서비스 {service}",
  statusNoServer: "이 컴퓨터의 대시보드: 설정 안 됨(agentic-dashboard setup)",
  statusClient: "이 컴퓨터의 에이전트: {url}에 \"{agent}\"로 연결됨(키 위치 {store}): {state}",
  statusNoClient: "이 컴퓨터의 에이전트: 연결 안 됨(agentic-dashboard connect)",
  stateWorking: "정상",
  stateUnreachable: "대시보드에 접속할 수 없음",
  stateRefused: "키 거절됨(HTTP {status})",
  stateNoKey: "키 없음",
  stateRunning: "실행 중",
  stateStopped: "설치됨, 멈춤",
  stateNotInstalled: "설치 안 됨",
  stateUnsupported: "이 시스템에서는 쓸 수 없음",
  storeKeychain: "시스템 키체인",
  serviceUsage: "사용법: agentic-dashboard service install|uninstall|restart|status",
  serviceState: "백그라운드 서비스 {label}: {state}",
  serviceRemoved: "백그라운드 서비스를 지웠어요.",
  serviceRestarted: "백그라운드 서비스를 다시 시작했어요.",
  ownerKey: "소유자 키({path}):\n  {key}",
  alreadyRunning: "대시보드가 백그라운드 서비스로 돌아가고 있어요. 여세요: {url}. 자세히: agentic-dashboard status",
  unknownCommand: "모르는 명령 {command}이에요. agentic-dashboard help를 보세요.",
  yesNo: "[Y/n]",
  noYes: "[y/N]",
};

let current: Lang = detectLang();
export const setLang = (lang: Lang) => { current = lang; };
export function t(key: MessageKey, vars: Record<string, string | number> = {}) {
  const template = (current === "ko" ? ko : en)[key];
  return template.replace(/\{(\w+)\}/g, (match, name: string) => name in vars ? String(vars[name]) : match);
}
