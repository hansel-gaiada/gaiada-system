// PRV-04 — Web Dev "Site & repo" card (run workspace, `/pipeline/[runId]`). Client-safe types +
// pure helpers only (no fetch, no server-only import) — mirrors the lib/pipeline.ts / lib/
// webdevChangeRequests.ts split so this stays importable from plain vitest and from either a
// server or client component.
//
// Design: docs/blueprints/provision-erp-seam-design.md §04 (the seam contract) / §06 (console card).
// Backend: platform-nest/src/modules/webdev/{webdev.controller,provisioning.service,provision-provider}.ts
//   (PRV-02/PRV-03, commit 39b112a). Endpoints (read from the controller, not the design's sketch):
//   GET  /api/:t/modules/webdev/provisioned-sites?runId=   -> ProvisionedSite[]
//   GET  /api/:t/modules/webdev/provisioned-sites/:id      -> ProvisionedSite
//   POST /api/:t/modules/webdev/provision                  -> 201|200 ProvisionedSite, 400/409/503 on refusal
//   POST /api/:t/modules/webdev/provisioned-sites/:id/reconcile -> 200 ProvisionedSite, 400/404/409/503 on refusal
//
// ── THE STATE MACHINE IS THE POINT ──────────────────────────────────────────────────────────────
// `requested -> pending -> provisioned -> live`, plus `failed` with a typed `failureReason`.
// `failed` is NOT always a dead end: `poll_timeout` and `provider_failed` keep a `providerRef` and
// the far side can still resolve them, so reconcile (a re-poll) can flip them forward (§04: "honest,
// not final"). `slug_conflict_foreign` / `slug_taken` / `egress_error` / `provider_rejected` never got
// (or never kept) a far-side handle to re-poll — the only way forward for those is a fresh Provision
// call with a different slug. `canReconcile` below encodes exactly that split so the UI never offers
// a Reconcile button that the backend would answer with a no-op `unchanged`.

export type SiteStatus = "requested" | "pending" | "provisioned" | "live" | "failed";
// WSK-08 (2026-09-01) — widened to the FIVE values the backend's framework CHECK now admits
// (migration 202609011230). `vite`/`nextjs` are kept because existing rows carry them and a label
// map that cannot render a stored value renders "undefined"; `astro`/`node`/`wp` are §08's canonical
// selectors, which is what new sites use.
export type SiteFramework = "vite" | "nextjs" | "astro" | "node" | "wp";

export const FRAMEWORK_LABEL: Record<SiteFramework, string> = {
  astro: "Static (Astro)",
  node: "Full-stack (Next.js + Nest)",
  wp: "WordPress",
  // Legacy: pre-§08 rows. Still valid in the DB, no longer offered for new sites.
  vite: "Static (Vite — legacy)",
  nextjs: "Next.js (legacy)",
};

/** What the console OFFERS for a new site — §08's kind vocabulary, not the internal framework
 *  names the old dropdown exposed ("Vite (static)" / "Next.js", which is exactly §08's complaint
 *  that "four places disagree about what a kind is"). Legacy vite/nextjs stay renderable above but
 *  are not offered: a new site should not be created against superseded vocabulary. */
export const FRAMEWORKS: SiteFramework[] = ["astro", "node", "wp"];

/** Offered but NOT yet provisionable, with the reason shown in the UI rather than discovered on
 *  submit.
 *
 *  `wp` is real end-to-end everywhere except the last mile: the DB CHECK admits it, the MCP tool's
 *  enum admits it, and the scaffolder composes the theme. What refuses it is the external
 *  "provision" HTTP tool, which is static-export-only and always was — it answers 422 with an
 *  honest reason and makes zero HTTP calls. §08's fix is the ERP's own repo control (GH-12's
 *  template-generate path) replacing that tool; until this flow is wired to it, offering WordPress
 *  as a live choice would be a button that always fails.
 *
 *  Shown-and-disabled rather than hidden on purpose: hiding it reads as "WordPress is not supported",
 *  which is now false and was the actual confusion this whole change came from. */
export const FRAMEWORK_UNAVAILABLE: Partial<Record<SiteFramework, string>> = {
  wp: "Needs the ERP repo-control path (§08) — the static-only provision service refuses it",
};

// OQ-P4 default. Was "vite"; now §08's static selector. provisioning.service.ts still defaults to
// "vite" server-side when no framework is sent, so this only governs what the form pre-selects.
export const DEFAULT_FRAMEWORK: SiteFramework = "astro";

export const STATUS_LABEL: Record<SiteStatus, string> = {
  requested: "Requested",
  pending: "Provisioning",
  provisioned: "Provisioned (SSL pending)",
  live: "Live",
  failed: "Failed",
};

/** The API/DTO shape of one mirror row — camelCase, matching `SiteDto` in
 *  `platform-nest/src/modules/webdev/provisioning.service.ts` field-for-field. */
export interface ProvisionedSite {
  id: string;
  tenantId: string;
  pipelineRunId: string | null;
  provider: string;
  providerRef: string | null;
  slug: string;
  framework: SiteFramework;
  repoUrl: string | null;
  stagingUrl: string | null;
  status: SiteStatus;
  failureReason: string | null;
  requestedBy: string | null;
  approvalId: string | null;
  lastReconciledAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Lineage (platform-nest 0.45.0): copied from the run when there is one, supplied by the caller
   *  for a standalone site; null for rows that pre-date the columns. */
  clientId: string | null;
  projectId: string | null;
}

/** Provision's own name grammar, mirrored client-side from `platform-nest/src/modules/webdev/slug.ts`
 *  (`PROVISION_SLUG_RE`) for immediate form feedback — defense in depth only; the backend re-validates
 *  and is the real boundary (design §01(2)). */
export const PROVISION_SLUG_RE = /^[a-z0-9-]{1,40}$/;
export function isValidSlugInput(slug: string): boolean {
  return PROVISION_SLUG_RE.test(slug);
}

/** Typed `failureReason` tokens this UI knows how to explain. Anything else falls back to a generic,
 *  still-honest message (`failureCopy`) — a reason the backend adds later must never render as a
 *  raw error, but it also must never be silently mislabeled as one of these specific cases. */
export type KnownFailureReason =
  | "egress_error" | "poll_timeout" | "slug_conflict_foreign" | "provider_rejected"
  | "provider_failed" | "superseded";

export interface FailureCopy {
  title: string;
  body: string;
  /** What the UI should offer: `reconcile` (a re-poll can still resolve it), `reprovision` (only a
   *  fresh Provision call — usually with a different slug — moves this forward), or `none` (a
   *  terminal record with nothing left to do here, e.g. superseded by a later attempt). */
  remedy: "reconcile" | "reprovision" | "none";
}

const FAILURE_COPY: Record<KnownFailureReason, FailureCopy> = {
  egress_error: {
    title: "Couldn't reach the provisioning service",
    body: "The request never got a response from the far side (network/DNS/TLS). Nothing was created — provisioning again is safe.",
    remedy: "reprovision",
  },
  poll_timeout: {
    title: "Still working — this isn't final",
    body: "Provisioning started and the far side hadn't finished within the poll window. It's often still running — check status now, or wait for the hourly reconcile sweep.",
    remedy: "reconcile",
  },
  slug_conflict_foreign: {
    title: "That name belongs to someone else's site",
    body: "A site with this name already exists on the provisioning host and isn't ours. Pick a different slug and provision again.",
    remedy: "reprovision",
  },
  provider_rejected: {
    title: "The provisioning service rejected the request",
    body: "It refused the input or our credential. Check the framework/slug, or ask an admin to verify the provisioning credential, then try again.",
    remedy: "reprovision",
  },
  provider_failed: {
    title: "The provisioning service logged a failure",
    body: "It accepted the request but its own process failed partway through. It may recover on its own restart-resume — check status now before retrying.",
    remedy: "reconcile",
  },
  superseded: {
    title: "Superseded by a later attempt",
    body: "A newer attempt for this run already exists (or is in progress). This record is history only.",
    remedy: "none",
  },
};

const GENERIC_FAILURE: FailureCopy = {
  title: "Provisioning failed",
  body: "The provisioning service reported a failure this UI doesn't have specific wording for yet.",
  remedy: "reconcile",
};

export function failureCopy(reason: string | null): FailureCopy {
  if (reason && reason in FAILURE_COPY) return FAILURE_COPY[reason as KnownFailureReason];
  return GENERIC_FAILURE;
}

/** Mirrors the backend's own reconcile logic (provisioning.service.ts's `reconcileProvisionedSite`):
 *  a `failed` row keeps its `providerRef` (and so is worth re-polling) ONLY for `poll_timeout` and
 *  `provider_failed` — every other failure token never got (or never kept) a far-side handle, so a
 *  reconcile call would just return `unchanged`. Any NON-failed, non-`live` status is always worth
 *  reconciling (it may have advanced, or — for a crashed `requested` row — never actually egressed). */
export function canReconcile(site: Pick<ProvisionedSite, "status" | "failureReason">): boolean {
  if (site.status === "live") return false;
  if (site.status === "failed") {
    return site.failureReason === "poll_timeout" || site.failureReason === "provider_failed";
  }
  return true; // requested | pending | provisioned
}

/** The `ux_wps_run` invariant, client-side: at most one NON-failed row exists per run at a time.
 *  Sites arrive newest-first (`ORDER BY created_at DESC`); the active one (if any) is therefore the
 *  first non-`failed` row. Used to decide whether the Provision form should even be offered — a
 *  fresh POST while one is already active would just hand back the existing row (200 `existing`),
 *  which is harmless but a confusing thing to invite from a form. */
export function activeSite(sites: ProvisionedSite[]): ProvisionedSite | null {
  return sites.find((s) => s.status !== "failed") ?? null;
}

/** Whether "Provision a new site" should be offered at all: no rows yet, or every existing row has
 *  failed (a failed row does NOT hold the `ux_wps_run` slot — design §04/PRV-01's partial-unique). */
export function canStartNewProvision(sites: ProvisionedSite[]): boolean {
  return activeSite(sites) === null;
}

// ── Request-time (POST) errors — distinct from a stored row's `failureReason` above ────────────────
// These tokens describe why the REQUEST itself was refused before (or without) a row existing —
// `invalid`/`precondition_failed` outcomes in provisioning.service.ts. `slug_taken` is the one 409
// that never creates a row (the conflicting non-failed row is already ours, in this same tenant).
export type RequestErrorToken =
  | "invalid_slug" | "unsupported_stack" | "unsupported_framework"
  | "run_not_found" | "run_blocked" | "prd_gate_not_decided" | "slug_taken";

const REQUEST_ERROR_COPY: Record<RequestErrorToken, string> = {
  invalid_slug: "That slug isn't valid — use lowercase letters, digits and hyphens only (1-40 characters).",
  // WSK-D28 / webdesk-design-v2.md §08: `unsupported_stack` no longer means "this PRD implies more
  // than a static site" — static/WordPress/full-stack are all recognized kinds now. It fires only
  // for a genuinely UNRECOGNIZED stack token (backend: provisioning.service.ts's `STACK_TO_FRAMEWORK`
  // lookup miss). A recognized WordPress/full-stack request that the current provider cannot fulfill
  // surfaces as `provider_rejected` instead (a stored-row failure, not a request-time refusal) — see
  // `FAILURE_REASON_COPY` below.
  unsupported_stack: "That stack hint wasn't recognized — check the PRD's stack value and try again, or provision manually.",
  unsupported_framework: "That framework isn't supported here — choose vite, nextjs, astro, node or wp.",
  run_not_found: "This run couldn't be found — it may have been deleted.",
  run_blocked: "This run is blocked — resolve that before provisioning a site for it.",
  prd_gate_not_decided: "The PRD sign-off gate hasn't been decided yet for this run — provisioning waits for that.",
  slug_taken: "That name is already in use in this company — pick a different slug and try again.",
};

/** Best-effort copy for a thrown provision/reconcile request error — by TOKEN when the thrown
 *  message is one this contract defines (true in DEMO_MODE, and once the bug documented below is
 *  fixed), else by HTTP STATUS as an honest, generic fallback.
 *
 *  VERIFIED BACKEND CONTRACT BUG (read from the live code, not assumed from the design sketch): every
 *  throw in `webdev.controller.ts` passes `{error: "<token>", ...}` as the exception body, but the
 *  shared `HttpErrorFilter` (`platform-nest/src/http-error.filter.ts`) only ever forwards a `message`/
 *  `field`/`existing` key — never a bare `error` key — and Nest's `HttpException` falls back to a
 *  useless constructor-derived `.message` ("Conflict Exception", "Bad Request Exception", …) when the
 *  thrown object carries no `message` of its own. Confirmed directly:
 *  `new (require('@nestjs/common').ConflictException)({error:'slug_conflict_foreign'}).message`
 *  === `"Conflict Exception"`. So against the REAL backend today, none of the typed tokens this file
 *  knows about ever reach the client over HTTP, and the `site` object attached to the 409/503 throws
 *  is dropped by the same filter (it only special-cases `existing`, not `site`). DEMO_MODE bypasses
 *  Nest entirely (see `platform.ts`), so a demo fixture's `error` field DOES arrive verbatim as
 *  `PlatformError.message` — the token branch below is what demo mode exercises today; the
 *  status-code branch is the honest fallback the real backend gets until that filter/controller
 *  mismatch is fixed (backend work, out of this ticket's file scope — reported, not silently patched
 *  around here). This is also why the UI never trusts an error body for a site's fields: it always
 *  re-reads the row via the list GET after any action, which is unaffected by this bug. */
export function describeActionError(status: number, message: string): string {
  if (message in REQUEST_ERROR_COPY) return REQUEST_ERROR_COPY[message as RequestErrorToken];
  if (message in FAILURE_COPY) return FAILURE_COPY[message as KnownFailureReason].title;
  switch (status) {
    case 400: return "That request wasn't valid — check the framework and slug, and that this run is ready to provision.";
    case 404: return "Not found.";
    case 409: return "That name is already taken — pick a different slug and try again.";
    case 503: return "The provisioning service couldn't be reached, or rejected the request. It's safe to try again.";
    default: return message || `Request failed (${status}).`;
  }
}
