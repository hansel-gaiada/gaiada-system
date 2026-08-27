// WSK-25 — the FRONTEND half's seam, copying ../control/release/release-transport.ts's exact
// pattern rather than inventing a new one (per this ticket's brief). Kept as PROMOTION'S OWN
// interface/token rather than reusing RELEASE_TRANSPORT directly for one concrete reason: that
// interface's `kind` enum (deploy/promote/rollback/rebuild) is coarse — it has no vocabulary for
// "activate domain/TLS" or "purge/warm" as distinct sub-steps, both named explicitly in this
// ticket's own step list ("deploy signed FE artifact -> domain/TLS activate -> purge/warm"). A
// second, sibling seam scoped to promotion's own needs is more honest than overloading the
// existing one's args bag to smuggle a finer-grained op through it.
//
// Under WSK-D26 the real targets are `delphi` (staging), `helios` (production), Hostinger (WP) —
// building real adapters for any of them is explicitly OUT of this ticket's scope: both hosts are
// OBSERVE-ONLY by owner ruling AND unreachable (SSH/HTTP both time out) from this dev machine. The
// default binding below (NotYetAvailableFrontendDeployDriver) is what ships; a real adapter is
// WSK-26'/29's build, bound to this SAME token, with no change needed to
// promotion-command.service.ts.

export const FRONTEND_DEPLOY_DRIVER = Symbol("FRONTEND_DEPLOY_DRIVER");

export type FrontendDeployStep = "deployArtifact" | "activateDomain" | "purgeAndWarm";

export interface FrontendDeployInput {
  step: FrontendDeployStep;
  tenantSlug: string;
  envId: string;
  version: string;
}

export interface FrontendDeployResult {
  ok: true;
  detail: string;
}

export interface FrontendDeployDriver {
  execute(input: FrontendDeployInput): Promise<FrontendDeployResult>;
}
