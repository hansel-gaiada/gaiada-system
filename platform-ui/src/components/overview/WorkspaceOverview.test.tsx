import { render, screen, within } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { WorkspaceOverview } from "./WorkspaceOverview";
import { OVERVIEW_WIDGETS, hasOverviewWidget, type OverviewWidgetComponent } from "./widgets";
import { COMPANY_SUBJECT, subjectOfRef, type OverviewSubject } from "@/lib/overview";
import { resolveMyWorkspaces } from "@/lib/workspaceAccess";
import { agencyTree, me, member } from "@/lib/workspaceFixtures";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {} }),
  usePathname: () => "/departments/d-web",
  useSearchParams: () => new URLSearchParams(),
}));

// The real widget host reaches the server actions through the Now band's blocks; the frame's tests never run them.
vi.mock("@/app/(app)/actions", () => ({ decideQueueItem: vi.fn() }));
vi.mock("@/lib/checkinActions", () => ({ submitCheckin: vi.fn() }));

afterEach(() => vi.restoreAllMocks());

const made = { ...me([member()]), name: "Made Putra" };
const placed = resolveMyWorkspaces({ me: made, tenantId: "co-a", root: agencyTree({ frontend: ["u-1"] }) });
const webDev = subjectOfRef(placed.mine[0]);
const MORNING = new Date(2026, 9, 13, 9, 30);

// The default host is empty: the blocks are server components that read their own data, and each has its own
// test. Here the frame is drawn with the host a test chooses.
const draw = (props: Partial<Parameters<typeof WorkspaceOverview>[0]> = {}) =>
  render(<WorkspaceOverview me={made} tenantId="co-a" subject={webDev} period="month" now={MORNING} widgets={{}} {...props} />);

describe("WorkspaceOverview: the header", () => {
  it("greets by first name and states the workspace, the company and the date", () => {
    draw();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Good morning, Made");
    expect(screen.getByText("Web Dev · Agency · Tuesday 13 October")).toBeInTheDocument();
  });

  it("follows the render clock into the afternoon and the evening", () => {
    const { unmount } = draw({ now: new Date(2026, 9, 13, 14, 0) });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Good afternoon, Made");
    unmount();
    draw({ now: new Date(2026, 9, 13, 21, 0) });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Good evening, Made");
  });

  it("has the period selector with the chosen period pressed", () => {
    draw({ period: "week" });
    expect(screen.getByRole("button", { name: "Week" })).toHaveAttribute("aria-pressed", "true");
  });

  it("offers the workspace's built quick actions as links with concrete hrefs", () => {
    draw();
    const actions = screen.getByRole("navigation", { name: "Quick actions" });
    expect(within(actions).getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["New briefing", "/departments/d-web/prd"],
      ["Triage requests", "/departments/d-web/requests"],
    ]);
  });

  it("draws no quick-action strip when there is none, as in the company frame", () => {
    draw({ subject: COMPANY_SUBJECT });
    expect(screen.queryByRole("navigation", { name: "Quick actions" })).not.toBeInTheDocument();
    expect(screen.getByText("Company · Agency · Tuesday 13 October")).toBeInTheDocument();
  });
});

describe("WorkspaceOverview: with no block to draw", () => {
  it("shows the header and one honest line, and no band, block or invented number", () => {
    const { container } = draw();
    expect(screen.getByText("The Web Dev Overview is being built. Until then, use its pages from the sidebar.")).toBeInTheDocument();
    expect(screen.queryAllByRole("heading", { level: 2 })).toHaveLength(0);
    expect(container.querySelectorAll(".ov-band")).toHaveLength(0);
    expect(container.querySelectorAll(".ov-block")).toHaveLength(0);
  });

  it("does the same for the company frame", () => {
    draw({ subject: COMPANY_SUBJECT });
    expect(screen.getByText(/The Company Overview is being built/)).toBeInTheDocument();
  });

  it("hosts the Now band's two blocks, Your numbers, My activity, Pulse, the Work blocks and the Growth blocks, and no other (DW-3c, DW-3d, DW-3j, DW-3e, DW-3f, DW-3g)", () => {
    expect(Object.keys(OVERVIEW_WIDGETS).sort()).toEqual(["appraisal", "campaigns", "learning", "my-activity", "needs-you", "projects", "pulse", "requests", "today", "your-numbers"]);
    expect(hasOverviewWidget("needs-you")).toBe(true);
    expect(hasOverviewWidget("pulse")).toBe(true);
    expect(hasOverviewWidget("projects")).toBe(true);
    expect(hasOverviewWidget("learning")).toBe(true);
    expect(hasOverviewWidget("appraisal")).toBe(true);
    expect(hasOverviewWidget("condition")).toBe(false);
  });
});

describe("WorkspaceOverview: the page's own body stays (plan §2.6 rule 1)", () => {
  const legacy = <div><h3>Project health</h3><p>today's KPI strip</p></div>;

  it("renders the legacy body under a quiet label, and the being-built line goes away", () => {
    draw({ legacy });
    expect(screen.getByRole("heading", { level: 2, name: "More from Web Dev" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "More from Web Dev" })).getByText("today's KPI strip")).toBeInTheDocument();
    expect(screen.queryByText(/is being built/)).not.toBeInTheDocument();
  });

  it("keeps the new header on top of it", () => {
    draw({ legacy });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Good morning, Made");
    expect(screen.getByRole("group", { name: "Period" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 }).compareDocumentPosition(screen.getByText("today's KPI strip")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("draws it below the bands when there are bands", () => {
    const host: Record<string, OverviewWidgetComponent> = { "needs-you": () => <p>five items</p> };
    const subject: OverviewSubject = { ...webDev, widgets: [{ key: "needs-you", band: "now", label: "Needs you" }] };
    draw({ subject, widgets: host, legacy });
    const labels = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(labels).toEqual(["Now", "More from Web Dev"]);
    expect(screen.getByText("five items").compareDocumentPosition(screen.getByText("today's KPI strip")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows the being-built line only without a legacy body", () => {
    const { unmount } = draw();
    expect(screen.getByText(/is being built/)).toBeInTheDocument();
    expect(screen.queryByText(/More from/)).not.toBeInTheDocument();
    unmount();
    draw({ legacy });
    expect(screen.queryByText(/is being built/)).not.toBeInTheDocument();
  });
});

describe("WorkspaceOverview: the bands and the host", () => {
  const subject: OverviewSubject = {
    ...webDev,
    widgets: [
      { key: "learning", band: "growth", label: "Learning" },
      { key: "pulse", band: "department", label: "Pulse" },
      { key: "needs-you", band: "now", label: "Needs you" },
      { key: "projects", band: "work", label: "Projects", ticket: "DW-3f" },
      { key: "no-component", band: "you", label: "No component yet" },
    ],
  };
  const host: Record<string, OverviewWidgetComponent> = {
    learning: () => <p>two assigned</p>,
    pulse: () => <p>four tiles</p>,
    "needs-you": () => <p>five items</p>,
    projects: () => <p>should stay hidden: ticketed</p>,
  };

  it("draws the bands in the fixed order with a quiet label each, and skips the empty ones", () => {
    draw({ subject, widgets: host });
    const labels = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    // The Department band carries the workspace's own name. You and Work have nothing to draw.
    expect(labels).toEqual(["Now", "Web Dev", "Growth"]);
    expect(screen.queryByText(/is being built/)).not.toBeInTheDocument();
  });

  it("draws each built widget in its band, and hides a planned one or one with no component", () => {
    draw({ subject, widgets: host });
    expect(screen.getByText("five items")).toBeInTheDocument();
    expect(screen.getByText("four tiles")).toBeInTheDocument();
    expect(screen.getByText("two assigned")).toBeInTheDocument();
    expect(screen.queryByText(/should stay hidden/)).not.toBeInTheDocument();
    expect(screen.queryByText("No component yet")).not.toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Now" })).getByText("five items")).toBeInTheDocument();
  });

  it("places the Pulse only for a workspace with a built tile, and hands it those tiles (DW-3e)", () => {
    const seen: string[][] = [];
    const spy: OverviewWidgetComponent = (props) => {
      seen.push((props.pulse ?? []).map((t) => t.key));
      return <p>pulse drawn</p>;
    };
    const one = (s: OverviewSubject): OverviewSubject => ({ ...s, widgets: [{ key: "pulse", band: "department", label: "Pulse" }] });
    const first = draw({ subject: one(webDev), widgets: { pulse: spy } });
    expect(seen[0]).toEqual(["requests-waiting", "sites-with-a-problem", "runs-waiting-approval"]);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Web Dev");

    first.unmount();

    // SEO has no built tile: no Pulse and so no Department band over nothing.
    const seoPlaced = resolveMyWorkspaces({ me: made, tenantId: "co-a", root: agencyTree({ seo: ["u-1"] }) });
    draw({ subject: one(subjectOfRef(seoPlaced.mine[0])), widgets: { pulse: spy } });
    expect(seen).toHaveLength(1);
    expect(screen.queryAllByRole("heading", { level: 2 })).toHaveLength(0);
  });

  it("gives a widget its inputs", () => {
    const seen: Record<string, unknown>[] = [];
    const spy: OverviewWidgetComponent = (props) => {
      seen.push({ tenantId: props.tenantId, period: props.period, deptId: props.deptId, unitPath: props.unitPath, key: props.widget.key });
      return <p>spied</p>;
    };
    draw({ subject, widgets: { "needs-you": spy }, period: "week" });
    expect(seen).toEqual([{ tenantId: "co-a", period: "week", deptId: "d-web", unitPath: ["d-web", "root"], key: "needs-you" }]);
  });

  it("gives a widget the workspace's tools, and Company none", () => {
    const seen: string[][] = [];
    const spy: OverviewWidgetComponent = (props) => {
      seen.push(props.tools.map((t) => t.key));
      return <p>spied</p>;
    };
    const one: OverviewSubject = { ...webDev, widgets: [{ key: "today", band: "now", label: "Today" }] };
    draw({ subject: one, widgets: { today: spy } });
    expect(seen[0]).toEqual(["claude-code", "claude", "claude-design", "github", "figma", "vscode"]);
    const company: OverviewSubject = { ...COMPANY_SUBJECT, widgets: [{ key: "today", band: "now", label: "Today" }] };
    draw({ subject: company, widgets: { today: spy } });
    expect(seen[1]).toEqual([]);
  });

  it("says the block's title and Unavailable for a widget whose read throws, and the rest still draws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken: OverviewWidgetComponent = () => {
      throw new Error("read failed");
    };
    draw({ subject, widgets: { ...host, pulse: broken } });
    const dept = screen.getByRole("region", { name: "Web Dev" });
    expect(within(dept).getByRole("heading", { name: "Pulse" })).toBeInTheDocument();
    expect(within(dept).getByText("Unavailable")).toBeInTheDocument();
    expect(screen.queryByText("four tiles")).not.toBeInTheDocument();
    expect(screen.getByText("five items")).toBeInTheDocument();
    expect(screen.getByText("two assigned")).toBeInTheDocument();
  });
});

describe("WorkspaceOverview: the Work band (DW-3f)", () => {
  const host: Record<string, OverviewWidgetComponent> = {
    projects: () => <p>projects block</p>,
    campaigns: () => <p>campaigns block</p>,
    requests: () => <p>requests block</p>,
  };

  it("draws the Work band with its three blocks for a department that has a unit", () => {
    draw({ widgets: host });
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Work"]);
    for (const t of ["projects block", "campaigns block", "requests block"]) expect(screen.getByText(t)).toBeInTheDocument();
  });

  it("drops the whole band, label and all, for a workspace with no unit to scope to", () => {
    draw({ widgets: host, subject: { ...webDev, deptId: null } });
    expect(screen.queryByRole("heading", { level: 2, name: "Work" })).not.toBeInTheDocument();
    expect(screen.queryByText("projects block")).not.toBeInTheDocument();
  });
});

describe("WorkspaceOverview: the Growth band and the company's modules (DW-3g)", () => {
  const host: Record<string, OverviewWidgetComponent> = {
    learning: () => <p>learning block</p>,
    appraisal: () => <p>appraisal block</p>,
  };

  it("places both blocks when every module is on (the default)", () => {
    draw({ widgets: host });
    expect(screen.getByRole("heading", { level: 2, name: "Growth" })).toBeInTheDocument();
    expect(screen.getByText("learning block")).toBeInTheDocument();
    expect(screen.getByText("appraisal block")).toBeInTheDocument();
  });

  it("drops only the block whose module is off", () => {
    draw({ widgets: host, moduleOn: (m: string) => m !== "lms" });
    expect(screen.queryByText("learning block")).not.toBeInTheDocument();
    expect(screen.getByText("appraisal block")).toBeInTheDocument();
  });

  it("drops the whole band, label and all, when both modules are off", () => {
    draw({ widgets: host, moduleOn: (m: string) => m !== "lms" && m !== "reports" });
    expect(screen.queryByRole("heading", { level: 2, name: "Growth" })).not.toBeInTheDocument();
    expect(screen.queryByText("appraisal block")).not.toBeInTheDocument();
  });
});
