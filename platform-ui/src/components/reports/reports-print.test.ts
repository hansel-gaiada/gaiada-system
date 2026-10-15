import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

// DW-4k — the print stylesheet for the report pages. jsdom has no print layout, so this pins the rules that make a printed
// report clean (the shell and the controls are hidden; the header, KPI tiles and table rows stay whole; charts keep their
// colours), and that every one of them is scoped to report pages so no other route can be affected.
const css = readFileSync(resolve(process.cwd(), "src/components/reports/reports-print.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const print = css.slice(css.indexOf("@media print"));

describe("reports-print.css", () => {
  it("hides the shell (sidebar, top bar, banner, assistant button, tabs) and the controls", () => {
    expect(print).toMatch(/\.erp-app:has\(\.rp-reports\) > :not\(\.erp-main\)\s*\{\s*display:\s*none/);
    expect(print).toMatch(/\.erp-main > :not\(\.erp-main__inner\)\s*\{\s*display:\s*none/);
    expect(print).toMatch(/\.ws-tabs/);
    for (const hidden of [".rp-noprint", ".page-header__actions", ".rc-period", ".rc-revision"]) expect(print).toContain(`.rp-reports ${hidden}`);
  });

  it("turns the viewport-high app grid into flowing content", () => {
    expect(print).toMatch(/\.erp-app:has\(\.rp-reports\)\s*\{[^}]*display:\s*block[^}]*height:\s*auto/);
    expect(print).toMatch(/\.erp-main\s*\{[^}]*overflow:\s*visible/);
  });

  it("keeps tiles, sections, highlights, warnings and table rows whole across a page break", () => {
    const block = print.match(/([^{}]*)\{\s*break-inside:\s*avoid/)?.[1] ?? "";
    for (const sel of [".rc-kpi", ".rc-section", ".rc-highlight", ".rc-warning", ".rc-rtable__row", ".lux-table__row"]) expect(block).toContain(sel);
  });

  it("charts keep their colours on paper and print as one column", () => {
    expect(print).toMatch(/print-color-adjust:\s*exact/);
    expect(print).toMatch(/-webkit-print-color-adjust:\s*exact/);
    expect(print).toMatch(/\.rc-sections-grid\s*\{\s*grid-template-columns:\s*1fr/);
  });

  it("shows the print-only scope/period line on paper and not on screen", () => {
    expect(css).toMatch(/\.rp-printonly\s*\{\s*display:\s*none/);
    expect(print).toMatch(/\.rp-reports \.rp-printonly\s*\{\s*display:\s*block/);
  });

  it("every print rule is scoped to report pages", () => {
    const selectors = [...print.matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim()).filter((s) => s && !s.startsWith("@media"));
    for (const group of selectors) {
      for (const sel of group.split(",").map((x) => x.trim())) expect(sel, sel).toMatch(/rp-reports/);
    }
  });
});
