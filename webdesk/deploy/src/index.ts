// WSK-29 — the package's public seam. Consumers import `getDriver()`, never
// `ssh-rsync-driver.ts` directly, so a future second implementation (a WHM/cPanel API driver, if
// ops decides delphi/helios's account layout wants that instead of raw rsync — see this ticket's
// report) is a one-line swap here, not a call-site hunt.
export type { DeployTarget, DeployResult, ExecFn, ExecResult, FrontendDeployDriver, HostConfig, ReachabilityResult } from "./types";
export { MissingHostConfig, resolveHostConfig } from "./config";
export { SshRsyncDeployDriver } from "./ssh-rsync-driver";

import { realExec } from "./real-exec";
import { SshRsyncDeployDriver } from "./ssh-rsync-driver";
import type { FrontendDeployDriver } from "./types";

/** The one real, network-touching driver this package ships. */
export function getDriver(): FrontendDeployDriver {
  return new SshRsyncDeployDriver(realExec);
}
