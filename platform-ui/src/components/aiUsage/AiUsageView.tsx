import Link from "next/link";
import type { ReactNode } from "react";
import { Card, HairlineTable } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import {
  NO_PERSON, costGapMark, costMark, dayLabel, departmentAiUsageHref, departmentLabel, figureNotes, formatCost, formatCount, formatTokens, isEmptyMonth,
  modelLabel, noUseText, personLabel, surfaceLabel, tokenMark,
  type DayLine, type DepartmentLine, type ModelLine, type PersonLine, type SurfaceLine, type UsageFigures,
} from "@/lib/aiUsage";
import "./aiUsage.css";

// AIP-16 and AIP-05 (BFF §66): the one drawing of an AI usage answer, for all three screens. Counts and money only: nothing here can show a thread
// title, a prompt or any text, because no answer carries one.
//
// The order is the by-surface breakdown FIRST. Knowledge embeds outnumber replies about 3,000 to 1, so one combined "calls" number would be
// the embeds and nothing else; the month total shows cost and tokens, never a calls figure, and the by-day column says "all surfaces".
// Every figure is said as the answer says it: a null sum is "unknown", never 0; a cost is shown from its decimal string; estimated tokens, a
// cost from our price table and a partial cost are marked beside the figure, with the sentences under the month total.

const TCOLS = "2fr repeat(4, minmax(0, 1fr))";
const FIGURE_COLS = [
  { label: "Calls", align: "right" as const },
  { label: "Tokens in", align: "right" as const },
  { label: "Tokens out", align: "right" as const },
  { label: "Cost", align: "right" as const },
];

function Mark({ text }: { text: string | null }) {
  return text ? <> <span className="aiu-mark">({text})</span></> : null;
}

function tokensCell(n: number | null, f: UsageFigures): ReactNode {
  return <>{formatTokens(n)}<Mark text={n === null ? null : tokenMark(f)} /></>;
}
function costCell(f: UsageFigures): ReactNode {
  return <>{formatCost(f.costUsd)}<Mark text={f.costUsd === null ? null : (costMark(f) ?? costGapMark(f))} /></>;
}
/** The four figure cells of one line. */
const figureCells = (f: UsageFigures): ReactNode[] => [formatCount(f.calls), tokensCell(f.promptTokens, f), tokensCell(f.completionTokens, f), costCell(f)];

function FigureTable({ first, rows }: { first: string; rows: { label: ReactNode; f: UsageFigures }[] }) {
  return <HairlineTable columns={[{ label: first }, ...FIGURE_COLS]} tcols={TCOLS} rows={rows.map((r) => [r.label, ...figureCells(r.f)])} />;
}

function SurfaceTable({ rows }: { rows: readonly SurfaceLine[] }) {
  return <FigureTable first="Surface" rows={rows.map((s) => ({ label: surfaceLabel(s.surface), f: s }))} />;
}

function MonthTotal({ totals }: { totals: UsageFigures }) {
  const notes = figureNotes(totals);
  return (
    <Card title="Month total">
      <dl className="aiu-total">
        <div><dt>Cost</dt><dd>{costCell(totals)}</dd></div>
        <div><dt>Tokens in</dt><dd>{tokensCell(totals.promptTokens, totals)}</dd></div>
        <div><dt>Tokens out</dt><dd>{tokensCell(totals.completionTokens, totals)}</dd></div>
      </dl>
      {notes.length > 0 ? <ul className="aiu-notes">{notes.map((n) => <li key={n}>{n}</li>)}</ul> : null}
    </Card>
  );
}

export interface AiUsageViewProps {
  month: string;
  totals: UsageFigures;
  bySurface: readonly SurfaceLine[];
  byDay: readonly DayLine[];
  byModel?: readonly ModelLine[];
  /** The department's people, drawn only when the answer HAD them (`null` or absent: the company tier, no section at all). */
  people?: readonly PersonLine[] | null;
  /** The company view's departments, each linking to its unit view. */
  departments?: readonly DepartmentLine[];
  /** The company view's "Company, no person" lines (`noPerson`). */
  noPerson?: readonly SurfaceLine[];
}

export function AiUsageView({ month, totals, bySurface, byDay, byModel, people, departments, noPerson }: AiUsageViewProps) {
  if (isEmptyMonth(totals)) return <EmptyNote>{noUseText(month)}</EmptyNote>;
  return (
    <div className="aiu">
      <Card title="By surface" hint="Each kind of AI use on its own. Knowledge indexing makes far more calls than replies, so they are never added together.">
        {bySurface.length > 0 ? <SurfaceTable rows={bySurface} /> : <EmptyNote>No surface recorded.</EmptyNote>}
      </Card>

      <MonthTotal totals={totals} />

      {byModel && byModel.length > 0 ? (
        <Card title="By model">
          <FigureTable first="Model" rows={byModel.map((m) => ({ label: modelLabel(m), f: m }))} />
        </Card>
      ) : null}

      {departments ? (
        <Card title="By department" hint="Each department's people, by the department they sit in. Open one for its month.">
          {departments.length > 0 ? (
            <HairlineTable
              columns={[{ label: "Department" }, ...FIGURE_COLS]}
              tcols={TCOLS}
              rows={departments.map((d) => [
                d.unitNodeId === null ? departmentLabel(d) : <Link key={d.unitNodeId} href={departmentAiUsageHref(d.unitNodeId, month)}>{departmentLabel(d)}</Link>,
                ...figureCells(d),
              ])}
            />
          ) : <EmptyNote>No department recorded.</EmptyNote>}
        </Card>
      ) : null}

      {noPerson && noPerson.length > 0 ? (
        <Card title={NO_PERSON} hint="Use that belongs to no person and no department, such as the company's own knowledge indexing.">
          <SurfaceTable rows={noPerson} />
        </Card>
      ) : null}

      {people ? (
        <Card title="By person" hint="Shown to this department's head and the owner. Counts and cost only: not a ranking and not a score.">
          {people.length > 0 ? (
            <FigureTable first="Person" rows={people.map((p) => ({ label: personLabel(p), f: p }))} />
          ) : <EmptyNote>No person in this department used AI this month.</EmptyNote>}
        </Card>
      ) : null}

      <Card title="By day" hint="UTC days. Calls here are all surfaces together.">
        {byDay.length > 0 ? (
          <HairlineTable
            columns={[{ label: "Day" }, { label: "Calls (all surfaces)", align: "right" }, FIGURE_COLS[1], FIGURE_COLS[2], FIGURE_COLS[3]]}
            tcols={TCOLS}
            rows={byDay.map((d) => [dayLabel(d.day), ...figureCells(d)])}
          />
        ) : <EmptyNote>No day recorded.</EmptyNote>}
      </Card>
    </div>
  );
}
