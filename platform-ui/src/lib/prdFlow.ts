// PRD Studio flow logic — pure, zero-I/O, client-safe (no `server-only`, no React).
//
// The tab reads as ONE flow with four beats: create a briefing → capture its recording → convert
// the transcript into a PRD run → clear two approvals (GM review, then client sign-off). The
// backend already models every state here — `meeting_recordings.status` for the first three beats,
// `pipeline_gates` (`prd_review` internal, `prd_sign` client) for the fourth — so nothing in this
// file invents a state; it only translates those fields into the one headline / one next step a
// person needs to see. Components render what these functions return and nothing else, so the copy
// is tested here rather than through the DOM.
import type { RecordingStatus } from "./meetings";
import type { PipelineGate, RunStatus } from "./pipeline";

export type BriefingPhase = "capture" | "processing" | "ready" | "failed" | "in_pipeline";

export interface BriefingPhaseView {
  phase: BriefingPhase;
  /** One short line: where this briefing is. */
  headline: string;
  /** One short line: what to do about it. `null` when there is nothing left to do on this tab. */
  next: string | null;
}

export function briefingPhase(status: RecordingStatus): BriefingPhaseView {
  switch (status) {
    case "scheduled":
    case "recording":
      return {
        phase: "capture",
        headline: "No recording yet",
        next: "Add the recording — record here, use the desktop helper, or upload a file.",
      };
    case "recorded":
    case "transcribing":
      return { phase: "processing", headline: "Transcribing", next: "Nothing to do — this updates by itself." };
    case "transcribed":
      return { phase: "ready", headline: "Transcript ready", next: "Convert it into a PRD run." };
    case "failed":
      return { phase: "failed", headline: "Transcription failed", next: "Retry, or upload a different file." };
    case "ingested":
      return { phase: "in_pipeline", headline: "In the pipeline", next: null };
  }
}

export type ChipTone = "idle" | "waiting" | "done" | "attention";
export interface ApprovalChip { label: string; tone: ChipTone }

export interface ApprovalTrackView {
  gm: ApprovalChip;
  client: ApprovalChip;
  /** One plain sentence for the whole run: who is holding it, or that it is through. */
  sentence: string;
  /** The internal `prd_review` gate a GM can decide right now, if any. */
  pendingGmGate: PipelineGate | null;
}

const NOT_YET: ApprovalChip = { label: "Not yet", tone: "idle" };

/** Gates arrive created_at-ascending; a review can be reopened, so the newest of a kind is the live one. */
function latestOfKind(gates: PipelineGate[], kind: PipelineGate["kind"]): PipelineGate | null {
  let found: PipelineGate | null = null;
  for (const g of gates) {
    if (g.kind !== kind) continue;
    if (!found || g.created_at >= found.created_at) found = g;
  }
  return found;
}

function decisionChip(g: PipelineGate, waitingLabel: string, doneLabel: string): ApprovalChip {
  if (g.status === "pending") return { label: waitingLabel, tone: "waiting" };
  switch (g.decision) {
    case "approved":
    case "signed":
      return { label: doneLabel, tone: "done" };
    case "changes_requested":
      return { label: "Changes requested", tone: "attention" };
    case "rejected":
      return { label: "Rejected", tone: "attention" };
    default:
      return { label: doneLabel, tone: "done" };
  }
}

export function approvalTrack(_run: { status: RunStatus }, gates: PipelineGate[]): ApprovalTrackView {
  const review = latestOfKind(gates, "prd_review");
  const sign = latestOfKind(gates, "prd_sign");

  if (!review) {
    return { gm: NOT_YET, client: NOT_YET, sentence: "The PRD is still being drafted from the transcript.", pendingGmGate: null };
  }

  const gm = decisionChip(review, "Waiting on GM", "Approved");
  if (gm.tone === "waiting") {
    return { gm, client: NOT_YET, sentence: "Waiting on the GM to review the PRD.", pendingGmGate: review };
  }
  if (gm.tone === "attention") {
    const sentence = review.decision === "rejected" ? "The GM rejected the PRD." : "The GM asked for changes to the PRD.";
    return { gm, client: NOT_YET, sentence, pendingGmGate: null };
  }

  // GM approved — the client beat decides the rest.
  if (!sign) {
    return { gm, client: NOT_YET, sentence: "GM approved. Client sign-off has not been opened yet.", pendingGmGate: null };
  }
  const client = decisionChip(sign, "Waiting on client", "Signed");
  if (client.tone === "waiting") {
    return { gm, client, sentence: "GM approved. Waiting on the client to sign the PRD.", pendingGmGate: null };
  }
  if (client.tone === "attention") {
    const sentence = sign.decision === "rejected" ? "The client rejected the PRD." : "The client asked for changes to the PRD.";
    return { gm, client, sentence, pendingGmGate: null };
  }
  return { gm, client, sentence: "PRD approved and signed — the build is unlocked.", pendingGmGate: null };
}

export interface FlowCounts {
  toCapture: number;
  processing: number;
  readyToConvert: number;
  failed: number;
  awaitingGm: number;
  awaitingClient: number;
  complete: number;
}

export function flowCounts(
  recordings: Array<{ status: RecordingStatus }>,
  runs: Array<{ run: { status: RunStatus }; gates: PipelineGate[] }>,
): FlowCounts {
  const counts: FlowCounts = { toCapture: 0, processing: 0, readyToConvert: 0, failed: 0, awaitingGm: 0, awaitingClient: 0, complete: 0 };
  for (const r of recordings) {
    switch (briefingPhase(r.status).phase) {
      case "capture": counts.toCapture++; break;
      case "processing": counts.processing++; break;
      case "ready": counts.readyToConvert++; break;
      case "failed": counts.failed++; break;
      case "in_pipeline": break;
    }
  }
  for (const { run, gates } of runs) {
    if (run.status === "complete") { counts.complete++; continue; }
    const t = approvalTrack(run, gates);
    if (t.gm.tone === "waiting") counts.awaitingGm++;
    else if (t.client.tone === "waiting") counts.awaitingClient++;
  }
  return counts;
}
