import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));

import { BehindTheMiss, type MissEntry } from "./BehindTheMiss";
import type { KpiDriversResult } from "@/lib/deptKpiDrivers";
import type { KpiDriver, KpiDrivers } from "@/lib/deptKpiDriverFormat";

// DW-4j-3 — "Behind the miss" (BFF §43.8). The page passes the honest reader's result in; every state of it is said here: the rows, the true
// "No one stands out", the reason in words, the failure line (never an empty claim), and the quiet nothing for a refusal.

const PERIOD = { periodKind: "week", start: "2026-10-05", end: "2026-10-11" };
const drivers = (key: string, label: string, rows: KpiDriver[] | null, reason?: string): KpiDrivers => ({
  kpi: { key, label, unit: key === "overdue-tasks" ? "count" : "percent", direction: key === "overdue-tasks" ? "down_good" : "up_good" },
  period: PERIOD, drivers: rows, ...(reason ? { reason } : {}),
});
const ok = (d: KpiDrivers): KpiDriversResult => ({ kind: "ok", data: d });
const entry = (key: string, label: string, unit: "percent" | "count", condition: "at_risk" | "off_track", result: KpiDriversResult): MissEntry => ({ kpi: { key, label, unit, condition }, result });

const projectsRows: KpiDriver[] = [
  { kind: "project", id: "p-web-1", name: "Client site redesign", value: 0.6, numerator: 3, denominator: 5 },
  { kind: "project", id: "p-web-2", name: "Mobile app revamp", value: 4 / 6, numerator: 4, denominator: 6 },
];
const projects = entry("projects-on-time", "Projects on time", "percent", "at_risk", ok(drivers("projects-on-time", "Projects on time", projectsRows)));

describe("BehindTheMiss: rows", () => {
  it("lists the projects in the order the server sent them, each linked to its page with its value and parts", () => {
    render(<BehindTheMiss entries={[projects]} />);
    expect(screen.getByRole("heading", { name: /Behind the miss/ })).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Behind the miss: Projects on time" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual(["Client site redesign60%3 of 5 milestones hit", "Mobile app revamp67%4 of 6 milestones hit"]);
    expect(within(rows[0]).getByRole("link", { name: "Client site redesign" })).toHaveAttribute("href", "/projects/p-web-1");
  });

  it("says the KPI's condition in words beside its name", () => {
    render(<BehindTheMiss entries={[projects]} />);
    expect(screen.getByRole("heading", { name: "Projects on time" })).toBeInTheDocument();
    expect(screen.getByText("At risk")).toBeInTheDocument();
  });

  it("links a person to their report for the period, and says an overdue count once", () => {
    const rows: KpiDriver[] = [{ kind: "person", id: "u-9", name: "Made Putra", value: 4 }, { kind: "person", id: "u-8", name: "Ayu", value: 2 }];
    render(<BehindTheMiss entries={[entry("overdue-tasks", "Overdue tasks", "count", "off_track", ok(drivers("overdue-tasks", "Overdue tasks", rows)))]} />);
    const list = screen.getByRole("list", { name: "Behind the miss: Overdue tasks" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((r) => r.textContent)).toEqual(["Made Putra4 overdue", "Ayu2 overdue"]);
    expect(within(items[0]).getByRole("link", { name: "Made Putra" })).toHaveAttribute("href", "/reports/person?periodKind=week&start=2026-10-05&end=2026-10-11&scopeRef=u-9");
    expect(screen.getByText("Off track")).toBeInTheDocument();
  });

  it("shows at most five rows even if more are sent", () => {
    const many: KpiDriver[] = Array.from({ length: 8 }, (_, i) => ({ kind: "person" as const, id: `u-${i}`, name: `Person ${i}`, value: 0.1 * i, numerator: i, denominator: 10 }));
    render(<BehindTheMiss entries={[entry("reopened-work-rate", "Reopened work rate", "percent", "at_risk", ok(drivers("reopened-work-rate", "Reopened work rate", many)))]} />);
    expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(5);
  });
});

describe("BehindTheMiss: the other honest states", () => {
  it("an empty answer is a true statement, worded for the grain: projects and people", () => {
    render(
      <BehindTheMiss
        entries={[
          entry("projects-on-time", "Projects on time", "percent", "at_risk", ok(drivers("projects-on-time", "Projects on time", []))),
          entry("check-in-compliance", "Check-in compliance", "percent", "off_track", ok(drivers("check-in-compliance", "Check-in compliance", []))),
        ]}
      />,
    );
    expect(screen.getByText("No project missed a milestone")).toBeInTheDocument();
    expect(screen.getByText("No one stands out")).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("drivers null says why, in words: not measured yet, or no breakdown for this KPI", () => {
    render(
      <BehindTheMiss
        entries={[
          entry("client-site-uptime", "Client site uptime", "percent", "at_risk", ok(drivers("client-site-uptime", "Client site uptime", null, "no_reader"))),
          entry("utilization", "Utilization", "percent", "off_track", ok(drivers("utilization", "Utilization", null, "no_drivers"))),
          entry("later", "Later KPI", "percent", "off_track", ok(drivers("later", "Later KPI", null, "reader_failed"))),
        ]}
      />,
    );
    expect(screen.getByText("Not measured yet")).toBeInTheDocument();
    expect(screen.getAllByText("No breakdown for this KPI")).toHaveLength(2);
    expect(screen.queryByText("No one stands out")).toBeNull();
  });

  it("a failed read says so and never claims an empty list; a missing unit is the same failure", () => {
    render(
      <BehindTheMiss
        entries={[
          entry("projects-on-time", "Projects on time", "percent", "at_risk", { kind: "error", reason: "boom" }),
          entry("overdue-tasks", "Overdue tasks", "count", "off_track", { kind: "not_found" }),
        ]}
      />,
    );
    expect(screen.getAllByText("Couldn't load what is behind this")).toHaveLength(2);
    expect(screen.queryByText("No one stands out")).toBeNull();
    expect(screen.queryByText("No project missed a milestone")).toBeNull();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("a refusal renders nothing for that KPI, and nothing at all when every KPI was refused", () => {
    const { container, rerender } = render(<BehindTheMiss entries={[entry("projects-on-time", "Projects on time", "percent", "at_risk", { kind: "forbidden" })]} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<BehindTheMiss entries={[entry("projects-on-time", "Projects on time", "percent", "at_risk", { kind: "forbidden" }), projects]} />);
    expect(screen.getByRole("list", { name: "Behind the miss: Projects on time" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 4 })).toHaveLength(1);
  });

  it("renders nothing when there is no KPI to look behind", () => {
    const { container } = render(<BehindTheMiss entries={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
