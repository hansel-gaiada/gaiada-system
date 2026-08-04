import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getPortalProject } from "@/lib/portal-data";
import { isPastDue, portalDate, relativeDays } from "@/lib/portal";
import { Card, Eyebrow } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { PortalLive } from "@/components/portal/PortalLive";
import { PortalBar, PortalFacts, PortalLink, PortalPageHead, PortalStatus } from "@/components/portal/PortalBits";

// CP-9 — one project, client-safe.
//
// Ownership is NOT re-checked here: the BFF resolves the caller's own clients and projects and answers
// 404 both for a project that is not theirs and for one that does not exist — deliberately
// indistinguishable, so the page cannot be used to probe for other clients' project ids. `notFound()` is
// therefore the correct and complete handling.
//
// The "work in progress" block shows COUNTS by status and no task titles. That is the BFF's contract
// (it never sends tasks) and it is the right product decision too: a client does not need to read
// "fix the staging cert" to know that 4 things are in flight and 1 is blocked.
export default async function PortalProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>No workspace selected.</EmptyNote>;

  const project = await getPortalProject(userId, tenant, projectId);
  if (!project) notFound();

  const now = new Date();
  const overdue = isPastDue(project.dueDate, now) && !["done", "complete"].includes(project.status);
  const w = project.workload ?? {};
  const inFlight = (w.in_progress ?? 0) + (w.blocked ?? 0);

  return (
    <>
      <PortalPageHead
        eyebrow={project.clientName ?? "Your project"}
        title={project.name}
        actions={<PortalLive topics={["projects", "deliverables", "approvals"]} />}
      />

      <div className="cp-stack">
        <Card title="Where things stand" headerRight={<PortalStatus status={project.status} />}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
            <span style={{ font: "600 30px/1 var(--font-display)", color: "var(--ink-strong)" }}>
              {project.progressPercent}%
            </span>
            <span style={{ font: "400 13px var(--font-body)", color: "var(--ink-muted)" }}>complete</span>
          </div>
          <PortalBar percent={project.progressPercent} />
          <div style={{ marginTop: 16 }}>
            <PortalFacts
              rows={[
                ...(project.startDate ? [{ k: "Started", v: portalDate(project.startDate) }] : []),
                ...(project.dueDate
                  ? [{
                      k: overdue ? "Was due" : "Target",
                      v: `${portalDate(project.dueDate)} (${relativeDays(project.dueDate, now)})`,
                      strong: overdue,
                    }]
                  : []),
                {
                  k: "In progress",
                  v: inFlight === 0
                    ? "Nothing active right now"
                    : `${inFlight} ${inFlight === 1 ? "item" : "items"}${w.blocked ? ` · ${w.blocked} on hold` : ""}`,
                },
                { k: "Completed", v: `${w.done ?? 0} items` },
              ]}
            />
          </div>
        </Card>

        {/* Anything waiting on the client, hoisted above the read-only detail. */}
        {project.runs.some((r) => r.pendingActions > 0) && (
          <div className="cp-callout">
            <div style={{ font: "600 14px/1.4 var(--font-body)", color: "var(--ink-strong)", marginBottom: 8 }}>
              This project is waiting on you
            </div>
            <div className="cp-needs">
              {project.runs.filter((r) => r.pendingActions > 0).map((r) => (
                <div className="cp-need" key={r.id}>
                  <div style={{ minWidth: 0 }}>
                    <div className="cp-need__label">{r.title ?? "Delivery"}</div>
                    <div className="cp-need__context">
                      {r.pendingActions === 1 ? "1 thing needs you" : `${r.pendingActions} things need you`}
                    </div>
                  </div>
                  <span className="cp-need__spacer" />
                  <Link href={`/portal/approvals/${r.id}`} className="btn btn-primary" style={{ fontSize: 13, textDecoration: "none" }}>
                    Review &amp; sign
                  </Link>
                </div>
              ))}
            </div>
          </div>
        )}

        <Card title="Milestones" hint="The dated commitments for this project. Each one groups the work needed to reach it.">
          {project.milestones.length === 0 ? (
            <EmptyNote>No milestones set yet.</EmptyNote>
          ) : (
            <div style={{ display: "grid", gap: 14 }}>
              {project.milestones.map((m) => {
                const items = m.itemCount ?? 0;
                const done = m.itemsDone ?? 0;
                const pct = items > 0 ? Math.round((done / items) * 100) : m.status === "done" ? 100 : 0;
                const late = m.status !== "done" && isPastDue(m.dueDate, now);
                return (
                  <div key={m.id}>
                    <div style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap", marginBottom: 5 }}>
                      <span style={{ font: "500 14px/1.35 var(--font-body)", color: "var(--ink-strong)" }}>{m.name}</span>
                      <PortalStatus status={m.status} />
                      <span className="cp-need__spacer" />
                      <span style={{
                        font: "400 12px var(--font-body)",
                        color: late ? "var(--status-danger-fg)" : "var(--ink-subtle)",
                        fontWeight: late ? 500 : 400,
                      }}>
                        {m.dueDate ? `${late ? "Was due" : "Due"} ${portalDate(m.dueDate)}` : "No date set"}
                      </span>
                    </div>
                    <PortalBar percent={pct} thin />
                    {items > 0 && (
                      <div style={{ font: "400 11px/1.6 var(--font-body)", color: "var(--ink-subtle)", marginTop: 3 }}>
                        {done} of {items} items complete
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        <Card title="Deliverables" headerRight={<PortalLink href="/portal/deliverables">All deliverables</PortalLink>}>
          {project.deliverables.length === 0 ? (
            <EmptyNote>No deliverables on this project yet.</EmptyNote>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              {project.deliverables.map((d) => {
                const late = isPastDue(d.dueDate, now) && !["delivered", "approved", "done"].includes(d.status);
                return (
                  <div key={d.id} style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
                    <span style={{ font: "400 14px/1.4 var(--font-body)", color: "var(--ink-body)" }}>{d.name}</span>
                    <PortalStatus status={d.status} />
                    <span className="cp-need__spacer" />
                    {(d.fileCount ?? 0) > 0 && (
                      <span style={{ font: "400 12px var(--font-body)", color: "var(--ink-subtle)" }}>
                        {d.fileCount} {d.fileCount === 1 ? "file" : "files"}
                      </span>
                    )}
                    <span style={{
                      font: "400 12px var(--font-body)",
                      color: late ? "var(--status-danger-fg)" : "var(--ink-subtle)",
                    }}>
                      {d.dueDate ? portalDate(d.dueDate) : ""}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        {project.runs.length > 0 && (
          <Card title="Delivery history" hint="Each delivery run is one pass through our production process for this project.">
            <div style={{ display: "grid", gap: 8 }}>
              {project.runs.map((r) => (
                <div key={r.id} style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
                  <Link href={`/portal/approvals/${r.id}`} style={{ font: "500 13px var(--font-body)", color: "var(--ink-strong)", textDecoration: "none" }}>
                    {r.title ?? "Delivery"}
                  </Link>
                  <PortalStatus status={r.status} />
                </div>
              ))}
            </div>
          </Card>
        )}

        <div>
          <Eyebrow style={{ display: "block", marginBottom: 6, opacity: 0.6 }}>Back</Eyebrow>
          <PortalLink href="/portal/projects">All your projects</PortalLink>
        </div>
      </div>
    </>
  );
}
