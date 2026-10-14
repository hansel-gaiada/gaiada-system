import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/deptAppraisalActions", () => ({ saveDeptAppraisalCommentary: vi.fn(), saveDeptAppraisalAssessment: vi.fn() }));

import { AppraisalView, CyclePicker } from "./AppraisalView";
import type { CyclePick, DeptAppraisalView } from "@/lib/deptAppraisalFormat";

const kpi = (over: Partial<DeptAppraisalView["kpis"][number]> = {}): DeptAppraisalView["kpis"][number] => ({
  key: "projects-on-time", label: "Projects on time", unit: "percent", direction: "up_good", value: 0.714, numerator: 5, denominator: 7,
  target: 0.75, tolerance: 0.05, targetSource: "approved", condition: "at_risk", ...over,
});

const view = (over: Partial<DeptAppraisalView> = {}): DeptAppraisalView => ({
  cycle: { id: "c1", name: "H2 2026 review", periodStart: "2026-07-01", periodEnd: "2026-12-31", status: "open" },
  unit: { id: "dept-1", name: "Web Dev" },
  workspace: "web-dev",
  kpis: [kpi(), kpi({ key: "requests-within-sla", label: "Requests within the SLA", value: null, condition: "unavailable", reason: "no_reader", target: null, tolerance: null, targetSource: "none", numerator: undefined, denominator: undefined })],
  condition: "at_risk",
  history: [
    { month: "2026-07-01", condition: "on_track", kpis: [] },
    { month: "2026-08-01", condition: "at_risk", kpis: [] },
    { month: "2026-09-01", condition: "unavailable", kpis: [] },
  ],
  people: { total: 6, byStatus: { draft: 1, submitted: 2, acknowledged: 1, disputed: 0, finalized: 2 }, distribution: [
    { band: 1, count: 0 }, { band: 2, count: 0 }, { band: 3, count: 1 }, { band: 4, count: 3 }, { band: 5, count: 1 },
  ] },
  hodCommentary: null,
  gmAssessment: null,
  ...over,
});

describe("AppraisalView", () => {
  it("shows the condition over the cycle in words, the cycle's name and range, and the KPI results with their targets", () => {
    render(<AppraisalView view={view()} canComment={false} canAssess={false} />);
    const banner = screen.getByRole("region", { name: "Department condition over the cycle" });
    expect(within(banner).getByText("At risk")).toBeTruthy();
    expect(banner.textContent).toContain("Web Dev over H2 2026 review (1 Jul 2026 to 31 Dec 2026)");
    const tiles = screen.getByRole("list", { name: "KPI results over the cycle" });
    expect(within(tiles).getByText("71%")).toBeTruthy();
    expect(within(tiles).getByText("Target 75% (tolerance 5 pts)")).toBeTruthy();
    expect(within(tiles).getByText("5 of 7")).toBeTruthy();
    // a KPI with no reader says so in words, with no number
    expect(within(tiles).getByText("Not measured yet")).toBeTruthy();
    expect(screen.getByText(/judged against the target in force for the cycle.s last month/)).toBeTruthy();
  });

  it("lays the history out one entry per month, each condition said in words", () => {
    render(<AppraisalView view={view()} canComment={false} canAssess={false} />);
    const items = within(screen.getByRole("list", { name: "Condition history" })).getAllByRole("listitem");
    expect(items.map((i) => i.getAttribute("aria-label"))).toEqual(["Jul 2026: on track", "Aug 2026: at risk", "Sep 2026: unavailable"]);
  });

  it("shows the people as counts and the distribution by band", () => {
    render(<AppraisalView view={view()} canComment={false} canAssess={false} />);
    expect(screen.getByText("6 appraisals")).toBeTruthy();
    const status = within(screen.getByRole("list", { name: "Appraisals by status" }));
    expect(status.getAllByRole("listitem").map((i) => i.textContent)).toEqual(["Draft 1", "Submitted 2", "Acknowledged 1", "Disputed 0", "Finalized 2"]);
    const bands = within(screen.getByRole("list", { name: "Distribution of composite scores by band" }));
    expect(bands.getAllByRole("listitem").map((i) => i.textContent)).toEqual(["Band 10", "Band 20", "Band 31", "Band 43", "Band 51"]);
  });

  it("says why there is no distribution instead of drawing an empty chart, and never lists a person", () => {
    const { container } = render(
      <AppraisalView view={view({ people: { total: 2, byStatus: { draft: 0, submitted: 2, acknowledged: 0, disputed: 0, finalized: 0 }, distribution: null, reason: "too_few" } })} canComment={false} canAssess={false} />,
    );
    expect(screen.getByText(/Too few scored appraisals to show a distribution/)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Distribution of composite scores by band" })).toBeNull();
    expect(container.textContent).not.toMatch(/Band \d/);
  });

  it("an empty roster says so", () => {
    render(<AppraisalView view={view({ people: { total: 0, byStatus: { draft: 0, submitted: 0, acknowledged: 0, disputed: 0, finalized: 0 }, distribution: null, reason: "too_few" } })} canComment={false} canAssess={false} />);
    expect(screen.getByText("No appraisals in this cycle yet")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Appraisals by status" })).toBeNull();
  });

  it("an open cycle with nothing written says so and offers each form only to the people the capability reaches", () => {
    const { rerender } = render(<AppraisalView view={view()} canComment={false} canAssess={false} />);
    expect(screen.getByText("No commentary written yet.")).toBeTruthy();
    expect(screen.getByText("No assessment written yet.")).toBeTruthy();
    expect(screen.queryByRole("form", { name: "Head's commentary" })).toBeNull();
    expect(screen.queryByRole("form", { name: "GM's assessment" })).toBeNull();

    rerender(<AppraisalView view={view()} canComment canAssess={false} />);
    expect(screen.getByRole("form", { name: "Head's commentary" })).toBeTruthy();
    expect(screen.queryByRole("form", { name: "GM's assessment" })).toBeNull();

    rerender(<AppraisalView view={view()} canComment={false} canAssess />);
    expect(screen.queryByRole("form", { name: "Head's commentary" })).toBeNull();
    expect(screen.getByRole("form", { name: "GM's assessment" })).toBeTruthy();
  });

  it("shows the written commentary with its author and date, as plain text, and pre-fills the form with it", () => {
    render(
      <AppraisalView
        view={view({ hodCommentary: { text: "A <b>strong</b> half.", by: "u1", byName: "Ayu", at: "2026-10-02T09:00:00.000Z" } })}
        canComment canAssess={false}
      />,
    );
    // The textarea carries its pre-filled value as text too, so the display is asserted on the paragraph.
    const shown = screen.getByText("A <b>strong</b> half.", { selector: "p" });
    expect(shown.querySelector("b")).toBeNull();
    expect(screen.getByText("By Ayu on 2026-10-02")).toBeTruthy();
    const form = screen.getByRole("form", { name: "Head's commentary" });
    expect((within(form).getByLabelText(/^Commentary/) as HTMLTextAreaElement).value).toBe("A <b>strong</b> half.");
    expect(within(form).getByRole("button", { name: "Replace commentary" })).toBeTruthy();
  });

  it("shows the GM's judgement BESIDE the computed condition, never in place of it", () => {
    render(
      <AppraisalView
        view={view({ gmAssessment: { text: "Recovering well.", condition: "on_track", by: "gm1", byName: "Hansel", at: "2026-10-03T09:00:00.000Z" } })}
        canComment={false} canAssess
      />,
    );
    const para = screen.getByText(/Computed:/).closest("p")!;
    expect(para.textContent).toContain("Computed: At risk");
    expect(para.textContent).toContain("GM's judgement: On track");
    expect(screen.getByText("Recovering well.", { selector: "p" })).toBeTruthy();
    const form = screen.getByRole("form", { name: "GM's assessment" });
    expect((within(form).getByLabelText(/Your judgement/) as HTMLSelectElement).value).toBe("on_track");
  });

  it("a closed cycle is the record: it says so, offers no form even to someone who may write, and words a missing half as never written", () => {
    render(<AppraisalView view={view({ cycle: { id: "c0", name: "H1 2026 review", periodStart: "2026-01-01", periodEnd: "2026-06-30", status: "closed" } })} canComment canAssess />);
    expect(screen.getByRole("note").textContent).toMatch(/This cycle is closed/);
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.getByText("No commentary was written for this cycle.")).toBeTruthy();
    expect(screen.getByText("No assessment was written for this cycle.")).toBeTruthy();
  });
});

describe("CyclePicker", () => {
  const cycles: CyclePick[] = [
    { id: "c2", name: "H2 2026 review", periodStart: "2026-07-01", periodEnd: "2026-12-31", status: "open" },
    { id: "c1", name: "H1 2026 review", periodStart: "2026-01-01", periodEnd: "2026-06-30", status: "closed" },
  ];
  it("lists the cycles as links that keep the department, with the chosen one marked, and a way back to the KPI view", () => {
    render(<CyclePicker unitId="dept-1" cycles={cycles} chosenId="c1" />);
    const nav = screen.getByRole("navigation", { name: "Appraisal cycle" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/appraisals/department?unit=dept-1",
      "/appraisals/department?unit=dept-1&cycle=c2",
      "/appraisals/department?unit=dept-1&cycle=c1",
    ]);
    expect(links[2].getAttribute("aria-current")).toBe("page");
    expect(links[0].getAttribute("aria-current")).toBeNull();
    expect(within(nav).getByText("Closed")).toBeTruthy();
  });
  it("marks the KPI view as the current one when no cycle is chosen", () => {
    render(<CyclePicker unitId="dept-1" cycles={cycles} chosenId={null} />);
    expect(screen.getByRole("link", { name: "KPIs for a period" }).getAttribute("aria-current")).toBe("page");
  });
  it("says the list is not theirs to read instead of showing an empty picker, and an unreadable list as unreadable", () => {
    const { rerender } = render(<CyclePicker unitId="dept-1" cycles={null} chosenId={null} reason="forbidden" />);
    expect(screen.getByText(/list of cycles is for department heads and the company-wide tiers/)).toBeTruthy();
    expect(screen.queryByText(/cycle link/)).toBeNull();
    rerender(<CyclePicker unitId="dept-1" cycles={null} chosenId={null} reason="boom" />);
    expect(screen.getByText(/could not be read: boom/)).toBeTruthy();
    expect(screen.getByText(/A cycle link still opens its department appraisal/)).toBeTruthy();
  });
  it("says there are no cycles only when the read was allowed and empty", () => {
    render(<CyclePicker unitId="dept-1" cycles={[]} chosenId={null} />);
    expect(screen.getByText("There are no appraisal cycles yet.")).toBeTruthy();
  });
});
