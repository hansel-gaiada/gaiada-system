// PRV-02 — the `ProvisionProvider` driver interface (design D-P2: the absorption seam).
//
// The mirror table already carries `provider ∈ {'provision','webdesk'}` as a COLUMN. This file is
// the code half of that decision: everything above it (the provisioning service, the idempotency
// core, the 409 adopt-only-if-ours rule, the controller, the events) talks to THIS interface and
// never to `provision`'s HTTP shapes. When webdesk P4 lands, a `WebdeskProvider` implements these
// four methods and the swap is a driver, not a redesign — same table, same tool name, same approvals.
//
// ── WHY THE RETURN TYPES ARE A DISCRIMINATED UNION AND NOT EXCEPTIONS ────────────────────────────
// `createProject` has exactly three outcomes the caller must handle DIFFERENTLY, and two of them are
// not errors:
//   - `accepted`  — provision took the request (202) and minted a project id.
//   - `conflict`  — the NAME is taken (409). This is the tenancy-critical branch: whether we adopt or
//                   refuse is decided by OUR OWN TABLE, never by anything the far side says. Modeling
//                   it as a thrown error invites a `catch` that treats it as a generic failure and
//                   either retries (double-create) or gives up (loses a recoverable crash-resume).
//   - `rejected`  — provision refused the input (400) or the credential (401). Terminal for this call.
// Only TRANSPORT failures throw (`ProvisionEgressError`) — the case where we genuinely do not know
// whether the far side received the request, which is the one case that must never be silently
// converted into "nothing happened".
//
// ── CREDENTIAL DISCIPLINE (non-negotiable, design §03 / D-P4) ───────────────────────────────────
// Nothing in this interface, and nothing any implementation returns, may carry a credential: not the
// provision service password, not the cached session JWT, not a GitHub PAT (which lives on gda-s01
// and never enters Zone A at all). `ProvisionEgressError` carries a message that implementations MUST
// keep credential-free — it is surfaced into `failure_reason`-adjacent logs and notifications.

/** One project as this seam cares about it. Deliberately NARROW: it is the intersection of what
 *  `provision` returns and what `webdev_provisioned_sites` stores, so a future provider only has to
 *  produce these five fields rather than emulate a Payload envelope. */
export interface ProvisionProject {
  /** The far side's opaque id — stored as `provider_ref`. No cross-zone FK (different trust zone). */
  id: string;
  /** The project name == our `slug`. */
  name: string;
  /** Far-side lifecycle. Mapped to ERP status by the service, never stored raw. */
  status: "pending" | "provisioned" | "live" | "failed";
  repoUrl: string | null;
  stagingUrl: string | null;
}

export type CreateProjectResult =
  | { outcome: "accepted"; project: ProvisionProject }
  /** The name is already taken on the far side. `existing` is the far side's own record for that
   *  name when it could be read back (a second call — `findProjectByName`), or null when it could
   *  not. Callers MUST NOT treat a non-null `existing` as permission to adopt: `provision`'s project
   *  namespace is GLOBAL and untenanted, so "a project with this name exists" says nothing about
   *  whose it is. Ownership is decided against the ERP's own mirror table. */
  | { outcome: "conflict"; existing: ProvisionProject | null }
  | { outcome: "rejected"; status: number; reason: string };

/** WSK-D28 / §08's canonical framework vocabulary. `astro`/`node` are aliases the ERP now accepts
 *  and stores (see `webdev_provisioned_sites.framework`'s widened CHECK) for what the `provision`
 *  driver already builds as `vite`/`nextjs` respectively — the driver is what translates the alias
 *  to provision's own wire vocabulary (`provision-http.ts`'s `PROVISION_WIRE_FRAMEWORK`), never
 *  this interface or the service layer, so a future `WebdeskProvider` (D-P2) that receives `wp`
 *  directly needs no change here. */
export type CanonicalFramework = "vite" | "nextjs" | "astro" | "node" | "wp";

export interface CreateProjectInput {
  /** The validated slug (`PROVISION_SLUG_RE`) — becomes the repo name AND the public hostname. */
  name: string;
  framework: CanonicalFramework;
  /** Attribution inside provision's own UI. A DISPLAY NAME only — never an ERP id, never a tenant
   *  id, never a run id (design §04: "provision stores no ERP identifiers"; correlation is
   *  Zone-A-side only, via `provider_ref`). */
  devName: string;
}

/** A transport-level failure: DNS, TCP, TLS, timeout, or a response we could not parse. Distinct
 *  from every HTTP answer, because an answer tells us the far side's state and this does not. */
export class ProvisionEgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvisionEgressError";
  }
}

/** The seam is not configured (no base URL / no service credential). Raised at DRIVER CONSTRUCTION,
 *  before any network intent exists, so an unconfigured deployment can never make a half-attempt.
 *  Mapped to 503 by the controller. */
export class ProvisionNotConfiguredError extends Error {
  constructor() {
    super("provision seam is not configured (PROVISION_BASE_URL / PROVISION_SERVICE_EMAIL / PROVISION_SERVICE_PASSWORD)");
    this.name = "ProvisionNotConfiguredError";
  }
}

export interface ProvisionProvider {
  /** Stable identifier stored in `webdev_provisioned_sites.provider`. `'erp_repo'` (WSK-D33 /
   *  webdesk-design-v2.md §08) is the ERP's OWN repo-control driver — GH-12's D14-approved
   *  create/generate path, filed through `fileAutomationApproval` and executed by
   *  `executeApprovedGithubRepoCreation` — added when `provision` (gda-s01) was decommissioned
   *  (measured 000 on every request, 2026-09-01). It is the DEFAULT and only provider
   *  `webdev.controller.ts` constructs today; `'provision'` is kept only for
   *  `provision-http.ts`'s own historical driver/tests (see that file's header for why it is not
   *  deleted) and is no longer reachable from any live controller path. See
   *  `migrations/202609011500_webdev_provisioned_sites_provider_widen.sql` for the schema half of
   *  this widen. */
  readonly key: "provision" | "webdesk" | "erp_repo";
  createProject(input: CreateProjectInput): Promise<CreateProjectResult>;
  /** Poll one project by far-side id. `null` = the far side no longer knows about it (404). */
  getProject(id: string): Promise<ProvisionProject | null>;
  /** Find by NAME — the 409-reconcile read. `null` when the name is free. */
  findProjectByName(name: string): Promise<ProvisionProject | null>;
}
