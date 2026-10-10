import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActivePortalCompany } from "@/lib/portal-company";
import { listPortalProjects } from "@/lib/portal-data";
import { splitProjects } from "@/lib/portalPeople";
import { isPastDue, portalDate, relativeDays } from "@/lib/portal";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { PortalLive } from "@/components/portal/PortalLive";
import { PortalBar, PortalPageHead, PortalStatus } from "@/components/portal/PortalBits";

// CP-9 — the client's projects.
//
// Active projects first, then finished ones under Past rather than mixed in by date. A client
// scanning this list is nearly always asking about live work, and a finished project sorted to the top
// by a recent `due_date` buries it.
export default async function PortalProjectsPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = (await getActivePortalCompany(me))?.id ?? null;
  if (!tenant) return <EmptyNote>No client account is linked to your sign-in, so there is nothing to show here. Overview explains why.</EmptyNote>;

  const projects = await listPortalProjects(userId, tenant);
  const now = new Date();
  // PV2-07: the server decides what is finished (`finished`), never the UI from `status`.
  const { active, past } = splitProjects(projects);

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
          <h2 style={{ margin: 0, font: "600 15px/1.3 var(--font-body)", color: "var(--ink-strong)" }}>Active</h2>
          {active.length === 0 ? (
            <EmptyNote>
              Nothing is running right now.{" "}
              {past.length > 0 ? "Your finished projects are listed under Past below. " : ""}
              To start something new, send us a request.
            </EmptyNote>
          ) : (
            active.map((p) => <ProjectCard key={p.id} p={p} now={now} />)
          )}

          {/* Past is history: collapsed when there is live work to look at, open when it is all there is. */}
          <details open={active.length === 0 && past.length > 0}>
            <summary style={{ cursor: "pointer", font: "600 15px/1.3 var(--font-body)", color: "var(--ink-muted)" }}>
              Past ({past.length})
            </summary>
            <div className="cp-stack" style={{ marginTop: 12 }}>
              {past.length === 0 ? (
                <EmptyNote>No finished projects yet. When a project wraps up, it moves here so you can still look back at it.</EmptyNote>
              ) : (
                past.map((p) => <ProjectCard key={p.id} p={p} now={now} />)
              )}
            </div>
          </details>
        </div>
      )}
    </>
  );
}

function ProjectCard({ p, now }: { p: Awaited<ReturnType<typeof listPortalProjects>>[number]; now: Date }) {
  const overdue = isPastDue(p.dueDate, now) && p.finished !== true;
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
