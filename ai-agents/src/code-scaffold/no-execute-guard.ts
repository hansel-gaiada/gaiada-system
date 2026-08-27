// WSK-20 — WSK-D6, made a runtime property instead of only a convention: "the scaffolder composes
// files and pushes. It NEVER runs npm install and NEVER executes SDK or template code in the
// agent-runner process." This is the ONE seam every process-spawning call in this module goes
// through (git-writer.ts's `runGit`); a binary outside the allow-list throws instead of running.
//
// This is a DEFENSE, not the whole proof — the whole proof is this file + `never-execute.test.ts`'s
// static source scan (no other file in code-scaffold/ imports node:child_process at all) + the
// integration test that runs a real scaffold and asserts the observed command log contains only
// `git` invocations.
import { execFile as execFileCb, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCb);

export class ExecGuardViolation extends Error {
  constructor(command: string) {
    super(`WSK-D6 violation: code.scaffold attempted to execute "${command}" — only "git" may run in this process`);
    this.name = "ExecGuardViolation";
  }
}

/** The single allowed binary. A `const` array of one, not a config knob — widening it is a design
 *  decision (see this file's header), not a call-site convenience. */
const ALLOWED_BINARIES = ["git"] as const;

function assertAllowed(command: string): void {
  const base = command.split(/[\\/]/).pop() ?? command;
  const name = base.replace(/\.exe$/i, "");
  if (!(ALLOWED_BINARIES as readonly string[]).includes(name)) {
    throw new ExecGuardViolation(command);
  }
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

/** Optional call log — tests read this to assert exactly what ran, never asserting on side effects
 *  alone. Reset with `resetExecLog()` between tests. */
const execLog: string[] = [];
export function resetExecLog(): void {
  execLog.length = 0;
}
export function getExecLog(): readonly string[] {
  return execLog;
}

/** The ONLY way this module ever spawns a process. Guarded (allow-list) and logged. */
export async function runGuarded(command: string, args: string[], opts: { cwd?: string } = {}): Promise<RunResult> {
  assertAllowed(command);
  execLog.push([command, ...args].join(" "));
  const { stdout, stderr } = await execFileAsync(command, args, { cwd: opts.cwd, encoding: "utf8" });
  return { stdout, stderr };
}

/** Synchronous variant — some git-writer call sites (bare-repo init for tests) prefer it. Same guard,
 *  same log. */
export function runGuardedSync(command: string, args: string[], opts: { cwd?: string } = {}): RunResult {
  assertAllowed(command);
  execLog.push([command, ...args].join(" "));
  const stdout = execFileSync(command, args, { cwd: opts.cwd, encoding: "utf8" });
  return { stdout, stderr: "" };
}
