// WSK-20 — "the scaffolder composes files and pushes." This file is the ONLY place `code-scaffold/`
// touches the filesystem/a subprocess, and it does so exclusively through `runGuarded`
// (no-execute-guard.ts) — never a raw `child_process` import (never-execute.test.ts's static scan
// proves that for every OTHER file in this directory; this file's own no-execute test proves the
// binary actually invoked is `git`, nothing else, for a real scaffold run).
//
// "Do not push to a real GitHub repo — use a local bare repo or a dry-run mode" (this ticket's own
// VERIFY instruction): `writeAndPush`'s `target` is either `{ mode: "push"; remoteUrl }` (a real
// `git push`, exercised in tests only against a LOCAL bare repo path, never a network URL) or
// `{ mode: "dry_run" }` (commits locally, never adds a remote, never pushes).
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { runGuarded } from "./no-execute-guard";
import type { GeneratedFile } from "./page-composer";

export type PushTarget = { mode: "push"; remoteUrl: string; branch?: string } | { mode: "dry_run" };

export interface WriteAndPushResult {
  workDir: string;
  pushedTo: string;
  commitSha: string;
}

async function writeTree(workDir: string, files: GeneratedFile[]): Promise<void> {
  for (const f of files) {
    const full = join(workDir, f.path);
    await mkdir(dirname(full), { recursive: true });
    if (typeof f.content === "string") {
      await writeFile(full, f.content, "utf8");
    } else {
      await writeFile(full, f.content);
    }
  }
}

/** Vendors the pinned SDK tarball (installed "from the snapshot tarball" — OQ-6, no registry infra)
 *  into `vendor/`, referenced by `package.json`'s `file:./vendor/...` dependency (templates/common.ts).
 *  Writing bytes to disk is composing a file, not executing anything — the tarball is never
 *  extracted/required by this process. */
export function vendorFiles(args: { sdkTsTarball: Buffer; sdkTsPackageJson: string; blockLibraryTarballPlaceholder?: Buffer }): GeneratedFile[] {
  const files: GeneratedFile[] = [
    { path: "vendor/webdesk-sdk.tgz", content: args.sdkTsTarball },
    { path: "vendor/webdesk-sdk-package.json", content: args.sdkTsPackageJson },
  ];
  if (args.blockLibraryTarballPlaceholder) {
    files.push({ path: "vendor/webdesk-blocks.tgz", content: args.blockLibraryTarballPlaceholder });
  }
  return files;
}

export async function writeAndPush(files: GeneratedFile[], target: PushTarget): Promise<WriteAndPushResult> {
  const workDir = join(tmpdir(), `wsk20-scaffold-${randomUUID()}`);
  await mkdir(workDir, { recursive: true });
  try {
    await writeTree(workDir, files);

    await runGuarded("git", ["init", "--initial-branch=main"], { cwd: workDir });
    await runGuarded("git", ["config", "user.email", "webdesk-scaffolder@gaiada.online"], { cwd: workDir });
    await runGuarded("git", ["config", "user.name", "WebDesk Scaffolder (WSK-20)"], { cwd: workDir });
    await runGuarded("git", ["add", "-A"], { cwd: workDir });
    await runGuarded("git", ["commit", "-m", "code.scaffold v2: initial generated repo"], { cwd: workDir });
    const { stdout: shaOut } = await runGuarded("git", ["rev-parse", "HEAD"], { cwd: workDir });
    const commitSha = shaOut.trim();

    if (target.mode === "dry_run") {
      return { workDir, pushedTo: workDir, commitSha };
    }

    await runGuarded("git", ["remote", "add", "origin", target.remoteUrl], { cwd: workDir });
    const branch = target.branch ?? "main";
    await runGuarded("git", ["push", "origin", `HEAD:${branch}`], { cwd: workDir });
    return { workDir, pushedTo: `${target.remoteUrl}#${branch}`, commitSha };
  } finally {
    // Leave workDir on disk for a caller that wants to inspect it (tests do); callers that don't may
    // clean up with cleanupWorkDir below. Never cleaned up implicitly — a silent rm here would make a
    // failed-push diagnosis harder.
  }
}

export async function cleanupWorkDir(workDir: string): Promise<void> {
  await rm(workDir, { recursive: true, force: true });
}
