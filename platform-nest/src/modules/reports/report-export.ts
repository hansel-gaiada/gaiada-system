// TR-18 — the XLSX/CSV export service (§6.3). Pure core (workbook/CSV assembly) + a thin
// filename/storage-key naming convention at the edge; the controller (reports.controller.ts)
// owns the I/O (authz, fetching the ReportDocument, persisting bytes via the EXISTING files
// plumbing — `storage()` + the `files` table, §"Storage" in the ticket — never a second storage
// path). This file never touches Postgres or the network.
//
// ─────────────────────────────── FORMATS IN SCOPE ─────────────────────────────────────────────
// `xlsx`, `csv`, AND `pdf` (TR-21 added the third). `EXPORT_FORMATS`/`ExportFormat` gained the
// member, and `exportContentType`/`exportFileExtension` gained a branch, exactly as this comment
// predicted — but `renderExport()` (the buffer-producing entry point) deliberately does NOT gain
// a `"pdf"` case: PDF bytes come from a real network round trip to the `report-renderer` sidecar
// (mint a one-shot token, call the sidecar, get bytes back — report-pdf-export.ts), which would
// violate this file's own "never touches Postgres or the network" invariant a few lines below.
// `reports.controller.ts`'s `createExport` branches on `format === "pdf"` BEFORE calling
// `renderExport`, and calls `report-pdf-export.ts` instead for that one format. Naming/typing
// helpers here (`exportFilename`/`exportContentType`/`exportFileExtension`/`exportStorageKey`)
// are all still shared across all three formats — only byte-rendering is not.
//
// ─────────────────────────────── AD-HOC MARKING (mandatory, §6.3 + §15 2026-07-30 amendment) ──
// Every artifact this module produces carries an unmissable provenance mark:
//   - `doc.header.sealed === false` (true for EVERY custom range by construction, §0057 rule 2,
//     and also true for a live-computed calendar period that has not been sealed yet) ->
//     `AD HOC · UNSEALED · as of <generatedAt>` in cell A1 (xlsx) / the first line (csv), PLUS a
//     `Provenance` sheet/section carrying the range and every `header.warnings` flag.
//   - `doc.header.sealed === true` -> `SEALED · rev <revision> · <seal_hash prefix>`. The hash
//     is NOT part of `ReportDocument` (it lives on `report_periods.seal_hash`) — the caller looks
//     it up via `getPeriodById` and passes it in as `opts.sealHash`; absent (should not happen for
//     a genuinely sealed doc, but defensively handled) renders as `unknown` rather than crashing.
// This mark is unconditional — there is no code path that omits it, which is what makes the ⚡
// assertion in the test suite meaningful (see report-export.test.ts).
//
// ─────────────────────────────── PERCENT-UNIT CONVENTION (ruling 3, stated explicitly) ─────────
// `ReportKpi`/`ReportSeries`/`ReportTable` unit `"percent"` values are stored in the DOCUMENT as a
// 0..1 FRACTION (confirmed by TR-17's own bug: the viewer's `KpiTiles` multiplies by 100 to render
// "86%", and `ReportTableView` was fixed to do the same for table cells — two renderers of the
// SAME underlying fraction). This export module makes the IDENTICAL choice for the same reason
// TR-17's fix did: **every percent-unit numeric cell (KPI value/delta, series points, table cells)
// is exported as the 0-100 PERCENTAGE NUMBER, never the raw 0-1 fraction** — so a KPI tile reading
// "86%" and this workbook's KPIs sheet both show `86`, not one showing `86` and the other `0.86`.
// Ratio numerator/denominator columns are UNCHANGED (they are raw counts, not fractions, so there
// is nothing to scale). The `Provenance` sheet states this convention in writing, because a
// spreadsheet user who does not read source code has no other way to know it.
import ExcelJS from "exceljs";
import { getReportMetric } from "./metrics";
import type { ReportDocument, ReportKpi, ReportSeries, ReportTable, ReportUnit } from "./report-document";

export type ExportFormat = "xlsx" | "csv" | "pdf";
export const EXPORT_FORMATS: ReadonlySet<string> = new Set(["xlsx", "csv", "pdf"]);

export type ExportKpiClass = "additive" | "ratio" | "point-in-time" | "distinct";

export interface ExportOptions {
  /** `report_periods.seal_hash`, looked up by the caller when `doc.header.sealed`. */
  sealHash?: string;
}

// ═══════════════════════════════ PURE — naming ═══════════════════════════════

/** Storage-key-safe encoding of a scopeRef segment: department scopeRefs are free-form org-node
 *  ids (e.g. `'d-hr'`), not always UUIDs, so this is `encodeURIComponent`, not a passthrough.
 *  `../../core/storage.ts`'s `safePath` already strips `..` sequences and normalizes `\`, so this
 *  only needs to keep the segment a single path component (no literal `/`). */
export function encodeScopeRefSegment(scopeRef: string): string {
  return encodeURIComponent(scopeRef);
}

export function decodeScopeRefSegment(segment: string): string {
  return decodeURIComponent(segment);
}

/** The storage key convention for an export job's bytes AND the only place grain/scopeRef are
 *  recorded for a job (the `files` table has no free metadata column — see the ticket's file-
 *  plumbing note) — `reports.controller.ts`'s `parseExportStorageKey` is this function's exact
 *  inverse, so re-authorizing a `GET .../exports/:jobId` read never trusts an unverified param. */
export function exportStorageKey(tenantId: string, grain: string, scopeRef: string, jobId: string): string {
  return `${tenantId}/report-exports/${grain}/${encodeScopeRefSegment(scopeRef)}/${jobId}`;
}

export interface ParsedExportKey {
  tenantId: string;
  grain: string;
  scopeRef: string;
  jobId: string;
}

export function parseExportStorageKey(key: string): ParsedExportKey | null {
  const parts = key.split("/");
  if (parts.length !== 5 || parts[1] !== "report-exports") return null;
  const [tenantId, , grain, scopeRefSegment, jobId] = parts;
  if (!tenantId || !grain || !scopeRefSegment || !jobId) return null;
  return { tenantId, grain, scopeRef: decodeScopeRefSegment(scopeRefSegment), jobId };
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 40) || "report";
}

/** `AD HOC · UNSEALED` / `SEALED · rev N · <hash>` provenance carried into the FILENAME —
 *  filesystem-safe (no `·`, no spaces-as-separators, no colons), the "survives into the stored
 *  PDF's metadata or filename" form the ⚡ acceptance bar explicitly permits (§6.3's own banner
 *  text is unsafe as a filename segment; xlsx/csv instead carry it in-cell/in-sheet, which a
 *  filename cannot do). PDF-only: `exportFilename` calls this ONLY for `format === "pdf"`, so
 *  every existing xlsx/csv filename (and its pinned test) is byte-for-byte unchanged. */
export function pdfProvenanceTag(doc: ReportDocument, opts: ExportOptions = {}): string {
  if (doc.header.sealed) {
    const prefix = opts.sealHash ? opts.sealHash.slice(0, 8) : "unknown";
    return `sealed-rev${doc.header.revision ?? 0}-${prefix}`;
  }
  return "adhoc-unsealed";
}

export function exportFilename(doc: ReportDocument, format: ExportFormat, opts: ExportOptions = {}): string {
  const h = doc.header;
  const base = `${slug(h.grain)}-${slug(h.scopeName || h.scopeRef)}-${h.periodStart}-to-${h.periodEnd}`;
  const stem = format === "pdf" ? `${base}-${pdfProvenanceTag(doc, opts)}` : base;
  return `${stem}.${exportFileExtension(format)}`;
}

export function exportFileExtension(format: ExportFormat): string {
  return format; // "xlsx" | "csv" | "pdf" — kept as its own function for a 1-line format->ext map
}

export function exportContentType(format: ExportFormat): string {
  if (format === "xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (format === "pdf") return "application/pdf";
  return "text/csv; charset=utf-8";
}

// ═══════════════════════════════ PURE — §5.4 class + the honesty banner ═══════════════════════

/** The KPIs sheet's CLASS column (§5.4 / this ticket's acceptance bar): `additive` / `ratio` /
 *  `point-in-time` / `distinct`. The two §5.4-class-N metrics are ALREADY self-describing via
 *  `ReportKpi.pointInTime`/`distinctOver` (document-builder.ts sets them — never omitted when
 *  applicable, per report-document.ts's own comment), so those flags are checked FIRST and are
 *  authoritative; the registry (`metrics.ts`) is the fallback for the additive/ratio majority.
 *  Defensive fallback (n/d shape) for a metricKey the registry does not recognise, so a future KPI
 *  never crashes the exporter — it degrades to a best-effort class rather than a 500. */
export function classifyKpi(kpi: ReportKpi): ExportKpiClass {
  if (kpi.pointInTime) return "point-in-time";
  if (kpi.distinctOver) return "distinct";
  try {
    const def = getReportMetric(kpi.metricKey);
    if (def.rangeClass === "ratio") return "ratio";
    if (def.rangeClass === "additive") return "additive";
    // non_additive without an explicit pointInTime/distinctOver flag should not occur (the two
    // seeded non_additive metrics both set one of those flags) — fall through to the n/d shape.
  } catch {
    // unknown metricKey — fall through
  }
  return kpi.numerator !== undefined && kpi.denominator !== undefined ? "ratio" : "additive";
}

/** Ruling 3's scaling: percent-unit values are exported 0-100, never the raw 0-1 fraction. */
export function scaleForUnit(value: number, unit: ReportUnit): number {
  return unit === "percent" ? value * 100 : value;
}

/** `AD HOC · UNSEALED · as of <ts>` for any unsealed document (every custom range, and any
 *  not-yet-sealed calendar period) or `SEALED · rev N · <hash prefix>` for a sealed one. This is
 *  the ONE function that decides the mark — every sheet/section below calls it, so there is no
 *  code path that can omit it (the ⚡ acceptance bar). */
export function bannerText(doc: ReportDocument, opts: ExportOptions = {}): string {
  if (doc.header.sealed) {
    const prefix = opts.sealHash ? opts.sealHash.slice(0, 12) : "unknown";
    return `SEALED · rev ${doc.header.revision ?? 0} · ${prefix}`;
  }
  return `AD HOC · UNSEALED · as of ${doc.header.generatedAt}`;
}

/** Every `Provenance` row (§6.3: "the range, and every `header.warnings` flag"). Key/value pairs,
 *  in display order; `warnings` entries are only emitted for flags that are actually SET (an
 *  absent flag means that condition does not apply to this document, not "false" worth stating). */
export function provenanceRows(doc: ExportOptions & { doc: ReportDocument }): [string, string][] {
  const { doc: d, sealHash } = doc;
  const h = d.header;
  const rows: [string, string][] = [
    ["Mark", bannerText(d, { sealHash })],
    ["Tenant", h.tenantId],
    ["Grain", h.grain],
    ["Scope", `${h.scopeName} (${h.scopeRef})`],
    ["Period kind", h.periodKind],
    ["Period label", h.periodLabel],
    ["Period start", h.periodStart],
    ["Period end", h.periodEnd],
    ["Day count", String(h.dayCount)],
    ["Generated at", h.generatedAt],
    ["Sealed", String(h.sealed)],
  ];
  if (h.customLabel) rows.push(["Custom label", h.customLabel]);
  if (h.periodId) rows.push(["Period id", h.periodId]);
  if (h.revision !== undefined) rows.push(["Revision", String(h.revision)]);
  if (h.sealed && sealHash) rows.push(["Seal hash", sealHash]);
  if (h.comparison) {
    rows.push(["Comparison window", `${h.comparison.periodStart} to ${h.comparison.periodEnd} (${h.comparison.dayCount} days)`]);
  }
  if (h.providerView) {
    rows.push(["Provider view", `${h.providerView.servedTenantName} (${h.providerView.servedTenantId})`]);
  }
  const w = h.warnings;
  if (w?.adHoc) rows.push(["Warning: ad hoc", "unsealed custom range — not the authoritative record"]);
  if (w?.partialPeriod) rows.push(["Warning: partial period", "range cuts across an incomplete week/month"]);
  if (w?.endsInFuture) rows.push(["Warning: ends in future", "periodEnd is after today — trailing days have no data yet"]);
  if (w?.precedesFactHistory) {
    rows.push(["Warning: precedes fact history", `first fact date ${w.precedesFactHistory.firstFactDate} — ${w.precedesFactHistory.affectedDays} affected day(s)`]);
  }
  if (w?.spansMembershipChange) rows.push(["Warning: spans membership change", "subject moved unit mid-range — department totals split"]);
  rows.push(["Percent convention", "percent-unit values in this workbook/file are 0-100 (e.g. 86 means 86%), not a 0-1 fraction"]);
  return rows;
}

// ═══════════════════════════════ PURE — CSV ═══════════════════════════════

/** Same quoting convention as `platform-ui/src/components/data/DataTable.tsx`'s client-side CSV
 *  export (`"` quoting, doubled internal quotes) — this is the server-side equivalent, so a user
 *  who already knows that shape from the UI sees the same shape from an export job. */
function csvCell(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return `"${s.replace(/"/g, '""')}"`;
}
function csvRow(cells: (string | number | boolean | null | undefined)[]): string {
  return cells.map(csvCell).join(",");
}

/** CSV has no concept of sheets, so the whole document is flattened into banner + sections
 *  (KPIs, one section per table, Series, Provenance), each with its own header row — the same
 *  content §6.3 requires of the XLSX, laid out linearly instead of tabbed. */
export function buildExportCsv(doc: ReportDocument, opts: ExportOptions = {}): string {
  const lines: string[] = [];
  lines.push(csvRow([bannerText(doc, opts)]));
  lines.push("");

  lines.push(csvRow(["KPIs"]));
  lines.push(csvRow(["Metric Key", "Label", "Unit", "Class", "Value", "Numerator", "Denominator", "Delta", "Appraisal Safe"]));
  for (const kpi of doc.kpis) {
    lines.push(
      csvRow([
        kpi.metricKey,
        kpi.label,
        kpi.unit,
        classifyKpi(kpi),
        scaleForUnit(kpi.value, kpi.unit),
        kpi.numerator ?? null,
        kpi.denominator ?? null,
        kpi.delta !== undefined ? scaleForUnit(kpi.delta, kpi.unit) : null,
        kpi.appraisalSafe,
      ]),
    );
  }
  lines.push("");

  for (const table of doc.tables) {
    lines.push(csvRow([`Table: ${table.label}`]));
    lines.push(csvRow(table.columns.map((c) => c.label)));
    for (const row of table.rows) {
      lines.push(csvRow(table.columns.map((c) => scaleCell(row[c.key], c.unit))));
    }
    if (table.totalRow) {
      lines.push(csvRow(table.columns.map((c) => scaleCell(table.totalRow![c.key], c.unit))));
    }
    lines.push("");
  }

  lines.push(csvRow(["Series"]));
  lines.push(csvRow(["Series Key", "Label", "Unit", "Kind", "Numerator Key", "Denominator Key", "Date", "Value"]));
  for (const series of doc.series) {
    for (const point of series.points) {
      lines.push(
        csvRow([series.key, series.label, series.unit, series.kind, series.numeratorKey ?? null, series.denominatorKey ?? null, point.t, point.v === null ? null : scaleForUnit(point.v, series.unit)]),
      );
    }
  }
  lines.push("");

  lines.push(csvRow(["Provenance"]));
  for (const [k, v] of provenanceRows({ doc, sealHash: opts.sealHash })) lines.push(csvRow([k, v]));

  return lines.join("\r\n");
}

function scaleCell(v: string | number | null | undefined, unit?: ReportUnit): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && unit) return scaleForUnit(v, unit);
  return v;
}

// ═══════════════════════════════ PURE-ish — XLSX (exceljs, OQ-2) ═══════════════════════════════
//
// `exceljs` (MIT, server-only, no runtime dependency on a browser/Electron) is the OQ-2 choice —
// hand-rolling the OOXML zip/XML format is a well-known time sink with no upside here (this
// program does not need anything exceljs can't do: cell styling for the banner, per-sheet column
// widths, a `Buffer` output for the files-table write). `npm audit` after adding it showed zero
// exceljs-attributable advisories (checked against the pre-existing repo-wide audit baseline).

const BANNER_FONT_SEALED: Partial<ExcelJS.Font> = { bold: true, color: { argb: "FF1B5E20" } };
const BANNER_FONT_ADHOC: Partial<ExcelJS.Font> = { bold: true, color: { argb: "FFB71C1C" } };
const HEADER_FONT: Partial<ExcelJS.Font> = { bold: true };

/** Excel sheet names: <=31 chars, no `* ? : \ / [ ]`, unique within the workbook (case-insensitive).
 *  `reserved` seeds the three fixed sheet names so a `ReportTable.label` can never collide with
 *  them, regardless of creation order. */
function safeSheetName(raw: string, reserved: Set<string>): string {
  const base = (raw.replace(/[*?:\\/[\]]/g, " ").trim().slice(0, 31) || "Sheet") as string;
  let name = base;
  let n = 2;
  while (reserved.has(name.toLowerCase())) {
    const suffix = ` (${n++})`;
    name = base.slice(0, 31 - suffix.length) + suffix;
  }
  reserved.add(name.toLowerCase());
  return name;
}

function writeBanner(sheet: ExcelJS.Worksheet, doc: ReportDocument, opts: ExportOptions, lastCol: number): void {
  const cell = sheet.getCell(1, 1);
  cell.value = bannerText(doc, opts);
  cell.font = doc.header.sealed ? BANNER_FONT_SEALED : BANNER_FONT_ADHOC;
  if (lastCol > 1) sheet.mergeCells(1, 1, 1, lastCol);
}

function writeHeaderRow(sheet: ExcelJS.Worksheet, rowIndex: number, headers: string[]): void {
  const row = sheet.getRow(rowIndex);
  row.values = headers;
  row.font = HEADER_FONT;
}

function autoWidth(sheet: ExcelJS.Worksheet, colCount: number, minWidth = 12): void {
  for (let i = 1; i <= colCount; i++) {
    const col = sheet.getColumn(i);
    let max = minWidth;
    col.eachCell({ includeEmpty: false }, (cell) => {
      const len = String(cell.value ?? "").length;
      if (len > max) max = len;
    });
    col.width = Math.min(max + 2, 60);
  }
}

const KPI_HEADERS = ["Metric Key", "Label", "Unit", "Class", "Value", "Numerator", "Denominator", "Delta", "Appraisal Safe"];

function writeKpiSheet(wb: ExcelJS.Workbook, doc: ReportDocument, opts: ExportOptions): void {
  const sheet = wb.addWorksheet("KPIs");
  writeBanner(sheet, doc, opts, KPI_HEADERS.length);
  const headerRow = 3;
  writeHeaderRow(sheet, headerRow, KPI_HEADERS);
  doc.kpis.forEach((kpi, i) => {
    const row = sheet.getRow(headerRow + 1 + i);
    row.values = [
      kpi.metricKey,
      kpi.label,
      kpi.unit,
      classifyKpi(kpi),
      scaleForUnit(kpi.value, kpi.unit),
      kpi.numerator ?? null,
      kpi.denominator ?? null,
      kpi.delta !== undefined ? scaleForUnit(kpi.delta, kpi.unit) : null,
      kpi.appraisalSafe,
    ];
  });
  autoWidth(sheet, KPI_HEADERS.length);
}

function writeTableSheet(wb: ExcelJS.Workbook, doc: ReportDocument, opts: ExportOptions, table: ReportTable, reserved: Set<string>): void {
  const sheet = wb.addWorksheet(safeSheetName(table.label || table.key, reserved));
  const headers = table.columns.map((c) => c.label);
  writeBanner(sheet, doc, opts, Math.max(headers.length, 1));
  const headerRow = 3;
  writeHeaderRow(sheet, headerRow, headers);
  table.rows.forEach((r, i) => {
    sheet.getRow(headerRow + 1 + i).values = table.columns.map((c) => scaleCell(r[c.key], c.unit));
  });
  if (table.totalRow) {
    const totalRowIdx = headerRow + 1 + table.rows.length;
    const row = sheet.getRow(totalRowIdx);
    row.values = table.columns.map((c) => scaleCell(table.totalRow![c.key], c.unit));
    row.font = HEADER_FONT;
  }
  autoWidth(sheet, headers.length);
}

const SERIES_HEADERS = ["Series Key", "Label", "Unit", "Kind", "Numerator Key", "Denominator Key", "Date", "Value"];

function writeSeriesSheet(wb: ExcelJS.Workbook, doc: ReportDocument, opts: ExportOptions): void {
  const sheet = wb.addWorksheet("Series");
  writeBanner(sheet, doc, opts, SERIES_HEADERS.length);
  const headerRow = 3;
  writeHeaderRow(sheet, headerRow, SERIES_HEADERS);
  let r = headerRow + 1;
  for (const series of doc.series) {
    for (const point of series.points) {
      sheet.getRow(r++).values = [
        series.key,
        series.label,
        series.unit,
        series.kind,
        series.numeratorKey ?? null,
        series.denominatorKey ?? null,
        point.t,
        point.v === null ? null : scaleForUnit(point.v, series.unit),
      ];
    }
  }
  autoWidth(sheet, SERIES_HEADERS.length);
}

function writeProvenanceSheet(wb: ExcelJS.Workbook, doc: ReportDocument, opts: ExportOptions): void {
  const sheet = wb.addWorksheet("Provenance");
  writeBanner(sheet, doc, opts, 2);
  const headerRow = 3;
  writeHeaderRow(sheet, headerRow, ["Field", "Value"]);
  provenanceRows({ doc, sealHash: opts.sealHash }).forEach(([k, v], i) => {
    sheet.getRow(headerRow + 1 + i).values = [k, v];
  });
  autoWidth(sheet, 2);
}

/** §6.3's XLSX sheet set: `KPIs` · one sheet per `ReportTable` · `Series` (long format) ·
 *  `Provenance` (always present — not only on an unsealed export — so a sealed export's own
 *  seal-hash/revision/range are equally inspectable, though the ⚡-gated requirement is only that
 *  the mark and this sheet are never ABSENT on an unsealed one). */
export function buildExportWorkbook(doc: ReportDocument, opts: ExportOptions = {}): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Gaiada Reports";
  wb.created = new Date(doc.header.generatedAt);

  const reserved = new Set(["kpis", "series", "provenance"]);
  writeKpiSheet(wb, doc, opts);
  for (const table of doc.tables) writeTableSheet(wb, doc, opts, table, reserved);
  writeSeriesSheet(wb, doc, opts);
  writeProvenanceSheet(wb, doc, opts);
  return wb;
}

export async function renderWorkbookBuffer(wb: ExcelJS.Workbook): Promise<Buffer> {
  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer as ArrayBuffer);
}

/** Top-level entry the controller calls for the two IN-PROCESS formats. `format` is validated by
 *  the caller against `EXPORT_FORMATS` before this runs. **Never called with `"pdf"`** — that
 *  format's bytes come from the `report-renderer` sidecar over the network (report-pdf-export.ts),
 *  which this file deliberately does not touch (see the file header). The throw below is a
 *  defensive backstop against a future caller mistake, not a reachable path today: `reports.
 *  controller.ts`'s `createExport` branches on `format === "pdf"` BEFORE ever calling this. */
export async function renderExport(doc: ReportDocument, format: ExportFormat, opts: ExportOptions = {}): Promise<Buffer> {
  if (format === "pdf") {
    throw new Error("renderExport does not handle pdf — see report-pdf-export.ts (the sidecar round trip)");
  }
  if (format === "csv") return Buffer.from(buildExportCsv(doc, opts), "utf8");
  const wb = buildExportWorkbook(doc, opts);
  return renderWorkbookBuffer(wb);
}

// Re-exported for tests that want to assert on the raw series/kpi/table types without importing
// report-document.ts twice.
export type { ReportDocument, ReportKpi, ReportSeries, ReportTable, ReportUnit };
