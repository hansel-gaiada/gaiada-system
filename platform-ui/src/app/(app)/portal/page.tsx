import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listPortalRuns, getPortalRun } from "@/lib/portal";
import { portalDecideGate, portalScopeSign } from "@/lib/portalActions";
import { Card, Eyebrow, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";

// WS11 client portal — a distinct client-facing DASHBOARD (same app, client-role-gated, its own login
// realm in prod). Shows the client's projects, a plain-language "current blockage" banner, and their
// own sign-offs (PRD, Scope Agreement) + feedback. Only calls the portal BFF, which enforces ownership.
export default async function PortalPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <Card><EmptyNote>No workspace selected.</EmptyNote></Card>;

  const runs = await listPortalRuns(userId, tenant);
  // Pull detail for each run so we can render its client-side gates inline (small N for a client).
  const details = await Promise.all(runs.map((r) => getPortalRun(userId, tenant, r.id)));

  return (
    <>
      <div style={{ marginBottom: 26 }}>
        <Eyebrow style={{ color: "var(--erp-accent)", marginBottom: 8, display: "block" }}>Your projects</Eyebrow>
        <h1 style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 34, lineHeight: 1.1 }}>Project Portal</h1>
        <p style={{ margin: "9px 0 0", font: "400 15px/1.5 var(--font-body)", color: "rgba(26,25,22,.62)", maxWidth: 620 }}>
          Track your projects in real time. When something needs you — a signature or feedback — it shows up here.
        </p>
      </div>

      {runs.length === 0 ? (
        <Card><EmptyNote>No projects yet. Once your kickoff is processed, your project appears here.</EmptyNote></Card>
      ) : (
        <div style={{ display: "grid", gap: 20 }}>
          {details.filter(Boolean).map((run) => {
            const r = run!;
            const pendingClientGates = r.gates.filter((g) => g.status === "pending");
            return (
              <Card key={r.id} title={r.title ?? "Project"} headerRight={<StatusBadge label={r.status.replace(/_/g, " ")} />}>
                {/* Plain-language blockage banner — the transparency piece. */}
                <div style={{ padding: "12px 14px", borderRadius: 12, background: "rgba(184,142,47,.08)", border: "1px solid rgba(184,142,47,.25)", marginBottom: 14, font: "500 14px/1.45 var(--font-body)" }}>
                  {r.currentBlockage}
                </div>

                {/* Client actions on pending gates */}
                {pendingClientGates.map((g) => (
                  <div key={g.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "10px 0", borderTop: "1px solid rgba(26,25,22,.06)" }}>
                    <div style={{ font: "400 14px/1.4 var(--font-body)" }}>
                      {g.kind === "prd_sign" && "Please review and sign the PRD to start work."}
                      {g.kind === "scope_signoff" && "Please sign the Scope Agreement."}
                      {g.kind === "customer_feedback" && "Your feedback is requested on the latest work."}
                      {!["prd_sign", "scope_signoff", "customer_feedback"].includes(g.kind) && `Action: ${g.kind}`}
                    </div>
                    {g.kind === "scope_signoff" ? (
                      <form action={portalScopeSign} style={{ display: "flex", gap: 8 }}>
                        <input type="hidden" name="runId" value={r.id} />
                        <input type="hidden" name="gateId" value={g.id} />
                        <button type="submit" className="btn btn-primary" style={{ fontSize: 13 }}>Sign Scope Agreement</button>
                      </form>
                    ) : g.kind === "prd_sign" ? (
                      <form action={portalDecideGate} style={{ display: "flex", gap: 8 }}>
                        <input type="hidden" name="gateId" value={g.id} />
                        <button type="submit" name="decision" value="signed" className="btn btn-primary" style={{ fontSize: 13 }}>Agree & sign PRD</button>
                      </form>
                    ) : (
                      <form action={portalDecideGate} style={{ display: "flex", gap: 8 }}>
                        <input type="hidden" name="gateId" value={g.id} />
                        <button type="submit" name="decision" value="approved" className="btn btn-primary" style={{ fontSize: 13 }}>Looks good</button>
                        <button type="submit" name="decision" value="changes_requested" className="btn" style={{ fontSize: 13 }}>Request changes</button>
                      </form>
                    )}
                  </div>
                ))}

                {/* Progress: client-safe stages (report track already hidden by the BFF) */}
                <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {r.stages.map((s, i) => (
                    <span key={i} style={{ font: "500 12px/1 var(--font-body)", padding: "6px 10px", borderRadius: 999, background: s.status === "done" ? "rgba(60,140,90,.12)" : "rgba(26,25,22,.06)" }}>
                      {s.name.replace(/_/g, " ")} · {s.status}
                    </span>
                  ))}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
