#!/usr/bin/env node
// WSK-29 — the LIVE (real network, real ssh binary) reachability probe. Read-only: the remote
// command is `true`, nothing is written or modified anywhere, honouring the owner's
// observe-only ruling on delphi/helios (2026-08-22) exactly as every other probe of these two
// hosts has (docs/plans/2026-08-26-webdesk-PROGRESS.md's tenant-zero findings block). Re-run this
// any time reachability needs re-checking; do not hand-roll a fresh `ssh ... true` — this script IS
// the canonical check and reports in the same ReachabilityResult shape the driver uses, so its
// output can be pasted straight into a report.
//
// Usage:  DEPLOY_USE_SSH_ALIAS=1 node --import tsx scripts/probe-live.mjs
//   (or set DELPHI_SSH_HOST/DELPHI_SSH_USER/... and HELIOS_SSH_HOST/... for the CI-shaped path)
import { getDriver } from "../src/index.ts";

const driver = getDriver();
const targets = ["staging", "production"];
let anyFailed = false;

for (const target of targets) {
  const res = await driver.probe(target);
  console.log(JSON.stringify(res));
  if (!res.reachable) anyFailed = true;
}

// Non-zero exit on any unreachable target — makes this usable as a CI/cron gate later, and means
// "it printed something" is never mistaken for "it printed something GOOD".
process.exit(anyFailed ? 1 : 0);
