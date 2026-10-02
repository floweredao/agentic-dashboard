import { configure } from "./config";
import { applyLocale } from "./i18n";

// The UI tests were written against a Korean dashboard in Seoul with every optional feature on.
configure({ timeZone: "Asia/Seoul", locale: "ko", features: { narration: true, push: true, digest: true, trustedLogin: false } });
applyLocale("ko");
