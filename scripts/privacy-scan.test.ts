import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mask, readDenylist, scanRepository } from "./privacy-scan";

function git(cwd: string, ...args: string[]) {
  const run = Bun.spawnSync(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd });
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
}

test("a denylisted value is found in tracked files, in a removed file's history and in a commit message, without regard to case", () => {
  // Given: a repository whose current tree, past diff and one commit message each hold a listed value in another case.
  const repo = mkdtempSync(join(tmpdir(), "privacy-scan-"));
  try {
    git(repo, "init", "-q");
    writeFileSync(join(repo, "old.txt"), "contact Jane Placeholder\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "add old notes");
    git(repo, "rm", "-q", "old.txt");
    writeFileSync(join(repo, "README.md"), "# Demo\nhost is box.example.test here\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "drop notes for MAPLE STREET");

    // When: the repository is scanned for four values.
    const hits = scanRepository(repo, ["jane placeholder", "BOX.EXAMPLE.TEST", "maple street", "never present"]);

    // Then: each value is reported where it is, and the absent one is not.
    expect(hits.filter((hit) => hit.where === "README.md:2").map((hit) => hit.entry)).toEqual(["BOX.EXAMPLE.TEST"]);
    expect(hits.some((hit) => hit.entry === "jane placeholder" && hit.where.startsWith("history "))).toBe(true);
    expect(hits.some((hit) => hit.entry === "maple street" && hit.where.startsWith("message "))).toBe(true);
    expect(hits.some((hit) => hit.entry === "never present")).toBe(false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a clean repository has no hits, and the denylist skips comments and blank lines", () => {
  const repo = mkdtempSync(join(tmpdir(), "privacy-scan-"));
  try {
    git(repo, "init", "-q");
    writeFileSync(join(repo, "a.txt"), "nothing personal\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "start");
    const list = join(repo, "denylist.txt");
    writeFileSync(list, "# a comment\n\n  Someone Else  \n");

    expect(readDenylist(list)).toEqual(["Someone Else"]);
    expect(readDenylist(join(repo, "missing.txt"))).toBeNull();
    expect(scanRepository(repo, ["Someone Else"])).toEqual([]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a printed value keeps only its first character and its length", () => {
  expect(mask("Jane Placeholder")).toBe("J*** (16 chars)");
});
