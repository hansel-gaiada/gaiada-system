"use client";
import { useState, useTransition } from "react";
import { Card, Button, HairlineTable, StatusBadge } from "@/components/ui";
import { addTaxCode, endTaxCode, addStandardPpnCodes } from "@/lib/financeActions";
import type { TaxCode } from "@/lib/finance";
import { SecondFactorPrompt } from "@/components/auth/SecondFactorPrompt";
import { isAssuranceRefusal } from "@/lib/stepUp";

// PV5-F2 — tax-code setup. Since PV5-04 a taxed invoice, bill or journal line must name a tax code; a company that has
// none cannot issue a taxed invoice. This is where Finance creates them.
//
// ── A RATE IS NEVER EDITED HERE ────────────────────────────────────────────────────────────────
// There is no edit button on a rate, on purpose. A rate change is a NEW effective-dated row after END-DATING the old
// one, so a return filed for an old period still reproduces the tax it was filed with (F7's rule). The server refuses
// an in-place edit as well; this screen simply never offers one.
//
// ── THE SERVER IS THE BOUNDARY ──────────────────────────────────────────────────────────────────
// Authorization (`finance_tax` configure: controller tier, high assurance), overlap and date checks all live in the
// API. This component surfaces its message verbatim and guesses at none of it.

const KIND_LABELS: Record<string, string> = {
  ppn_output: "PPN output (sales)", ppn_input: "PPN input (purchases)", pph21: "PPh 21", pph23: "PPh 23",
  pph42: "PPh 4(2)", pph_badan: "PPh Badan", exempt: "Exempt",
};

export function baseLabel(m: number): string {
  if (m === 1) return "full base";
  if (Math.abs(m - 11 / 12) < 1e-9) return "11/12 of the base";
  return `${m} of the base`;
}

export function TaxCodeManager({ codes }: { codes: TaxCode[] }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // PV5-14: the last refusal named assurance (`finance_tax` configure is a high-assurance action).
  const [needsFactor, setNeedsFactor] = useState(false);
  const [form, setForm] = useState({
    code: "", name: "", kind: "ppn_output", rate: "", baseMultiplier: "1", effectiveFrom: "", effectiveTo: "",
  });
  const [endDates, setEndDates] = useState<Record<string, string>>({});

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  function standard() {
    setError(null);
    setNotice(null);
    setNeedsFactor(false);
    start(async () => {
      const r = await addStandardPpnCodes();
      setNeedsFactor(!r.ok && isAssuranceRefusal(r.reason));
      if (!r.ok || !r.result) return setError(r.error ?? "Could not add the standard PPN codes.");
      const { created, skipped } = r.result;
      setNotice(
        created.length === 0
          ? "The standard PPN codes are already set up; nothing was added."
          : `Added ${created.join(" and ")}.${skipped.length ? ` Already present: ${skipped.join(", ")}.` : ""}`,
      );
    });
  }

  function add() {
    setError(null);
    setNotice(null);
    setNeedsFactor(false);
    start(async () => {
      const r = await addTaxCode({
        code: form.code.trim(), name: form.name.trim(), kind: form.kind, rate: form.rate.trim(),
        baseMultiplier: form.baseMultiplier.trim() || "1", effectiveFrom: form.effectiveFrom,
        effectiveTo: form.effectiveTo || null,
      });
      setNeedsFactor(!r.ok && isAssuranceRefusal(r.reason));
      if (!r.ok) return setError(r.error ?? "Could not add this tax code.");
      setNotice(`Added ${form.code.trim()} from ${form.effectiveFrom}.`);
      setForm({ code: "", name: "", kind: "ppn_output", rate: "", baseMultiplier: "1", effectiveFrom: "", effectiveTo: "" });
    });
  }

  function end(c: TaxCode) {
    const to = endDates[c.id];
    if (!to) return setError("Pick the last day this row applies.");
    setError(null);
    setNotice(null);
    setNeedsFactor(false);
    start(async () => {
      const r = await endTaxCode(c.id, to);
      setNeedsFactor(!r.ok && isAssuranceRefusal(r.reason));
      if (!r.ok) return setError(r.error ?? "Could not end-date this tax code.");
      setNotice(`${c.code} from ${c.effectiveFrom} now ends on ${to}.`);
    });
  }

  return (
    <>
      <Card
        title="Tax codes"
        hint="Each row is a rate that applies from a date. A rate change is a new row, so returns for old periods still reproduce."
      >
        {codes.length === 0 ? (
          <p className="fin-muted">
            This company has no tax codes, so an invoice, bill or journal line that carries tax is refused. Add the
            standard Indonesian PPN codes below, or add a code yourself.
          </p>
        ) : (
          <HairlineTable
            columns={[
              { label: "Code" }, { label: "Kind" }, { label: "Rate", align: "right" }, { label: "Applies to" },
              { label: "From" }, { label: "To" }, { label: "Status" }, { label: "Action" },
            ]}
            rows={codes.map((c) => [
              <span key="c" title={c.name}>{c.code}</span>,
              KIND_LABELS[c.kind] ?? c.kind,
              `${c.rate}%`,
              baseLabel(c.baseMultiplier),
              c.effectiveFrom,
              c.effectiveTo ?? "no end date",
              <StatusBadge key="s" label={c.effectiveTo ? "archived" : "active"} />,
              c.effectiveTo === null ? (
                <span key="a" className="fin-form__actions" style={{ margin: 0 }}>
                  <input
                    type="date"
                    aria-label={`Last day for ${c.code} from ${c.effectiveFrom}`}
                    value={endDates[c.id] ?? ""}
                    min={c.effectiveFrom}
                    onChange={(e) => setEndDates((d) => ({ ...d, [c.id]: e.target.value }))}
                  />
                  <Button onClick={() => end(c)} disabled={pending}>End-date</Button>
                </span>
              ) : (
                c.inUse ? "In use" : "—"
              ),
            ])}
          />
        )}
      </Card>

      <Card
        title="Standard PPN codes"
        hint="Statutory reference data for Indonesian output VAT. Safe to run again: it only adds what is missing."
        style={{ marginTop: 22 }}
      >
        <p className="fin-muted">
          Adds one code, <strong>PPN</strong>, with two dated rows: 11% of the full base for supplies from 1 April 2022 to
          31 December 2024, and 12% applied to 11/12 of the base (an effective 11%) from 1 January 2025. An invoice names
          the code and the tax follows the invoice date.
        </p>
        <div className="fin-form__actions">
          <Button onClick={standard} disabled={pending}>{pending ? "Working…" : "Add the standard PPN codes"}</Button>
        </div>
      </Card>

      <Card title="Add a tax code" hint="For anything beyond standard PPN. To change a rate, end-date the old row first." style={{ marginTop: 22 }}>
        <div className="fin-form">
          <label className="fin-form__field">
            <span>Code</span>
            <input value={form.code} onChange={set("code")} placeholder="e.g. PPH23" maxLength={32} />
          </label>
          <label className="fin-form__field">
            <span>Name</span>
            <input value={form.name} onChange={set("name")} placeholder="What the code is" maxLength={200} />
          </label>
          <label className="fin-form__field">
            <span>Kind</span>
            <select value={form.kind} onChange={set("kind")}>
              {Object.entries(KIND_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </label>
          <label className="fin-form__field">
            <span>Rate (%)</span>
            <input value={form.rate} onChange={set("rate")} inputMode="decimal" placeholder="e.g. 11" />
          </label>
          <label className="fin-form__field">
            <span>Share of the base the rate applies to</span>
            <input value={form.baseMultiplier} onChange={set("baseMultiplier")} inputMode="decimal" placeholder="1 = full base" />
          </label>
          <label className="fin-form__field">
            <span>Applies from</span>
            <input type="date" value={form.effectiveFrom} onChange={set("effectiveFrom")} />
          </label>
          <label className="fin-form__field">
            <span>Applies until (optional)</span>
            <input type="date" value={form.effectiveTo} onChange={set("effectiveTo")} />
          </label>
        </div>
        <div className="fin-form__actions">
          <Button onClick={add} disabled={pending}>{pending ? "Working…" : "Add tax code"}</Button>
        </div>
      </Card>

      {error && <p className="fin-form__error" role="alert">{error}</p>}
      {needsFactor && <SecondFactorPrompt />}
      {notice && <p className="fin-muted" role="status" style={{ marginTop: 12 }}>{notice}</p>}
    </>
  );
}
