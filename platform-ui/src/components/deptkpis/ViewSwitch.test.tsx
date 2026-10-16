import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));

import { ViewSwitch, kpiViewHref } from "./ViewSwitch";

// DW-10b-2 (BFF section 58.4): the "This period | By month" switch. `view=months` is a URL parameter and both links keep the department (`unit`).

describe("ViewSwitch", () => {
  it("links both views with the department kept, and marks the current one", () => {
    render(<ViewSwitch unit="dept-1" view="months" />);
    const nav = screen.getByRole("navigation", { name: "KPI view" });
    const period = screen.getByRole("link", { name: "This period" });
    const months = screen.getByRole("link", { name: "By month" });
    expect(nav).toContainElement(period);
    expect(period).toHaveAttribute("href", "/appraisals/department?unit=dept-1");
    expect(months).toHaveAttribute("href", "/appraisals/department?unit=dept-1&view=months");
    expect(months).toHaveAttribute("aria-current", "page");
    expect(period).not.toHaveAttribute("aria-current");
  });

  it("marks This period as current on the period view", () => {
    render(<ViewSwitch unit="dept-1" view="period" />);
    expect(screen.getByRole("link", { name: "This period" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "By month" })).not.toHaveAttribute("aria-current");
  });

  it("carries the period the page was opened on both ways, so the round trip lands where the viewer was", () => {
    render(<ViewSwitch unit="dept-1" view="period" period={{ periodKind: "week", start: "2026-10-05", end: "2026-10-11" }} />);
    expect(screen.getByRole("link", { name: "By month" })).toHaveAttribute("href", "/appraisals/department?unit=dept-1&view=months&periodKind=week&start=2026-10-05&end=2026-10-11");
    expect(screen.getByRole("link", { name: "This period" })).toHaveAttribute("href", "/appraisals/department?unit=dept-1&periodKind=week&start=2026-10-05&end=2026-10-11");
  });

  it("encodes a department id", () => {
    expect(kpiViewHref("a b&c", "months")).toBe("/appraisals/department?unit=a+b%26c&view=months");
  });
});
