"use client";
import { ConfirmAction } from "@/components/finance/ConfirmAction";
import { recogniseLease } from "@/lib/financeActions";
import { useState } from "react";

// Recognise a lease under PSAK 73.
//
// ── THE ONLY ACTION HERE THAT CHANGES THE SIZE OF THE BALANCE SHEET ────────────────────────────
// Closing a period stops posting; committing a cutover moves a line; a year-end close shifts a
// figure between equity accounts. This one CREATES an asset and a liability that did not previously
// exist. The company gets bigger on both sides. That is the correct treatment under PSAK 73 and it
// is also the thing a reader should know before clicking, so the copy says it plainly.
//
// ── THE ASSET CLASS IS REQUIRED, NOT DEFAULTED ─────────────────────────────────────────────────
// It decides how the right-of-use asset depreciates for the whole lease term. Defaulting it would
// pick a useful life on the reader's behalf and be wrong silently — the kind of guess that only
// surfaces years later as a carrying value nobody can explain.
export function RecogniseLeaseAction({
  instrumentId, instrumentCode, assetClasses,
}: {
  instrumentId: string;
  instrumentCode: string;
  assetClasses: Array<{ id: string; code: string; name: string }>;
}) {
  const [classId, setClassId] = useState(assetClasses[0]?.id ?? "");

  if (assetClasses.length === 0) {
    return (
      <p className="fin-muted">
        No asset classes are defined, so there is nothing to depreciate a right-of-use asset against.
        A lease cannot be recognised until one exists — the class sets the useful life.
      </p>
    );
  }

  return (
    <>
      <div className="fin-form__field" style={{ marginBlockEnd: 12 }}>
        <label htmlFor="lease-class">Right-of-use asset class</label>
        <select id="lease-class" value={classId} onChange={(e) => setClassId(e.target.value)}>
          {assetClasses.map((c) => (
            <option key={c.id} value={c.id}>{c.code} · {c.name}</option>
          ))}
        </select>
        <span>Sets how the right-of-use asset depreciates for the whole lease term.</span>
      </div>

      <ConfirmAction
        expected={instrumentCode}
        expectedLabel="instrument code"
        consequence={
          "Creates a right-of-use ASSET and a lease LIABILITY that did not exist before — the "
          + "balance sheet grows on both sides. This is the PSAK 73 treatment, and it is not a "
          + "transfer between accounts that can be reversed by moving a figure back."
        }
        actionLabel="Recognise this lease"
        run={({ confirm }) => recogniseLease(instrumentId, { confirm, assetClassId: classId })}
      />
    </>
  );
}
