// WSK-29 — the real driver behind `deploy.staging`/`deploy.production` "at the control plane"
// (docs/plans/2026-08-26-webdesk-PROGRESS.md's own line for this ticket). It is a REAL, working
// SSH+rsync implementation — not a mock — but it is not wired into anything that can call it
// against delphi/helios yet. See this ticket's report for exactly what IS wired (the aggregated
// `webdesk.deploy.staging`/`webdesk.site.promote` MCP tools, WSK-31) and what still is not (a live
// Zone A->Zone B command channel, WSK-22/23; and now, per this ticket's own live recon, a decided
// remote account/path on delphi/helios — see config.ts's HostConfig.remoteBasePath comment).
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE: probe() and deploy() report ONLY what they actually
// observed from a real (possibly faked-in-test) exec call. Neither one has a code path that
// returns `reachable:true` or `ok:true` without a zero exit code in hand. That is what "a
// clearly-labelled unreachable state" (the ticket's own words) means operationally — grep for
// `reachable: true` / `ok: true` in this file: both occurrences are gated behind
// `res.code === 0`, nothing else.
import type { DeployResult, DeployTarget, ExecFn, FrontendDeployDriver, HostConfig, ReachabilityResult } from "./types";
import { MissingHostConfig, resolveHostConfig } from "./config";

/** Builds the `ssh` argv common to probe + deploy's post-rsync symlink swap. Centralised so the
 *  two call sites can never drift on a flag (e.g. one adding BatchMode and the other forgetting
 *  it, which would make deploy() hang on a password prompt in an unattended run). */
function sshArgs(cfg: HostConfig, remoteCommand: string): string[] {
  const args = [
    "-o", "BatchMode=yes", // never prompt — an unattended caller must get a refusal, not a hang
    "-o", `ConnectTimeout=${cfg.connectTimeoutSec}`,
    "-o", "StrictHostKeyChecking=accept-new", // pin-on-first-use; never the disabled-checking form
  ];
  if (cfg.sshKeyPath) args.push("-i", cfg.sshKeyPath);
  if (cfg.sshPort) args.push("-p", String(cfg.sshPort));
  const target = cfg.sshUser ? `${cfg.sshUser}@${cfg.host}` : cfg.host;
  args.push(target, remoteCommand);
  return args;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class SshRsyncDeployDriver implements FrontendDeployDriver {
  constructor(
    private readonly exec: ExecFn,
    private readonly resolveConfig: (target: DeployTarget) => HostConfig = resolveHostConfig,
  ) {}

  async probe(target: DeployTarget): Promise<ReachabilityResult> {
    let cfg: HostConfig;
    try {
      cfg = this.resolveConfig(target);
    } catch (err) {
      if (err instanceof MissingHostConfig) {
        return { target, host: "(unconfigured)", reachable: false, checkedAt: nowIso(), detail: err.message };
      }
      throw err;
    }
    const args = sshArgs(cfg, "true"); // the cheapest possible remote command — this is a reachability check, not a deploy
    const start = Date.now();
    const res = await this.exec("ssh", args, { timeoutMs: (cfg.connectTimeoutSec + 5) * 1000 });
    const latencyMs = Date.now() - start;
    if (res.timedOut) {
      return {
        target, host: cfg.host, reachable: false, checkedAt: nowIso(), latencyMs,
        detail: `ssh timed out after ${cfg.connectTimeoutSec}s connecting to ${cfg.host}`,
      };
    }
    if (res.code === 0) {
      return { target, host: cfg.host, reachable: true, checkedAt: nowIso(), latencyMs, detail: "ssh exited 0" };
    }
    return {
      target, host: cfg.host, reachable: false, checkedAt: nowIso(), latencyMs,
      detail: `ssh exited ${res.code ?? "null"}: ${res.stderr.trim().slice(0, 300) || "(no stderr)"}`,
    };
  }

  async deploy(target: DeployTarget, artifactDir: string, opts?: { releaseId?: string }): Promise<DeployResult> {
    const cfg = this.resolveConfig(target); // throws MissingHostConfig — deploy() never swallows this the way probe() does; a deploy attempt with no host at all is a caller bug, not an expected "unreachable" outcome
    const releaseId = opts?.releaseId ?? `rel-${nowIso().replace(/[:.]/g, "-")}`;

    if (!cfg.remoteBasePath) {
      return {
        target, releaseId, ok: false,
        detail:
          `webdesk/deploy: ${target}'s remote base path is not configured — set ` +
          `${target === "staging" ? "DELPHI" : "HELIOS"}_REMOTE_BASE_PATH to the specific hosting-account ` +
          "docroot ops provisioned for this site. Reachability alone is not enough: delphi/helios are " +
          "live shared-hosting boxes serving real third-party customer accounts (see this ticket's " +
          "report), so there is no safe generic default path to fall back to.",
      };
    }

    const remotePath = `${cfg.remoteBasePath.replace(/\/+$/, "")}/releases/${releaseId}`;
    const sshOptionsForRsync = [
      "-o", "BatchMode=yes",
      "-o", `ConnectTimeout=${cfg.connectTimeoutSec}`,
      "-o", "StrictHostKeyChecking=accept-new",
      ...(cfg.sshKeyPath ? ["-i", cfg.sshKeyPath] : []),
      ...(cfg.sshPort ? ["-p", String(cfg.sshPort)] : []),
    ].join(" ");
    const dest = `${cfg.sshUser ? `${cfg.sshUser}@` : ""}${cfg.host}:${remotePath}/`;

    const rsyncRes = await this.exec(
      "rsync",
      ["-az", "--delete", "-e", `ssh ${sshOptionsForRsync}`, `${artifactDir.replace(/\/+$/, "")}/`, dest],
      { timeoutMs: (cfg.connectTimeoutSec + 300) * 1000 }, // artifact transfer, not a bare connect — a much longer ceiling than probe()
    );
    if (rsyncRes.code !== 0) {
      return {
        target, releaseId, ok: false, remotePath,
        detail: `rsync exited ${rsyncRes.code ?? "null"}${rsyncRes.timedOut ? " (timed out)" : ""}: ${rsyncRes.stderr.trim().slice(0, 500) || "(no stderr)"}`,
      };
    }

    // Atomic activation: land the release under releases/<id>/ first (above), only THEN repoint
    // `current`. A failure here leaves the previous `current` untouched — never a half-deployed
    // symlink pointing at a directory that only partially rsync'd.
    const swapArgs = sshArgs(cfg, `ln -sfn '${remotePath}' '${cfg.remoteBasePath.replace(/\/+$/, "")}/current'`);
    const swapRes = await this.exec("ssh", swapArgs, { timeoutMs: (cfg.connectTimeoutSec + 10) * 1000 });
    if (swapRes.code !== 0) {
      return {
        target, releaseId, ok: false, remotePath,
        detail: `rsync landed the release at ${remotePath} but the "current" symlink swap failed ` +
          `(ssh exited ${swapRes.code ?? "null"}: ${swapRes.stderr.trim().slice(0, 300) || "(no stderr)"}) — ` +
          "the PREVIOUS release is still live; nothing was activated.",
      };
    }

    return { target, releaseId, ok: true, remotePath, detail: `deployed and activated ${remotePath}` };
  }
}
