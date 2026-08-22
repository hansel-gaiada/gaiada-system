import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { PersonCharts, ProjectCharts, DepartmentCharts, CompanyCharts } from "./GrainCharts";
import type { ReportDocument, ReportSeries } from "@/lib/reports";

function baseHeader(overrides: Partial<ReportDocument["header"]> = {}): ReportDocument["header"] {
  return {
    tenantId: "t1", grain: "person", scopeRef: "u1", scopeName: "Test Scope",
    periodKind: "month", periodStart: "2026-07-01", periodEnd: "2026-07-30", dayCount: 30,
    periodLabel: "July 2026", generatedAt: new Date().toISOString(), sealed: false,
    ...overrides,
  };
}

function series(key: string, label: string, unit: ReportSeries["unit"] = "count"): ReportSeries {
  return { key, label, unit, kind: "line", points: [{ t: "2026-07-01", v: 3 }, { t: "2026-07-02", v: 5 }] };
}

function doc(overrides: Partial<ReportDocument> = {}): ReportDocument {
  return {
    header: baseHeader(overrides.header),
    kpis: [],
    series: [series("activity_events", "Activity"), series("tasks_completed_on_time", "Completed on time"), series("tasks_completed_with_due_date", "Completed with a due date")],
    distributions: [],
    tables: [],
    highlights: [],
    narrative: { source: "deterministic", text: "" },
    ...overrides,
  };
}

// A section's title is its own <h3> heading — the chart kit's `ChartDataFallback` also repeats the
// same label as a table caption/column header (so the visually-hidden table reads sensibly on its
// own), which means a plain text query can match twice. `heading` role queries sidestep that and
// are also the more honest assertion: "this SECTION exists", not "this string appears somewhere".
function sectionHeading(name: string) {
  return screen.queryByRole("heading", { name });
}

// Ruling 2 (§15, TR-13 landing note): "render what the document actually contains and degrade
// honestly for what it doesn't — do not render an empty chart frame that implies missing data is
// zero." These tests pin BOTH halves of that rule for every grain's composition.
describe("GrainCharts — render what's there, never an empty frame for what isn't (ruling 2)", () => {
  it("PersonCharts renders the common charts and omits time-by-project / contributions when absent", () => {
    render(<PersonCharts document={doc({ header: baseHeader({ grain: "person" }) })} />);
    expect(sectionHeading("Activity")).toBeInTheDocument();
    expect(sectionHeading("Completed on time vs. with a due date")).toBeInTheDocument();
    expect(sectionHeading("Time by project")).not.toBeInTheDocument();
    expect(sectionHeading("Contributions to others' work")).not.toBeInTheDocument();
  });

  it("PersonCharts renders time-by-project and contributions when the document carries them", () => {
    const document = doc({
      header: baseHeader({ grain: "person" }),
      distributions: [{ key: "time_by_project", label: "Time by project", kind: "donut", slices: [{ label: "Project A", value: 10 }] }],
      tables: [{ key: "contributions", label: "Contributions to others' work", columns: [{ key: "project", label: "Project" }], rows: [{ project: "Project A" }] }],
    });
    render(<PersonCharts document={document} />);
    expect(sectionHeading("Time by project")).toBeInTheDocument();
    expect(sectionHeading("Contributions to others' work")).toBeInTheDocument();
  });

  it("ProjectCharts renders the overdue-tasks table when present", () => {
    const withTable = doc({
      header: baseHeader({ grain: "project" }),
      tables: [{ key: "overdue_tasks", label: "Overdue tasks (as of range end)", columns: [{ key: "title", label: "Task" }], rows: [{ title: "Fix bug" }] }],
    });
    render(<ProjectCharts document={withTable} />);
    expect(sectionHeading("Overdue tasks (as of range end)")).toBeInTheDocument();
  });

  it("ProjectCharts omits the overdue-tasks table when the document carries no such table", () => {
    const without = doc({ header: baseHeader({ grain: "project" }) });
    render(<ProjectCharts document={without} />);
    expect(sectionHeading("Overdue tasks (as of range end)")).not.toBeInTheDocument();
  });

  it("DepartmentCharts renders served-companies-split and per-person only when present", () => {
    const document = doc({
      header: baseHeader({ grain: "department" }),
      distributions: [{ key: "served_companies_split", label: "Served companies", kind: "stacked", slices: [{ label: "Viceroy", value: 5 }] }],
      tables: [{ key: "per_person", label: "Per-person summary", columns: [{ key: "person", label: "Person" }], rows: [{ person: "Made Putra" }] }],
    });
    render(<DepartmentCharts document={document} />);
    expect(sectionHeading("Served companies")).toBeInTheDocument();
    expect(sectionHeading("Per-person summary")).toBeInTheDocument();
  });

  it("DepartmentCharts omits served-companies-split and per-person when absent", () => {
    render(<DepartmentCharts document={doc({ header: baseHeader({ grain: "department" }) })} />);
    expect(sectionHeading("Served companies")).not.toBeInTheDocument();
    expect(sectionHeading("Per-person summary")).not.toBeInTheDocument();
  });

  it("CompanyCharts renders department portfolio only when present, and never crashes on a bare document", () => {
    const bare = doc({ header: baseHeader({ grain: "company", scopeRef: "t1" }) });
    const { container } = render(<CompanyCharts document={bare} />);
    expect(container).toBeInTheDocument();
    expect(sectionHeading("Department portfolio")).not.toBeInTheDocument();
  });

  it("CompanyCharts renders department portfolio when the document carries it", () => {
    const withTable = doc({
      header: baseHeader({ grain: "company", scopeRef: "t1" }),
      tables: [{ key: "department_portfolio", label: "Department portfolio", columns: [{ key: "department", label: "Department" }], rows: [{ department: "Web Dev" }] }],
    });
    render(<CompanyCharts document={withTable} />);
    expect(sectionHeading("Department portfolio")).toBeInTheDocument();
  });
});

// ── a foreign producer's keys must not be silently dropped ──────────────────────────────────────
// The four PM grains were once the only producers of a ReportDocument. The social-media module now
// builds its own (`social/reports.ts`) with keys no allowlist in GrainCharts mentions, so a social
// report rendered through this kit — including into a PDF via /print/reports/[jobToken] — carried
// its KPI wall and narrative but silently lost every series and table it had computed.

function socialDoc(overrides: Partial<ReportDocument> = {}): ReportDocument {
  return {
    header: baseHeader({ grain: "company", scopeName: "Acme Coffee" }),
    kpis: [],
    // Note: NONE of these keys appear in any allowlist in GrainCharts.
    series: [series("impressions_daily", "Impressions"), series("followers_daily", "Followers")],
    distributions: [],
    tables: [
      { key: "top_posts", label: "Top posts", columns: [{ key: "network", label: "Network" }], rows: [{ network: "instagram" }] },
      { key: "kpi_vs_target", label: "KPI vs target", columns: [{ key: "metric", label: "Metric" }], rows: [{ metric: "Impressions" }] },
    ],
    highlights: [],
    narrative: { source: "deterministic", text: "" },
    ...overrides,
  };
}

describe("a foreign producer's series/tables are rendered, not dropped", () => {
  it("renders social's own series and tables through the company grain", () => {
    render(<CompanyCharts document={socialDoc()} />);
    expect(sectionHeading("Impressions")).not.toBeNull();
    expect(sectionHeading("Followers")).not.toBeNull();
    expect(sectionHeading("Top posts")).not.toBeNull();
    expect(sectionHeading("KPI vs target")).not.toBeNull();
  });

  it("does not double-render a key the grain composition already consumed", () => {
    // throughput_weighted is rendered by CompanyCharts itself as "Throughput (weighted)"; the
    // generic pass must not add a second section under the series' own label.
    const d = socialDoc({ series: [series("throughput_weighted", "Throughput")] });
    render(<CompanyCharts document={d} />);
    expect(sectionHeading("Throughput (weighted)")).not.toBeNull();
    expect(screen.queryAllByRole("heading", { name: "Throughput" })).toHaveLength(0);
  });

  it("skips an empty series rather than drawing a frame that implies zero", () => {
    const empty: ReportSeries = { key: "impressions_daily", label: "Impressions", unit: "count", kind: "line", points: [] };
    render(<CompanyCharts document={socialDoc({ series: [empty] })} />);
    expect(sectionHeading("Impressions")).toBeNull();
  });

  it("never charts a RATIO series alone — the average-of-averages trap", () => {
    // A ratio charted by itself silently sums per-bucket percentages. Which chart honestly shows a
    // ratio is a per-grain judgement, so the generic pass declines rather than guessing.
    const ratio: ReportSeries = {
      key: "engagement_rate", label: "Engagement rate", unit: "percent", kind: "line",
      points: [{ t: "2026-07-01", v: 3.5 }], numeratorKey: "engagements_period", denominatorKey: "impressions_period",
    };
    render(<CompanyCharts document={socialDoc({ series: [ratio] })} />);
    expect(sectionHeading("Engagement rate")).toBeNull();
  });
});
