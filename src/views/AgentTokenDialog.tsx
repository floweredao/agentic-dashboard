import { useState } from "react";
import { RecordInputSchema } from "../../shared/contracts";
import { createAgent, inviteAgent, testAgent, type IssuedAgent } from "../account-api";
import { errorMessage } from "../api";
import { Dialog } from "../components/primitives";
import { useCredentials } from "../account-context";
import { agentText } from "./agent-copy";

export function AgentTokenDialog({ initial, onClose, onChanged }: {
  readonly initial: IssuedAgent | null; readonly onClose: () => void; readonly onChanged: () => Promise<void>;
}) {
  const t = agentText();
  const { csrfToken } = useCredentials();
  const [name, setName] = useState("omo");
  const [capture, setCapture] = useState(false);
  const [issued, setIssued] = useState(initial);
  const [invitation, setInvitation] = useState<Awaited<ReturnType<typeof inviteAgent>> | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [verified, setVerified] = useState<string | null>(null);
  const close = () => {
    if ((!issued && !invitation) || acknowledged || window.confirm(t.lose)) { onClose(); return true; }
    return false;
  };
  const run = async (work: () => Promise<void>) => {
    setPending(true); setError("");
    try { await work(); } catch (cause) { setError(await errorMessage(cause)); } finally { setPending(false); }
  };
  const copy = (value: string) => run(async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); }
    catch { setShowToken(true); setError(t.clipboardBlocked); }
  });
  const record = RecordInputSchema.parse({ kind: "note", title: t.testTitle, body: t.testBody, tags: ["test"] });
  const payload = JSON.stringify({ requestId: "connection-test-1", record });
  const origin = location.origin;
  const command = invitation
    ? `curl -fsSL https://raw.githubusercontent.com/floweredao/agentic-dashboard/main/install.sh | sh -s -- connect --url '${origin}' --code '${invitation.code}'`
    : `curl --config ~/.agentic-dashboard/curl.conf --json '${payload}' '${origin}/api/v1/records'`;
  return <Dialog title={t.title} onClose={close}>
    <div className="account-stack">
      <p className="setting-note">{t.access}</p>
      {!issued && !invitation && <form className="account-stack" onSubmit={event => {
        event.preventDefault(); void run(async () => { setIssued(await createAgent({ name, capture }, csrfToken)); await onChanged(); });
      }}>
        <label className="field"><span>{t.preset}</span><select value={["omo", "codex", "chatgpt"].includes(name) ? name : "custom"}
          onChange={event => setName(event.target.value === "custom" ? "" : event.target.value)}>
          {["omo", "codex", "chatgpt"].map(preset => <option key={preset} value={preset}>{preset}</option>)}<option value="custom">{t.custom}</option>
        </select></label>
        <label className="field"><span>{t.name}</span><input value={name} onChange={event => setName(event.target.value)}
          pattern="[a-z][a-z0-9-]{0,31}" maxLength={32} required autoComplete="off" /></label>
        <label className="account-check"><input type="checkbox" checked={capture} onChange={event => setCapture(event.target.checked)} />{t.capture}</label>
        <div className="account-actions"><button className="btn btn-primary" disabled={pending || !name}>{t.create}</button>
          <button type="button" className="btn btn-outline" disabled={pending || !/^[a-z][a-z0-9-]{0,31}$/.test(name)}
            onClick={() => void run(async () => { setInvitation(await inviteAgent(name, csrfToken)); })}>{t.installer}</button></div>
      </form>}
      {issued && <>
        <p>{t.once}</p><p className="setting-note">{t.storage}</p>
        <label className="field"><span>{t.token}</span><input type={showToken ? "text" : "password"} value={issued.key} readOnly autoComplete="off" /></label>
        {error === t.clipboardBlocked && <p role="alert" className="form-error">{error}</p>}
        <div className="account-actions">
          <button className="btn btn-primary" disabled={pending} onClick={() => void copy(issued.key)}>{copied ? t.copied : t.copy}</button>
          <button className="btn btn-outline" disabled={pending} onClick={() => void copy(`header = "Authorization: Bearer ${issued.key}"\n`)}>{t.copyConfig}</button>
          <button className="btn btn-outline" disabled={pending} onClick={() => void copy(JSON.stringify({ url: origin, agent: issued.agent.name, token: issued.key }, null, 2))}>{t.copyJson}</button>
        </div>
        <p className="setting-note">{t.jsonNote}</p><p className="setting-note">{t.browserTest}</p>
        <button className="btn btn-outline" disabled={pending} onClick={() => void run(async () => {
          const saved = await testAgent(issued.key, record); setVerified(saved.id); await onChanged();
        })}>{t.test}</button>
        {verified && <p role="status">{t.verified} · <a href={`#/library/${verified}`} onClick={event => { if (!close()) event.preventDefault(); }}>{t.view}</a></p>}
        <p className="setting-note">{t.cli}</p>
        <pre className="account-code">{`agentic-dashboard connect --url '${origin}' --agent '${issued.agent.name}' --key-stdin`}</pre>
        <button className="btn btn-outline" onClick={() => void copy(`agentic-dashboard connect --url '${origin}' --agent '${issued.agent.name}' --key-stdin`)}>{t.copyConnect}</button>
        <p className="setting-note">{t.curl}</p><pre className="account-code">{command}</pre>
        <button className="btn btn-outline" onClick={() => void copy(command)}>{t.copySave}</button>
      </>}
      {invitation && <><p className="setting-note">{t.installNote}</p><pre className="account-code">{command}</pre>
        <button className="btn btn-primary" onClick={() => void copy(command)}>{copied ? t.copied : t.copyCommand}</button></>}
      {(issued || invitation) && <label className="account-check"><input type="checkbox" checked={acknowledged}
        onChange={event => setAcknowledged(event.target.checked)} />{t.acknowledged}</label>}
      {error && (!issued || error !== t.clipboardBlocked) && <p role="alert" className="form-error">{error}</p>}
      <div className="dialog-actions"><button className="btn btn-quiet" onClick={close}>{t.cancel}</button>
        {(issued || invitation) && <button className="btn btn-primary" disabled={!acknowledged || pending} onClick={onClose}>{t.done}</button>}</div>
    </div>
  </Dialog>;
}
