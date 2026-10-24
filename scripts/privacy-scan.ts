import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Hit = { entry: string; where: string };

export function readDenylist(path: string): string[] | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8").split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
}

export function mask(entry: string): string {
  return `${entry.slice(0, 1)}*** (${entry.length} chars)`;
}

function git(cwd: string, args: string[]): { code: number; out: string } {
  const run = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode > 1) throw new Error(`git ${args[0]} failed: ${run.stderr.toString().trim()}`);
  return { code: run.exitCode, out: run.stdout.toString() };
}

export function scanRepository(repo: string, entries: string[]): Hit[] {
  const hits: Hit[] = [];
  const messages = git(repo, ["log", "--all", "--format=%h%x00%B%x01"]).out.split("\x01");
  for (const entry of entries) {
    const tree = git(repo, ["grep", "-n", "-I", "-i", "-F", "-e", entry]);
    for (const line of tree.out.split("\n").filter(Boolean)) {
      const [file, number] = line.split(":");
      hits.push({ entry, where: `${file}:${number}` });
    }
    for (const sha of git(repo, ["log", "--all", "-i", `-S${entry}`, "--format=%h"]).out.split("\n").filter(Boolean)) {
      hits.push({ entry, where: `history ${sha}` });
    }
    const lower = entry.toLowerCase();
    for (const message of messages) {
      const [sha, body = ""] = message.replace(/^\n/, "").split("\0");
      if (body.toLowerCase().includes(lower)) hits.push({ entry, where: `message ${sha}` });
    }
  }
  return hits;
}

if (import.meta.main) {
  const path = process.env.PRIVACY_DENYLIST ?? join(homedir(), ".config", "dash-web", "denylist.txt");
  const entries = readDenylist(path);
  if (entries === null) {
    console.log("privacy-scan: no denylist, skipped");
    process.exit(0);
  }
  const hits = scanRepository(process.cwd(), entries);
  for (const hit of hits) console.log(`${hit.where}: ${mask(hit.entry)}`);
  console.log(hits.length === 0 ? `privacy-scan: ${entries.length} entries, no hits` : `privacy-scan: ${hits.length} hits`);
  process.exit(hits.length === 0 ? 0 : 1);
}
