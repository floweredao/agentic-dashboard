import { DeploymentError, parseCaptured } from "./config";
import type { Capture } from "./config";

export type Command = { readonly args: readonly string[]; readonly input?: string };
export type Step =
  | { readonly kind: "command"; readonly command: Command; readonly capture?: Capture }
  | { readonly kind: "ensure"; readonly probe: Command; readonly create: Command; readonly update?: Command; readonly match?: string };
export type Transport = (command: Command) => Promise<string>;
export const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const render = (value: Command) => value.args.map(quote).join(" ") + (value.input === undefined ? "" : " < [REDACTED stdin]");
function unreachable(value: never): never { throw new DeploymentError(`Unknown command step: ${String(value)}`); }

export function renderPlan(plan: readonly Step[]): string {
  return plan.map(step => {
    switch (step.kind) {
      case "command": return render(step.command) + (step.capture ? ` # capture @${step.capture}@` : "");
      case "ensure": return [
        render(step.probe),
        `# if absent${step.match ? ` (${step.match})` : ""}:`, render(step.create),
        ...(step.update ? ["# otherwise:", render(step.update)] : []),
      ].join("\n");
      default: return unreachable(step);
    }
  }).join("\n");
}
export async function executePlan(plan: readonly Step[], transport: Transport): Promise<void> {
  // Capture values are the only mutable execution state; no shell evaluates config or output.
  const values = new Map<string, string>();
  const resolve = (item: Command): Command => ({
    ...item, args: item.args.map(arg => arg.replace(/@([A-Z_]+)@/g, (_, key: string) => {
      const value = values.get(key);
      if (value === undefined) throw new DeploymentError(`Unresolved command output: ${key}`);
      return value;
    })),
  });
  for (const step of plan) {
    switch (step.kind) {
      case "command": {
        const output = await transport(resolve(step.command));
        if (step.capture) {
          if (!output.trim()) throw new DeploymentError(`Empty command output: ${step.capture}`);
          values.set(step.capture, parseCaptured(step.capture, output.trim()));
        }
        break;
      }
      case "ensure": {
        const output = (await transport(resolve(step.probe))).trim();
        const existing = step.match ? output.split("\n").find(line => line.trim().split(/\s+/)[0] === step.match) : output;
        if (existing) {
          values.set("EXISTING", existing.trim());
          if (step.update) await transport(resolve(step.update));
        } else await transport(resolve(step.create));
        break;
      }
      default: unreachable(step);
    }
  }
}
export async function runCommand(item: Command): Promise<string> {
  // Capture both streams, including failures: secret-access/token commands must never echo payloads.
  const proc = Bun.spawn([...item.args], {
    stdin: item.input === undefined ? "ignore" : new Blob([item.input]),
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, , code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new DeploymentError(`${render(item)} exited ${code}; output withheld to protect credentials`);
  return stdout;
}
