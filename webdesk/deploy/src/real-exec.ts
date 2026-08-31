// WSK-29 — the ONE real implementation of ExecFn (node:child_process). Every unit test in this
// package imports the TYPE from ./types and supplies its own fake; only scripts/probe-live.mjs and
// a real future caller import this file. Isolating it here means `grep -L real-exec src/*.test.ts`
// is a one-line proof that no test spawns a process — the same style of static, grep-provable
// guarantee webdesk/payload/src/public-gateway.mjs's own header uses for its denylist.
import { spawn } from "node:child_process";
import type { ExecFn, ExecResult } from "./types";

export const realExec: ExecFn = (cmd, args, opts) =>
  new Promise<ExecResult>((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + String(err), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
