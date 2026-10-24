import { useEffect, useState } from "react";
import { accountAgents, revokeAgent, rotateAgent, type AccountAgent, type IssuedAgent } from "../account-api";
import { errorMessage } from "../api";
import { useCredentials } from "../account-context";
import { AgentTokenDialog } from "./AgentTokenDialog";
import { agentText } from "./agent-copy";
import "../styles/accounts.css";

export function AgentConnections() {
  const t = agentText();
  const d = useCredentials();
  const [agents, setAgents] = useState<readonly AccountAgent[] | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState(false);
  const [issued, setIssued] = useState<IssuedAgent | null>(null);
  const reload = async () => { setAgents(await accountAgents()); };
  const run = async (work: () => Promise<void>) => {
    setPending(true); setError("");
    try { await work(); } catch (cause) { setError(await errorMessage(cause)); } finally { setPending(false); }
  };
  useEffect(() => { void run(reload); }, []);
  return <section className="channel-section account-section" aria-labelledby="agent-connect-heading">
    <div className="account-actions"><h2 id="agent-connect-heading">{t.title}</h2>
      <button className="btn btn-primary" disabled={pending} onClick={() => { setIssued(null); setOpen(true); }}>{t.create}</button></div>
    {agents === null && !error && <p role="status">{t.loading}</p>}
    {agents?.length === 0 && <p className="setting-note">{t.noAgents}</p>}
    <div className="account-stack">
      {agents?.map(agent => <article className="account-agent" key={agent.name}>
        <div><h3>{agent.name}</h3><p className="setting-note">{agent.revokedAt ? t.revoked : agent.lastUsedAt ? t.active : t.ready}</p>
          {agent.name === "chatgpt" && <p className="setting-note">{t.chatgpt}</p>}</div>
        <div className="account-actions">
          <button className="btn btn-outline" disabled={pending || agent.revokedAt !== null} onClick={() => {
            if (window.confirm(t.rotateConfirm)) void run(async () => { setIssued(await rotateAgent(agent.name, d.csrfToken)); setOpen(true); await reload(); });
          }}>{t.rotate}</button>
          <button className="btn btn-quiet" disabled={pending || agent.revokedAt !== null} onClick={() => {
            if (window.confirm(t.revokeConfirm)) void run(async () => { await revokeAgent(agent.name, d.csrfToken); await reload(); });
          }}>{t.revoke}</button>
        </div>
      </article>)}
    </div>
    {error && <div role="alert"><p className="form-error">{error}</p><button className="btn btn-outline" onClick={() => void run(reload)}>{t.retry}</button></div>}
    {open && <AgentTokenDialog initial={issued} onChanged={reload} onClose={() => { setOpen(false); setIssued(null); void d.refresh(); }} />}
  </section>;
}
