import "server-only";
import { readResult, type ReadResult } from "./readResult";
// WS11 meeting-to-delivery pipeline — data layer for the internal ADNARA dashboard + gate inbox.
// Thin readers over the platform pipeline API (0017 / PipelineController). Every reader DEGRADES
// gracefully (return []/null on 404/403) so the page ships ahead of any missing backend — same
// pattern as lib/pm.ts / lib/it.ts. Client-facing gates live in the separate client portal; this
// module surfaces the INTERNAL side (runs across the three tracks + the internal review inbox).
//
// WD-02 (Web Dev Phase 1): adds the per-run workspace reads (`/pipeline/[runId]`) — the run-detail
// shape already carried everything needed (stages incl. artifact_ref/confidence, gates, scope
// signoffs, client_id); this module just widens the types to match the controller's real SELECTs
// and adds pure helpers (blockage text, stage grouping/labels) so the page stays thin.
//
// BFF CONTRACT (implemented in platform-nest):
//   GET   /api/:t/pipeline/runs?status=         -> PipelineRun[]        (list — carries client_id + project_id since C4/C6)
//   GET   /api/:t/pipeline/runs/:id             -> PipelineRunDetail    (detail — includes client_id + project_id)
//   PATCH /api/:t/pipeline/runs/:id             -> { id, status }       (status only — see pipelineActions)
//   POST  /api/:t/pipeline/runs/:runId/stages   -> { id, deduped? }
//   GET   /api/:t/pipeline/gates?status=&actorSide=&kind=  -> PipelineGate[]
//   POST  /api/:t/pipeline/gates                -> { id, status, deduped? }
//   POST  /api/:t/pipeline/gates/:id/decide     -> { id, status, decision }   (see pipelineActions)
//   POST  /api/:t/pipeline/runs/:runId/scope-signoffs -> { runId, party, complete, parties }
import { platformFetch, PlatformError } from "./platform";

export type RunStatus = "extracting" | "delivery_active" | "report_done" | "scope_pending" | "complete" | "blocked";
export type GateKind = "prd_review" | "prd_sign" | "pm_review" | "customer_feedback" | "pm_approval" | "scope_signoff";
export type Track = "delivery" | "report" | "scope";
export type ActorSide = "internal" | "client";
export type ScopeParty = "provider" | "client";

// Recovery-tool option lists (mirrors the controller's own validation sets — pipeline.controller.ts's
// RUN_STATUS/GATE_KINDS/ACTOR_SIDES — so the manual-override forms in the run workspace offer exactly
// what the backend will accept, nothing more).
export const RUN_STATUSES: RunStatus[] = ["extracting", "delivery_active", "report_done", "scope_pending", "complete", "blocked"];
export const ACTOR_SIDES: ActorSide[] = ["internal", "client"];
export const ALL_GATE_KINDS: GateKind[] = ["prd_review", "prd_sign", "pm_review", "customer_feedback", "pm_approval", "scope_signoff"];

export interface PipelineRun {
  id: string;
  title: string | null;
  status: RunStatus;
  source_meeting_id: string | null;
  mom_ref: string | null;
  created_at: string;
  updated_at: string;
  // C4/C6: the LIST select now carries these too, so the list can show whose work a run is and link
  // to its project without cross-referencing the recordings registry. Optional because a server on an
  // older tag omits them — the UI then renders no link rather than an empty one.
  client_id?: string | null;
  project_id?: string | null;
  owner_id?: string | null;
}
export interface PipelineStage {
  id: string;
  track: Track;
  name: string;
  status: "pending" | "running" | "awaiting_gate" | "done" | "failed";
  artifact_ref: string | null;
  confidence: number | null;
  updated_at: string;
}
export interface PipelineGate {
  id: string;
  run_id: string;
  stage_id: string | null;
  kind: GateKind;
  actor_side: "internal" | "client";
  status: "pending" | "decided";
  decision: string | null;
  note: string | null;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}
// Both SELECTs now carry client_id/project_id (C4/C6). The detail narrows them to required, since the
// run-workspace links depend on them being present.
export interface PipelineRunDetail extends PipelineRun {
  client_id: string | null;
  project_id: string | null;
  stages: PipelineStage[];
  gates: PipelineGate[];
  scopeSignoffs: Array<{ party: string; signer_name: string | null; signed_at: string }>;
}

export const GATE_LABEL: Record<GateKind, string> = {
  prd_review: "PRD review",
  prd_sign: "PRD sign-off (client)",
  pm_review: "PM review",
  customer_feedback: "Customer feedback",
  pm_approval: "PM approval",
  scope_signoff: "Scope sign-off",
};

export const TRACK_LABEL: Record<Track, string> = {
  delivery: "Delivery",
  report: "Report",
  scope: "Scope",
};

// The scope dual-sign — pipeline.controller.ts's REQUIRED_SCOPE_PARTIES. "provider" is the agency's
// own half (what the run workspace's sign-off form records); "client" arrives via the portal BFF.
export const SCOPE_PARTIES: ScopeParty[] = ["provider", "client"];
export const SCOPE_PARTY_LABEL: Record<ScopeParty, string> = {
  provider: "Agency",
  client: "Client",
};
// Rendering order for the three-track workspace layout (stable regardless of stage insertion order).
export const TRACK_ORDER: Track[] = ["delivery", "scope", "report"];

// Stage `name` values are workflow-defined slugs (prd_extract, scope_extract, claude_design, …), not
// an enum we control here — humanize generically, with the small set of known acronyms spelled out.
const STAGE_ACRONYMS = new Set(["prd", "qa", "cta", "seo"]);
export function humanizeStageName(name: string): string {
  return name
    .split("_")
    .filter(Boolean)
    .map((w) => (STAGE_ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

// C1: the controller accepts `status`, `clientId` and `projectId` (plus `sourceMeetingId`, not
// surfaced here — that's the hub's own lookup path). Narrowing happens SERVER-side; the alternative
// was fetching the 200-row cap and hiding most of it in the browser, which is not a filter.
// Passing no opts keeps every existing call site's behavior identical.
export async function listPipelineRuns(
  userId: string,
  tenant: string,
  opts: { status?: string; clientId?: string; projectId?: string } = {},
): Promise<ReadResult<PipelineRun[]>> {
  const q = new URLSearchParams();
  if (opts.status) q.set("status", opts.status);
  if (opts.clientId) q.set("clientId", opts.clientId);
  if (opts.projectId) q.set("projectId", opts.projectId);
  const qs = q.toString();
  // AGN-3: a refused run list is no longer the same value as "this company has run nothing".
  return readResult(platformFetch<PipelineRun[]>(`/api/${tenant}/pipeline/runs${qs ? `?${qs}` : ""}`, userId), {
    absentAsEmpty: [],
  });
}

export async function getPipelineRun(userId: string, tenant: string, runId: string): Promise<ReadResult<PipelineRunDetail | null>> {
  // 404 on one run is a real answer ("no such run") and stays inside `ok` as null; 403 is not.
  return readResult(platformFetch<PipelineRunDetail>(`/api/${tenant}/pipeline/runs/${runId}`, userId), {
    absentAsEmpty: null,
  });
}

/** The internal review inbox: pending gates the client does NOT own (pm_review / pm_approval / prd_review). */
export async function listInternalPendingGates(userId: string, tenant: string): Promise<ReadResult<PipelineGate[]>> {
  // ⚠ This feeds a "work waiting for you" count. Degrading a refusal to [] told the viewer there
  // was NOTHING TO DO, which is the most consequential possible way to be wrong about a queue.
  return readResult(
    platformFetch<PipelineGate[]>(`/api/${tenant}/pipeline/gates?status=pending&actorSide=internal`, userId),
    { absentAsEmpty: [] },
  );
}

// ---- Pure helpers for the run workspace (WD-02) — no fetch, easy to unit test ----

/** Stages grouped by track, in TRACK_ORDER, each track's stages kept in the backend's chronological
 *  (created_at ASC) order. A track with no stages yet still gets an (empty) entry. */
export function groupStagesByTrack(stages: PipelineStage[]): Record<Track, PipelineStage[]> {
  const grouped: Record<Track, PipelineStage[]> = { delivery: [], report: [], scope: [] };
  for (const s of stages) grouped[s.track]?.push(s);
  return grouped;
}

// WD-03 (D-3) — the SAME client-sign-gate-by-track convention pipeline.controller.ts's updateStage
// enforces server-side. Kept here ONLY so the workspace can show a "locked after signature" state
// without round-tripping a doomed PATCH first; the 409 from the backend remains the real boundary
// (this is UI convenience, not an authority — editStageArtifactAction still lets the backend decide).
// `report` has no entry: the report artifact is internal-only, never client-signed, never locked.
const CLIENT_SIGN_GATE_KIND_BY_TRACK: Partial<Record<Track, GateKind[]>> = {
  delivery: ["prd_sign", "customer_feedback"],
  scope: ["scope_signoff"],
};

/** Mirrors PipelineController.updateStage's D-3 lock check (see that file's comment for why
 *  "stage.status === 'done'" is deliberately NOT also a trigger). */
export function isStageLocked(stage: Pick<PipelineStage, "track">, gates: PipelineGate[]): boolean {
  const kinds = CLIENT_SIGN_GATE_KIND_BY_TRACK[stage.track];
  if (!kinds || kinds.length === 0) return false;
  return gates.some((g) => g.actor_side === "client" && g.status === "decided" && kinds.includes(g.kind));
}

/** Plain-language "what's blocking this run right now", for staff (mirrors the client-portal's
 *  `currentBlockage`, PortalController, but surfaces BOTH actor sides — staff need to know whether
 *  they or the client are the ones holding it up). Gates arrive created_at-ascending from the
 *  backend, so the first pending one is the earliest-opened — the "pending beat". */
export function describeBlockage(
  run: { status: RunStatus },
  gates: PipelineGate[],
): { text: string; pendingGate: PipelineGate | null } {
  const pending = gates.find((g) => g.status === "pending") ?? null;
  if (pending) {
    const who = pending.actor_side === "client" ? "the client" : "internal review";
    return { text: `Waiting on ${who}: ${GATE_LABEL[pending.kind] ?? pending.kind}`, pendingGate: pending };
  }
  if (run.status === "blocked") return { text: "Blocked — needs internal follow-up before it can continue.", pendingGate: null };
  if (run.status === "complete") return { text: "Complete — nothing outstanding.", pendingGate: null };
  return { text: "In progress — no gate is currently open.", pendingGate: null };
}

export interface ScopeSignoffSummary {
  complete: boolean;
  signed: ScopeParty[];
  outstanding: ScopeParty[];
  text: string;
}

// B1 — mirrors recordScopeSignoff's own `complete`/`parties` computation (REQUIRED_SCOPE_PARTIES),
// so the workspace can word the state honestly the instant the agency's half lands: `complete:false`
// with only "provider" signed reads as "waiting on the client to counter-sign", not as a stuck run.
export function summarizeScopeSignoffs(scopeSignoffs: Array<{ party: string }>): ScopeSignoffSummary {
  const have = new Set(scopeSignoffs.map((s) => s.party));
  const signed = SCOPE_PARTIES.filter((p) => have.has(p));
  const outstanding = SCOPE_PARTIES.filter((p) => !have.has(p));
  const complete = outstanding.length === 0;
  const text = complete
    ? "Both parties have signed — the scope agreement is complete."
    : signed.length === 0
      ? "Neither party has signed the scope agreement yet."
      : `Waiting on ${outstanding.map((p) => SCOPE_PARTY_LABEL[p]).join(", ")} to sign.`;
  return { complete, signed, outstanding, text };
}
