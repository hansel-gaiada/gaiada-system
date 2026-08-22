import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getPortalTimeline, listPortalProjects } from "@/lib/portal-data";
import {
  clientStatus, portalDate, projectRange, projectUrgencyTier, relativeDays, splitTimeline, statusTone,
  type PortalProject, type PortalTimelineEvent,
} from "@/lib/portal";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { UrgencyChip } from "@/components/pm/UrgencyChip";
import { PortalLive } from "@/components/portal/PortalLive";
import { PortalPageHead } from "@/components/portal/PortalBits";

// CP-10 — the whole relationship in one chronological stream.
//
// Two sections, not one list: WHAT'S COMING (dated commitments still ahead) and WHAT'S HAPPENED. The
// split is computed in `splitTimeline`, which puts an overdue `due` item into HISTORY rather than
// leaving it under "coming up" — an overdue milestone listed as upcoming reads as though it were still
// on schedule, which is the one thing a timeline must never imply.
//
// Events are composed by the BFF from client-visible OBJECTS (milestones, deliverables, the client's own
// decisions, contracts, invoices, confirmed payments) and never from the internal activity log. So
// nothing here can start leaking because someone added a new internal event type.
const KIND_WORD: Record<PortalTimelineEvent["kind"], string> = {
  milestone: "Milestone",
  deliverable: "Deliverable",
  decision: "Your decision",
  contract: "Agreement",
  invoice: "Invoice",
  payment: "Payment",
};

export default async function PortalTimelinePage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>No workspace selected.</EmptyNote>;

  // P4-K2: the project range + urgency tier crossing into the portal, per the K1 client-safe
  // projection (project authored range · progress % · milestone state · urgency tier — never ball
  // history, internal status labels, staff names or task titles). `listPortalProjects` already
  // returns `startDate`/`dueDate`/`progressPercent`; nothing new to fetch, only to render.
  const [events, projects] = await Promise.all([
    getPortalTimeline(userId, tenant),
    listPortalProjects(userId, tenant),
  ]);
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const { upcoming, history } = splitTimeline(events, now);

  return (
    <>
      <PortalPageHead
        eyebrow="Your account"
        title="Timeline"
        lead="Everything scheduled and everything that has happened, in one place."
        actions={<PortalLive topics={["projects", "deliverables", "invoices", "contracts", "approvals"]} />}
      />

      {projects.length > 0 && (
        <Card title="Your projects">
          <ProjectRanges projects={projects} today={today} />
        </Card>
      )}

      {events.length === 0 ? (
        <EmptyNote>Nothing on your timeline yet.</EmptyNote>
      ) : (
        <div className="cp-stack">
          <Card title="Coming up">
            {upcoming.length === 0 ? (
              <EmptyNote>Nothing dated ahead. We&apos;ll add dates here as they&apos;re agreed.</EmptyNote>
            ) : (
              <Stream events={upcoming} now={now} />
            )}
          </Card>
          <Card title="What&apos;s happened">
            {history.length === 0 ? <EmptyNote>Nothing yet.</EmptyNote> : <Stream events={history} now={now} />}
          </Card>
        </div>
      )}
    </>
  );
}

// P4-K2 — the client-safe range + urgency strip. Deliberately just three fields per project: the
// authored range (`projectRange`, workstream H's `startDate`/`dueDate`, never the task-derived
// envelope), the progress percentage the portal already showed pre-Phase-4, and the urgency tier
// (`projectUrgencyTier`, the ONE shared definition — never a bespoke date comparison here). No
// milestone titles, no ball holder, no internal status word: those stay off this component by
// construction because `PortalProject` never carries them (see `lib/portal.ts`'s BFF contract).
function ProjectRanges({ projects, today }: { projects: PortalProject[]; today: string }) {
  return (
    <div className="cp-tl">
      {projects.map((p) => (
        <div className="cp-tl__row" key={p.id}>
          <div className="cp-tl__rail">
            <UrgencyChip tier={projectUrgencyTier(p, today)} variant="dot" detail={portalDate(p.dueDate)} />
          </div>
          <div className="cp-tl__body">
            <div className="cp-tl__label">
              <Link href={`/portal/projects/${p.id}`} style={{ color: "inherit", textDecoration: "none" }}>
                {p.name}
              </Link>
            </div>
            <div className="cp-tl__meta">
              {projectRange(p)} · {p.progressPercent}% complete
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function Stream({ events, now }: { events: PortalTimelineEvent[]; now: Date }) {
  return (
    <div className="cp-tl">
      {events.map((e) => (
        <div className="cp-tl__row" key={`${e.kind}-${e.id}`}>
          <div className="cp-tl__when">
            {portalDate(e.at)}
            {/* `--ink-subtle`, not `--ink-faint` — the relative-days line is real, readable meta
                a client relies on, not decoration (accessibility contract, design-language §14). */}
            <div style={{ font: "400 11px/1.5 var(--font-body)", color: "var(--ink-subtle)" }}>
              {relativeDays(e.at, now)}
            </div>
          </div>
          <div className="cp-tl__rail">
            {/* The dot's colour carries the item's state; the text beside it repeats that state in
                words, so the colour is decoration and never the only signal. */}
            <span className="cp-tl__dot" style={{ background: `var(--status-${statusTone(e.status)})` }} />
          </div>
          <div className="cp-tl__body">
            <div className="cp-tl__label">
              {e.projectId && (e.kind === "milestone" || e.kind === "deliverable") ? (
                <Link href={`/portal/projects/${e.projectId}`} style={{ color: "inherit", textDecoration: "none" }}>
                  {e.label}
                </Link>
              ) : e.kind === "contract" ? (
                <Link href={`/portal/contracts/${e.id}`} style={{ color: "inherit", textDecoration: "none" }}>
                  {e.label}
                </Link>
              ) : e.kind === "invoice" ? (
                <Link href={`/portal/invoices/${e.id}`} style={{ color: "inherit", textDecoration: "none" }}>
                  {e.label}
                </Link>
              ) : (
                e.label
              )}
            </div>
            <div className="cp-tl__meta">
              {KIND_WORD[e.kind]}
              {e.status && ` · ${clientStatus(e.status)}`}
              {e.context && ` · ${e.context}`}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
