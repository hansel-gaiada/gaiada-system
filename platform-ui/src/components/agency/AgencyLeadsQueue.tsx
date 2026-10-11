"use client";
import { useActionState, useState } from "react";
import Link from "next/link";
import { Card, HairlineTable, StatusBadge, Button } from "@/components/ui";
import { Field } from "@/components/forms/Field";
import { formatDateTime } from "@/lib/format";
import {
  STATUS_LABEL, filterQueue, formatAge, formatDeal, needsInvite, stageCounts, stageLabel,
  type LeadQueueRow, type PipelineCurrency, type PipelineStage,
} from "@/lib/agencyLeads";
import type { CreateLeadResult } from "@/app/(app)/agency/leads/actions";
import "./agencyLeads.css";

const COLUMNS = [
  { label: "Organisation" },
  { label: "Contact" },
  { label: "Status" },
  { label: "Stage" },
  { label: "Value" },
  { label: "Owner" },
  { label: "Age" },
  { label: "Submission" },
  { label: "" },
];
const TCOLS = "2fr 1.6fr 1fr 1fr 1.2fr 1fr 0.8fr 1fr 1.2fr";

/** AD-11 — the discovery-intake queue (design §9.2). `new` rows get a distinct, actionable "Needs an
 *  invite →" link into the lead's detail page rather than only a status chip (this ticket's explicit
 *  instruction: "make that actionable, not just a chip") — `new` means we created the lead and never
 *  sent the form, the easiest thing in an agency pipeline to drop. */
export function AgencyLeadsQueue({
  rows,
  stages = null,
  currencies = null,
  canCreate,
  createAction,
}: {
  rows: LeadQueueRow[];
  /** M5-P1 reference data. Null when the reference read was refused: the queue still renders, with chips
   *  built from the stage keys present in the rows. */
  stages?: PipelineStage[] | null;
  currencies?: PipelineCurrency[] | null;
  canCreate: boolean;
  createAction: (prev: CreateLeadResult | null, formData: FormData) => Promise<CreateLeadResult>;
}) {
  const [showForm, setShowForm] = useState(false);
  const [state, formAction, pending] = useActionState(createAction, null);
  // M5-P1: these two only FILTER. `filterQueue` returns a subsequence in the order received, so the
  // BFF's whose-move-it-is order (contract rule 1) is never disturbed.
  const [stageFilter, setStageFilter] = useState<string | null>(null);
  const [hideClosed, setHideClosed] = useState(false);
  const counts = stageCounts(rows);
  const chipStages: { key: string; label: string }[] = stages
    ? stages.map((s) => ({ key: s.key, label: s.label }))
    : Object.keys(counts).map((k) => ({ key: k, label: stageLabel(null, k) }));
  const shown = filterQueue(rows, { stage: stageFilter, hideClosed }, stages);

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {canCreate && (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          {!showForm && (
            <Button size="md" onClick={() => setShowForm(true)}>
              Log a lead
            </Button>
          )}
        </div>
      )}

      {showForm && (
        <Card title="Log a lead" headerRight={<Button variant="ghost" onClick={() => setShowForm(false)}>Close</Button>}>
          <form action={formAction} className="lux-form-grid">
            <Field name="orgName" label="Organisation" required />
            <Field name="contactName" label="Contact name" />
            <Field name="contactEmail" label="Contact email" type="text" />
            <Field name="contactPhone" label="Contact phone / WhatsApp" />
            {state?.error && (
              <p style={{ margin: 0, gridColumn: "1 / -1", font: "400 13px var(--font-body)", color: "var(--status-critical-fg)" }}>
                {state.error}
              </p>
            )}
            <div style={{ gridColumn: "1 / -1" }}>
              <Button type="submit" size="md" disabled={pending}>
                {pending ? "Creating…" : "Create lead"}
              </Button>
            </div>
          </form>
          <p className="adl-hint">
            Source is recorded as &ldquo;staff&rdquo; — for someone who phoned or emailed in rather than answering
            an invite. It lands in the queue as <strong>new</strong>, which means the next step is sending them
            the discovery form.
          </p>
        </Card>
      )}

      <Card title={shown.length === rows.length ? `Queue (${rows.length})` : `Queue (${shown.length} of ${rows.length})`}>
        {rows.length > 0 && (
          <div className="adl-filters" role="group" aria-label="Filter by pipeline stage">
            <button
              type="button"
              className="adl-chip"
              aria-pressed={stageFilter === null}
              onClick={() => setStageFilter(null)}
            >
              All <span className="adl-chip__n">{rows.length}</span>
            </button>
            {chipStages.map((c) => (
              <button
                key={c.key}
                type="button"
                className="adl-chip"
                aria-pressed={stageFilter === c.key}
                onClick={() => setStageFilter(stageFilter === c.key ? null : c.key)}
              >
                {c.label} <span className="adl-chip__n">{counts[c.key] ?? 0}</span>
              </button>
            ))}
            <label className="adl-filters__toggle">
              <input type="checkbox" checked={hideClosed} onChange={(e) => setHideClosed(e.target.checked)} />
              Hide closed (won and lost)
            </label>
          </div>
        )}
        {rows.length === 0 ? (
          <div className="dash-empty">
            <div style={{ fontFamily: "var(--font-display)", fontSize: 18 }}>No leads in the queue</div>
            <p>Log one above, or wait for the first invite link to be answered.</p>
          </div>
        ) : shown.length === 0 ? (
          <div className="dash-empty">
            <div style={{ fontFamily: "var(--font-display)", fontSize: 18 }}>No leads match this filter</div>
            <p>{rows.length} lead{rows.length === 1 ? " is" : "s are"} in the queue. Clear the filter to see them.</p>
          </div>
        ) : (
          <HairlineTable
            tcols={TCOLS}
            columns={COLUMNS}
            rows={shown.map((r) => [
              <Link key={r.id} href={`/agency/leads/${r.id}`}>{r.orgName}</Link>,
              <span key={`${r.id}-contact`}>
                {r.contactName ?? "—"}
                {r.contactEmail ? <span className="adl-subtle"> · {r.contactEmail}</span> : null}
              </span>,
              <StatusBadge key={`${r.id}-status`} label={STATUS_LABEL[r.status] ?? r.status} />,
              <span key={`${r.id}-stage`} title={`In this stage since ${formatDateTime(r.stageEnteredAt)}`}>{stageLabel(stages, r.stage)}</span>,
              <span key={`${r.id}-value`} className={r.dealValue ? undefined : "adl-subtle"}>{formatDeal(r.dealValue, r.dealCurrency, currencies)}</span>,
              r.ownerName ?? <span className="adl-subtle" key={`${r.id}-owner`}>Unassigned</span>,
              <span key={`${r.id}-age`} title={formatDateTime(r.createdAt)}>{formatAge(r.ageSeconds)}</span>,
              r.hasSubmission ? "Yes" : "No",
              needsInvite(r.status) ? (
                <Link key={`${r.id}-cta`} href={`/agency/leads/${r.id}#invite`} className="lux-btn lux-btn--solid lux-btn--sm">
                  Needs an invite →
                </Link>
              ) : (
                <Link key={`${r.id}-cta`} href={`/agency/leads/${r.id}`} className="lux-btn lux-btn--ghost lux-btn--sm">
                  Open →
                </Link>
              ),
            ])}
          />
        )}
      </Card>
    </div>
  );
}
