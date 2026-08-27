// WSK-29 — host config resolution, fail-closed on every missing piece.
//
// Two ways to name a target host, deliberately kept separate:
//   - Explicit vars (DELPHI_SSH_HOST / DELPHI_SSH_USER / DELPHI_SSH_KEY_PATH / DELPHI_SSH_PORT):
//     the form a CI runner or a future control-plane process must use — nothing there can read a
//     developer's `~/.ssh/config`.
//   - An `ssh -F <alias-config>` alias (default: the literal alias name "delphi"/"helios", which
//     this dev machine's own `~/.ssh/config` already defines — see the WSK-29 report for the exact
//     entries) — a LOCAL convenience for interactive probing only. `DEPLOY_USE_SSH_ALIAS=1` opts in;
//     it is OFF by default so a CI box with no such alias fails closed with a clear message instead
//     of silently trying to open a connection that can never resolve.
import type { DeployTarget, HostConfig } from "./types";

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

const PREFIX: Record<DeployTarget, string> = { staging: "DELPHI", production: "HELIOS" };
const ALIAS: Record<DeployTarget, string> = { staging: "delphi", production: "helios" };

export class MissingHostConfig extends Error {
  constructor(target: DeployTarget, missing: string) {
    super(
      `webdesk/deploy: ${target} not configured — set ${missing} (or DEPLOY_USE_SSH_ALIAS=1 for a ` +
        `local dev probe against the "${ALIAS[target]}" entry in this machine's ~/.ssh/config).`,
    );
    this.name = "MissingHostConfig";
  }
}

/** Resolve a target's connection facts. Throws MissingHostConfig (never returns a guessed value)
 *  when neither the explicit vars nor the alias opt-in is present — the same "not enabled: set X"
 *  doctrine every other fail-closed tool in this repo uses. `remoteBasePath` is the one field this
 *  function does NOT require: `probe()` never needs it, and `deploy()` checks for it itself with
 *  its own message, because "can't reach the host" and "don't know where to put files on it" are
 *  different operators' problems (network access vs. hosting-account provisioning). */
export function resolveHostConfig(target: DeployTarget): HostConfig {
  const prefix = PREFIX[target];
  const useAlias = env("DEPLOY_USE_SSH_ALIAS") === "1";

  const host = env(`${prefix}_SSH_HOST`);
  const user = env(`${prefix}_SSH_USER`);
  if (host && user) {
    return {
      target,
      host,
      sshUser: user,
      sshKeyPath: env(`${prefix}_SSH_KEY_PATH`),
      sshPort: env(`${prefix}_SSH_PORT`) ? Number(env(`${prefix}_SSH_PORT`)) : undefined,
      remoteBasePath: env(`${prefix}_REMOTE_BASE_PATH`),
      connectTimeoutSec: Number(env("WEBDESK_DEPLOY_CONNECT_TIMEOUT_SEC") ?? 10),
    };
  }
  if (useAlias) {
    return {
      target,
      host: ALIAS[target], // resolved by the operator's own ~/.ssh/config (Host + User + IdentityFile there)
      sshUser: "", // carried by the alias entry; the driver omits -l when sshUser is empty
      remoteBasePath: env(`${prefix}_REMOTE_BASE_PATH`),
      connectTimeoutSec: Number(env("WEBDESK_DEPLOY_CONNECT_TIMEOUT_SEC") ?? 10),
    };
  }
  throw new MissingHostConfig(target, `${prefix}_SSH_HOST and ${prefix}_SSH_USER`);
}
