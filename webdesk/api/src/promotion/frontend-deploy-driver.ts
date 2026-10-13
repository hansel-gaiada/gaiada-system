// WSK-25 — the FRONTEND half's seam, copying ../control/release/release-transport.ts's exact
// pattern rather than inventing a new one (per this ticket's brief). Kept as PROMOTION'S OWN
// interface/token rather than reusing RELEASE_TRANSPORT directly for one concrete reason: that
// interface's `kind` enum (deploy/promote/rollback/rebuild) is coarse — it has no vocabulary for
// "activate domain/TLS" or "purge/warm" as distinct sub-steps, both named explicitly in this
// ticket's own step list ("deploy signed FE artifact -> domain/TLS activate -> purge/warm"). A
// second, sibling seam scoped to promotion's own needs is more honest than overloading the
// existing one's args bag to smuggle a finer-grained op through it.
//
// RETIRED AS A DEPLOY PATH (M6-P6j, WSK-D29/D79): no control-plane adapter will be built. Delivery is
// per site, run by the site's own CI over SFTP (webdesk/templates/_deploy/); `delphi`, `helios` and
// Hostinger are per-site targets reached that way. The default binding below
// (NotYetAvailableFrontendDeployDriver) is what ships.

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
