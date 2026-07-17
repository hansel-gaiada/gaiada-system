import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { listPipelineRuns, listInternalPendingGates, GATE_LABEL } from "@/lib/pipeline";
import { decideGateAction } from "@/lib/pipelineActions";
import { Card, Eyebrow, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { formatDateTime } from "@/lib/format";

// WS11 build item 6 — internal delivery-pipeline dashboard + review inbox. Runs across the three
// tracks + the gates awaiting internal (PM/UI/web-dev) review. Client-facing sign-offs live in the
// client portal. Degrades gracefully (empty states) until runs exist / the backend is deployed.
export default async function PipelinePage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) {
    return <Card><EmptyNote>Select a company to see its delivery pipeline.</EmptyNote></Card>;
  }
  const [runs, gates] = await Promise.all([
    listPipelineRuns(userId, tenant),
    listInternalPendingGates(userId, tenant),
  ]);
  const mayDecide = can(me, "approvals.decide", tenant);
  // Form actions must resolve to void; the typed result is consumed for revalidation only (MVP).
  async function onDecide(formData: FormData) {
    "use server";
    await decideGateAction(formData);
  }

  return (
    <>
      <div style={{ marginBottom: 26 }}>
        <Eyebrow style={{ color: "var(--erp-accent)", marginBottom: 8, display: "block" }}>Delivery</Eyebrow>
        <h1 style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 34, lineHeight: 1.1 }}>Delivery Pipeline</h1>
        <p style={{ margin: "9px 0 0", font: "400 15px/1.5 var(--font-body)", color: "rgba(26,25,22,.62)", maxWidth: 620 }}>
          Every meeting-to-delivery run and its three tracks (delivery · report · scope). Reviews awaiting your
          decision appear below; client sign-offs happen in the client portal.
        </p>
      </div>

      <Card title="Awaiting internal review" headerRight={<span className="dash-pending-chip">{gates.length} PENDING</span>}>
        {gates.length === 0 ? (
          <EmptyNote>No prototypes or builds waiting on your review.</EmptyNote>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {gates.map((g) => (
              <div key={g.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "12px 14px", border: "1px solid rgba(26,25,22,.08)", borderRadius: 12 }}>
                <div>
                  <div style={{ fontFamily: "var(--font-display)", fontSize: 15 }}>{GATE_LABEL[g.kind] ?? g.kind}</div>
                  <div style={{ font: "400 13px/1.4 var(--font-body)", color: "rgba(26,25,22,.55)" }}>
                    Run {g.run_id.slice(0, 8)} · opened {formatDateTime(g.created_at)}
                    {g.note ? ` · ${g.note}` : ""}
                  </div>
                </div>
                {mayDecide ? (
                  <form action={onDecide} style={{ display: "flex", gap: 8 }}>
                    <input type="hidden" name="gateId" value={g.id} />
                    <button type="submit" name="decision" value="approved" className="btn btn-primary" style={{ fontSize: 13 }}>Approve</button>
                    <button type="submit" name="decision" value="changes_requested" className="btn" style={{ fontSize: 13 }}>Request changes</button>
                  </form>
                ) : (
                  <StatusBadge label="review pending" />
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <div style={{ marginTop: 28 }}>
        <Card title="Runs">
          {runs.length === 0 ? (
            <EmptyNote>No pipeline runs yet. They appear here once a meeting is dispatched.</EmptyNote>
          ) : (
            <HairlineTable
              columns={[{ label: "Run" }, { label: "Meeting" }, { label: "Status" }, { label: "Started", align: "right" }]}
              rows={runs.map((r) => [
                r.title ?? "(untitled)",
                r.source_meeting_id ?? "—",
                <StatusBadge key="s" label={r.status.replace(/_/g, " ")} />,
                formatDateTime(r.created_at),
              ])}
              tcols="1.8fr 1.2fr 1fr 1fr"
            />
          )}
        </Card>
      </div>
    </>
  );
}
