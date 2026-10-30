import Link from "next/link";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import {
  budgetModeLabel, budgetStateWords, percentText, type Allowances, type BudgetFigures, type CompanyBudgetLine, type UnitBudgetLine,
} from "@/lib/aiBudget";
import { budgetNoCostNote, budgetSpentText, departmentAiUsageHref, formatCost, formatCount, monthLabel, personLabel } from "@/lib/aiUsage";
import { AddUnitBudgetForm, AllowanceCell, ClearAllowanceButton, CompanyBudgetForm, LiftStopButton, UnitBudgetForm } from "./BudgetForms";
import "./aiUsage.css";

// AIP-17b and AIP-18 (BFF §66.8, §66.9, §66.11): the budget lines on the usage screens, and the owner's forms beside them. Counts and money only.
//
// A BUDGET LINE says the figure, what has been spent against it (never `$0` for an unknown spend), the percent and the state in words, and "lifted this
// month" for a stop the owner or the head lifted. NO BUDGET, NO BOX: a reader with nothing set sees nothing; the owner (`capabilities.canManage`) sees
// the form that sets one, which is a control, not an empty box. The forms are rendered only when the answer says the person may use them (a mirror;
// the server decides every write).

function Figures({ line }: { line: BudgetFigures }) {
  const unknown = line.spentUsd === null;
  return (
    <>
      <dl className="aiu-budget__figs">
        <div><dt>Figure</dt><dd>{formatCost(line.monthlyUsd)} a month</dd></div>
        <div><dt>Spent so far</dt><dd>{budgetSpentText(line)}</dd></div>
        <div><dt>Percent</dt><dd>{unknown ? "unknown" : percentText(line.percent)}</dd></div>
        <div><dt>State</dt><dd data-state={line.state}>{budgetStateWords(line.state)}</dd></div>
      </dl>
      {budgetNoCostNote(line.noCostCalls) ? <p className="aiu-note">{budgetNoCostNote(line.noCostCalls)}</p> : null}
    </>
  );
}

/** The mode and the "lifted" mark of a unit line, in words. */
function UnitFlags({ line }: { line: UnitBudgetLine }) {
  return (
    <p className="aiu-flags">
      <span className="aiu-flag" data-mode={line.mode}>{budgetModeLabel(line.mode)}</span>
      {line.stopLifted ? <span className="aiu-flag aiu-flag--lifted">lifted for this month</span> : null}
    </p>
  );
}

// ── The company view ──────────────────────────────────────────────────────────────────────────────

/** The company's alert figure. Nothing at all when none is set and the person cannot set one. */
export function CompanyBudgetSection({ line, canManage }: { line: CompanyBudgetLine | null; canManage: boolean }) {
  if (line === null && !canManage) return null;
  return (
    <Card title="Company alert figure" hint="The owner and the GM are told when the month's AI spend reaches 80% and 100% of it. It never stops anyone.">
      {line ? <Figures line={line} /> : <p className="aiu-note">No alert figure is set.</p>}
      {canManage ? <CompanyBudgetForm key={line?.monthlyUsd ?? "none"} line={line} /> : null}
    </Card>
  );
}

/** Every department's budget line, each linking to that department's month. The owner edits one in place and can add one for a department that has none. */
export function DepartmentBudgetsSection({ units, canManage, month, departments }: {
  units: readonly UnitBudgetLine[];
  canManage: boolean;
  month: string;
  /** The departments of the company view (the by-department lines with a node), for "add a budget". */
  departments: readonly { unitNodeId: string; name: string | null }[];
}) {
  const have = new Set(units.map((u) => u.unitNodeId));
  const options = canManage ? departments.filter((d) => !have.has(d.unitNodeId)).map((d) => ({ value: d.unitNodeId, label: d.name ?? "Department not in the organisation tree" })) : [];
  if (units.length === 0 && options.length === 0) return null;
  return (
    <Card title="Department budgets" hint={`${monthLabel(month)}. Each department's spend counts its whole subtree. Report only tells; Soft stop also moves the department's replies to a lighter mode at 100%.`}>
      {units.length === 0 ? <p className="aiu-note">No department has a budget.</p> : (
        <ul className="aiu-budgets">
          {units.map((u) => (
            <li key={u.unitNodeId} className="aiu-budget">
              <h4 className="aiu-budget__name"><Link href={departmentAiUsageHref(u.unitNodeId, month)}>{u.name ?? "Department not in the organisation tree"}</Link></h4>
              <UnitFlags line={u} />
              <Figures line={u} />
              {canManage ? <UnitBudgetForm key={`${u.monthlyUsd}-${u.mode}`} unitNodeId={u.unitNodeId} line={u} label={u.name ?? "Department"} /> : null}
            </li>
          ))}
        </ul>
      )}
      {canManage ? <AddUnitBudgetForm options={options} /> : null}
    </Card>
  );
}

/** The owner's list of per-person overrides and the default (`GET allowances`). */
export function AllowancesSection({ allowances }: { allowances: Allowances }) {
  return (
    <Card title="Daily reply allowances" hint="How many assistant replies a person gets a day (UTC) before replies move to a lighter mode. Set one person's in their department's AI usage.">
      <p className="aiu-note">Default: {formatCount(allowances.defaultDailyReplies)} replies a day.</p>
      {allowances.overrides.length === 0 ? <EmptyNote>No one has their own allowance.</EmptyNote> : (
        <ul className="aiu-budgets">
          {allowances.overrides.map((o) => (
            <li key={o.userId} className="aiu-budget aiu-budget--row">
              <span className="aiu-budget__name">{personLabel(o)}</span>
              <span>{formatCount(o.dailyReplies)} replies a day</span>
              <ClearAllowanceButton userId={o.userId} name={personLabel(o)} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ── The department view ───────────────────────────────────────────────────────────────────────────

/** This department's own budget line, with the owner's form and the lift button. Nothing at all when none is set and the person cannot set one. */
export function UnitBudgetSection({ unitNodeId, name, line, canManage, showLift, month }: {
  unitNodeId: string;
  name: string | null;
  line: UnitBudgetLine | null;
  canManage: boolean;
  /** `liftOffered(...)`, decided by the page: soft stop, at or over 100%, not lifted this month, `canLiftStop`, the current month. */
  showLift: boolean;
  month: string;
}) {
  if (line === null && !canManage) return null;
  return (
    <Card title="Budget" hint={`${monthLabel(month)}. This department's spend counts its whole subtree.`}>
      {line ? (
        <>
          <UnitFlags line={line} />
          <Figures line={line} />
        </>
      ) : <p className="aiu-note">No budget is set for this department.</p>}
      {showLift ? <LiftStopButton unitNodeId={unitNodeId} monthName={monthLabel(month)} /> : null}
      {canManage ? <UnitBudgetForm key={`${line?.monthlyUsd ?? ""}-${line?.mode ?? ""}`} unitNodeId={unitNodeId} line={line} label={name ?? "Department"} /> : null}
    </Card>
  );
}

/** The by-person table's "Allowance" cell content for one person (owner only). */
export function allowanceCell(allow: { defaultDailyReplies: number; overrides: readonly { userId: string; dailyReplies: number }[] }, p: { userId: string; name: string | null }) {
  const o = allow.overrides.find((x) => x.userId === p.userId);
  return <AllowanceCell userId={p.userId} name={personLabel(p)} dailyReplies={o ? o.dailyReplies : allow.defaultDailyReplies} isDefault={!o} />;
}
