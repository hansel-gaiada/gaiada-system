import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listPortalRuns } from "@/lib/portal";
import { Card, Eyebrow, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import "@/components/pipeline/pipeline.css";

// WS11 client portal — the client-facing DASHBOARD (same app and the same `gaiada` Keycloak realm as
// staff, gated by the `client` role). Shows the client's projects with a plain-language "current
// blockage" line; documents and sign-offs live on the run page. Only calls the portal BFF, which
// enforces ownership.
//
// C3/C5: this page used to fetch EVERY run's full detail (`getPortalRun` per run — one HTTP call each,
// four queries behind each) and inline the artifacts and sign forms. It is now a summary over the
// batched `/portal/runs`, which returns the blockage and a pending-action count in two queries total,
// and `/portal/[runId]` is where a client reads and signs. Two wins in one change: the round trips stop
// scaling with the number of projects, and a client can finally open a single project.
export default async function PortalPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <Card><EmptyNote>No workspace selected.</EmptyNote></Card>;

  const { runs, isPortalClient } = await listPortalRuns(userId, tenant);
  // Runs needing the client first: a portal whose top card is settled work buries the one thing that
  // is actually waiting on them.
  const ordered = [...runs].sort((a, b) => (b.pendingActions ?? 0) - (a.pendingActions ?? 0));

  return (
    <>
      <div style={{ marginBottom: 26 }}>
        <Breadcrumbs items={[{ label: "Home", href: "/" }, { label: "Project Portal" }]} />
        <Eyebrow style={{ color: "var(--erp-accent)", marginBottom: 8, display: "block" }}>Your projects</Eyebrow>
        <h1 style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 34, lineHeight: 1.1 }}>Project Portal</h1>
        <p style={{ margin: "9px 0 0", font: "400 15px/1.5 var(--font-body)", color: "var(--ink-muted)", maxWidth: 620 }}>
          Track your projects in real time. When something needs you — a signature or feedback — it shows up here.
        </p>
      </div>

      {runs.length === 0 ? (
        <Card>
          {isPortalClient ? (
            <EmptyNote>No projects yet. Once your kickoff is processed, your project appears here.</EmptyNote>
          ) : (
            // Staff opening the client-facing view. Saying "once your kickoff is processed" here
            // implied a project was on its way to THEM; this is a preview of a surface that only
            // resolves against a client account.
            <EmptyNote>
              This is the client-facing portal. You&apos;re signed in as a staff member, so there is no
              client account to resolve projects against — a client sees their own projects and
              sign-offs here. Track delivery internally under Delivery Pipeline.
            </EmptyNote>
          )}
        </Card>
      ) : (
        <div style={{ display: "grid", gap: 16 }}>
          {ordered.map((r) => (
            <Card
              key={r.id}
              title={r.title ?? "Project"}
              headerRight={<StatusBadge label={r.status.replace(/_/g, " ")} />}
            >
              <div style={{ padding: "12px 14px", borderRadius: 12, background: "color-mix(in srgb, var(--status-warning) 8%, transparent)", border: "1px solid color-mix(in srgb, var(--status-warning) 30%, transparent)", font: "500 14px/1.45 var(--font-body)" }}>
                {r.currentBlockage}
              </div>
              <div style={{ display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", marginTop: 12 }}>
                {/* Stated as a count, not a generic "action needed": a client with two signatures
                    outstanding should not open the project expecting one. */}
                {(r.pendingActions ?? 0) > 0 ? (
                  <span style={{ font: "500 13px var(--font-body)", color: "var(--erp-accent)" }}>
                    {r.pendingActions === 1 ? "1 thing needs you" : `${r.pendingActions} things need you`}
                  </span>
                ) : (
                  <span style={{ font: "400 13px var(--font-body)", color: "var(--ink-subtle)" }}>
                    Nothing needed from you right now
                  </span>
                )}
                <Link
                  href={`/portal/${r.id}`}
                  className={(r.pendingActions ?? 0) > 0 ? "btn btn-primary" : "btn"}
                  style={{ fontSize: 13, textDecoration: "none" }}
                >
                  {(r.pendingActions ?? 0) > 0 ? "Review & sign" : "Open project"}
                </Link>
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
