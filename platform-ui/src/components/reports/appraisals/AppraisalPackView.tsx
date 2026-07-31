import type { ReactNode } from "react";
import { StatusBadge } from "@/components/ui";
import { CohortBand } from "@/components/reports/charts/CohortBand";
import { APPRAISAL_AXES, AXIS_LABELS, DEVIATION_THRESHOLD, type AppraisalPack } from "@/lib/appraisals";
import "./appraisals.css";

// TR-26 — THE FAIRNESS CORE OF THE WHOLE FEATURE (§11 principle 2 / the ticket's own acceptance
// bar): "the subject sees the IDENTICAL pack the manager submitted — same numbers, same
// commentary, no manager-only annotations leaking and nothing hidden from them either."
//
// This is enforced STRUCTURALLY, not by convention: `AppraisalPackView` takes only `pack` (the
// exact `AppraisalPack` both roles read from the exact same endpoint, `GET /appraisals/:id` or
// `GET /appraisals/mine`) and an optional `footerSlot` for whatever role-specific ACTION belongs
// underneath it (the manager's read-only post-submit view passes nothing; the subject's view passes
// an ack/dispute form; HR's view passes a finalize control). There is no `viewer`/`isManager` prop
// anywhere in this component and no conditional branch keyed on who is looking — every field on
// `pack` renders unconditionally, every time, for everyone who is allowed to open this page at all
// (the actual access boundary is the server's 403, resolved before this component ever mounts — see
// every page in app/(app)/appraisals/*). AppraisalPackView.fairness.test.tsx asserts this by
// rendering the identical `pack` through the manager call site and the subject call site and
// diffing their text content.
export function AppraisalPackView({ pack, footerSlot }: { pack: AppraisalPack; footerSlot?: ReactNode }) {
  return (
    <div className="rc-viz rc-appr-page">
      <header className="rc-appr-head">
        <div>
          <h2 className="rc-appr-head__title">{pack.subjectName}&rsquo;s appraisal</h2>
          <div className="rc-appr-head__meta">
            <span>{pack.cycleName}</span>
            <StatusBadge label={pack.status} />
            {pack.roleKey && <span>Role cohort: {pack.roleKey}</span>}
            <span>Manager: {pack.managerName}</span>
          </div>
        </div>
      </header>

      {/* Ethical requirement 3 — evidence_stale must be prominent, and the UI must explain WHY
          finalize is blocked rather than showing a dead button. Rendered here (not only on an HR
          finalize control) because the subject is equally entitled to know their evidence is
          under question — §11 principle 2 draws no exception for an inconvenient flag. */}
      {pack.evidenceStale && (
        <div className="rc-appr-banner" role="alert">
          <span className="rc-appr-banner__glyph" aria-hidden>!</span>
          <span>
            <strong>Evidence has changed since this appraisal was generated.</strong> One or more of the sealed
            periods this pack was built from has since been amended. A manager or HR must re-confirm the
            evidence before this appraisal can be finalized — it cannot be finalized as-is.
          </span>
        </div>
      )}

      <CompositeSummary pack={pack} />

      <section className="rc-section">
        <h3 className="rc-section__title">Axis scores</h3>
        <div className="rc-appr-axes">
          {APPRAISAL_AXES.map((axis) => {
            const s = pack.scores[axis];
            const deviates = s.auto !== null && s.manager !== null && Math.abs(s.manager - s.auto) > DEVIATION_THRESHOLD;
            return (
              <div className="rc-appr-axis" key={axis}>
                <div className="rc-appr-axis__row">
                  <span className="rc-appr-axis__name">{AXIS_LABELS[axis]}</span>
                  <span className="rc-appr-axis__weight">Weight {Math.round((pack.weights[axis] ?? 0) * 100)}%</span>
                </div>
                <div className="rc-appr-axis__scores">
                  <span>Auto (input): <strong>{s.auto === null ? "n/a — no bandable metric" : `${s.auto} of 5`}</strong></span>
                  <span className="rc-appr-axis__score-value">
                    Manager score: {s.manager === null ? "not yet scored" : `${s.manager} of 5`}
                  </span>
                  {deviates && <span className="rc-appr-axis__deviation">Deviates &gt;{DEVIATION_THRESHOLD} band from auto</span>}
                </div>
                {s.note && <p className="rc-appr-axis__note">{s.note}</p>}
              </div>
            );
          })}
        </div>
      </section>

      {pack.cohortBands.length > 0 && (
        <section className="rc-section">
          <h3 className="rc-section__title">Cohort position (appraisal-safe metrics)</h3>
          <p style={{ margin: 0, font: "400 12px var(--font-body)", color: "var(--rc-text-muted)" }}>
            Each metric is banded 1-5 by percentile within the same role cohort and cycle — never compared
            across roles. A cohort of fewer than 5 people shows the raw value only, never a band or ranking.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {pack.cohortBands.map((b) => (
              <CohortBand key={b.metricKey} data={b} subjectLabel={pack.subjectName} />
            ))}
          </div>
        </section>
      )}

      <section className="rc-section">
        <h3 className="rc-section__title">Manager commentary</h3>
        {pack.commentary ? (
          <p className="rc-appr-commentary">{pack.commentary}</p>
        ) : (
          <p className="rc-appr-commentary rc-appr-commentary--empty">No commentary yet.</p>
        )}
      </section>

      <section className="rc-section">
        <h3 className="rc-section__title">History</h3>
        <div className="rc-appr-acks">
          {pack.acks.length === 0 && (
            <p style={{ margin: 0, font: "400 12px var(--font-body)", color: "var(--rc-text-muted)" }}>
              No acknowledgement or dispute recorded yet.
            </p>
          )}
          {pack.acks.map((a) => (
            <div className="rc-appr-ack" key={a.id}>
              <div className="rc-appr-ack__row">
                <span className={`rc-appr-ack__action rc-appr-ack__action--${a.action}`}>{a.action}</span>
                <span>{a.actorName}</span>
                <span>{new Date(a.createdAt).toLocaleString()}</span>
              </div>
              {a.comment && <p className="rc-appr-ack__comment">{a.comment}</p>}
            </div>
          ))}
          <p style={{ margin: 0, font: "400 11px var(--font-body)", color: "var(--rc-text-muted)" }}>
            This trail is append-only — the database rejects any edit or delete of a past entry. Every action
            here adds a new row rather than changing history.
          </p>
        </div>
      </section>

      {footerSlot}
    </div>
  );
}

function CompositeSummary({ pack }: { pack: AppraisalPack }) {
  return (
    <section className="rc-section">
      <div className="rc-appr-composite">
        <span className="rc-appr-composite__value">{pack.composite === null ? "—" : pack.composite.toFixed(2)}</span>
        <span className="rc-appr-composite__label">Composite score {pack.composite === null ? "(not yet computed)" : "(of 5)"}</span>
      </div>
    </section>
  );
}
