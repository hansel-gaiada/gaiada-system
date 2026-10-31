"use client";
// SCP-6a — the sheet import's preview (BFF §63.23.3, §63.23.6 step 5): every row of the sheet as a real table, its outcome in words (never colour alone),
// what it would write, the reasons in plain sentences, and a box to untick a row (`skip`). A refused row is marked with a rule down its edge and says
// "Refused". Rows the person ticked back in after the preview was made have no verdict yet and say so: the page asks for a new preview first.
// SCP-6 rehearsal finding: a row is numbered as in the sheet, `r.row + 1 + offset` (the rows above the header are not sent, so the server counts from it).
import {
  OUTCOME_LABEL, fieldLabel, rowCodeText, scheduledText, valueText,
  type ImportAnswer, type ImportKind, type ImportRow, type RowIssue,
} from "@/lib/sheetImport";

export type ShownOutcome = Exclude<ImportRow["outcome"], "joined"> | "unchecked";

/** `joined` (SCP-6b1) counts the rows that continue the post above; it is present only when there are some, and they are not in `rows`. */
export interface PreviewCounts { rows: number; ready: number; unchanged: number; refused: number; skipped: number; unchecked: number; joined?: number }

/** A row that continues the post above (BFF §63.23.9), whatever that post's outcome: shown under it, with nothing of its own to untick. */
export const continuesAbove = (r: ImportRow): boolean => typeof r.joinedTo === "number";

/** What a row shows now: skipped when unticked, "unchecked" when it was skipped in the preview but is ticked back in, else the server's outcome. */
export function shownOutcome(r: ImportRow, skip: ReadonlySet<number>, previewedSkip: ReadonlySet<number>): ShownOutcome {
  if (skip.has(r.row)) return "skipped";
  return previewedSkip.has(r.row) ? "unchecked" : (r.outcome as ShownOutcome);
}

export function previewCounts(answer: ImportAnswer, skip: ReadonlySet<number>, previewedSkip: ReadonlySet<number>): PreviewCounts {
  const posts = answer.rows.filter((r) => !continuesAbove(r));
  const c: PreviewCounts = { rows: posts.length, ready: 0, unchanged: 0, refused: 0, skipped: 0, unchecked: 0 };
  for (const r of posts) c[shownOutcome(r, skip, previewedSkip)] += 1;
  const joined = answer.rows.length - posts.length;
  return joined > 0 ? { ...c, joined } : c;
}

export function summaryText(c: PreviewCounts): string {
  const parts = [`${c.ready} ready`, `${c.unchanged} already there`, `${c.refused} refused`, `${c.skipped} skipped`];
  if (c.unchecked > 0) parts.push(`${c.unchecked} not checked yet`);
  if (c.joined) parts.push(`${c.joined} continue${c.joined === 1 ? "s" : ""} the post above`);
  return `${c.rows} ${c.rows === 1 ? "row" : "rows"}: ${parts.join(", ")}.`;
}

function Issues({ kind, issues, tone }: { kind: ImportKind; issues: RowIssue[]; tone: "refusal" | "warning" }) {
  return (
    <>
      {issues.map((i, n) => (
        <li key={`${tone}-${i.code}-${i.field}-${n}`} className={`scp-import__reason--${tone}`}>
          {tone === "refusal" ? "Refused: " : "Note: "}{rowCodeText(i.code, i.field ? fieldLabel(kind, i.field) : undefined)}
        </li>
      ))}
    </>
  );
}

function WhatItDoes({ row, kind, timeZone }: { row: ImportRow; kind: ImportKind; timeZone: string }) {
  if (kind === "allocation") {
    const entries = row.changes ? Object.entries(row.changes) : [];
    if (entries.length === 0) return <span className="scp-table__sub">{row.outcome === "unchanged" ? "Nothing to change." : ""}</span>;
    return (
      <ul className="scp-import__changes">
        {entries.map(([field, v]) => <li key={field}>{fieldLabel(kind, field)}: {valueText(v.from)} to {valueText(v.to)}</li>)}
      </ul>
    );
  }
  if (!row.post) return null;
  const when = scheduledText(row.post.scheduledAt, timeZone);
  return (
    <>
      <span className="scp-table__client">{row.post.title ?? ""}</span>
      <span className="scp-table__sub">
        {[row.post.format, when, row.post.isExtra ? "extra post" : null].filter(Boolean).join(" · ")}
      </span>
      {row.cycle?.created && (
        <span className="scp-table__sub">Opens the month&rsquo;s cycle{row.cycle.deadline ? `, deadline ${row.cycle.deadline}` : ""}.</span>
      )}
    </>
  );
}

export function SheetImportPreview({
  kind, answer, offset, skip, previewedSkip, cellOf, timeZone, onToggle, disabled, caption,
}: {
  kind: ImportKind;
  answer: ImportAnswer;
  /** The header's index in the sheet (0 when it has none): added to the server's row index for the number the sheet shows. */
  offset: number;
  /** The rows currently unticked. */
  skip: ReadonlySet<number>;
  /** The rows that were unticked when the preview was made. */
  previewedSkip: ReadonlySet<number>;
  /** The sheet's own text for a row's client, for a row the server could not name. */
  cellOf: (row: number) => string;
  timeZone: string;
  onToggle: (row: number, include: boolean) => void;
  disabled?: boolean;
  caption: string;
}) {
  return (
    <div className="scp-tablewrap">
      <table className="scp-table scp-import__table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Import</th>
            <th scope="col">Row</th>
            <th scope="col">Client</th>
            <th scope="col">What it does</th>
            <th scope="col">Outcome</th>
            <th scope="col">Why</th>
          </tr>
        </thead>
        <tbody>
          {answer.rows.map((r) => {
            if (continuesAbove(r)) {
              return (
                <tr key={r.row} className="scp-import__row--joined">
                  <td />
                  <td className="scp-table__num">{r.row + 1 + offset}</td>
                  <td colSpan={4}><span className="scp-table__sub">Continues the post above</span></td>
                </tr>
              );
            }
            const shown = shownOutcome(r, skip, previewedSkip);
            const label = shown === "unchecked" ? "Not checked yet" : OUTCOME_LABEL[shown];
            const included = !skip.has(r.row);
            return (
              <tr key={r.row} className={shown === "refused" ? "scp-import__row--refused" : shown === "skipped" ? "scp-import__row--skipped" : undefined}>
                <td>
                  <span className="scp-import__check">
                    <input type="checkbox" checked={included} disabled={disabled} aria-label={`Import row ${r.row + 1 + offset}`} onChange={(e) => onToggle(r.row, e.target.checked)} />
                  </span>
                </td>
                <td className="scp-table__num">{r.row + 1 + offset}</td>
                <td><span className="scp-table__client">{r.clientName ?? (cellOf(r.row) || "No client")}</span></td>
                <td>{shown === "skipped" || shown === "unchecked" ? null : <WhatItDoes row={r} kind={kind} timeZone={timeZone} />}</td>
                <td><span className={`scp-import__outcome scp-import__outcome--${shown}`}>{label}</span></td>
                <td>
                  {shown === "skipped" ? <span className="scp-table__sub">Left out of the import.</span>
                    : shown === "unchecked" ? <span className="scp-table__sub">Update the preview to check this row.</span>
                    : (r.refusals.length > 0 || r.warnings.length > 0) && (
                      <ul className="scp-import__reasons">
                        <Issues kind={kind} issues={r.refusals} tone="refusal" />
                        <Issues kind={kind} issues={r.warnings} tone="warning" />
                      </ul>
                    )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
