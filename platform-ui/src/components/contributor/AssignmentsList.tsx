import Link from "next/link";
import { reviewStateInfo } from "@/lib/webdeskEditorialModel";
import { formatDateTime } from "@/lib/format";
import type { AssignmentRow, AssignmentsView } from "@/lib/contributorModel";
import { ReviewStateChip } from "@/components/webdesk/editorial/ReviewStateChip";
import { AssuranceNotice } from "./AssuranceNotice";

// M5-W1f: "My assignments". Draws a built `AssignmentsView` (lib/contributorModel.ts). Every non-answer is its own words; an empty list appears only
// for a board that answered with no rows.
const note = { margin: 0, font: "400 14px/1.6 var(--font-body)", color: "var(--ink-muted)" } as const;

function Rows({ rows, label }: { rows: AssignmentRow[]; label: string }) {
  return (
    <ul aria-label={label} style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
      {rows.map((r) => (
        <li key={r.itemId} data-testid="assignment-row" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", padding: "10px 14px", border: "1px solid var(--line)", borderRadius: 10, background: "var(--surface-card)" }}>
          <Link href={r.href} style={{ font: "600 14px var(--font-body)", color: "var(--ink)" }}>{r.title}</Link>
          <ReviewStateChip state={r.state} testId="assignment-state" />
          <span className="wc-muted">{r.collectionKey} / {r.locale}{r.dueAt ? ` / due ${formatDateTime(r.dueAt)}` : ""}</span>
          {!reviewStateInfo(r.state).known && <span className="wc-muted">Unknown review state</span>}
        </li>
      ))}
    </ul>
  );
}

export function AssignmentsList({ view }: { view: AssignmentsView }) {
  switch (view.kind) {
    case "assurance": return <AssuranceNotice />;
    case "refused": return <p role="alert" data-testid="assignments-refused" style={note}>{view.message}</p>;
    case "unavailable": return <p role="alert" data-testid="assignments-unavailable" style={note}>{view.message}</p>;
    case "no_sites": return <p data-testid="assignments-no-sites" style={note}>No website is open to you yet. Your invitation may not have been given a site: ask the person who invited you.</p>;
    case "ok":
      return (
        <div style={{ display: "grid", gap: 24 }}>
          {view.sections.map((s) => (
            <section key={`${s.tenantSlug}/${s.siteId}`} aria-label={s.siteName} data-testid="assignments-site" style={{ display: "grid", gap: 10 }}>
              <h2 style={{ margin: 0, font: "600 16px var(--font-display)", color: "var(--ink)" }}>{s.siteName}</h2>
              {s.kind === "none" && <p data-testid="assignments-none" style={note}>Nothing is assigned to you on this site yet.</p>}
              {(s.kind === "refused" || s.kind === "unavailable") && <p role="alert" data-testid={`site-${s.kind}`} style={note}>{s.message}</p>}
              {s.kind === "items" && (
                <>
                  {s.mine.length > 0 && <><h3 style={{ margin: 0, font: "600 13px var(--font-body)", color: "var(--ink-muted)" }}>Assigned to you</h3><Rows rows={s.mine} label="Assigned to you" /></>}
                  {s.others.length > 0 && <><h3 style={{ margin: 0, font: "600 13px var(--font-body)", color: "var(--ink-muted)" }}>Also open to you</h3><Rows rows={s.others} label="Also open to you" /></>}
                  {s.more && <p data-testid="assignments-more" style={note}>More items exist on this site than are listed here.</p>}
                </>
              )}
            </section>
          ))}
        </div>
      );
  }
}
