// WSK-20 — real `git`, real filesystem, NEVER a real GitHub repo (this ticket's own VERIFY
// instruction: "use a local bare repo or a dry-run mode"). Both are exercised here; no test in this
// file ever sets `remoteUrl` to a network address.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeAndPush, cleanupWorkDir, vendorFiles } from "./git-writer";
import { resetExecLog, getExecLog } from "./no-execute-guard";
import type { GeneratedFile } from "./page-composer";

const execFileAsync = promisify(execFile);

const sampleFiles: GeneratedFile[] = [
  { path: "README.md", content: "# generated\n" },
  { path: "src/pages/index.astro", content: "<html></html>\n" },
];

const cleanupPaths: string[] = [];
afterEach(async () => {
  for (const p of cleanupPaths.splice(0)) await rm(p, { recursive: true, force: true });
});

describe("writeAndPush — dry_run", () => {
  it("commits locally and never adds a remote", async () => {
    resetExecLog();
    const result = await writeAndPush(sampleFiles, { mode: "dry_run" });
    cleanupPaths.push(result.workDir);

    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.pushedTo).toBe(result.workDir);
    expect(getExecLog().some((c) => c.startsWith("git remote"))).toBe(false);
    expect(getExecLog().some((c) => c.startsWith("git push"))).toBe(false);

    const readmeOnDisk = await readFile(join(result.workDir, "README.md"), "utf8");
    expect(readmeOnDisk).toBe("# generated\n");
  });

  it("writes nested paths and binary vendor files intact", async () => {
    const files: GeneratedFile[] = [
      ...sampleFiles,
      ...vendorFiles({ sdkTsTarball: Buffer.from([0x1f, 0x8b, 0x00, 0x01]), sdkTsPackageJson: "{}\n" }),
    ];
    const result = await writeAndPush(files, { mode: "dry_run" });
    cleanupPaths.push(result.workDir);
    const tarball = await readFile(join(result.workDir, "vendor/webdesk-sdk.tgz"));
    expect(tarball).toEqual(Buffer.from([0x1f, 0x8b, 0x00, 0x01]));
  });
});

describe("writeAndPush — push, against a LOCAL bare repo (never a real GitHub URL)", () => {
  it("pushes main to a local bare repo and the bare repo receives the exact commit", async () => {
    const bareDir = await mkdtemp(join(tmpdir(), "wsk20-bare-"));
    cleanupPaths.push(bareDir);
    await execFileAsync("git", ["init", "--bare", "--initial-branch=main", bareDir]);

    resetExecLog();
    const result = await writeAndPush(sampleFiles, { mode: "push", remoteUrl: bareDir, branch: "main" });
    cleanupPaths.push(result.workDir);

    expect(result.pushedTo).toBe(`${bareDir}#main`);
    const { stdout } = await execFileAsync("git", ["--git-dir", bareDir, "rev-parse", "refs/heads/main"]);
    expect(stdout.trim()).toBe(result.commitSha);

    // The whole push, end to end, ran through NOTHING but `git` — no npm/node/other binary.
    for (const cmd of getExecLog()) expect(cmd.split(" ")[0]).toBe("git");
  });
});

describe("cleanupWorkDir", () => {
  it("removes the working directory", async () => {
    const result = await writeAndPush(sampleFiles, { mode: "dry_run" });
    await cleanupWorkDir(result.workDir);
    await expect(readFile(join(result.workDir, "README.md"), "utf8")).rejects.toThrow();
  });
});
