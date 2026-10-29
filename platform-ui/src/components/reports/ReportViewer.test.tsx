import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ReportViewer } from "./ReportViewer";
import type { ReportDocument } from "@/lib/reports";

// SCP-5a (BFF §63.18): the report viewer draws the one SIMULATED mark and the print stylesheet tiles a SIMULATED watermark behind every page when the document is `simulated`; a document that
// is not simulated is drawn exactly as before. jsdom has no print layout, so the watermark is pinned as the stylesheet's own rule (a tiled background of the document's box, scoped to the print
// route, because a fixed banner is not dependable across pages in this Chromium: the TR-20 note in print.css).
afterEach(cleanup);

const doc = (over: Partial<ReportDocument> = {}): ReportDocument => ({
  header: {
    tenantId: "co", grain: "company", scopeRef: "e1", scopeName: "Northwind Traders", periodKind: "month", periodStart: "2026-09-01", periodEnd: "2026-09-30", dayCount: 30,
    periodLabel: "September 2026", generatedAt: "2026-10-05T00:00:00Z", sealed: false,
  },
  kpis: [{ metricKey: "reach_month", label: "Reach", unit: "count", value: 12000, appraisalSafe: false }],
  series: [], distributions: [], highlights: [],
  tables: [{ key: "notes", label: "Insights and suggestions", columns: [{ key: "area", label: "Area" }, { key: "insight", label: "Insight" }], rows: [{ area: "Followers", insight: "Steady." }] }],
  narrative: { source: "deterministic", text: "A good month." },
  ...over,
});

describe("ReportViewer and the SIMULATED watermark", () => {
  it("a simulated document draws the one mark with its note, and marks the page for the print watermark", () => {
    const { container } = render(<ReportViewer document={doc({ simulated: true })} />);
    const marks = screen.getAllByRole("img", { name: "Simulated" });
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveTextContent("SIMULATED");
    expect(screen.getByRole("note")).toHaveTextContent(/Simulated numbers from the social simulator/);
    expect(container.querySelector(".rc-page")).toHaveClass("rc-page--simulated");
  });

  it("a document that is not simulated is unchanged: no mark, no note, no watermark class, and the same markup as a document without the flag", () => {
    const plain = render(<ReportViewer document={doc()} />);
    expect(screen.queryAllByRole("img", { name: "Simulated" })).toHaveLength(0);
    expect(screen.queryByRole("note")).toBeNull();
    expect(plain.container.querySelector(".rc-page--simulated")).toBeNull();
    expect(plain.container.querySelector(".rc-page")?.className).toBe("rc-viz rc-page");
    const html = plain.container.innerHTML;
    plain.unmount();
    const explicitFalse = render(<ReportViewer document={doc({ simulated: false })} />);
    expect(explicitFalse.container.innerHTML).toBe(html);
  });

  it("draws every table of the document, the notes and the action plan included, so the PDF stays whole", () => {
    render(<ReportViewer document={doc({ simulated: true })} />);
    expect(screen.getByRole("heading", { name: "Insights and suggestions" })).toBeInTheDocument();
    expect(screen.getByText("Steady.")).toBeInTheDocument();
    expect(screen.getByText("A good month.")).toBeInTheDocument();
  });

  it("the print stylesheet tiles the SIMULATED watermark behind the simulated document only, scoped to the print route", () => {
    const css = readFileSync(resolve(process.cwd(), "src/app/print/print.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = css.match(/\.tr20-print \.rc-page--simulated\s*\{([^}]*)\}/);
    expect(rule, "the watermark rule").not.toBeNull();
    expect(rule![1]).toMatch(/background-image:\s*url\("data:image\/svg\+xml/);
    expect(rule![1]).toMatch(/SIMULATED/);
    expect(rule![1]).toMatch(/background-repeat:\s*repeat/);
    // a tile shorter than a page, so every printed page carries it
    const height = Number(rule![1].match(/height='(\d+)'/)![1]);
    expect(height).toBeLessThan(700);
    // it is a background of the document's own box, never a fixed banner (not dependable across pages here)
    expect(rule![1]).not.toMatch(/position:\s*fixed/);
    // every other selector of the new rule set stays under the print route: nothing leaks to another page
    expect([...css.matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim()).filter((s) => s.includes("rc-page--simulated")).every((s) => s.startsWith(".tr20-print "))).toBe(true);
  });
});
