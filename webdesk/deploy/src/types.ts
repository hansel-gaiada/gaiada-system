// WSK-29 — the driver seam's own vocabulary.
//
// Two hosting targets exist per WSK-D26 (docs/plans/2026-08-26-webdesk-PROGRESS.md's reversal
// section): `delphi` (non-WP staging) and `helios` (non-WP production). WordPress sites stay on
// Hostinger and are out of scope for this driver — that path is a DNS + content-export exercise
// (infra/runbooks/onboard-server.md), never an SSH deploy.

export type DeployTarget = "staging" | "production";

/** One target's connection facts. No defaults on the network-identifying fields — an unset host
 *  or remote path must fail CLOSED with a named missing variable, the same "not enabled: set X"
 *  doctrine `mcp-hub/src/delivery-tools.ts`'s `deploy.staging`/`deploy.production` already use,
 *  never a silent no-op or a guessed path on somebody else's shared-hosting box. */
export interface HostConfig {
  target: DeployTarget;
  /** Hostname or IP the driver connects to. May also be a bare `ssh -F <file>` alias for local/dev
   *  convenience (see config.ts) — CI must set the explicit form. */
  host: string;
  sshUser: string;
  sshKeyPath?: string;
  sshPort?: number;
  /** Where releases land on the remote box. REQUIRED to deploy (not to probe) — see the WSK-29
   *  report: delphi/helios are live cPanel/WHM shared-hosting boxes serving real third-party
   *  customer sites (per-account php-fpm pools, per-account home directories), not a blank VPS we
   *  fully own, so this path can never default to something generic like `/var/www` — it must name
   *  the SPECIFIC account/vhost docroot ops provisions for our own use. */
  remoteBasePath?: string;
  connectTimeoutSec: number;
}

export interface ReachabilityResult {
  target: DeployTarget;
  host: string;
  reachable: boolean;
  checkedAt: string; // ISO-8601, UTC
  /** Human-readable reason: "ssh exited 0" | "ssh timed out after Ns" | "ssh exited 255: <stderr>"
   *  | "config missing: ...". Never invents a reason it did not observe. */
  detail: string;
  latencyMs?: number;
}

export interface DeployResult {
  target: DeployTarget;
  releaseId: string;
  ok: boolean;
  /** Same non-inventing rule as ReachabilityResult.detail — this is what a caller (a future
   *  control-plane handler, or a human reading the audit log) actually gets told. */
  detail: string;
  remotePath?: string;
}

/** The seam WSK-29 asks for: "an interface with a real driver ... and a clearly-labelled
 *  unreachable state". Nothing in this repo may call `deploy()` and get back an `ok:true` that
 *  was not genuinely observed — see ssh-rsync-driver.ts's own header for how that is enforced. */
export interface FrontendDeployDriver {
  probe(target: DeployTarget): Promise<ReachabilityResult>;
  deploy(target: DeployTarget, artifactDir: string, opts?: { releaseId?: string }): Promise<DeployResult>;
}

/** Dependency-injection seam for both class of side effect this driver has (spawning a process).
 *  Every test in this package supplies a FAKE implementation — no unit test here ever spawns
 *  `ssh`/`rsync` for real or touches the network. `scripts/probe-live.mjs` is the one caller that
 *  wires the REAL implementation (node:child_process), and it is a script, not a test. */
export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}
export type ExecFn = (
  cmd: string,
  args: string[],
  opts: { timeoutMs: number },
) => Promise<ExecResult>;
