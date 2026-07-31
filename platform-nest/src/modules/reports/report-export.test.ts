// TR-18 — the PURE half of the export service: banner/mark text, the §5.4 KPI class column,
// percent scaling, storage-key encode/decode, and the CSV/XLSX sheet shapes. No database, no
// Nest — house pattern (document-builder.test.ts, report-seal.test.ts). The controller
// orchestration (authz, sealed-branch fetch, files-table persistence, download) is covered
// against live Postgres + Cerbos in reports.controller.export.db.test.ts.
import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import {
  bannerText,
  buildExportCsv,
  buildExportWorkbook,
  classifyKpi,
  decodeScopeRefSegment,
  encodeScopeRefSegment,
  EXPORT_FORMATS,
  exportContentType,
  exportFileExtension,
  exportFilename,
  exportStorageKey,
  parseExportStorageKey,
  pdfProvenanceTag,
  provenanceRows,
  renderExport,
  scaleForUnit,
} from "./report-export";
import type { ReportDocument, ReportKpi } from "./report-document";

function baseDoc(overrides: Partial<ReportDocument["header"]> = {}): ReportDocument {
  return {
    header: {
      tenantId: "t1",
      grain: "person",
      scopeRef: "u1",
      scopeName: "Alice",
      periodKind: "custom",
      periodStart: "2026-07-01",
      periodEnd: "2026-07-15",
      dayCount: 15,
      periodLabel: "1 Jul – 15 Jul 2026",
      generatedAt: "2026-07-31T12:00:00.000Z",
      sealed: false,
      ...overrides,
    },
    kpis: [
      { metricKey: "delivery.tasks_completed", label: "Tasks Completed", unit: "count", value: 12, appraisalSafe: false },
      { metricKey: "delivery.on_time_rate", label: "On-Time Rate", unit: "percent", value: 0.86, numerator: 43, denominator: 50, delta: 0.04, appraisalSafe: true },
      { metricKey: "discipline.overdue_open", label: "Overdue (open)", unit: "count", value: 3, appraisalSafe: false, pointInTime: true },
      { metricKey: "evidence.source_diversity", label: "Source Diversity", unit: "count", value: 2, appraisalSafe: false, distinctOver: true },
    ],
    series: [
      {
        key: "delivery.on_time_rate",
        label: "On-Time Rate",
        unit: "percent",
        kind: "line",
        points: [
          { t: "2026-07-01", v: 0.5 },
          { t: "2026-07-02", v: null },
        ],
        numeratorKey: "delivery.on_time_rate.n",
        denominatorKey: "delivery.on_time_rate.d",
      },
    ],
    distributions: [],
    tables: [
      {
        key: "overdue_tasks",
        label: "Overdue Tasks",
        columns: [
          { key: "title", label: "Title" },
          { key: "share", label: "Share", unit: "percent", align: "right" },
        ],
        rows: [{ title: "Ship the thing", share: 0.5 }],
        totalRow: { title: "Total", share: 1 },
      },
    ],
    highlights: [],
    narrative: { source: "deterministic", text: "Completed 12 tasks." },
  };
}

describe("bannerText — the mandatory ad-hoc/sealed mark (⚡)", () => {
  it("an UNSEALED document ALWAYS carries the AD HOC mark, with the generatedAt timestamp", () => {
    const doc = baseDoc({ sealed: false });
    expect(bannerText(doc)).toBe("AD HOC · UNSEALED · as of 2026-07-31T12:00:00.000Z");
  });

  it("a SEALED document carries the SEALED mark with revision + hash prefix", () => {
    const doc = baseDoc({ sealed: true, revision: 2, periodId: "p1" });
    expect(bannerText(doc, { sealHash: "abcdef0123456789" })).toBe("SEALED · rev 2 · abcdef012345");
  });

  it("a SEALED document with no hash available degrades to 'unknown' rather than throwing", () => {
    const doc = baseDoc({ sealed: true, revision: 0 });
    expect(bannerText(doc)).toBe("SEALED · rev 0 · unknown");
  });

  it("the mark cannot be absent for ANY unsealed header shape — day/week/month/custom, with or without warnings", () => {
    const shapes: Partial<ReportDocument["header"]>[] = [
      { sealed: false, periodKind: "day" },
      { sealed: false, periodKind: "week" },
      { sealed: false, periodKind: "month" },
      { sealed: false, periodKind: "custom" },
      { sealed: false, warnings: { adHoc: true } },
      { sealed: false, warnings: undefined },
    ];
    for (const shape of shapes) {
      const text = bannerText(baseDoc(shape));
      expect(text.startsWith("AD HOC · UNSEALED · as of ")).toBe(true);
    }
  });
});

describe("classifyKpi — §5.4 class column", () => {
  it("an additive registry metric classifies 'additive'", () => {
    const kpi: ReportKpi = { metricKey: "delivery.tasks_completed", label: "x", unit: "count", value: 1, appraisalSafe: false };
    expect(classifyKpi(kpi)).toBe("additive");
  });

  it("a ratio registry metric classifies 'ratio'", () => {
    const kpi: ReportKpi = { metricKey: "delivery.on_time_rate", label: "x", unit: "percent", value: 0.5, numerator: 1, denominator: 2, appraisalSafe: true };
    expect(classifyKpi(kpi)).toBe("ratio");
  });

  it("pointInTime is authoritative regardless of the registry rangeClass (#20)", () => {
    const kpi: ReportKpi = { metricKey: "discipline.overdue_open", label: "x", unit: "count", value: 3, appraisalSafe: false, pointInTime: true };
    expect(classifyKpi(kpi)).toBe("point-in-time");
  });

  it("distinctOver is authoritative for the unseeded #22, which the registry does not even contain", () => {
    const kpi: ReportKpi = { metricKey: "evidence.source_diversity", label: "x", unit: "count", value: 2, appraisalSafe: false, distinctOver: true };
    expect(classifyKpi(kpi)).toBe("distinct");
  });

  it("an unknown metricKey degrades to the n/d shape instead of throwing", () => {
    const withND: ReportKpi = { metricKey: "made.up.metric", label: "x", unit: "count", value: 1, numerator: 1, denominator: 2, appraisalSafe: false };
    const withoutND: ReportKpi = { metricKey: "made.up.metric.2", label: "x", unit: "count", value: 1, appraisalSafe: false };
    expect(classifyKpi(withND)).toBe("ratio");
    expect(classifyKpi(withoutND)).toBe("additive");
  });
});

describe("scaleForUnit — ruling 3's percent convention (0-100, never the raw fraction)", () => {
  it("percent values are multiplied by 100", () => {
    expect(scaleForUnit(0.86, "percent")).toBe(86);
  });
  it("non-percent units pass through unchanged", () => {
    expect(scaleForUnit(42, "count")).toBe(42);
    expect(scaleForUnit(42, "minutes")).toBe(42);
    expect(scaleForUnit(4.2, "score")).toBe(4.2);
  });
});

describe("storage key encode/decode round-trip", () => {
  it("round-trips a uuid scopeRef (person/project/company grain)", () => {
    const key = exportStorageKey("tenant-1", "person", "u-123", "job-1");
    expect(parseExportStorageKey(key)).toEqual({ tenantId: "tenant-1", grain: "person", scopeRef: "u-123", jobId: "job-1" });
  });

  it("round-trips a non-uuid department node id (e.g. 'd-hr')", () => {
    const key = exportStorageKey("tenant-1", "department", "d-hr", "job-2");
    expect(parseExportStorageKey(key)).toEqual({ tenantId: "tenant-1", grain: "department", scopeRef: "d-hr", jobId: "job-2" });
  });

  it("round-trips a scopeRef containing characters that need encoding", () => {
    const seg = encodeScopeRefSegment("d/weird name?");
    expect(decodeScopeRefSegment(seg)).toBe("d/weird name?");
    const key = exportStorageKey("t1", "department", "d/weird name?", "job-3");
    expect(parseExportStorageKey(key)?.scopeRef).toBe("d/weird name?");
  });

  it("rejects a malformed key rather than guessing", () => {
    expect(parseExportStorageKey("not-an-export-key")).toBeNull();
    expect(parseExportStorageKey("t1/some-other-prefix/person/u1/job1")).toBeNull();
  });
});

describe("filename/content-type", () => {
  it("xlsx and csv get distinct, correct content types", () => {
    expect(exportContentType("xlsx")).toContain("spreadsheetml");
    expect(exportContentType("csv")).toContain("text/csv");
  });
  it("filename is derived from grain/scope/range, never containing PII-adjacent separators unsafely", () => {
    const name = exportFilename(baseDoc(), "xlsx");
    expect(name).toMatch(/^person-alice-2026-07-01-to-2026-07-15\.xlsx$/);
  });
});

describe("TR-21 — pdf added as a real format (§6.3), never reshaping xlsx/csv", () => {
  it("EXPORT_FORMATS/exportFileExtension/exportContentType all recognize pdf", () => {
    expect(EXPORT_FORMATS.has("pdf")).toBe(true);
    expect(exportFileExtension("pdf")).toBe("pdf");
    expect(exportContentType("pdf")).toBe("application/pdf");
  });

  it("renderExport refuses to handle pdf itself — that byte-rendering happens over the network, in report-pdf-export.ts, never here", async () => {
    await expect(renderExport(baseDoc(), "pdf")).rejects.toThrow(/report-pdf-export/);
  });

  describe("pdfProvenanceTag — the AD HOC/SEALED mark's filename-safe form (⚡ must never be absent)", () => {
    it("unsealed -> 'adhoc-unsealed'", () => {
      expect(pdfProvenanceTag(baseDoc({ sealed: false }))).toBe("adhoc-unsealed");
    });
    it("sealed -> 'sealed-rev<N>-<8-char hash prefix>'", () => {
      const doc = baseDoc({ sealed: true, revision: 3 });
      expect(pdfProvenanceTag(doc, { sealHash: "abcdef1234567890" })).toBe("sealed-rev3-abcdef12");
    });
    it("sealed with no sealHash supplied (defensive — should not happen for a genuinely sealed doc) -> 'unknown', never a crash", () => {
      const doc = baseDoc({ sealed: true, revision: 0 });
      expect(pdfProvenanceTag(doc)).toBe("sealed-rev0-unknown");
    });
  });

  describe("exportFilename(doc, 'pdf') carries the provenance tag; xlsx/csv are BYTE-FOR-BYTE unchanged", () => {
    it("pdf filename embeds 'adhoc-unsealed' for an unsealed document", () => {
      const name = exportFilename(baseDoc(), "pdf");
      expect(name).toBe("person-alice-2026-07-01-to-2026-07-15-adhoc-unsealed.pdf");
    });
    it("pdf filename embeds the sealed tag with the real hash prefix for a sealed document", () => {
      const doc = baseDoc({ sealed: true, revision: 0 });
      const name = exportFilename(doc, "pdf", { sealHash: "cafebabe12345678" });
      expect(name).toBe("person-alice-2026-07-01-to-2026-07-15-sealed-rev0-cafebabe.pdf");
    });
    it("xlsx filename is IDENTICAL to before pdf existed — no regression from adding the third format", () => {
      expect(exportFilename(baseDoc(), "xlsx")).toBe("person-alice-2026-07-01-to-2026-07-15.xlsx");
    });
  });
});

describe("provenanceRows — the range + every set header.warnings flag", () => {
  it("includes only the warnings flags that are actually set", () => {
    const doc = baseDoc({
      warnings: {
        adHoc: true,
        endsInFuture: true,
        precedesFactHistory: { firstFactDate: "2026-06-01", affectedDays: 3 },
      },
    });
    const rows = provenanceRows({ doc });
    const keys = rows.map(([k]) => k);
    expect(keys).toContain("Warning: ad hoc");
    expect(keys).toContain("Warning: ends in future");
    expect(keys).toContain("Warning: precedes fact history");
    expect(keys).not.toContain("Warning: partial period");
    expect(keys).not.toContain("Warning: spans membership change");
  });

  it("states the percent convention explicitly, so a reader without source access still knows the scale", () => {
    const rows = provenanceRows({ doc: baseDoc() });
    const percentRow = rows.find(([k]) => k === "Percent convention");
    expect(percentRow?.[1]).toMatch(/0-100/);
  });
});

describe("buildExportCsv", () => {
  const doc = baseDoc();
  const csv = buildExportCsv(doc);

  it("starts with the mandatory AD HOC banner as the first line", () => {
    expect(csv.split("\r\n")[0]).toBe('"AD HOC · UNSEALED · as of 2026-07-31T12:00:00.000Z"');
  });

  it("KPIs section carries the class column and n/d for the ratio metric", () => {
    expect(csv).toContain('"delivery.on_time_rate","On-Time Rate","percent","ratio","86","43","50","4","true"');
  });

  it("point-in-time and distinct KPIs are labelled, not silently additive", () => {
    expect(csv).toContain('"discipline.overdue_open"');
    expect(csv).toMatch(/"discipline\.overdue_open".*"point-in-time"/);
    expect(csv).toMatch(/"evidence\.source_diversity".*"distinct"/);
  });

  it("percent-unit table columns are scaled 0-100 in both the row and the total row", () => {
    expect(csv).toContain('"Ship the thing","50"');
    expect(csv).toContain('"Total","100"');
  });

  it("includes a Series section with a scaled percent value and a Provenance section", () => {
    expect(csv).toContain('"Series"');
    expect(csv).toMatch(/"delivery\.on_time_rate","On-Time Rate","percent","line","delivery\.on_time_rate\.n","delivery\.on_time_rate\.d","2026-07-01","50"/);
    expect(csv).toContain('"Provenance"');
  });

  it("a SEALED document's CSV carries the SEALED mark, never the AD HOC one", () => {
    const sealedDoc = baseDoc({ sealed: true, revision: 1, periodId: "p1" });
    const sealedCsv = buildExportCsv(sealedDoc, { sealHash: "0011223344556677" });
    expect(sealedCsv.split("\r\n")[0]).toBe('"SEALED · rev 1 · 001122334455"');
    expect(sealedCsv).not.toContain("AD HOC");
  });
});

describe("buildExportWorkbook (xlsx, exceljs)", () => {
  const doc = baseDoc();

  it("produces KPIs, one sheet per table, Series, and Provenance", () => {
    const wb = buildExportWorkbook(doc);
    const names = wb.worksheets.map((s) => s.name);
    expect(names).toEqual(["KPIs", "Overdue Tasks", "Series", "Provenance"]);
  });

  it("A1 on every sheet carries the mandatory unsealed banner", () => {
    const wb = buildExportWorkbook(doc);
    for (const sheet of wb.worksheets) {
      expect(String(sheet.getCell("A1").value)).toMatch(/^AD HOC · UNSEALED · as of /);
    }
  });

  it("A1 on a sealed document's workbook carries the SEALED banner on every sheet", () => {
    const sealedDoc = baseDoc({ sealed: true, revision: 3, periodId: "p1" });
    const wb = buildExportWorkbook(sealedDoc, { sealHash: "aa11bb22cc33dd44" });
    for (const sheet of wb.worksheets) {
      expect(String(sheet.getCell("A1").value)).toBe("SEALED · rev 3 · aa11bb22cc33");
    }
  });

  it("the KPIs sheet header row (row 3) matches the §6.3 shape incl. the class column", () => {
    const wb = buildExportWorkbook(doc);
    const kpiSheet = wb.getWorksheet("KPIs")!;
    const headerRow = kpiSheet.getRow(3).values as unknown[];
    expect(headerRow.slice(1)).toEqual(["Metric Key", "Label", "Unit", "Class", "Value", "Numerator", "Denominator", "Delta", "Appraisal Safe"]);
    const ratioRow = kpiSheet.getRow(5).values as unknown[]; // row 4 = tasks_completed, row 5 = on_time_rate
    expect(ratioRow.slice(1)).toEqual(["delivery.on_time_rate", "On-Time Rate", "percent", "ratio", 86, 43, 50, 4, true]);
  });

  it("a ReportTable label collision with a reserved sheet name (KPIs/Series/Provenance) is disambiguated, never silently dropped", () => {
    const collidingDoc: ReportDocument = {
      ...doc,
      tables: [
        { key: "kpis", label: "KPIs", columns: [{ key: "a", label: "A" }], rows: [] },
        { key: "series2", label: "Series", columns: [{ key: "a", label: "A" }], rows: [] },
      ],
    };
    const wb = buildExportWorkbook(collidingDoc);
    const names = wb.worksheets.map((s) => s.name);
    // Exactly one real "KPIs" and one real "Series" sheet (the fixed ones); the colliding table
    // sheets must have been renamed to something else, and every sheet name must be unique.
    expect(names.filter((n) => n === "KPIs")).toHaveLength(1);
    expect(names.filter((n) => n === "Series")).toHaveLength(1);
    expect(new Set(names).size).toBe(names.length);
  });

  it("round-trips through exceljs's own xlsx writer/reader without throwing (a real OOXML file, not just an in-memory object)", async () => {
    const wb = buildExportWorkbook(doc);
    const buf = await wb.xlsx.writeBuffer();
    const reloaded = new ExcelJS.Workbook();
    // `Buffer.from(buf)` structurally satisfies exceljs's own runtime expectation, but two
    // different `@types/node` copies in the dependency tree declare nominally-incompatible
    // `Buffer` generics — a type-only friction, not a real bug — so the load call is invoked
    // through an `any`-typed reference rather than fighting that mismatch with more casts.
    await (reloaded.xlsx.load as (data: unknown) => Promise<ExcelJS.Workbook>)(Buffer.from(buf));
    expect(reloaded.worksheets.map((s) => s.name)).toEqual(["KPIs", "Overdue Tasks", "Series", "Provenance"]);
  });
});

describe("renderExport dispatch", () => {
  it("csv format returns a UTF-8 buffer of buildExportCsv's output", async () => {
    const doc = baseDoc();
    const buf = await renderExport(doc, "csv");
    expect(buf.toString("utf8")).toContain("AD HOC · UNSEALED");
  });
  it("xlsx format returns a real OOXML buffer (zip magic bytes)", async () => {
    const doc = baseDoc();
    const buf = await renderExport(doc, "xlsx");
    // OOXML files are zip archives: magic bytes 'PK'.
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
  });
});

describe("performance — a 10k-row table renders well under the 5s bar", () => {
  it("xlsx with a 10,000-row ReportTable completes in under 5 seconds", async () => {
    const bigDoc: ReportDocument = {
      ...baseDoc(),
      tables: [
        {
          key: "big",
          label: "Big Table",
          columns: [
            { key: "id", label: "Id" },
            { key: "name", label: "Name" },
            { key: "rate", label: "Rate", unit: "percent" },
          ],
          rows: Array.from({ length: 10_000 }, (_, i) => ({ id: i, name: `Row ${i}`, rate: i / 10_000 })),
        },
      ],
    };
    const start = Date.now();
    const buf = await renderExport(bigDoc, "xlsx");
    const elapsed = Date.now() - start;
    expect(buf.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(5000);
  }, 10_000);
});
