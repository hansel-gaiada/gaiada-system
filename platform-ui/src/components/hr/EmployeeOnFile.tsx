import Link from "next/link";
import { formatMoney } from "@/lib/hr-full";
import type { EmployeeAllowance, EmployeeBenefit, EmployeeTaxProfile, TaxProfile } from "@/lib/hr-full";
import type { ReadResult } from "@/lib/readResult";
import { label } from "@/lib/hrCompensation";
import { Card, HairlineTable } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";

// HR › Compensation › what is on file for ONE employee (DW-7f-3b, BFF §51): the allowances and benefits in force, each with
// "show history", and the tax profile in force with the history behind it.
//
// Rules this card holds:
//   - Each of the three is its own honest read. A refused or failed read is said in words (ReadRefusal); it is never an
//     empty table that could mean "nothing is assigned". An empty list is shown as empty only when the server answered [].
//   - "In force today" is decided by the SERVER (REPORTS_TZ), never by this browser's or this server's clock: the default
//     lists are read with current=true and the history lists without it. A benefit enrolment is in force when it is within its
//     dates AND active; the others are only in the history, where the Status column says what each is.
//   - The NPWP is shown as the server returned it, to a viewer who may read payroll. Nothing is derived or masked here.
//   - History is a link (a query parameter), not client state, so the card stays a server component and a link can be shared.
const dim = { font: "400 12px/1.5 var(--font-body)", color: "var(--erp-ink-60)" } as const;

export type OnFileKey = "allowances" | "benefits" | "tax";

function Refused<T>({ read, subject }: { read: Exclude<ReadResult<T>, { kind: "ok" }>; subject: string }) {
  const Subject = subject.charAt(0).toUpperCase() + subject.slice(1);
  return read.kind === "forbidden"
    ? <ReadRefusal inline subject={subject} kind="forbidden" />
    : <ReadRefusal inline subject={Subject} kind="unavailable" reason={read.reason} />;
}

function Section({
  title, noun, shown, toggleHref, children,
}: { title: string; noun: string; shown: boolean; toggleHref: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <h3 style={{ margin: 0, font: "600 13px var(--font-body)" }}>{title}</h3>
        <Link href={toggleHref} aria-label={`${shown ? "Hide" : "Show"} ${noun} history`} style={{ color: "var(--erp-accent)", font: "400 13px var(--font-body)" }}>
          {shown ? "Hide history" : "Show history"}
        </Link>
      </div>
      {children}
    </section>
  );
}

const amountOf = (a: EmployeeAllowance, currency: string): string =>
  a.amount !== null ? formatMoney(a.amount, currency)
    : a.percent !== null ? `${Number(a.percent)}% of base`
    : "—";

const endOf = (to: string | null): string => to ?? "no end date";

function TaxProfileFacts({ p }: { p: TaxProfile }) {
  return (
    <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 16px", font: "400 13px var(--font-body)" }}>
      <dt style={dim}>NPWP</dt>
      <dd style={{ margin: 0 }}>{p.hasNpwp ? (p.npwp ?? "on file, number not returned") : "none on file"}</dd>
      <dt style={dim}>PTKP status</dt>
      <dd style={{ margin: 0 }}>{p.ptkpStatus}</dd>
      <dt style={dim}>TER category</dt>
      <dd style={{ margin: 0 }}>{p.terCategory ?? "—"}</dd>
      <dt style={dim}>Tax resident</dt>
      <dd style={{ margin: 0 }}>{p.taxResident ? "yes" : "no"}</dd>
      <dt style={dim}>Since</dt>
      <dd style={{ margin: 0 }}>{p.effectiveFrom}</dd>
    </dl>
  );
}

export function EmployeeOnFile({
  employeeName, closeHref, hrefFor, shown, currency, allowancesRead, benefitsRead, taxRead,
}: {
  employeeName: string | null;
  closeHref: string;
  /** The page's own URL with `key`'s history toggled. */
  hrefFor: (key: OnFileKey) => string;
  shown: Record<OnFileKey, boolean>;
  currency: string;
  allowancesRead: ReadResult<EmployeeAllowance[]>;
  benefitsRead: ReadResult<EmployeeBenefit[]>;
  taxRead: ReadResult<EmployeeTaxProfile>;
}) {
  const tax = taxRead.kind === "ok" ? taxRead.data : null;
  return (
    <Card
      title={`On file${employeeName ? ` — ${employeeName}` : ""}`}
      hint="What the server holds for this person: the allowances in force today, the benefit enrolments that are active today, and the tax profile payroll withholds on. Closed rows, and enrolments that are pending, suspended or terminated, stay under “Show history”."
      style={{ marginBottom: 22 }}
    >
      <div style={{ display: "grid", gap: 18 }}>
        <p style={{ margin: 0, font: "400 13px var(--font-body)" }}>
          <Link href={closeHref} style={{ color: "var(--erp-accent)" }}>Close</Link>
        </p>

        <Section title={shown.allowances ? "Allowances and deductions, all" : "Allowances and deductions in force"} noun="allowance" shown={shown.allowances} toggleHref={hrefFor("allowances")}>
          {allowancesRead.kind !== "ok" ? (
            <Refused read={allowancesRead} subject="this person's allowances" />
          ) : allowancesRead.data.length === 0 ? (
            <EmptyNote>{shown.allowances ? "The server holds no allowance for this employee." : "No allowance is in force for this employee today."}</EmptyNote>
          ) : (
            <HairlineTable
              columns={[{ label: "Allowance" }, { label: "Amount", align: "right" }, { label: "From" }, { label: "To" }, { label: "Note" }]}
              rows={allowancesRead.data.map((a) => [
                `${a.allowanceCode} · ${a.allowanceLabel}${a.direction === "deduction" ? " (deduction)" : ""}`,
                amountOf(a, currency),
                a.effectiveFrom,
                endOf(a.effectiveTo),
                a.note || "—",
              ])}
            />
          )}
        </Section>

        <Section title={shown.benefits ? "Benefit enrolments, all" : "Benefit enrolments in force"} noun="benefit" shown={shown.benefits} toggleHref={hrefFor("benefits")}>
          {benefitsRead.kind !== "ok" ? (
            <Refused read={benefitsRead} subject="this person's benefit enrolments" />
          ) : benefitsRead.data.length === 0 ? (
            <EmptyNote>{shown.benefits ? "The server holds no benefit enrolment for this employee." : "No active benefit enrolment is in force for this employee today."}</EmptyNote>
          ) : (
            <HairlineTable
              columns={[
                { label: "Plan" }, { label: "Member no." }, { label: "Dependants", align: "right" },
                { label: "Status" }, { label: "From" }, { label: "To" },
              ]}
              rows={benefitsRead.data.map((b) => [
                `${b.planCode} · ${b.planName}`,
                b.memberNumber ?? "—",
                String(b.dependants),
                label(b.status),
                b.effectiveFrom,
                endOf(b.effectiveTo),
              ])}
            />
          )}
        </Section>

        <Section title="Tax profile" noun="tax profile" shown={shown.tax} toggleHref={hrefFor("tax")}>
          {taxRead.kind !== "ok" ? (
            <Refused read={taxRead} subject="this person's tax profile" />
          ) : (
            <>
              {tax?.current ? (
                <TaxProfileFacts p={tax.current} />
              ) : (
                <EmptyNote>
                  {tax && tax.history.length > 0
                    ? "No tax profile is in force today (every profile on file has ended or starts later)."
                    : "No tax profile is on file for this employee."}
                </EmptyNote>
              )}
              {shown.tax && tax && (
                tax.history.length === 0 ? (
                  <EmptyNote>The server holds no tax profile for this employee.</EmptyNote>
                ) : (
                  <HairlineTable
                    columns={[
                      { label: "From" }, { label: "To" }, { label: "NPWP" }, { label: "PTKP" },
                      { label: "TER" }, { label: "Resident" },
                    ]}
                    rows={tax.history.map((p) => [
                      p.effectiveFrom,
                      endOf(p.effectiveTo),
                      p.hasNpwp ? (p.npwp ?? "on file") : "none",
                      p.ptkpStatus,
                      p.terCategory ?? "—",
                      p.taxResident ? "yes" : "no",
                    ])}
                  />
                )
              )}
            </>
          )}
        </Section>
      </div>
    </Card>
  );
}
