// Executing one lab attempt: materialise the submission, run it in a capped container, capture
// bounded output, collect artefacts, grade, clean up.
//
// The cleanup path is written to run even when everything else fails. A leaked container on
// SumoPod holds memory the owner's production needs, and a leaked temp directory fills a disk
// shared with 19 other containers.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import {
  buildRunArgs, buildNetworkArgs, buildTargetArgs, resolveImage, resolveLimits, type Limits,
} from "./sandbox.js";
import { grade, type Grade, type GradingSpec, type RunOutcome } from "./grade.js";

export interface SubmittedFile { path: string; content: string }

/** A companion service the attacker container talks to. Cyber labs only (L6). */
export interface TargetSpec {
  /** A KEY into the allow-list, exactly like the attacker's image. Never a reference. */
  image: string;
  /** Hostname the attacker resolves it by. Defaults to "target". */
  alias?: string;
  /** Seconds to wait for it to come up before running the attacker. */
  readySec?: number;
  env?: Record<string, string>;
  memoryMb?: number;
}

export interface RunRequest {
  challengeId: string;
  image: string;
  files: SubmittedFile[];
  command?: string[];
  limits?: Limits;
  gradingSpec: GradingSpec;
  /** Present only for a Cyber lab. Forces `network: "isolated"` — see runLab. */
  target?: TargetSpec;
}

export interface RunResult {
  runId: string;
  challengeId: string;
  status: "succeeded" | "failed" | "error";
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  artefacts: string[];
  grade: Grade | null;
  error?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

/**
 * Reject a path that would escape the submission directory.
 *
 * `../../etc/passwd`, an absolute path, a Windows drive letter, a NUL byte. The caller is our own
 * platform, but the CONTENT of `files[]` originates with a learner — and a learner on a Cyber
 * Security course is explicitly being taught to try this.
 */
export function safeRelativePath(p: string): string | null {
  if (!p || p.includes("\0")) return null;
  if (p.startsWith("/") || p.startsWith("\\") || /^[a-zA-Z]:/.test(p)) return null;
  const normalised = normalize(p).replace(/\\/g, "/");
  if (normalised.startsWith("../") || normalised === ".." || normalised.includes("/../")) return null;
  if (normalised.startsWith("/")) return null;
  return normalised;
}

/** Spawn, capture bounded output, kill on the wall clock. Never uses a shell — argv only. */
function exec(
  cmd: string, args: string[], timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    // No `shell: true`, ever. With a shell, a file name or a challenge argument becomes part of a
    // command line — the injection shape the Cyber course teaches, in our own runner.
    const child = spawn(cmd, args, { shell: false });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    // Bounded in MEMORY, not merely truncated at the end: a `yes` loop would otherwise grow this
    // string until the process dies, and it would take the box with it.
    const cap = config.maxOutputBytes;
    const append = (buf: Buffer, into: "out" | "err") => {
      const target = into === "out" ? stdout : stderr;
      if (target.length >= cap) return;
      const room = cap - target.length;
      const text = buf.toString("utf8", 0, Math.min(buf.length, room));
      if (into === "out") stdout += text; else stderr += text;
      if ((into === "out" ? stdout : stderr).length >= cap) {
        const note = "\n… output truncated at the runner's limit …\n";
        if (into === "out") stdout += note; else stderr += note;
      }
    };
    child.stdout?.on("data", (b: Buffer) => append(b, "out"));
    child.stderr?.on("data", (b: Buffer) => append(b, "err"));

    const timer = setTimeout(() => {
      timedOut = true;
      // SIGKILL, not SIGTERM. This is the docker CLI; the container itself is killed separately by
      // the caller's `docker rm -f`, because a client that has gone away does not stop a container.
      child.kill("SIGKILL");
    }, timeoutMs);

    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };
    child.on("error", (e) => {
      stderr += `\n${e instanceof Error ? e.message : String(e)}`;
      done(null);
    });
    child.on("close", (code) => done(code));
  });
}

/** Marker the wrapper prefixes each produced-file line with. */
export const ARTEFACT_MARKER = "__LAB_FILE__";

/**
 * Split the run's stdout into the learner-visible output and the artefact listing.
 *
 * The listing is produced by a wrapper we control, appended after the learner's command, and
 * STRIPPED here so a `stdoutMatches` check never sees our own marker lines.
 *
 * ⚠ Honest about what this is: the listing comes from inside the learner's own container, so a
 *   determined learner can fabricate it — `touch dist/app.js` satisfies "did you produce
 *   dist/app.js" without building anything. That is a weakness of the CHECK, not of the sandbox,
 *   and the fix is at authoring time: pair `fileExists` with a `stdoutMatches` on the real tool's
 *   own success line. The alternative — listing from a second container over a shared volume — is
 *   not portable (see sandbox.ts), and no artefact report can be non-forgeable while the learner
 *   controls the process that produces the artefacts.
 */
export function splitArtefacts(stdout: string): { stdout: string; artefacts: string[] } {
  const kept: string[] = [];
  const artefacts: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith(ARTEFACT_MARKER)) {
      const p = line.slice(ARTEFACT_MARKER.length).trim();
      if (p.startsWith("/work/")) artefacts.push(p.slice("/work/".length));
      continue;
    }
    kept.push(line);
  }
  return { stdout: kept.join("\n"), artefacts };
}

/**
 * The default command: copy the READ-ONLY submission into the writable area, run the challenge's
 * entry script, then list what was produced — and preserve the entry script's real exit code, so
 * an `exitCode` check grades the learner's command rather than the wrapper's tail.
 */
export function defaultCommand(): string[] {
  return [
    "sh", "-c",
    "cp -r /lab/. /work/ && cd /work && sh run.sh; c=$?; " +
    "find /work -name node_modules -prune -o -name .git -prune -o -type f -print 2>/dev/null " +
    `| head -400 | sed 's|^|${"__LAB_FILE__"}|'; exit $c`,
  ];
}

export async function runLab(req: RunRequest): Promise<RunResult> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const containerName = `lab-${runId.slice(0, 12)}`;
  let workdir: string | null = null;
  let network: string | null = null;
  let targetName: string | null = null;
  let targetAlias: string | null = null;
  let targetIp: string | null = null;

  const finish = (
    partial: Partial<RunResult> & Pick<RunResult, "status">,
  ): RunResult => ({
    runId, challengeId: req.challengeId, exitCode: null, timedOut: false,
    stdout: "", stderr: "", artefacts: [], grade: null,
    startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - t0,
    ...partial,
  });

  try {
    const image = resolveImage(req.image);
    const limits = resolveLimits(req.limits);

    const totalBytes = req.files.reduce((n, f) => n + Buffer.byteLength(f.content, "utf8"), 0);
    if (totalBytes > config.maxSubmissionBytes) {
      return finish({ status: "error", error: `submission is ${totalBytes} bytes; the limit is ${config.maxSubmissionBytes}` });
    }

    workdir = await mkdtemp(join(tmpdir(), "lab-src-"));
    // ⚠ mkdtemp CREATES 0700, owned by this process. The lab container runs as uid 65534 and cannot
    //   traverse that, so /lab mounts successfully and then every run dies on
    //   `cp: can't stat '/lab/.': Permission denied`. Found only on the real Linux host — Docker
    //   Desktop's uid-translation layer hides it completely, so the local drive was green.
    //
    //   0755 is safe here precisely because the mount is READ-ONLY: the container may read the
    //   challenge files and the learner's own submission, and may not alter either.
    await chmod(workdir, 0o755);

    for (const f of req.files) {
      const rel = safeRelativePath(f.path);
      if (rel === null) {
        return finish({ status: "error", error: `rejected file path ${JSON.stringify(f.path)} — it escapes the submission directory` });
      }
      const dest = join(workdir, rel);
      await mkdir(dirname(dest), { recursive: true, mode: 0o755 });
      await writeFile(dest, f.content, "utf8");
      // A 0600 file inside a 0755 directory is exactly as unreadable to uid 65534 as the directory
      // was. Both halves, or neither works.
      await chmod(dest, 0o644);
    }

    // A target IMPLIES an isolated network. A Cyber lab whose attacker had no network would run
    // against nothing and grade as "you did not get the flag" — a confusing way to report a
    // misconfigured challenge, so the spec cannot express that combination at all.
    const wantsNetwork = limits.network === "isolated" || !!req.target;
    if (wantsNetwork) {
      network = `lab-net-${runId.slice(0, 12)}`;
      const net = await exec("docker", buildNetworkArgs(network), 20_000);
      if (net.code !== 0) {
        network = null;
        return finish({ status: "error", error: `could not create the isolated network: ${net.stderr.trim()}` });
      }
      limits.network = "isolated";
    }

    if (req.target) {
      // The target's image goes through the SAME allow-list as the attacker's. A caller-supplied
      // target image would be "run any container on this host" wearing a lab's clothes.
      const targetImage = resolveImage(req.target.image);
      targetName = `${containerName}-target`;
      const alias = /^[a-z0-9][a-z0-9-]*$/.test(req.target.alias ?? "") ? req.target.alias! : "target";
      targetAlias = alias;
      const started = await exec("docker", buildTargetArgs({
        image: targetImage,
        networkName: network!,
        containerName: targetName,
        alias,
        memoryMb: Math.min(req.target.memoryMb ?? 256, config.maxMemoryMb),
        env: req.target.env,
      }), 120_000);
      if (started.code !== 0) {
        const err = started.stderr.trim();
        targetName = null;
        return finish({ status: "error", error: `could not start the lab target: ${err}` });
      }
      // Give it a moment to bind. Crude on purpose: a readiness PROBE would need to reach into the
      // internal network from here, and the whole point of that network is that nothing outside it
      // can. A fixed wait the challenge author sets is honest about what we can actually observe.
      const readyMs = Math.min(Math.max(req.target.readySec ?? 3, 1), 30) * 1000;
      await new Promise((r) => setTimeout(r, readyMs));
      // If it died on startup, say so NOW rather than letting the attacker fail against nothing and
      // reporting that as the learner's result.
      const alive = await exec("docker", ["inspect", "-f", "{{.State.Running}}", targetName], 15_000);
      if (alive.stdout.trim() !== "true") {
        const logs = await exec("docker", ["logs", "--tail", "20", targetName], 15_000);
        return finish({
          status: "error",
          error: `the lab target exited before the exercise started: ${logs.stderr.trim() || logs.stdout.trim() || "no output"}`.slice(0, 500),
        });
      }
      // ⚠ The alias is NOT resolved by DNS at attack time. Driving this end-to-end on SumoPod
      // (2026-08-25) found that gVisor's `runsc` netstack does not proxy Docker's embedded DNS
      // resolver (127.0.0.11) on a `--internal` bridge network — `getaddrinfo EAI_AGAIN` from the
      // attacker container, even though the identical network and target resolve fine under `runc`,
      // and the target's raw IP is reachable under `runsc` too. So this reads the IP Docker actually
      // assigned and bakes it into the attacker's own /etc/hosts (see buildRunArgs' `addHost`),
      // which needs no runtime DNS at all. `{{range .NetworkSettings.Networks}}` rather than
      // `.NetworkSettings.Networks.<name>` because the network's name contains hyphens, which the Go
      // template parser (used by `docker inspect -f`) rejects as bare dotted-path syntax.
      const ipRes = await exec(
        "docker",
        ["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", targetName],
        15_000,
      );
      targetIp = ipRes.stdout.trim();
      if (ipRes.code !== 0 || !targetIp) {
        return finish({
          status: "error",
          error: `could not resolve the lab target's address: ${ipRes.stderr.trim() || "no address reported"}`,
        });
      }
    }

    // Copying is what lets a submission `npm install` or write build output without ever being
    // able to modify the graded test files in /lab.
    const command = req.command ?? defaultCommand();

    const args = buildRunArgs({
      image, workdir, command, limits, networkName: network ?? undefined, containerName,
      addHost: targetAlias && targetIp ? { alias: targetAlias, ip: targetIp } : undefined,
    });
    // +5s so the docker CLI's own teardown is inside our wall clock rather than racing it.
    const res = await exec("docker", args, limits.timeoutSec * 1000 + 5_000);

    if (res.timedOut) {
      // The CLI was killed; the CONTAINER is still running. This is the line whose absence leaks a
      // container that holds memory the owner's production needs.
      await exec("docker", ["rm", "-f", containerName], 20_000).catch(() => undefined);
    }

    const { stdout, artefacts } = splitArtefacts(res.stdout);
    const outcome: RunOutcome = {
      exitCode: res.code, stdout, stderr: res.stderr, artefacts, timedOut: res.timedOut,
    };
    const g = grade(req.gradingSpec, outcome);

    return finish({
      status: g.passed ? "succeeded" : "failed",
      exitCode: res.code, timedOut: res.timedOut,
      stdout, stderr: res.stderr, artefacts, grade: g,
    });
  } catch (e) {
    return finish({ status: "error", error: e instanceof Error ? e.message : String(e) });
  } finally {
    // Best-effort, and each step independent: one failure must not skip the others.
    await exec("docker", ["rm", "-f", containerName], 15_000).catch(() => undefined);
    // The TARGET before the network: a network cannot be removed while a container is attached,
    // and a leaked vulnerable container on a shared host is the worst possible thing to leave behind.
    if (targetName) await exec("docker", ["rm", "-f", targetName], 20_000).catch(() => undefined);
    if (network) await exec("docker", ["network", "rm", network], 15_000).catch(() => undefined);
    if (workdir) await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Exported for the queue's health reporting. */
export async function dockerAvailable(): Promise<boolean> {
  const r = await exec("docker", ["version", "--format", "{{.Server.Version}}"], 10_000);
  return r.code === 0;
}
