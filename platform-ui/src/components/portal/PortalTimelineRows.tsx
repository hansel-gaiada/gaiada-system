import Link from "next/link";
import {
  clientStatus, portalDate, projectRange, projectUrgencyTier, relativeDays, statusTone,
  type PortalProject, type PortalTimelineEvent,
} from "@/lib/portal";
import { UrgencyChip } from "@/components/pm/UrgencyChip";

// The two row lists on /portal/timeline. Both draw on the `.cp-tl__row` grid in portal.css, which has
// THREE columns (when · rail · body), so every row renders all three cells, even when the "when" is
// empty. A row that skips one shifts every later cell left: the body lands in the 14px rail column
// and the project name wraps one word per line (the bug the 1.0.0-alpha.346 live drive found).
// PortalTimelineRows.test.tsx pins the three cells for both lists.

const KIND_WORD: Record<PortalTimelineEvent["kind"], string> = {
  milestone: "Milestone",
  deliverable: "Deliverable",
  decision: "Your decision",
  contract: "Contract",
  invoice: "Invoice",
  payment: "Payment",
};

/** The date column: a date plus how far away it is. `--ink-subtle`, not `--ink-faint`: the
 *  relative-days line is real, readable meta a client relies on, not decoration (accessibility
 *  contract, design-language §14). */
function When({ at, now }: { at: string | null; now: Date }) {
  return (
    <div className="cp-tl__when">
      {portalDate(at)}
      <div style={{ font: "400 11px/1.5 var(--font-body)", color: "var(--ink-subtle)" }}>
        {relativeDays(at, now)}
      </div>
    </div>
  );
}

// P4-K2 — the client-safe range + urgency strip. Deliberately just three fields per project: the
// authored range (`projectRange`, workstream H's `startDate`/`dueDate`, never the task-derived
// envelope), the progress percentage the portal already showed pre-Phase-4, and the urgency tier
// (`projectUrgencyTier`, the ONE shared definition — never a bespoke date comparison here). No
// milestone titles, no ball holder, no internal status word: those stay off this component by
// construction because `PortalProject` never carries them (see `lib/portal.ts`'s BFF contract).
// The "when" column carries the project's due date, the same date the urgency dot speaks for.
export function PortalProjectRanges({ projects, now }: { projects: PortalProject[]; now: Date }) {
  const today = now.toISOString().slice(0, 10);
  return (
    <div className="cp-tl">
      {projects.map((p) => (
        <div className="cp-tl__row" key={p.id}>
          <When at={p.dueDate} now={now} />
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

export function PortalTimelineStream({ events, now }: { events: PortalTimelineEvent[]; now: Date }) {
  return (
    <div className="cp-tl">
      {events.map((e) => (
        <div className="cp-tl__row" key={`${e.kind}-${e.id}`}>
          <When at={e.at} now={now} />
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
