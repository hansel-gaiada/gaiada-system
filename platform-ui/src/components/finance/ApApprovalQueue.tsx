"use client";
import { useState, useTransition } from "react";
import { Card, HairlineTable, Button } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { approveApBill } from "@/lib/financeActions";
import type { ApBill } from "@/lib/finance";

// The approval queue — every draft bill in the company, not just the ones this browser entered.
//
// ── WHY THIS REPLACED A SESSION-SCOPED LIST ────────────────────────────────────────────────────
// `bill_entry` and `approve` are deliberately different Cerbos grants so the person who types a
// vendor's invoice is not the one who admits it to the books. That separation only does anything if
// the approver can FIND what is waiting. A list built from what the current session happened to
// create serves one person exercising both halves for a demo, and serves nobody doing the real job —
// the approver is by construction a different person, in a different session, who did not create it.
//
// So the queue is server-read (`GET .../ap/bills?status=draft`) and this component only holds the
// per-row pending state.
export function ApApprovalQueue({ drafts }: { drafts: ApBill[] }) {
  const [pending, start] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approved, setApproved] = useState<Set<string>>(new Set());

  return (
    <Card
      title="Bills awaiting approval"
      hint="A draft posts nothing. Approving is what moves the AP control account — and is a separate grant from entering."
    >
      {drafts.length === 0 ? (
        <EmptyNote>
          No bills are waiting. A bill entered here stays a draft until somebody with the approve
          grant admits it — that gap is the control, not a delay.
        </EmptyNote>
      ) : (
        <>
          <HairlineTable
            columns={[
              { label: "Bill" }, { label: "Vendor" }, { label: "Due" },
              { label: "Total", align: "right" }, { label: "Withheld", align: "right" },
              { label: "Vendor is owed", align: "right" }, { label: "" },
            ]}
            rows={drafts.map((b) => [
              b.billNo,
              `${b.vendorCode} · ${b.vendorName}`,
              b.dueDate,
              Number(b.total).toLocaleString("id-ID"),
              // Shown on every row, because the gross is NOT what the vendor gets and approving is
              // the moment that distinction becomes a liability to two different creditors.
              Number(b.withholdingAmount) ? Number(b.withholdingAmount).toLocaleString("id-ID") : "—",
              Number(b.amountPayable).toLocaleString("id-ID"),
              approved.has(b.id) ? "approved" : (
                <Button
                  key={b.id}
                  disabled={pending && busyId === b.id}
                  onClick={() => {
                    setError(null); setBusyId(b.id);
                    start(async () => {
                      const r = await approveApBill(b.id);
                      if (r.ok) setApproved((s) => new Set(s).add(b.id));
                      else setError(r.error ?? "Failed.");
                    });
                  }}
                >
                  {pending && busyId === b.id ? "Approving…" : "Approve"}
                </Button>
              ),
            ])}
          />
          {error ? <p className="fin-form__error">{error}</p> : null}
          <p className="fin-muted" style={{ marginBlockStart: 12 }}>
            A 403 here means you hold bill entry but not approval. That is the control working, not a
            fault — ask whoever holds <code>approve</code> for this company.
          </p>
        </>
      )}
    </Card>
  );
}
