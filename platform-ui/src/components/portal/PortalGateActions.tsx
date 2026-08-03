import { portalDecideGate, portalScopeSign } from "@/lib/portalActions";
import { ArtifactMarkdown } from "@/components/pipeline/ArtifactMarkdown";
import type { PortalGate, PortalStage } from "@/lib/portal";

// WD-03 (D-3) — "what a client signed must be what the record holds." So the sign view has to show
// the client the ACTUAL artifact it is asking them to sign, not just a status chip. Kind -> track is
// the same convention pipeline.controller.ts's updateStage lock uses to find "the stage this client
// gate governs" (no stage_id FK on the shipped fan-out workflow's gates — see that file's comment).
const GATE_TRACK: Record<string, string> = { prd_sign: "delivery", customer_feedback: "delivery", scope_signoff: "scope" };

const PROMPT: Record<string, string> = {
  prd_sign: "Please review and sign the PRD to start work.",
  scope_signoff: "Please sign the Scope Agreement.",
  customer_feedback: "Your feedback is requested on the latest work.",
};

/**
 * The client's outstanding decisions on one run, with the artifact each one governs.
 *
 * Extracted from the portal list page (C5) so the run DETAIL page renders the identical thing. This is
 * the D-3 surface — what the client sees is what they sign — and two copies of it would be two places
 * for that guarantee to drift. Deliberately a server component: the forms post to server actions and
 * nothing here needs interactivity.
 */
export function PortalGateActions({
  runId,
  gates,
  stages,
}: {
  runId: string;
  gates: PortalGate[];
  stages: PortalStage[];
}) {
  const pending = gates.filter((g) => g.status === "pending");
  if (!pending.length) return null;

  return (
    <>
      {pending.map((g) => {
        const track = GATE_TRACK[g.kind];
        const stage = track ? stages.find((s) => s.track === track) : undefined;
        return (
          <div key={g.id} style={{ padding: "10px 0", borderTop: "1px solid var(--line-soft)" }}>
            <div style={{ font: "400 14px/1.4 var(--font-body)", marginBottom: stage?.artifact_ref ? 10 : 0 }}>
              {PROMPT[g.kind] ?? `Action: ${g.kind}`}
            </div>
            {stage?.artifact_ref && (
              <div style={{ padding: "10px 12px", background: "var(--wash)", borderRadius: 8, marginBottom: 10 }}>
                <ArtifactMarkdown text={stage.artifact_ref} />
              </div>
            )}
            {/* A sign gate with no artifact to show is worth saying out loud rather than presenting a
                bare button: under D-3 the client is being asked to sign something they cannot read. */}
            {!stage?.artifact_ref && (g.kind === "prd_sign" || g.kind === "scope_signoff") && (
              <p style={{ margin: "0 0 10px", font: "400 13px/1.45 var(--font-body)", color: "var(--ink-subtle)" }}>
                The document for this signature isn&apos;t available yet. Please wait until it appears
                here before signing.
              </p>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              {g.kind === "scope_signoff" ? (
                <form action={portalScopeSign} style={{ display: "flex", gap: 8 }}>
                  <input type="hidden" name="runId" value={runId} />
                  <input type="hidden" name="gateId" value={g.id} />
                  <button type="submit" className="btn btn-primary" style={{ fontSize: 13 }} disabled={!stage?.artifact_ref}>
                    Sign Scope Agreement
                  </button>
                </form>
              ) : g.kind === "prd_sign" ? (
                <form action={portalDecideGate} style={{ display: "flex", gap: 8 }}>
                  <input type="hidden" name="gateId" value={g.id} />
                  <button type="submit" name="decision" value="signed" className="btn btn-primary" style={{ fontSize: 13 }} disabled={!stage?.artifact_ref}>
                    Agree &amp; sign PRD
                  </button>
                </form>
              ) : (
                <form action={portalDecideGate} style={{ display: "flex", gap: 8 }}>
                  <input type="hidden" name="gateId" value={g.id} />
                  <button type="submit" name="decision" value="approved" className="btn btn-primary" style={{ fontSize: 13 }}>Looks good</button>
                  <button type="submit" name="decision" value="changes_requested" className="btn" style={{ fontSize: 13 }}>Request changes</button>
                </form>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}
