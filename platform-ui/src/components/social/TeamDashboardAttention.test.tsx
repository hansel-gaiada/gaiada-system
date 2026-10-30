import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

// SCP-5f (BFF §63.27.4): a late cycle step in the Team dashboard's "Needs attention": its own group with its words, one row per step with the client, the step's title and the day
// it was due in words, linking to the client's Plan tab. Team-level: no person, no holder.
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));

import { TeamDashboard } from "./TeamDashboard";
import { asTeamDashboard } from "@/lib/socialTeam";

const data = (needsAttention: unknown[], partial: string[] = []) =>
  asTeamDashboard({ month: "2026-10", needsAttention, clients: [], workload: [], waits: [], stepAverages: [], estimatesNotSet: [], personRowsLimited: false, partial });
const lateStep = (over: Record<string, unknown> = {}) => ({
  kind: "cycle_step_late", engagementId: "e-1", clientName: "Northwind Traders", step: "planning", dueDate: "2026-10-12", title: "November 2026 plan", since: "2026-10-12", ...over,
});

describe("a late cycle step in Needs attention", () => {
  it("is a group of its own, worded, with one row per step: the client, the step, the day it was due, a link to the client's Plan tab", () => {
    render(<TeamDashboard data={data([lateStep(), lateStep({ step: "report", dueDate: "2026-10-05", since: "2026-10-05", title: "Monthly report for August 2026" })])} deptId="d-soc" />);
    const group = document.querySelector<HTMLElement>('[data-kind="cycle_step_late"]')!;
    expect(within(group).getByRole("heading", { name: /Cycle step late/ })).toHaveTextContent("2");
    expect(group).toHaveTextContent("past its due date and still open");
    const rows = within(group).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Northwind Traders");
    expect(rows[0]).toHaveTextContent("Monthly report for August 2026"); // the longest late first
    expect(rows[0]).toHaveTextContent("Was due 5 Oct");
    expect(rows[1]).toHaveTextContent("November 2026 plan");
    expect(rows[1]).toHaveTextContent("Was due 12 Oct");
    expect(within(rows[1]).getByRole("link")).toHaveAttribute("href", "/departments/d-soc/profile/e-1?tab=plan");
  });

  it("names no person and no holder", () => {
    render(<TeamDashboard data={data([lateStep()])} deptId="d-soc" />);
    const row = within(document.querySelector<HTMLElement>('[data-kind="cycle_step_late"]')!).getByRole("listitem");
    expect(row).not.toHaveTextContent(/With /);
  });

  it("an unavailable needs-attention list is unknown, not an empty one", () => {
    render(<TeamDashboard data={data([], ["needsAttention"])} deptId="d-soc" />);
    expect(document.querySelector('[data-kind="cycle_step_late"]')).toBeNull();
    expect(screen.getByTestId("partial")).toHaveTextContent("needs attention");
  });
});
