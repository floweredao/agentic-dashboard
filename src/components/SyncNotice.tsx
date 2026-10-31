import { useEffect, useState } from "react";
import { strings } from "../i18n";

const text = strings({
  en: { stale: "Refresh failed. You're viewing the last successful copy; new agent saves may not be visible yet.", retry: "Retry refresh" },
  ko: { stale: "새로고침에 실패해 마지막으로 받은 내용을 보여 주고 있어요. 에이전트의 새 저장이 아직 보이지 않을 수 있어요.", retry: "다시 새로고침" },
});
export function SyncNotice() {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    const failed = () => setStale(true); const ready = () => setStale(false);
    window.addEventListener("agentic:sync-failed", failed); window.addEventListener("agentic:sync-ready", ready);
    return () => { window.removeEventListener("agentic:sync-failed", failed); window.removeEventListener("agentic:sync-ready", ready); };
  }, []);
  return stale && <aside className="sync-notice" role="alert"><p>{text().stale}</p>
    <button className="btn btn-outline" onClick={() => location.reload()}>{text().retry}</button></aside>;
}
