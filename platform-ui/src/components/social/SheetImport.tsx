"use client";
// SCP-6a — "Import from your sheet" (BFF §63.23, SCP-D10): the Social Media team's one-off move from the sheet. Six steps: what (the allocation or a
// month's plan), the sheet (an .xlsx or .csv, or pasted rows), the columns (guessed from the header row, changeable), the names the server could not
// match, the preview (every row's outcome, untick to skip) and the import with its result.
//
// SCP-6 rehearsal finding: a real sheet has title rows above the column names. The person says which row holds them (the page proposes one with
// `detectHeaderRow`); only the rows from there on are sent, so the server's row indexes are into those. Every row number the page shows is the sheet's own:
// the server's index + 1 + `offset` (the header's index, 0 when there is none).
//
// WHAT THE PAGE DOES AND DOES NOT DO. It reads the file in the browser only to hand it to `import/parse`, maps columns, and shows what the server
// answered. Which cell is a client, how a date is read and why a row is refused are the server's (`lib/sheetImport.ts` words the codes). Nothing is
// written until "Import N rows", which the server runs again in one transaction; if a row the person kept is refused it writes nothing and answers the
// preview again, which is drawn here with the refused rows marked. Only the four Social approvers may import (`social_engagement` · `plan`): the page
// gate is a hint, and the server's 403 `not_a_social_approver` is the boundary.
import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { applyImport, parseSheet, previewImport } from "@/lib/socialImportActions";
import { shiftMonth } from "@/lib/deptCalendar";
import {
  DATE_ORDER_LABEL, IMPORT_KIND_LABEL, IMPORT_STEPS, MAX_IMPORT_ROWS, MAX_SHEET_BYTES, blankRowIndexes, buildImportBody, columnLetter, detectHeaderRow,
  duplicateColumns, fieldLabel, fieldsFor, guessColumns, headerCandidates, headerRowLabel, templateCsv, templateFilename, type DateOrder, type ImportAnswer, type ImportDraft, type ImportKind, type SheetTab,
  type UnmatchedClient, type UnmatchedOfficer,
} from "@/lib/sheetImport";
import { SheetImportPreview, previewCounts, summaryText } from "./SheetImportPreview";
import "./cycles.css";
import "./allocation.css";
import "./sheet-import.css";

export interface ImportPerson { id: string; name: string }

type Step = 1 | 2 | 3 | 4 | 5 | 6;
type Problem = { text: string; field?: string };

const browserZone = (): string => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
};

/** A file as base64, read in the browser (the route takes `contentBase64`). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("The file could not be read."));
    reader.onload = () => {
      const url = typeof reader.result === "string" ? reader.result : "";
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

/** Saves the template as a file, client-side (a Blob), so the page needs no route for it. */
function downloadTemplate(kind: ImportKind): void {
  const url = URL.createObjectURL(new Blob([templateCsv(kind)], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = templateFilename(kind);
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** "Download CSV template": the headers of the chosen kind, in the contract's field order. */
export function TemplateButton({ kind, label }: { kind: ImportKind; label?: string }) {
  return (
    <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => downloadTemplate(kind)}>
      {label ?? "Download CSV template"}
    </button>
  );
}

/** The six steps as a list. With `current` the wizard's progress (that step is `aria-current="step"`); without it, an explanation, a sentence per step. */
export function ImportSteps({ current }: { current?: Step }) {
  if (current === undefined) {
    return (
      <ol className="scp-import__explain" aria-label="The six steps">
        {IMPORT_STEPS.map((s) => <li key={s.key}><strong>{s.title}.</strong> {s.blurb}</li>)}
      </ol>
    );
  }
  return (
    <ol className="scp-import__steps" aria-label="Steps">
      {IMPORT_STEPS.map((s, i) => (
        <li key={s.key} className={`scp-import__step${i + 1 < current ? " scp-import__step--done" : ""}`} aria-current={i + 1 === current ? "step" : undefined}>
          {s.title}
        </li>
      ))}
    </ol>
  );
}

const rowLabel = (rows: number[], offset: number): string => `Row${rows.length === 1 ? "" : "s"} ${rows.map((r) => r + 1 + offset).join(", ")}`;

/** The header select's value for "No header row". */
const NO_HEADER = "none";

/** Names the server could not match stay listed (with the person's pick) when a later preview no longer lists them. */
function mergeNames(prev: { clients: UnmatchedClient[]; officers: UnmatchedOfficer[] }, next: ImportAnswer["unmatched"]) {
  const merge = <T extends { sheetName: string }>(a: T[], b: T[]): T[] => [...a.map((x) => b.find((y) => y.sheetName === x.sheetName) ?? x), ...b.filter((y) => !a.some((x) => x.sheetName === y.sheetName))];
  return { clients: merge(prev.clients, next.clients), officers: merge(prev.officers, next.officers) };
}

export function SheetImport({
  deptId, thisMonth, engagements, officers, officersKnown,
}: {
  deptId: string;
  /** The report month (`YYYY-MM`): a plan import starts at the month after it, and never before it. */
  thisMonth: string;
  /** Every open client's engagement, for the client picker (the suggestions come first). */
  engagements: readonly ImportPerson[];
  /** The company's members, for the officer picker. */
  officers: readonly ImportPerson[];
  /** False when the member list could not be read: the officer picker is then empty and the page says so. */
  officersKnown: boolean;
}) {
  const uid = useId();
  const [step, setStep] = useState<Step>(1);
  const [kind, setKind] = useState<ImportKind>("allocation");
  const [month, setMonth] = useState(() => shiftMonth(thisMonth, 1));
  const [source, setSource] = useState<"file" | "paste">("file");
  const [file, setFile] = useState<File | null>(null);
  const [pasted, setPasted] = useState("");
  const [tabs, setTabs] = useState<SheetTab[] | null>(null);
  const [tabIdx, setTabIdx] = useState(0);
  /** The index (into the tab's rows) of the row that holds the column names; null: the sheet has none. */
  const [headerIdx, setHeaderIdx] = useState<number | null>(0);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [dateOrder, setDateOrder] = useState<DateOrder>("dmy");
  const [skip, setSkip] = useState<ReadonlySet<number>>(new Set());
  const [previewedSkip, setPreviewedSkip] = useState<ReadonlySet<number>>(new Set());
  const [clientMatches, setClientMatches] = useState<Record<string, string>>({});
  const [officerMatches, setOfficerMatches] = useState<Record<string, string>>({});
  const [names, setNames] = useState<{ clients: UnmatchedClient[]; officers: UnmatchedOfficer[] }>({ clients: [], officers: [] });
  const [answer, setAnswer] = useState<ImportAnswer | null>(null);
  const [refusedApply, setRefusedApply] = useState(false);
  const [result, setResult] = useState<ImportAnswer | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  // Moving to another step puts focus on its title, so a keyboard or screen-reader user lands on it (not on the first mount).
  const shownStep = useRef<Step>(step);
  useEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    headingRef.current?.focus();
  }, [step]);

  const tab = tabs?.[tabIdx] ?? null;
  const rows = tab?.rows ?? [];
  const fields = fieldsFor(kind);
  const headerRow = headerIdx !== null;
  const offset = headerIdx ?? 0;
  /** What is sent: the rows from the header on (nothing above it), or every row when there is no header. The server's row indexes and `skip` are into these. */
  const sentRows = headerIdx === null ? rows : rows.slice(headerIdx);
  const headers = headerIdx !== null ? (rows[headerIdx] ?? []) : [];
  const columnCount = rows.reduce((n, r) => Math.max(n, r.length), 0);
  const hasNames = names.clients.length + names.officers.length > 0;
  const errId = `${uid}-error`;
  const rowLimit = MAX_IMPORT_ROWS[kind];

  const draft = (over: Partial<ImportDraft> = {}): ImportDraft => ({
    kind, rows: sentRows, headerRow, mapping, skip, clientMatches, officerMatches, month, dateOrder, timeZone: browserZone(), ...over,
  });

  /**
   * A fresh read of a tab (or of the same tab under another header row or kind): the header row (proposed by `detectHeaderRow` unless the person chose
   * one; `null` is "no header row"), the guess from it, the blank rows from it on unticked, every later step cleared.
   */
  function startTab(nextKind: ImportKind, t: SheetTab | null, header?: number | null) {
    const idx = header !== undefined ? header : t ? detectHeaderRow(nextKind, t.rows) : null;
    setHeaderIdx(idx);
    const guess = idx !== null && t && t.rows[idx] ? guessColumns(nextKind, t.rows[idx]) : {};
    setMapping(Object.fromEntries(fieldsFor(nextKind).map((x) => [x.key, x.key in guess ? String(guess[x.key]) : ""])));
    setSkip(new Set(t ? blankRowIndexes(idx === null ? t.rows : t.rows.slice(idx)) : []));
    setPreviewedSkip(new Set());
    setClientMatches({}); setOfficerMatches({});
    setNames({ clients: [], officers: [] });
    setAnswer(null); setResult(null); setRefusedApply(false);
  }

  function chooseKind(next: ImportKind) {
    setKind(next);
    if (tab) startTab(next, tab);
  }

  async function guarded(work: () => Promise<void>) {
    setBusy(true);
    setProblem(null);
    try { await work(); } catch { setProblem({ text: "The ERP answered in a way this page cannot read. Nothing was written. Try again, and tell IT if it keeps happening." }); } finally { setBusy(false); }
  }

  async function readSheet() {
    await guarded(async () => {
      let res;
      if (source === "file") {
        if (!file) { setProblem({ text: "Choose an .xlsx or .csv file first.", field: "file" }); return; }
        if (file.size > MAX_SHEET_BYTES) { setProblem({ text: "The file is over 2 MB. Cut the sheet down, or paste the rows instead.", field: "file" }); return; }
        res = await parseSheet({ filename: file.name, contentBase64: await fileToBase64(file) });
      } else {
        if (pasted.trim() === "") { setProblem({ text: "Paste the rows first.", field: "text" }); return; }
        res = await parseSheet({ text: pasted });
      }
      if (!res.ok) { setProblem({ text: res.message, field: res.field === "contentBase64" || res.field === "filename" ? "file" : res.field }); return; }
      if (res.tabs.length === 0) { setProblem({ text: "The sheet has no tabs with anything in them.", field: source === "file" ? "file" : "text" }); return; }
      setTabs(res.tabs);
      setTabIdx(0);
      startTab(kind, res.tabs[0]);
    });
  }

  function chooseTab(i: number) {
    setTabIdx(i);
    startTab(kind, tabs?.[i] ?? null);
  }

  function chooseHeader(value: string) {
    startTab(kind, tab, value === NO_HEADER ? null : Number(value));
  }

  function goTo(next: Step) {
    setProblem(null);
    setStep(next);
  }

  /** `POST import/<kind>` with `dryRun: true`. Answers the preview, or null after saying why not. */
  async function check(over: Partial<ImportDraft>): Promise<ImportAnswer | null> {
    const d = draft(over);
    const res = await previewImport(kind, buildImportBody(d, true));
    if (!res.ok) { setProblem({ text: res.message, field: res.field }); return null; }
    setAnswer(res.answer);
    setPreviewedSkip(new Set(d.skip));
    setRefusedApply(false);
    return res.answer;
  }

  async function previewFromColumns() {
    await guarded(async () => {
      const a = await check({ clientMatches: {}, officerMatches: {} });
      if (!a) return;
      setClientMatches({}); setOfficerMatches({});
      setNames({ clients: a.unmatched.clients, officers: a.unmatched.officers });
      goTo(a.unmatched.clients.length + a.unmatched.officers.length > 0 ? 4 : 5);
    });
  }

  async function previewFromNames() {
    await guarded(async () => {
      const a = await check({});
      if (!a) return;
      setNames((n) => mergeNames(n, a.unmatched));
      goTo(5);
    });
  }

  async function previewAgain() {
    await guarded(async () => {
      const a = await check({});
      if (a) setNames((n) => mergeNames(n, a.unmatched));
    });
  }

  async function runImport() {
    await guarded(async () => {
      const res = await applyImport(kind, buildImportBody(draft(), false));
      if (res.ok) { setResult(res.answer); goTo(6); return; }
      if (res.error === "import_rows_refused" && res.detail) {
        setAnswer(res.detail);
        setPreviewedSkip(new Set(skip));
        setRefusedApply(true);
      }
      setProblem({ text: res.message, field: res.field });
    });
  }

  function toggleRow(row: number, include: boolean) {
    setSkip((s) => { const n = new Set(s); if (include) n.delete(row); else n.add(row); return n; });
  }

  // ── Step 2's checks ────────────────────────────────────────────────────────────────────────────────────────
  const rowsToImport = sentRows.length - (headerRow ? 1 : 0);
  const tooManyRows = sentRows.length > rowLimit;
  const sheetProblem = !tab ? null : rowsToImport <= 0 ? "This tab has no rows to import." : tooManyRows ? `This tab has ${sentRows.length} rows${offset > 0 ? " from the header row on" : ""}; one import takes ${rowLimit} at most. Split the sheet.` : null;

  // ── Step 3's checks ────────────────────────────────────────────────────────────────────────────────────────
  const missing = fields.filter((x) => x.required && (mapping[x.key] ?? "") === "").map((x) => x.label);
  const dupes = duplicateColumns(mapping);
  const dupeText = dupes.map((d) => `${columnLetter(d.column)} is given to ${d.fields.map((k) => fieldLabel(kind, k)).join(" and ")}`).join("; ");
  const columnsProblem = missing.length > 0 ? `Choose a column for: ${missing.join(", ")}.` : dupes.length > 0 ? `One column can hold one field only: ${dupeText}.` : null;

  // ── Step 5 ─────────────────────────────────────────────────────────────────────────────────────────────────
  const counts = answer ? previewCounts(answer, skip, previewedSkip) : null;
  const clientCol = mapping.client !== undefined && mapping.client !== "" ? Number(mapping.client) : -1;
  const cellOf = (row: number): string => (clientCol >= 0 ? (sentRows[row]?.[clientCol] ?? "").trim() : "");
  const stale = counts !== null && counts.unchecked > 0;
  const canImport = counts !== null && counts.ready > 0 && counts.refused === 0 && !stale && !busy;

  const problemFor = (field: string): boolean => problem?.field === field;
  const describe = (field: string): { "aria-describedby"?: string; "aria-invalid"?: true } => (problemFor(field) ? { "aria-describedby": errId, "aria-invalid": true } : {});
  const errorNote = problem && (
    <p className="scp-msg scp-msg--error" id={errId} role="alert">{problem.text}</p>
  );

  const clientOptions = (c: UnmatchedClient) => {
    const suggested = c.suggestions;
    const rest = engagements.filter((e) => !suggested.some((s) => s.engagementId === e.id));
    return (
      <>
        <option value="">Leave unmatched (its rows are refused)</option>
        {suggested.length > 0 && <optgroup label="Suggested">{suggested.map((s) => <option key={s.engagementId} value={s.engagementId}>{s.clientName}</option>)}</optgroup>}
        {rest.length > 0 && <optgroup label="All open clients">{rest.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</optgroup>}
      </>
    );
  };

  // ── Step 6 ─────────────────────────────────────────────────────────────────────────────────────────────────
  const dept = encodeURIComponent(deptId);
  const written = result ? result.rows.filter((r) => r.outcome === "ready") : [];
  const already = result ? result.rows.filter((r) => r.outcome === "unchanged").length : 0;
  const touched = [...new Map(written.filter((r) => r.engagementId).map((r) => [r.engagementId as string, r.clientName ?? "this client"])).entries()];
  const resultText = result
    ? `Imported ${written.length} ${written.length === 1 ? "row" : "rows"}${already > 0 ? `, ${already} already there` : ""}${result.summary.skipped > 0 ? `, ${result.summary.skipped} skipped` : ""}.`
    : "";
  const planHref = (id: string) => `/departments/${dept}/profile/${encodeURIComponent(id)}?tab=plan${kind === "plan" ? `&month=${month}` : ""}`;

  return (
    <div className="scp-import">
      <ImportSteps current={step} />
      {/* The one polite region of the wizard: the result is announced here, not by role="log". */}
      <p className="scp-sr-only" role="status" aria-live="polite">{resultText}</p>

      {step === 1 && (
        <section className="scp-import__panel" aria-labelledby={`${uid}-t1`}>
          <h3 className="scp-import__title" id={`${uid}-t1`} tabIndex={-1} ref={headingRef}>1. What is in the sheet?</h3>
          <fieldset className="scp-import__choices">
            <legend>The sheet holds</legend>
            <label className="scp-import__choice">
              <input type="radio" name={`${uid}-kind`} checked={kind === "allocation"} onChange={() => chooseKind("allocation")} />
              <span>{IMPORT_KIND_LABEL.allocation}<small>One row per client: officer, posts per month, creative source, batch, report, platforms, formats and default time.</small></span>
            </label>
            <label className="scp-import__choice">
              <input type="radio" name={`${uid}-kind`} checked={kind === "plan"} onChange={() => chooseKind("plan")} />
              <span>{IMPORT_KIND_LABEL.plan}<small>One row per post: client, date, title, format, caption and the rest. Posts are created as planned.</small></span>
            </label>
          </fieldset>
          {kind === "plan" && (
            <div className="scp-field">
              <label htmlFor={`${uid}-month`}>Month of the plan</label>
              <input id={`${uid}-month`} className="scp-input" type="month" value={month} min={thisMonth} onChange={(e) => setMonth(e.target.value)} aria-describedby={`${uid}-month-hint`} />
              <span className="scp-field__hint" id={`${uid}-month-hint`}>One month per import. Posts dated outside it, or before today, are refused.</span>
            </div>
          )}
          <div className="scp-import__nav">
            <TemplateButton kind={kind} />
            <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={kind === "plan" && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)} onClick={() => goTo(2)}>Next: the sheet</button>
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="scp-import__panel" aria-labelledby={`${uid}-t2`}>
          <h3 className="scp-import__title" id={`${uid}-t2`} tabIndex={-1} ref={headingRef}>2. The sheet</h3>
          <fieldset className="scp-import__choices">
            <legend>Where is the sheet?</legend>
            <label className="scp-import__choice">
              <input type="radio" name={`${uid}-source`} checked={source === "file"} onChange={() => setSource("file")} />
              <span>Upload a file<small>An .xlsx or .csv, 2 MB at most.</small></span>
            </label>
            <label className="scp-import__choice">
              <input type="radio" name={`${uid}-source`} checked={source === "paste"} onChange={() => setSource("paste")} />
              <span>Paste rows<small>Select the cells in Google Sheets or Excel, copy, and paste them here.</small></span>
            </label>
          </fieldset>
          {source === "file" ? (
            <div className="scp-field">
              <label htmlFor={`${uid}-file`}>Sheet file (.xlsx or .csv)</label>
              <input
                id={`${uid}-file`} className="scp-input" type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={(e) => { setFile(e.target.files?.[0] ?? null); setProblem(null); }} {...describe("file")}
              />
            </div>
          ) : (
            <div className="scp-field">
              <label htmlFor={`${uid}-paste`}>Pasted rows</label>
              <textarea
                id={`${uid}-paste`} className="scp-input scp-textarea scp-import__paste" value={pasted}
                onChange={(e) => { setPasted(e.target.value); setProblem(null); }} {...describe("text")}
              />
            </div>
          )}
          {errorNote}
          <div className="scp-import__nav">
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={readSheet} disabled={busy}>{busy ? "Reading…" : tabs ? "Read the sheet again" : "Read the sheet"}</button>
          </div>

          {tabs && tab && (
            <>
              {tabs.length > 1 && (
                <div className="scp-field">
                  <label htmlFor={`${uid}-tab`}>Tab</label>
                  <select id={`${uid}-tab`} className="scp-input" value={tabIdx} onChange={(e) => chooseTab(Number(e.target.value))}>
                    {tabs.map((t, i) => <option key={`${t.name}-${i}`} value={i}>{t.name} ({t.rows.length} {t.rows.length === 1 ? "row" : "rows"})</option>)}
                  </select>
                </div>
              )}
              <div className="scp-field">
                <label htmlFor={`${uid}-header`}>Which row holds the column names?</label>
                <select id={`${uid}-header`} className="scp-input" value={headerIdx === null ? NO_HEADER : String(headerIdx)} onChange={(e) => chooseHeader(e.target.value)} aria-describedby={`${uid}-header-hint`}>
                  {headerCandidates(rows).map((i) => <option key={i} value={String(i)}>{headerRowLabel(i, rows[i])}</option>)}
                  <option value={NO_HEADER}>No header row: I&rsquo;ll choose the columns myself</option>
                </select>
                <span className="scp-field__hint" id={`${uid}-header-hint`}>Rows above it, such as a title, are left out.</span>
              </div>
              <div className="scp-tablewrap">
                <table className="scp-table scp-import__sample">
                  <caption>The first rows of {tab.name}, as the ERP read them.</caption>
                  <thead>
                    <tr>{Array.from({ length: Math.min(columnCount, 12) }, (_, c) => <th scope="col" key={c}>{columnLetter(c)}</th>)}</tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 5).map((r, i) => (
                      <tr key={i}>{Array.from({ length: Math.min(columnCount, 12) }, (_, c) => <td key={c} title={r[c] ?? ""}>{r[c] ?? ""}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {sheetProblem && <p className="scp-msg scp-msg--error" role="alert">{sheetProblem}</p>}
            </>
          )}
          <div className="scp-import__nav">
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => goTo(1)}>Back</button>
            <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={!tab || sheetProblem !== null} onClick={() => goTo(3)}>Next: the columns</button>
          </div>
        </section>
      )}

      {step === 3 && tab && (
        <section className="scp-import__panel" aria-labelledby={`${uid}-t3`}>
          <h3 className="scp-import__title" id={`${uid}-t3`} tabIndex={-1} ref={headingRef}>3. Which column is which?</h3>
          <p className="scp-lede" style={{ margin: 0 }}>
            {headerRow ? "The page matched the header row to the fields; change any guess." : "There is no header row to guess from: choose the columns yourself."}
            {" "}A field left on &ldquo;Not in my sheet&rdquo; is not imported, and an empty cell never clears a value.
          </p>
          <ul className="scp-import__fields">
            {fields.map((x) => {
              const id = `${uid}-col-${x.key}`;
              return (
                <li key={x.key} className="scp-import__field">
                  <label htmlFor={id}>{x.label}{x.required && <span className="scp-import__req">(required)</span>}</label>
                  <select
                    id={id} className="scp-input" value={mapping[x.key] ?? ""} aria-describedby={`${id}-hint${problemFor(`columns.${x.key}`) ? ` ${errId}` : ""}`}
                    aria-invalid={problemFor(`columns.${x.key}`) || undefined} onChange={(e) => setMapping((m) => ({ ...m, [x.key]: e.target.value }))}
                  >
                    <option value="">Not in my sheet</option>
                    {Array.from({ length: columnCount }, (_, c) => {
                      const h = (headers[c] ?? "").trim();
                      return <option key={c} value={String(c)}>{`Column ${columnLetter(c)}${h ? `: ${h.length > 40 ? `${h.slice(0, 40)}…` : h}` : ""}`}</option>;
                    })}
                  </select>
                  <span className="scp-field__hint" id={`${id}-hint`}>{x.hint}</span>
                </li>
              );
            })}
          </ul>
          {kind === "plan" && (
            <div className="scp-field">
              <label htmlFor={`${uid}-order`}>Date order</label>
              <select id={`${uid}-order`} className="scp-input" value={dateOrder} onChange={(e) => setDateOrder(e.target.value as DateOrder)} aria-describedby={`${uid}-order-hint`}>
                {(Object.keys(DATE_ORDER_LABEL) as DateOrder[]).map((o) => <option key={o} value={o}>{DATE_ORDER_LABEL[o]}</option>)}
              </select>
              <span className="scp-field__hint" id={`${uid}-order-hint`}>
                Dates like 2026-11-03 and real spreadsheet dates are always year, month, day. Times are read in {browserZone()}, this browser&rsquo;s time zone.
              </span>
            </div>
          )}
          {columnsProblem && <p className="scp-note scp-note--reason" id={`${uid}-colproblem`}>{columnsProblem}</p>}
          {errorNote}
          <div className="scp-import__nav">
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => goTo(2)}>Back</button>
            <button
              type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={busy || columnsProblem !== null}
              aria-describedby={columnsProblem ? `${uid}-colproblem` : undefined} onClick={previewFromColumns}
            >
              {busy ? "Checking…" : "Preview"}
            </button>
          </div>
        </section>
      )}

      {step === 4 && (
        <section className="scp-import__panel" aria-labelledby={`${uid}-t4`}>
          <h3 className="scp-import__title" id={`${uid}-t4`} tabIndex={-1} ref={headingRef}>4. Names the ERP could not match</h3>
          <p className="scp-lede" style={{ margin: 0 }}>
            Pick who each name in the sheet is. A client must already have an open engagement in the ERP; one is never created here. Names you leave alone have their rows refused.
          </p>
          {names.clients.length === 0 && names.officers.length === 0 && <p className="scp-note">Every name matched.</p>}
          <ul className="scp-import__names">
            {names.clients.map((c, i) => {
              const id = `${uid}-client-${i}`;
              return (
                <li key={`c-${c.sheetName}`} className="scp-import__name">
                  <label htmlFor={id}>Client for &ldquo;{c.sheetName}&rdquo;</label>
                  <select id={id} className="scp-input" value={clientMatches[c.sheetName] ?? ""} aria-describedby={`${id}-rows`} onChange={(e) => setClientMatches((m) => ({ ...m, [c.sheetName]: e.target.value }))}>
                    {clientOptions(c)}
                  </select>
                  <small id={`${id}-rows`}>{rowLabel(c.rows, offset)}</small>
                </li>
              );
            })}
            {names.officers.map((o, i) => {
              const id = `${uid}-officer-${i}`;
              return (
                <li key={`o-${o.sheetName}`} className="scp-import__name">
                  <label htmlFor={id}>Officer for &ldquo;{o.sheetName}&rdquo;</label>
                  <select id={id} className="scp-input" value={officerMatches[o.sheetName] ?? ""} aria-describedby={`${id}-rows`} onChange={(e) => setOfficerMatches((m) => ({ ...m, [o.sheetName]: e.target.value }))}>
                    <option value="">Leave unmatched (its rows are refused)</option>
                    {officers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <small id={`${id}-rows`}>{rowLabel(o.rows, offset)}</small>
                </li>
              );
            })}
          </ul>
          {names.officers.length > 0 && !officersKnown && (
            <p className="scp-note" role="status">The company&rsquo;s member list could not be read, so officers cannot be picked here. Import the clients first and set the officers in the Allocation.</p>
          )}
          {errorNote}
          <div className="scp-import__nav">
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => goTo(3)}>Back</button>
            <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={busy} onClick={previewFromNames}>{busy ? "Checking…" : "Preview again"}</button>
          </div>
        </section>
      )}

      {step === 5 && answer && counts && (
        <section className="scp-import__panel" aria-labelledby={`${uid}-t5`}>
          <h3 className="scp-import__title" id={`${uid}-t5`} tabIndex={-1} ref={headingRef}>5. Preview</h3>
          <p className="scp-import__summary">{summaryText(counts)}</p>
          {refusedApply && <p className="scp-msg scp-msg--error" role="alert">Nothing was written: the rows marked Refused need fixing, or unticking, first.</p>}
          {!refusedApply && errorNote}
          {counts.refused > 0 && !refusedApply && (
            <p className="scp-note">Rows marked Refused stop the import. Fix the sheet or the names, or untick them to leave them out.</p>
          )}
          {stale && <p className="scp-note" role="status">You ticked rows back in. Update the preview so they are checked before you import.</p>}
          <SheetImportPreview
            kind={kind} answer={answer} offset={offset} skip={skip} previewedSkip={previewedSkip} cellOf={cellOf} timeZone={browserZone()} onToggle={toggleRow} disabled={busy}
            caption={`${IMPORT_KIND_LABEL[kind]}${kind === "plan" ? " for the month you chose" : ""}: every row of the sheet, what the import would do with it and why. Nothing has been written yet.`}
          />
          <div className="scp-import__nav">
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => goTo(hasNames ? 4 : 3)}>Back</button>
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" disabled={busy} onClick={previewAgain}>Update the preview</button>
            <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" disabled={!canImport} onClick={runImport}>
              {busy ? "Importing…" : `Import ${counts.ready} ${counts.ready === 1 ? "row" : "rows"}`}
            </button>
          </div>
        </section>
      )}

      {step === 6 && result && (
        <section className="scp-import__panel" aria-labelledby={`${uid}-t6`}>
          <h3 className="scp-import__title" id={`${uid}-t6`} tabIndex={-1} ref={headingRef}>6. Imported</h3>
          <p className="scp-msg scp-msg--ok">{resultText}</p>
          <ul className="scp-import__links">
            <li><Link href={`/departments/${dept}/allocation`}>Open the Allocation</Link></li>
            {touched.map(([id, name]) => <li key={id}><Link href={planHref(id)}>{`${name}: Plan tab`}</Link></li>)}
            <li><Link href={`/departments/${dept}/settings`}>Open Settings (the deadline table)</Link></li>
          </ul>
          {result.importId && <p className="scp-note">Import reference: {result.importId}. Every activity row of this import carries it.</p>}
        </section>
      )}
    </div>
  );
}
