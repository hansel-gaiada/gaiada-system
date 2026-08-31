import Link from "next/link";
import type { PipelineGate, PipelineRun } from "@/lib/pipeline";
import { approvalTrack } from "@/lib/prdFlow";
import { formatDateTime } from "@/lib/format";
import "./prd-studio.css";

// Step 4 — one PRD run and the two approvals it must clear. The GM beat (`prd_review`, internal) can
// be decided right here by anyone holding `approvals.decide` — the same `decideGateAction` the run
// workspace uses, so there is one decide path, not two. The client beat (`prd_sign`) is decided in
// the client portal and is read-only here on purpose: the row says where it happens instead of
// pretending staff can sign for the client. Server-safe (no hooks): the page passes a server action.
export function RunApprovalRow({
  run,
  gates,
  briefingHref,
  briefingTitle,
  mayDecide,
  onDecide,
}: {
  run: PipelineRun;
  /** `null` = the gates were not read for this run (page detail cap) — say so rather than guess. */
  gates: PipelineGate[] | null;
  briefingHref?: string | null;
  briefingTitle?: string | null;
  mayDecide: boolean;
  onDecide: (formData: FormData) => Promise<void>;
}) {
  const t = gates
    ? approvalTrack(run, gates)
    : {
        gm: { label: "See run", tone: "idle" as const },
        client: { label: "See run", tone: "idle" as const },
        sentence: "Open the run to see its approvals.",
        pendingGmGate: null,
      };
  const canDecide = mayDecide && t.pendingGmGate !== null;
  return (
    <div className="prd-run">
      <div>
        <h3 className="prd-run__title">
          <Link href={`/pipeline/${run.id}`}>{run.title ?? "(untitled run)"}</Link>
        </h3>
        <div className="prd-run__meta">
          <span>Started {formatDateTime(run.created_at)}</span>
          {briefingHref ? (
            <Link href={briefingHref}>From briefing: {briefingTitle ?? "open"}</Link>
          ) : run.source_meeting_id ? (
            <span>From briefing {run.source_meeting_id}</span>
          ) : (
            <span>Started by hand — no briefing</span>
          )}
        </div>
      </div>

      <div className="prd-track" aria-label="Approvals">
        <div className="prd-beat">
          <span className="prd-beat__name">GM review</span>
          <span className="prd-chip" data-tone={t.gm.tone}>{t.gm.label}</span>
        </div>
        <span className="prd-track__arrow" aria-hidden="true">→</span>
        <div className="prd-beat">
          <span className="prd-beat__name">Client sign-off</span>
          <span className="prd-chip" data-tone={t.client.tone}>{t.client.label}</span>
          {t.client.tone === "waiting" && <span className="prd-beat__where">Signed in the client portal</span>}
        </div>
      </div>

      <p className="prd-run__sentence">{t.sentence}</p>

      {canDecide && t.pendingGmGate && (
        <form action={onDecide} className="prd-run__decide">
          <input type="hidden" name="gateId" value={t.pendingGmGate.id} />
          <input type="hidden" name="runId" value={run.id} />
          <button type="submit" name="decision" value="approved" className="lux-btn lux-btn--solid lux-btn--sm">Approve</button>
          <button type="submit" name="decision" value="changes_requested" className="lux-btn lux-btn--ghost lux-btn--sm">Request changes</button>
        </form>
      )}
    </div>
  );
}
