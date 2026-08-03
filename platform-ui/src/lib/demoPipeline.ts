import "server-only";
// TEMP DEMO MODE — stateful in-memory store for the WS11 delivery pipeline (mirrors demoMeetings.ts
// exactly). Lets /pipeline, /pipeline/[runId], and the PRD Studio tab (WD-02) exercise real run
// data — three tracks, gates, artifacts, a pending beat — with NO backend. Wired from
// demoFixtures.getDemoResponse before the generic route matching. Session-only, resets on restart
// — same convention as every other demo store in this file. Safe to delete once the real backend
// is deployed and verified (WD-01).
//
// run-demo-1 is the client-linked, fully-extracted case (mirrors the live-verified "Acme Coffee
// kickoff" run: 3 done stages with realistic confidences, one pending client gate) and is the run
// demoMeetings.ts's rec-demo-1 already points at via pipeline_run_id — keep the two in sync.
// run-demo-2 exercises the OTHER real-world state this ticket has to degrade cleanly for: a run
// with client_id NULL (the known dispatcher gap — client context isn't always attached) and a
// pending INTERNAL gate (so the workspace's own Approve/Request-changes affordance is exercisable).

interface DemoStage {
  id: string; run_id: string; track: "delivery" | "report" | "scope"; name: string;
  status: "pending" | "running" | "awaiting_gate" | "done" | "failed";
  artifact_ref: string | null; confidence: number | null; updated_at: string;
}
interface DemoGate {
  id: string; run_id: string; stage_id: string | null;
  kind: string; actor_side: "internal" | "client"; status: "pending" | "decided";
  decision: string | null; note: string | null;
  decided_by: string | null; decided_at: string | null; created_at: string;
}
interface DemoRun {
  id: string; title: string | null; status: string; source_meeting_id: string | null;
  client_id: string | null; mom_ref: string | null; created_by: string | null;
  created_at: string; updated_at: string;
}
interface DemoResult { status: number; json: unknown }
const ok = (json: unknown): DemoResult => ({ status: 200, json });

const PRD_ARTIFACT = `# Northwind Traders — Site Redesign PRD

## Summary
Full redesign focused on conversion. Homepage and checkout are the priority surfaces; existing
brand assets carry over. Target: end of Q3, budget flexible for phase 1.

## Goals
- Raise homepage-to-cart conversion by **15%**
- Cut checkout abandonment via a shorter, single-page flow
- Ship a design system the client's own team can extend

## Scope (v1)
1. Homepage hero + featured collections
2. Product listing + filters
3. Single-page checkout
4. Basic order-confirmation email

> Out of scope for v1: loyalty program, multi-currency, native apps.

See the linked Scope Agreement for commercial terms.`;

const SCOPE_ARTIFACT = `## Scope Agreement — Site Redesign

**Engagement:** 8 weeks, fixed-fee phase 1.

- Discovery + IA: 1 week
- Design (desktop + mobile): 2 weeks
- Build: 4 weeks
- QA + launch: 1 week

Change requests beyond this scope route through the standard maintenance intake once launched.`;

const REPORT_ARTIFACT = `### Internal meeting report

Client is motivated by a competitor's recent relaunch; timeline pressure is real but budget has
room in phase 2. Flag for the account lead: they mentioned a possible SEO engagement once the
redesign ships — worth a warm handoff to the SEO desk.`;

const PRD_ARTIFACT_2 = `# Mobile App Revamp — draft PRD

## Summary
Early draft from the kickoff call. Client wants an offline-first rework of the existing app;
scope on push notifications is still being scoped with them.

## Open questions
- Which platforms first — iOS or both?
- Does the existing backend need new endpoints, or is this purely client-side?`;

const RUNS: DemoRun[] = [
  {
    id: "run-demo-1",
    title: "Northwind — site redesign kickoff",
    status: "scope_pending",
    source_meeting_id: "mtg-northwind-kickoff", // matches demoMeetings.ts rec-demo-1.meeting_id
    client_id: "cl-1", // Northwind Traders
    mom_ref: null,
    created_by: "demo-hansel",
    created_at: "2026-07-18T03:10:00Z",
    updated_at: "2026-07-21T09:00:00Z",
  },
  {
    id: "run-demo-2",
    title: "Mobile app revamp — discovery",
    status: "delivery_active",
    source_meeting_id: null, // exercises "no source meeting" as well as "no client" in the same run
    client_id: null, // KNOWN GAP: the dispatcher currently drops client context on some ingests
    mom_ref: null,
    created_by: "demo-hansel",
    created_at: "2026-07-23T01:00:00Z",
    updated_at: "2026-07-23T02:30:00Z",
  },
];

const STAGES: DemoStage[] = [
  // run-demo-1 — all three tracks fully extracted (mirrors the live-verified real run).
  { id: "stg-1-prd", run_id: "run-demo-1", track: "delivery", name: "prd_extract", status: "done", artifact_ref: PRD_ARTIFACT, confidence: 0.9, updated_at: "2026-07-18T03:20:00Z" },
  { id: "stg-1-scope", run_id: "run-demo-1", track: "scope", name: "scope_extract", status: "done", artifact_ref: SCOPE_ARTIFACT, confidence: 0.85, updated_at: "2026-07-18T03:21:00Z" },
  { id: "stg-1-report", run_id: "run-demo-1", track: "report", name: "report_extract", status: "done", artifact_ref: REPORT_ARTIFACT, confidence: 0.8, updated_at: "2026-07-18T03:22:00Z" },
  // run-demo-2 — only the delivery track has drafted so far; scope/report haven't run yet.
  { id: "stg-2-prd", run_id: "run-demo-2", track: "delivery", name: "prd_extract", status: "done", artifact_ref: PRD_ARTIFACT_2, confidence: 0.78, updated_at: "2026-07-23T01:30:00Z" },
  { id: "stg-2-scope", run_id: "run-demo-2", track: "scope", name: "scope_extract", status: "pending", artifact_ref: null, confidence: null, updated_at: "2026-07-23T01:00:00Z" },
  { id: "stg-2-report", run_id: "run-demo-2", track: "report", name: "report_extract", status: "pending", artifact_ref: null, confidence: null, updated_at: "2026-07-23T01:00:00Z" },
];

const GATES: DemoGate[] = [
  // run-demo-1: PRD already approved + signed; the scope sign-off is the pending beat (client-side).
  { id: "gt-1-prdreview", run_id: "run-demo-1", stage_id: "stg-1-prd", kind: "prd_review", actor_side: "internal", status: "decided", decision: "approved", note: null, decided_by: "demo-hansel", decided_at: "2026-07-18T04:00:00Z", created_at: "2026-07-18T03:25:00Z" },
  { id: "gt-1-prdsign", run_id: "run-demo-1", stage_id: "stg-1-prd", kind: "prd_sign", actor_side: "client", status: "decided", decision: "signed", note: null, decided_by: null, decided_at: "2026-07-19T10:00:00Z", created_at: "2026-07-18T04:05:00Z" },
  { id: "gt-1-scopesign", run_id: "run-demo-1", stage_id: "stg-1-scope", kind: "scope_signoff", actor_side: "client", status: "pending", decision: null, note: null, decided_by: null, decided_at: null, created_at: "2026-07-21T09:00:00Z" },
  // run-demo-2: internal PM review pending on the drafted PRD — exercises the workspace's own decide form.
  { id: "gt-2-pmreview", run_id: "run-demo-2", stage_id: "stg-2-prd", kind: "pm_review", actor_side: "internal", status: "pending", decision: null, note: "Needs a platform decision before we draft scope.", decided_by: null, decided_at: null, created_at: "2026-07-23T01:35:00Z" },
];

const SCOPE_SIGNOFFS: Record<string, { party: string; signer_name: string | null; signed_at: string }[]> = {
  "run-demo-1": [{ party: "provider", signer_name: "Dewi Santoso", signed_at: "2026-07-20T09:00:00Z" }],
  "run-demo-2": [],
};

const REQUIRED_SCOPE_PARTIES = ["provider", "client"];
let seq = 500;
const nid = (p: string) => `${p}-${++seq}`;
const now = () => new Date().toISOString();

// WD-03 (D-3) — SAME convention as platform-nest's PipelineController.updateStage and
// lib/pipeline.ts's isStageLocked: a stage locks once a DECIDED client gate of a matching kind
// exists for its run/track. `report` has no entry (never client-signed, never locked).
const CLIENT_SIGN_GATE_KIND_BY_TRACK: Partial<Record<string, string[]>> = {
  delivery: ["prd_sign", "customer_feedback"],
  scope: ["scope_signoff"],
};

/** Returns a DemoResult for any /pipeline route, or null if it doesn't match. */
export function pipelineDemo(method: string, p: string, params: URLSearchParams, body?: string): DemoResult | null {
  const m = method.toUpperCase();

  const decideM = p.match(/^\/api\/[^/]+\/pipeline\/gates\/([^/]+)\/decide$/);
  if (decideM && m === "POST") {
    const gate = GATES.find((g) => g.id === decideM[1]);
    if (!gate || gate.status !== "pending") return { status: 404, json: { error: "gate not found or already decided" } };
    const b = JSON.parse(body || "{}") as { decision?: string; note?: string };
    if (!b.decision) return { status: 400, json: { error: "decision required" } };
    gate.status = "decided";
    gate.decision = b.decision;
    if (b.note) gate.note = b.note;
    gate.decided_by = "demo-hansel";
    gate.decided_at = new Date().toISOString();
    return ok({ id: gate.id, status: "decided", decision: gate.decision });
  }

  // WD-03 (D-3) — artifact edit / signature lock, exercised in DEMO_MODE too.
  const patchStageM = p.match(/^\/api\/[^/]+\/pipeline\/stages\/([^/]+)$/);
  if (patchStageM && m === "PATCH") {
    const stage = STAGES.find((s) => s.id === patchStageM[1]);
    if (!stage) return { status: 404, json: { error: "stage not found" } };
    const b = JSON.parse(body || "{}") as { status?: DemoStage["status"]; artifactRef?: string; confidence?: number };
    const editingArtifact = b.artifactRef !== undefined;
    if (editingArtifact) {
      const kinds = CLIENT_SIGN_GATE_KIND_BY_TRACK[stage.track];
      const locked = !!kinds?.length && GATES.some(
        (g) => g.run_id === stage.run_id && g.actor_side === "client" && g.status === "decided" && kinds.includes(g.kind),
      );
      if (locked) return { status: 409, json: { error: "artifact is locked — the client has already signed this stage" } };
    }
    if (b.status !== undefined) stage.status = b.status;
    if (b.artifactRef !== undefined) stage.artifact_ref = b.artifactRef;
    if (b.confidence !== undefined) stage.confidence = b.confidence;
    stage.updated_at = new Date().toISOString();
    return ok({ id: stage.id, status: stage.status });
  }

  const gatesM = p.match(/^\/api\/[^/]+\/pipeline\/gates$/);
  if (gatesM && m === "GET") {
    const status = params.get("status") ?? "pending";
    const actorSide = params.get("actorSide");
    const kind = params.get("kind");
    let rows = GATES.filter((g) => g.status === status);
    if (actorSide) rows = rows.filter((g) => g.actor_side === actorSide);
    if (kind) rows = rows.filter((g) => g.kind === kind);
    return ok(rows);
  }
  // B5 — open a gate by hand (the run-workspace recovery form). Mirrors PipelineController.openGate's
  // dedupe: a pending gate of the same (run, kind, actorSide) is returned instead of duplicated.
  if (gatesM && m === "POST") {
    const b = JSON.parse(body || "{}") as { runId?: string; stageId?: string; kind?: string; actorSide?: string; note?: string };
    if (!b.runId) return { status: 400, json: { error: "runId required" } };
    if (!b.kind) return { status: 400, json: { error: "invalid gate kind" } };
    if (!b.actorSide) return { status: 400, json: { error: "actorSide must be internal|client" } };
    if (!RUNS.find((r) => r.id === b.runId)) return { status: 404, json: { error: "run not found" } };
    const dup = GATES.find(
      (g) => g.run_id === b.runId && (g.stage_id ?? null) === (b.stageId ?? null) && g.kind === b.kind && g.actor_side === b.actorSide && g.status === "pending",
    );
    if (dup) return { status: 201, json: { id: dup.id, status: "pending", deduped: true } };
    const gate: DemoGate = {
      id: nid("gt"), run_id: b.runId, stage_id: b.stageId ?? null, kind: b.kind,
      actor_side: b.actorSide as "internal" | "client", status: "pending", decision: null,
      note: b.note ?? null, decided_by: null, decided_at: null, created_at: now(),
    };
    GATES.push(gate);
    return { status: 201, json: { id: gate.id, status: "pending" } };
  }

  // B3 — park/unblock/re-status a run by hand (the run-workspace recovery form).
  const runStatusM = p.match(/^\/api\/[^/]+\/pipeline\/runs\/([^/]+)$/);
  if (runStatusM && m === "PATCH") {
    const run = RUNS.find((r) => r.id === runStatusM[1]);
    if (!run) return { status: 404, json: { error: "run not found" } };
    const b = JSON.parse(body || "{}") as { status?: string };
    if (b.status) run.status = b.status;
    run.updated_at = now();
    return ok({ id: run.id, status: run.status });
  }

  // B4 — add a beat by hand when automation didn't create one (the run-workspace recovery form).
  const createStageM = p.match(/^\/api\/[^/]+\/pipeline\/runs\/([^/]+)\/stages$/);
  if (createStageM && m === "POST") {
    const run = RUNS.find((r) => r.id === createStageM[1]);
    if (!run) return { status: 404, json: { error: "run not found" } };
    const b = JSON.parse(body || "{}") as { track?: DemoStage["track"]; name?: string; status?: DemoStage["status"]; artifactRef?: string; confidence?: number };
    if (!b.track) return { status: 400, json: { error: "track must be delivery|report|scope" } };
    if (!b.name) return { status: 400, json: { error: "name required" } };
    const stage: DemoStage = {
      id: nid("stg"), run_id: run.id, track: b.track, name: b.name, status: b.status ?? "pending",
      artifact_ref: b.artifactRef ?? null, confidence: b.confidence ?? null, updated_at: now(),
    };
    STAGES.push(stage);
    return { status: 201, json: { id: stage.id } };
  }

  // B1 — the agency's half of the scope dual-sign. Mirrors recordScopeSignoff: one row per
  // (run, party), a re-file is a no-op, `complete` reflects both parties having signed.
  const scopeSignoffM = p.match(/^\/api\/[^/]+\/pipeline\/runs\/([^/]+)\/scope-signoffs$/);
  if (scopeSignoffM && m === "POST") {
    const run = RUNS.find((r) => r.id === scopeSignoffM[1]);
    if (!run) return { status: 404, json: { error: "run not found" } };
    const b = JSON.parse(body || "{}") as { party?: string; gateId?: string; signerName?: string; signatureRef?: string };
    if (!b.party) return { status: 400, json: { error: "party required" } };
    const list = SCOPE_SIGNOFFS[run.id] ?? (SCOPE_SIGNOFFS[run.id] = []);
    if (!list.some((s) => s.party === b.party)) {
      list.push({ party: b.party, signer_name: b.signerName ?? null, signed_at: now() });
    }
    const parties = list.map((s) => s.party);
    const complete = REQUIRED_SCOPE_PARTIES.every((p2) => parties.includes(p2));
    if (complete) {
      const gate = GATES.find((g) => g.run_id === run.id && g.kind === "scope_signoff" && g.status === "pending");
      if (gate) { gate.status = "decided"; gate.decision = "signed"; gate.decided_by = "demo-hansel"; gate.decided_at = now(); }
    }
    return { status: 201, json: { runId: run.id, party: b.party, complete, parties } };
  }

  const detailM = p.match(/^\/api\/[^/]+\/pipeline\/runs\/([^/]+)$/);
  if (detailM && m === "GET") {
    const run = RUNS.find((r) => r.id === detailM[1]);
    if (!run) return { status: 404, json: { error: "run not found" } };
    return ok({
      ...run,
      stages: STAGES.filter((s) => s.run_id === run.id),
      gates: GATES.filter((g) => g.run_id === run.id),
      scopeSignoffs: SCOPE_SIGNOFFS[run.id] ?? [],
    });
  }

  const listM = p.match(/^\/api\/[^/]+\/pipeline\/runs$/);
  if (listM && m === "GET") {
    const status = params.get("status");
    let rows = RUNS;
    if (status) rows = rows.filter((r) => r.status === status);
    // The real list SELECT doesn't return client_id (only the detail read does) — match that shape.
    return ok(rows.map(({ client_id, ...rest }) => { void client_id; return rest; }));
  }

  return null;
}
