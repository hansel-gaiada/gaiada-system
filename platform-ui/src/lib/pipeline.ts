import "server-only";
// WS11 meeting-to-delivery pipeline — data layer for the internal ADNARA dashboard + gate inbox.
// Thin readers over the platform pipeline API (0017 / PipelineController). Every reader DEGRADES
// gracefully (return []/null on 404/403) so the page ships ahead of any missing backend — same
// pattern as lib/pm.ts / lib/it.ts. Client-facing gates live in the separate client portal; this
// module surfaces the INTERNAL side (runs across the three tracks + the internal review inbox).
//
// BFF CONTRACT (implemented in platform-nest):
//   GET  /api/:t/pipeline/runs                 -> PipelineRun[]
//   GET  /api/:t/pipeline/runs/:id             -> PipelineRunDetail
//   GET  /api/:t/pipeline/gates?status=&actorSide=&kind=  -> PipelineGate[]
//   POST /api/:t/pipeline/gates/:id/decide     -> { id, status, decision }   (see pipelineActions)
import { platformFetch, PlatformError } from "./platform";

export type RunStatus = "extracting" | "delivery_active" | "report_done" | "scope_pending" | "complete" | "blocked";
export type GateKind = "prd_review" | "prd_sign" | "pm_review" | "customer_feedback" | "pm_approval" | "scope_signoff";

export interface PipelineRun {
  id: string;
  title: string | null;
  status: RunStatus;
  source_meeting_id: string | null;
  created_at: string;
}
export interface PipelineStage {
  id: string;
  track: "delivery" | "report" | "scope";
  name: string;
  status: "pending" | "running" | "awaiting_gate" | "done" | "failed";
  artifact_ref: string | null;
  confidence: number | null;
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
  created_at: string;
}
export interface PipelineRunDetail extends PipelineRun {
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

async function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 404 || e.status === 403)) return fallback;
    throw e;
  }
}

export async function listPipelineRuns(userId: string, tenant: string): Promise<PipelineRun[]> {
  return safe(platformFetch<PipelineRun[]>(`/api/${tenant}/pipeline/runs`, userId), []);
}

export async function getPipelineRun(userId: string, tenant: string, runId: string): Promise<PipelineRunDetail | null> {
  return safe(platformFetch<PipelineRunDetail>(`/api/${tenant}/pipeline/runs/${runId}`, userId), null);
}

/** The internal review inbox: pending gates the client does NOT own (pm_review / pm_approval / prd_review). */
export async function listInternalPendingGates(userId: string, tenant: string): Promise<PipelineGate[]> {
  return safe(platformFetch<PipelineGate[]>(`/api/${tenant}/pipeline/gates?status=pending&actorSide=internal`, userId), []);
}
