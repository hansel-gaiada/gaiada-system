import { describe, it, expect, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ContentLint, Lint } from "@/lib/webdeskContentModel";
import { ContentChecksCard } from "./ContentChecksCard";

afterEach(cleanup);
const lintOf = (content?: ContentLint, unavailable?: string): Lint => ({ unresolvedTokens: [], markers: {}, ...(content ? { content } : {}), ...(unavailable ? { unavailable } : {}) });
const show = (l: Lint) => render(<><input data-pointer="/seo/title" data-testid="title" /><ContentChecksCard lint={l} /></>);

describe("ContentChecksCard", () => {
  it("issues: grouped by severity, with the aeo table and couldn't-check rules", () => {
    show(lintOf({
      findings: [
        { code: "h1.missing", severity: "warn", path: "/seo/title", message: "No H1 found" },
        { code: "keyword.placement", severity: "info", path: "/", message: "Keyword is late" },
      ],
      aeo: { score: 64, factors: [{ id: "faq", label: "FAQ", points: 5, max: 15, detail: "one Q&A" }] },
      unavailable: [{ rule: "twin.missing", reason: "unreadable" }],
    }));
    expect(screen.getByTestId("content-findings-warn").textContent).toContain("No H1 found");
    expect(screen.getByTestId("content-findings-info").textContent).toContain("Keyword is late");
    expect(screen.getByTestId("aeo-score").textContent).toBe("64");
    expect(screen.getByTestId("aeo-factor-faq").textContent).toContain("5/15");
    expect(screen.getByTestId("content-unavailable").textContent).toContain("couldn't check: twin.missing");
    expect(screen.queryByTestId("content-checks-clean")).toBeNull();
  });
  it("a finding's path button focuses the field when the editor has it; '/' has no button", () => {
    show(lintOf({ findings: [
      { code: "a", severity: "warn", path: "/seo/title", message: "m1" },
      { code: "b", severity: "warn", path: "/", message: "m2" },
    ], aeo: null, unavailable: [] }));
    const btns = screen.getAllByTestId("finding-goto");
    expect(btns).toHaveLength(1);
    fireEvent.click(btns[0]);
    expect(document.activeElement).toBe(screen.getByTestId("title"));
  });
  it("a path with no field says so instead of doing nothing", () => {
    show(lintOf({ findings: [{ code: "a", severity: "warn", path: "/blocks/9/props/x", message: "m" }], aeo: null, unavailable: [] }));
    fireEvent.click(screen.getByTestId("finding-goto"));
    expect(screen.getByRole("status").textContent).toContain("no single field");
  });
  it("clean: all-clear only when nothing failed to run", () => {
    show(lintOf({ findings: [], aeo: { score: 90, factors: [] }, unavailable: [] }));
    expect(screen.getByTestId("content-checks-clean").textContent).toBe("No content issues found.");
  });
  it("clean but some rule could not run: qualified, lists the rule", () => {
    show(lintOf({ findings: [], aeo: { score: 50, factors: [] }, unavailable: [{ rule: "sources", reason: "" }] }));
    expect(screen.getByTestId("content-checks-clean").textContent).toBe("No issues from the checks that could run.");
    expect(screen.getByTestId("content-unavailable").textContent).toContain("couldn't check: sources");
  });
  it("every rule unavailable: never the all-clear", () => {
    show(lintOf({ findings: [], aeo: null, unavailable: [{ rule: "a", reason: "x" }, { rule: "b", reason: "y" }] }));
    expect(screen.getByTestId("content-checks-none-ran")).toBeTruthy();
    expect(screen.queryByTestId("content-checks-clean")).toBeNull();
    expect(screen.getByTestId("content-checks-card").textContent).not.toContain("No content issues");
  });
  it("aeo null with checks run: says there is no score", () => {
    show(lintOf({ findings: [], aeo: null, unavailable: [] }));
    expect(screen.getByTestId("aeo-none")).toBeTruthy();
  });
  it("absent (older WebDesk): says nothing was checked, not 'no issues'", () => {
    show(lintOf());
    expect(screen.getByTestId("content-checks-absent").textContent).toContain("did not report content checks");
    expect(screen.getByTestId("content-checks-card").textContent).not.toContain("No content issues");
  });
  it("the whole lint unavailable: couldn't run", () => {
    show(lintOf({ findings: [], aeo: null, unavailable: [] }, "composition invalid"));
    expect(screen.getByTestId("content-checks-absent").textContent).toContain("Couldn't run");
  });
});
