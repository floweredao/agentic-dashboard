import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { APP_ROOT } from "./paths";

export const SKILL_MARKER = "<!-- Installed by agentic-dashboard connect; `agentic-dashboard skills install` rewrites this file. -->";
const CONNECTION_SLOT = "<!-- connection: filled in when this skill is installed on a connected computer -->";
export const SKILL_SOURCE = join(APP_ROOT, "skills", "agentic-dashboard", "SKILL.md");

export interface SkillTarget {
  readonly id: "claude-code" | "codex" | "omo" | "agents";
  readonly label: string;
  /** The tool's own folder; the tool counts as present when it exists. */
  readonly root: string;
  readonly file: string;
}

export function skillTargets(userHome: string, env: NodeJS.ProcessEnv = process.env): SkillTarget[] {
  const codex = env["CODEX_HOME"] || join(userHome, ".codex");
  const target = (id: SkillTarget["id"], label: string, root: string, skills: string): SkillTarget =>
    ({ id, label, root, file: join(skills, "agentic-dashboard", "SKILL.md") });
  return [
    target("claude-code", "Claude Code", join(userHome, ".claude"), join(userHome, ".claude", "skills")),
    target("codex", "Codex", codex, join(codex, "skills")),
    target("omo", "OmO", join(userHome, ".omo"), join(userHome, ".omo", "agent", "skills")),
    target("agents", "~/.agents", join(userHome, ".agents"), join(userHome, ".agents", "skills")),
  ];
}

/** The repository's skill, rewritten for this computer: its own command path and the dashboard it is connected to. */
export function renderSkill(source: string, connection: { launcher: string; url: string; agent: string }) {
  if (!source.includes(CONNECTION_SLOT)) throw new Error(`The skill source has no connection slot (${CONNECTION_SLOT})`);
  const command = connection.launcher;
  const body = source
    .replace(/\bagentic-dashboard (agent|connect|skills|status)\b/g, `${command} $1`)
    .replace(CONNECTION_SLOT, `This computer is connected to ${connection.url} as the agent \`${connection.agent}\`; \`${command} agent\` already has its key.`);
  const end = body.indexOf("\n---\n", 4);
  return end === -1 ? `${SKILL_MARKER}\n${body}` : `${body.slice(0, end + 5)}${SKILL_MARKER}\n${body.slice(end + 5)}`;
}

/** Writes the skill unless a file that agentic-dashboard didn't write is already there (`force` replaces it anyway). */
export function writeSkill(target: SkillTarget, content: string, force = false): "written" | "skipped" {
  if (existsSync(target.file) && !force && !readFileSync(target.file, "utf8").includes(SKILL_MARKER)) return "skipped";
  mkdirSync(dirname(target.file), { recursive: true });
  writeFileSync(target.file, content);
  return "written";
}
