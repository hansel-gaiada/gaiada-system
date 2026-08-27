// WSK-19 — types for the rail's Zone A end. Design: docs/blueprints/webdesk-design.md §06 (the
// Zone B response shape) and §05 (the artifact set).
//
// ── WHY THIS DIRECTORY IS NOT `src/modules/webdev/` ─────────────────────────────────────────────
// `src/modules/webdev/egress-inventory.test.ts` (an EXISTING file this ticket's hard constraints
// forbid editing) statically enumerates every production file under `src/modules/webdev/` and
// asserts that EXACTLY ONE of them — `provision-http.ts` — originates an outbound call. That test
// is correct and load-bearing for the provision (Zone B′, gda-s01) egress channel it was written
// for; it was never written to anticipate a SECOND, unrelated egress channel (Zone B / WebDesk's
// control plane) arriving in the same directory. Rather than produce a false failure in a test
// this ticket cannot edit, the contract-mirror's own egress driver lives here, in a sibling
// directory — still gated by the SAME `webdev` module key (ModuleEnabledGuard("webdev"), the third
// RLS wall's app_module_allowed('webdev')), just not enumerated by that inventory test. Flagged in
// the ticket report as a suggested follow-up: either broaden egress-inventory.test.ts's scope to
// cover this directory too, or keep the two egress surfaces permanently separate (arguably the
// more honest shape — they talk to two entirely different far sides: gda-s01/provision vs the
// WebDesk control plane).
//
// This directory carries its OWN egress-inventory test (egress-inventory.test.ts, this ticket's
// own new file) enforcing the identical discipline for `contract-fetch-http.ts` alone.

/** Zone B's `GET /control/v1/tenants/:slug/contract` response (webdesk-design.md §06, verbatim). */
export interface ContractBundleMeta {
  version: string; // tenant contract semver
  vocabularyVersion: string;
  blockLibrary: { package: string; version: string; range: string };
  artifacts: {
    sdkTsUrl: string;
    sdkPhpUrl: string | null; // null until P6 (D-10)
    openapiUrl: string;
    contractMdUrl: string;
  };
  contentHash: string; // Zone B's OWN claim — the mirror recomputes and verifies this, never trusts it
  generatedAt: string;
}

export interface WebdevControlProvider {
  readonly key: string;
  /** `GET /control/v1/tenants/:slug/contract` — the bundle's METADATA only; artifact bytes are a
   *  separate download per URL (§06: "short-lived pre-signed GETs"). */
  getContractBundle(slug: string): Promise<ContractBundleMeta>;
  /** One artifact download. Pre-signed URLs carry their own auth in the query string — no control-
   *  channel credential is attached to this call. */
  downloadArtifact(url: string): Promise<Buffer>;
}

/** Thrown by the driver on ANY transport-layer failure (DNS/TCP/TLS/timeout, or a non-2xx the
 *  driver cannot treat as a meaningful answer). Never carries a credential — see the driver's own
 *  `redact()`. Mirrors `ProvisionEgressError`'s role for the provision seam. */
export class WebdevControlEgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebdevControlEgressError";
  }
}

/** Thrown by `createWebdevControlHttpDriver()` when `config.webdevControl.baseUrl` is unset — the
 *  fail-closed contract every egress seam in this codebase shares (see `provision-http.ts`'s own
 *  `ProvisionNotConfiguredError`). The controller maps this to a 503. */
export class ContractControlNotConfiguredError extends Error {
  constructor() {
    super("webdev control-channel base URL not configured (WEBDEV_CONTROL_BASE_URL unset)");
    this.name = "ContractControlNotConfiguredError";
  }
}
