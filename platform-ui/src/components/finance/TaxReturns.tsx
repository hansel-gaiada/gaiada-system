"use client";
import { useState, useTransition } from "react";
import { Card, Button, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { SecondFactorPrompt } from "@/components/auth/SecondFactorPrompt";
import { prepareTaxReturn, fileTaxReturn } from "@/lib/financeTaxActions";
import { isAssuranceRefusal } from "@/lib/stepUp";
import {
  TAX_RETURN_KINDS, TAX_RETURN_KIND_LABEL, driftFor, figureLabels, formatTaxAmount, isAnnualKind, returnLabel,
  type TaxReturn, type TaxReturnDrift,
} from "@/lib/taxReturns";
import type { ReadResult } from "@/lib/readResult";

// DW-7g-1 — Finance > Tax > Returns: prepare a period's return, review it, record the filing, amend a filed one.
//
// ── TAX IS MONEY: ONLY WHAT THE SERVER RETURNED, AND RE-READ AFTER EVERY WRITE ──────────────────────────────────
// A DRAFT STORES NO FIGURES (`202608271230`): they are recomputed from the ledger each time they are asked for, and are
// frozen into the row only at filing. So a draft row shows "—" until someone asks ("Show figures", which is Prepare again:
// it is idempotent and answers with the live figure). That figure is labelled as computed now and not stored. A filed or
// amended row shows the figures AS FILED. Nothing here adds, nets or rounds a figure: each is the server's, formatted.
//
// ── READS ARE HONEST ─────────────────────────────────────────────────────────────────────────────────────────────
// The list and the drift each arrive as a `ReadResult`. A refused or failed list is said in words and never the empty
// note; a failed drift read says it could not check, and is never "no drift". Only a 200 with `clean: true` may say that.
//
// ── THE CONTROLS ARE COSMETIC ─────────────────────────────────────────────────────────────────────────────────
// `canAct` is a superset of the server's rule (see `canWorkTaxReturns`). Cerbos `finance_tax` decides, and a refusal comes
// back in words. Filing is confirmed by typing the period, because the server compares it too.
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function RowButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: string }) {
  return (
    <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" aria-label={label} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

/** The consequence, the filing reference and the typed period. Armed only on a reference and an exact period. */
function FilingForm({
  ret, amend, onDone, onFailed, onCancel,
}: {
  ret: TaxReturn;
  amend: boolean;
  onDone: (message: string) => void;
  onFailed: (error: string, reason?: string) => void;
  onCancel: () => void;
}) {
  const [pending, start] = useTransition();
  const [reference, setReference] = useState("");
  const [typed, setTyped] = useState("");
  const label = returnLabel(ret);
  const armed = reference.trim().length > 0 && typed === label;
  const f = figureLabels(ret.kind);

  return (
    <Card title={amend ? `Amend ${label}` : `Record filing for ${label}`} style={{ marginTop: 22 }}>
      <form
        className="fin-form"
        action={() => {
          start(async () => {
            const r = await fileTaxReturn(ret.id, { filingReference: reference, confirm: typed, amend });
            if (!r.ok || !r.result) return onFailed(r.error ?? "Could not record this filing.", r.reason);
            const g = r.result.filed;
            onDone(
              `${amend ? "Amendment recorded" : "Filing recorded"} for ${r.result.period}, reference ${r.result.filingReference}. ` +
              `Figures of record: ${f.output} ${formatTaxAmount(g.output)}, ${f.input} ${formatTaxAmount(g.input)}, ${f.net} ${formatTaxAmount(g.net)}.`,
            );
          });
        }}
      >
        <p className="fin-muted fin-form__field--wide">
          {amend
            ? "This records an amendment to a return that is already filed: it replaces the figures of record with what the ledger computes now and keeps the new reference. It is a separate statement to the tax office, and the earlier figures are not kept on the return."
            : "This marks the return as filed with the tax office; it cannot be undone except by an amendment. The figures are frozen as the ledger computes them now."}
          {" "}Nothing is sent from here: transmission goes through a licensed ASP/PJAP, and the reference is the receipt it gave you.
        </p>
        <label className="fin-form__field">
          <span>Filing reference (NTPN or receipt)</span>
          <input value={reference} onChange={(e) => setReference(e.target.value)} autoComplete="off" maxLength={200} />
        </label>
        <div className="fin-form__field">
          <label htmlFor={`file-confirm-${ret.id}`}>Type the period to confirm</label>
          <input
            id={`file-confirm-${ret.id}`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={label}
            autoComplete="off"
          />
          <span>Exactly <strong>{label}</strong>, including capitalisation.</span>
        </div>
        <div className="fin-form__actions">
          <Button type="submit" disabled={!armed || pending}>{pending ? "Working…" : amend ? "Record amendment" : "Record filing"}</Button>
          <Button variant="ghost" onClick={onCancel} disabled={pending}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}

export function TaxReturns({
  returns, drift, canAct, defaultPeriod,
}: {
  returns: ReadResult<TaxReturn[]>;
  drift: ReadResult<TaxReturnDrift>;
  /** Show Prepare, Show figures, Record filing and Amend. Cosmetic: the server refuses in words. */
  canAct: boolean;
  /** The last closed month, as the page worked it out. */
  defaultPeriod: { year: number; month: number };
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [needsFactor, setNeedsFactor] = useState(false);
  const [filing, setFiling] = useState<{ id: string; amend: boolean } | null>(null);
  // Live figures a person asked for on a draft: the server's answer at that moment, never stored, never carried to another row.
  const [previews, setPreviews] = useState<Record<string, { output: number; input: number; net: number }>>({});
  const [form, setForm] = useState({ kind: "ppn", year: String(defaultPeriod.year), month: String(defaultPeriod.month) });

  const annual = isAnnualKind(form.kind);
  const clear = () => { setError(null); setNotice(null); setNeedsFactor(false); };
  const fail = (message: string, reason?: string) => { setError(message); setNeedsFactor(isAssuranceRefusal(reason)); };

  function prepare() {
    clear();
    start(async () => {
      const r = await prepareTaxReturn(form.kind, Number(form.year), annual ? null : Number(form.month));
      if (!r.ok || !r.result) return fail(r.error ?? "Could not prepare this return.", r.reason);
      const p = r.result;
      const f = figureLabels(p.kind);
      setPreviews((m) => ({ ...m, [p.id]: p.computed }));
      setNotice(
        `Prepared ${returnLabel(p)} as a ${p.status ?? "draft"}. The ledger computes now: ${f.output} ${formatTaxAmount(p.computed.output)}, ` +
        `${f.input} ${formatTaxAmount(p.computed.input)}, ${f.net} ${formatTaxAmount(p.computed.net)}. Nothing is stored until it is filed.`,
      );
    });
  }

  function showFigures(r: TaxReturn) {
    clear();
    start(async () => {
      const res = await prepareTaxReturn(r.kind, r.periodYear, r.periodMonth);
      if (!res.ok || !res.result) return fail(res.error ?? "Could not compute the figures.", res.reason);
      setPreviews((m) => ({ ...m, [r.id]: res.result!.computed }));
    });
  }

  const filingRow = returns.kind === "ok" && filing ? returns.data.find((r) => r.id === filing.id) ?? null : null;

  return (
    <div id="tax-returns" style={{ marginTop: 22, scrollMarginTop: 16 }}>
      {drift.kind === "forbidden" && (
        <ReadRefusal subject="the check of filed returns against the ledger" kind="forbidden" inline />
      )}
      {drift.kind === "unavailable" && (
        <p className="sys-empty-note" role="alert">
          Could not check whether the filed returns still match the ledger. This is not a statement that they do; it means we cannot tell right now.
          {drift.reason ? <span className="sys-refusal__reason"> {drift.reason}</span> : null}
        </p>
      )}
      {drift.kind === "ok" && !drift.data.clean && (
        <Card title="Filed returns that no longer match the ledger" style={{ marginBottom: 22 }}>
          <div role="alert">
            <div className="fin-verdict" style={{ marginBottom: 12 }}>
              <StatusBadge label="blocked" />
              <span className="fin-verdict__note">
                {drift.data.problems.length} filed {drift.data.problems.length === 1 ? "return has" : "returns have"} drifted: a journal was posted into a period already declared.
              </span>
            </div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {drift.data.problems.map((p, i) => <li key={i}>{p.detail}</li>)}
            </ul>
            <p className="fin-muted" style={{ marginTop: 12 }}>
              Each needs a decision. To correct what was declared, amend that return: it re-reads the ledger and records a new
              filing reference. Or leave it and carry the difference into a later return. Preparing a return again does not change
              a filed one. A return that is not filed yet needs nothing: its figures are recomputed from the ledger every time.
            </p>
          </div>
        </Card>
      )}
      {drift.kind === "ok" && drift.data.clean && returns.kind === "ok" && returns.data.some((r) => r.status !== "draft") && (
        <p className="fin-muted" style={{ marginBottom: 12 }}>
          Every filed return still matches the ledger.
        </p>
      )}

      <Card
        title={returns.kind === "ok" ? `Returns · ${returns.data.length}` : "Returns"}
        hint="One return per kind and tax period. A draft holds no figures: they are worked out from the ledger when asked for. Filing freezes them as filed; an amendment replaces them, it never erases the filing."
      >
        {returns.kind === "forbidden" && <ReadRefusal subject="tax returns" kind="forbidden" inline />}
        {returns.kind === "unavailable" && (
          <p className="sys-empty-note" role="alert">
            Could not load the tax returns. This is not a statement that none were prepared; it means we cannot tell right now.
            {returns.reason ? <span className="sys-refusal__reason"> {returns.reason}</span> : null}
          </p>
        )}
        {returns.kind === "ok" && returns.data.length === 0 && (
          <EmptyNote>No return has been prepared for this company. Prepare one for a closed month below.</EmptyNote>
        )}
        {returns.kind === "ok" && returns.data.length > 0 && (
          <HairlineTable
            columns={[
              { label: "Return" }, { label: "Period" }, { label: "Status" },
              { label: "Output / withheld", align: "right" }, { label: "Input / offset", align: "right" }, { label: "Net", align: "right" },
              { label: "Filed" }, { label: "Reference" }, ...(canAct ? [{ label: "Action" }] : []),
            ]}
            rows={returns.data.map((r) => {
              const label = returnLabel(r);
              const draft = r.status === "draft";
              const live = draft ? previews[r.id] : undefined;
              const net = draft ? live?.net : r.filedNet == null ? undefined : Number(r.filedNet);
              const drifted = driftFor(r, drift.kind === "ok" ? drift.data : null);
              const f = figureLabels(r.kind);
              return [
                <span key="k" title={TAX_RETURN_KIND_LABEL[r.kind as keyof typeof TAX_RETURN_KIND_LABEL] ?? r.kind}>{label}</span>,
                `${r.periodStart} to ${r.periodEnd}`,
                <span key="s">
                  <StatusBadge label={r.status} />
                  {drifted ? <span className="fin-muted" title={drifted}> · ledger has moved</span> : null}
                </span>,
                draft ? (live ? formatTaxAmount(live.output) : "—") : formatTaxAmount(r.filedOutput),
                draft ? (live ? formatTaxAmount(live.input) : "—") : formatTaxAmount(r.filedInput),
                <span key="n" title={f.net}>
                  {net === undefined ? "—" : formatTaxAmount(net)}
                  {net !== undefined && net < 0 ? <span className="fin-muted"> refundable</span> : null}
                  {draft && live ? <span className="fin-muted"> live, not stored</span> : null}
                  {draft && !live ? <span className="fin-muted"> not stored until filed</span> : null}
                </span>,
                r.filedAt ? r.filedAt.slice(0, 10) : "Not filed",
                r.filingReference ?? "—",
                ...(canAct
                  ? [
                      <span key="a" className="fin-form__actions" style={{ margin: 0 }}>
                        {draft ? (
                          <>
                            <RowButton label={`Show figures for ${label}`} onClick={() => showFigures(r)} disabled={pending}>Show figures</RowButton>
                            <RowButton label={`Record filing for ${label}`} onClick={() => { clear(); setFiling({ id: r.id, amend: false }); }} disabled={pending}>Record filing</RowButton>
                          </>
                        ) : (
                          <RowButton label={`Amend ${label}`} onClick={() => { clear(); setFiling({ id: r.id, amend: true }); }} disabled={pending}>Amend</RowButton>
                        )}
                      </span>,
                    ]
                  : []),
              ];
            })}
          />
        )}
      </Card>

      {filing && filingRow ? (
        <FilingForm
          key={`${filing.id}:${filing.amend}`}
          ret={filingRow}
          amend={filing.amend}
          onCancel={() => setFiling(null)}
          onFailed={fail}
          onDone={(m) => { setFiling(null); setNotice(m); }}
        />
      ) : null}

      {canAct ? (
        <Card
          title="Prepare a return"
          hint="Safe to repeat: asking again for the same kind and period returns the same draft. A period that is already filed is refused; amend it instead."
          style={{ marginTop: 22 }}
        >
          <div className="fin-form">
            <label className="fin-form__field">
              <span>Return</span>
              <select value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}>
                {TAX_RETURN_KINDS.map((k) => <option key={k} value={k}>{TAX_RETURN_KIND_LABEL[k]}</option>)}
              </select>
            </label>
            <label className="fin-form__field">
              <span>Year</span>
              <input value={form.year} onChange={(e) => setForm((f) => ({ ...f, year: e.target.value }))} inputMode="numeric" maxLength={4} />
            </label>
            <label className="fin-form__field">
              <span>Month</span>
              <select
                value={annual ? "" : form.month}
                disabled={annual}
                onChange={(e) => setForm((f) => ({ ...f, month: e.target.value }))}
              >
                {annual ? <option value="">Whole year</option> : null}
                {MONTHS.map((m, i) => <option key={m} value={String(i + 1)}>{m}</option>)}
              </select>
            </label>
          </div>
          <div className="fin-form__actions">
            <Button onClick={prepare} disabled={pending}>{pending ? "Working…" : "Prepare return"}</Button>
          </div>
        </Card>
      ) : null}

      {error && <p className="fin-form__error" role="alert" style={{ marginTop: 12 }}>{error}</p>}
      {needsFactor && <SecondFactorPrompt />}
      {notice && <p className="fin-muted" role="status" style={{ marginTop: 12 }}>{notice}</p>}
    </div>
  );
}
