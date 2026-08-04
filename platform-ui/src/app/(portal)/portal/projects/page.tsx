import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listPortalProjects } from "@/lib/portal-data";
import { isPastDue, portalDate, relativeDays } from "@/lib/portal";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { PortalLive } from "@/components/portal/PortalLive";
import { PortalBar, PortalPageHead, PortalStatus } from "@/components/portal/PortalBits";

// CP-9 — the client's projects.
//
// Active projects first, then closed ones under their own heading rather than mixed in by date. A client
// scanning this list is nearly always asking about live work, and a finished project sorted to the top
// by a recent `due_date` buries it.
export default async function PortalProjectsPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>No workspace selected.</EmptyNote>;

  const projects = await listPortalProjects(userId, tenant);
  const now = new Date();
  const CLOSED = new Set(["done", "complete", "archived", "cancelled"]);
  const active = projects.filter((p) => !CLOSED.has(p.status));
  const closed = projects.filter((p) => CLOSED.has(p.status));

  return (
    <>
      <PortalPageHead
        eyebrow="Your work"
        title="Projects"
        lead="Every project we're running for you, and how far each one has come."
        actions={<PortalLive topics={["projects"]} />}
      />

      {projects.length === 0 ? (
        <EmptyNote>No projects yet. Once your kickoff is processed, your project appears here.</EmptyNote>
      ) : (
        <div className="cp-stack">
          {active.map((p) => (
            <ProjectCard key={p.id} p={p} now={now} />
          ))}
          {closed.length > 0 && (
            <>
              <h2 style={{ margin: "10px 0 0", font: "600 15px/1.3 var(--font-body)", color: "var(--ink-muted)" }}>
                Completed
              </h2>
              {closed.map((p) => (
                <ProjectCard key={p.id} p={p} now={now} />
              ))}
            </>
          )}
        </div>
      )}
    </>
  );
}

function ProjectCard({ p, now }: { p: Awaited<ReturnType<typeof listPortalProjects>>[number]; now: Date }) {
  const overdue = isPastDue(p.dueDate, now) && !["done", "complete"].includes(p.status);
  return (
    <Card
      title={p.name}
      headerRight={<PortalStatus status={p.status} />}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 8 }}>
        <span style={{ font: "600 20px/1 var(--font-display)", color: "var(--ink-strong)" }}>{p.progressPercent}%</span>
        <span style={{ font: "400 12px var(--font-body)", color: "var(--ink-subtle)" }}>
          {p.milestonesDone} of {p.milestoneCount} milestones · {p.deliverableCount}{" "}
          {p.deliverableCount === 1 ? "deliverable" : "deliverables"}
        </span>
      </div>
      <PortalBar percent={p.progressPercent} thin />

      <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginTop: 14, font: "400 13px var(--font-body)", color: "var(--ink-muted)" }}>
        {p.startDate && <span>Started {portalDate(p.startDate)}</span>}
        {p.dueDate && (
          <span style={overdue ? { color: "var(--status-danger-fg)", fontWeight: 500 } : undefined}>
            {/* "Due" vs "Was due": the tense is the fastest way to convey that a date has passed, and it
                works for readers who cannot see the colour change. */}
            {overdue ? "Was due" : "Due"} {portalDate(p.dueDate)} ({relativeDays(p.dueDate, now)})
          </span>
        )}
        {p.nextMilestoneDue && <span>Next milestone {portalDate(p.nextMilestoneDue)}</span>}
      </div>

      <div style={{ marginTop: 16 }}>
        <Link href={`/portal/projects/${p.id}`} className="btn" style={{ fontSize: 13, textDecoration: "none" }}>
          Open project
        </Link>
      </div>
    </Card>
  );
}
