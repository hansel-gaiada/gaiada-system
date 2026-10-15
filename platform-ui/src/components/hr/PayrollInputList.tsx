import { HairlineTable } from "@/components/ui";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { formatMoney, type PayrollInput } from "@/lib/hr-full";
import type { ReadResult } from "@/lib/readResult";

// DW-7f-1c: one list of payroll inputs on the run page. It renders an honest read: a refused or failed
// read is said in words and is never an empty table, and an empty `ok` list says "No inputs" because the
// server answered that there are none. Money is formatted from the strings the server returned; a
// quantity or amount the server left null renders "—".
const dim = { font: "400 12px/1.5 var(--font-body)", color: "var(--erp-ink-60)" } as const;

function qty(v: string | null): string | null {
  if (v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : null;   // numeric(12,3) "12.500" reads 12.5
}

function quantityAndAmount(i: PayrollInput, currency: string): string {
  const parts = [
    qty(i.quantity) !== null ? `Qty ${qty(i.quantity)}` : null,
    i.amount !== null && i.amount !== "" ? formatMoney(i.amount, currency) : null,
  ].filter(Boolean) as string[];
  return parts.length ? parts.join(" · ") : "—";
}

export function PayrollInputList({
  title, subject, intro, read, currency,
}: {
  title: string;
  /** What the list is, mid-sentence: "the payroll inputs this run consumed". */
  subject: string;
  intro?: string;
  read: ReadResult<PayrollInput[]>;
  currency: string;
}) {
  const Subject = subject.charAt(0).toUpperCase() + subject.slice(1);
  return (
    <section aria-label={title} style={{ display: "grid", gap: 8 }}>
      <h3 style={{ margin: 0, font: "600 14px/1.4 var(--font-body)" }}>{title}</h3>
      {intro ? <p style={{ margin: 0, ...dim }}>{intro}</p> : null}
      {read.kind === "forbidden" ? (
        <ReadRefusal inline subject={subject} kind="forbidden" />
      ) : read.kind === "unavailable" ? (
        <ReadRefusal inline subject={Subject} kind="unavailable" reason={read.reason} />
      ) : read.data.length === 0 ? (
        <p style={{ margin: 0, font: "400 13px/1.5 var(--font-body)" }}>No inputs</p>
      ) : (
        <HairlineTable
          columns={[
            { label: "Employee" }, { label: "Category" }, { label: "Label" }, { label: "Period" },
            { label: "Quantity / amount", align: "right" }, { label: "Taxable" }, { label: "Note" },
          ]}
          rows={read.data.map((i) => [
            i.employeeName,
            i.category,
            i.label,
            i.periodStart === i.periodEnd ? i.periodStart : `${i.periodStart} → ${i.periodEnd}`,
            quantityAndAmount(i, currency),
            i.taxable ? "Yes" : "No",
            i.note || "—",
          ])}
        />
      )}
    </section>
  );
}
