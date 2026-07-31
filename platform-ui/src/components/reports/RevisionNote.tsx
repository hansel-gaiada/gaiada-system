import type { ReportHeader } from "@/lib/reports";
import { BackendPending } from "@/components/BackendPending";
import "./reports.css";

// TR-17's revision affordance. `ReportViewer` (TR-16) already renders the sealed/live/ad-hoc badge
// in the header meta row (`header.sealed ? "Sealed · rev N" : ...`) — this component is the thing
// TR-17 adds ON TOP of that: a place to actually SWITCH revisions once more than one exists, which
// only makes sense for a sealed document (an amended, re-sealed period gets revision+1 — §6.2
// `POST .../periods/:id/amend`). A live/unsealed document has no revision concept at all, so this
// renders nothing for the common case today (every real backend read is unsealed until TR-15 —
// see report-document.ts's own header comment), matching the site's "render nothing when there's
// nothing to show" convention (HrEnvelopeBanner is the precedent cited in the review).
//
// The honest gap: `GET /api/:t/reports/periods` / `GET .../periods/:id` (§6.2, the endpoints that
// would list a scope's period history so a user could pick an OLDER revision) don't exist as
// controller routes yet — TR-14 shipped only the migration, not the CRUD surface. So the picker can
// show the CURRENT revision (from the document it already fetched) but cannot offer anything else
// yet, and says so plainly rather than pretending a single-item dropdown is the whole feature.
export function RevisionNote({ header }: { header: ReportHeader }) {
  if (!header.sealed || header.revision == null) return null;
  return (
    <div className="rc-viz rc-revision">
      <div className="rc-revision__row">
        <label className="rc-revision__label" htmlFor="rc-revision-select">Revision</label>
        <select id="rc-revision-select" className="rc-revision__select" value={header.revision} disabled>
          <option value={header.revision}>Rev {header.revision} (latest)</option>
        </select>
      </div>
      <BackendPending
        what="Only the latest revision can be shown — browsing an earlier revision needs the period-history endpoints, which aren't live yet."
        contract="GET /api/:t/reports/periods · GET /api/:t/reports/periods/:id"
      />
    </div>
  );
}
