import { cleanup, render, screen, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OVERVIEW_WIDGETS, hasOverviewWidget, type OverviewWidgetProps } from "./index";
import { ClientHealth } from "./ClientHealth";
import { ClientHealthBlock } from "./ClientHealthBlock";
import { clientHealthView, clientHealthWidgetPlaced, MAX_CLIENT_HEALTH_ROWS } from "@/lib/overviewClientHealth";
import { COMPANY_OVERVIEW, WORKSPACES, GENERIC_WORKSPACE } from "@/lib/workspaces";
import { COMPANY_SUBJECT, selectBands } from "@/lib/overview";
import { HOTEL, agencyTree, me as meFixture, member } from "@/lib/workspaceFixtures";
import { resolveMyWorkspaces } from "@/lib/workspaceAccess";
import { subjectOfRef } from "@/lib/overview";
import type { ClientHealthBoard, ClientHealthRow, ClientHealthSignals, HealthSource, HealthState } from "@/lib/clientHealth";
import * as hub from "@/lib/clientHub";
import * as entities from "@/lib/entities";

// DW-10d: the Client health block (DW-D34's first optional block). A summary of the staff health board: counts, the clients that need a
// person worst first, the board link. A failed read is "Unavailable", never an empty board; "No clients" and "All N on track" only
// after a successful read; the department narrows the board exactly as the board page does.

vi.mock("@/lib/clientHub", () => ({ getClientHealthBoard: vi.fn() }));
vi.mock("@/lib/entities", () => ({ readClients: vi.fn() }));
vi.mock("@/app/(app)/actions", () => ({ decideQueueItem: vi.fn() }));
vi.mock("@/lib/deptKpiAlertActions", () => ({ acknowledgeKpiAlert: vi.fn() }));
vi.mock("@/lib/checkinActions", () => ({ submitCheckin: vi.fn() }));

const board = vi.mocked(hub.getClientHealthBoard);
const readClients = vi.mocked(entities.readClients);

const ASOF = "2026-10-15T12:00:00.000Z";
const daysAgo = (n: number) => new Date(Date.parse(ASOF) - n * 86_400_000).toISOString();
const SIGNALS: ClientHealthSignals = {
  waitingOnUs: { count: 0, oldestSince: null }, waitingOnClient: { count: 0, oldestSince: null },
  lateDeliverables: { count: 0, oldestDue: null }, lateMilestones: { count: 0, oldestDue: null },
  openChangeRequests: 0, conversationsAwaitingReply: 0, overdueInvoices: { count: 0, oldestDue: null },
  site: null, deliveryOnTime: null, activeProjects: 1, activeServices: 0,
};
const row = (id: string, name: string, state: HealthState, over: Partial<ClientHealthSignals> = {}, code?: "waiting_on_us_14d" | "invoice_overdue"): ClientHealthRow => ({
  clientId: id, name, status: "active", ownerUserId: null, ownerName: null, state,
  reasons: code ? [{ code, count: 1, since: daysAgo(15) }] : [], signals: { ...SIGNALS, ...over },
});
const ok = (clients: ClientHealthRow[], unavailable: HealthSource[] = []) =>
  ({ kind: "ok" as const, data: { asOf: ASOF, onTimeKnownSince: null, clients, unavailable } satisfies ClientHealthBoard });
const clientsOk = (ids: string[]) => ({ kind: "ok" as const, data: ids.map((id) => ({ id }) as never) });
const refused = { kind: "forbidden" as const };
const failed = { kind: "unavailable" as const, reason: "boom" };

const person = meFixture([member()]);
const props = (extra: Partial<OverviewWidgetProps> = {}): OverviewWidgetProps => ({
  me: person, tenantId: "co-a", period: "month", deptId: null, unitPath: [], tools: [],
  widget: { key: "client-health", band: "work", label: "Client health" }, ...extra,
});
const block = () => screen.getByRole("region", { name: "Client health" });

const MIX = [
  row("c-ok", "Fine Co", "on_track"),
  row("c-quiet", "Quiet Co", "quiet"),
  row("c-risk", "Risky Co", "at_risk", { waitingOnUs: { count: 1, oldestSince: daysAgo(8) } }),
  row("c-off", "Late Co", "off_track", { waitingOnUs: { count: 2, oldestSince: daysAgo(15) } }, "waiting_on_us_14d"),
  row("c-unk", "Unknown Co", "unknown"),
];

beforeEach(() => { board.mockReset(); readClients.mockReset(); });
afterEach(cleanup);

describe("Client health is wired into the host (DW-10d)", () => {
  it("has a component, and the registry lists it as the one optional block of every workspace's Overview", () => {
    expect(hasOverviewWidget("client-health", OVERVIEW_WIDGETS)).toBe(true);
    for (const list of [COMPANY_OVERVIEW, ...[...WORKSPACES, GENERIC_WORKSPACE].map((w) => w.overview)]) {
      for (const w of list.filter((x) => x.placement === "optional")) expect(hasOverviewWidget(w.key, OVERVIEW_WIDGETS), w.key).toBe(true);
    }
  });
});

describe("ClientHealth (widget): the company frame", () => {
  it("reads the whole board once, with no department read, and says the counts worst first", async () => {
    board.mockResolvedValue(ok(MIX));
    render(await ClientHealth(props()));
    expect(board).toHaveBeenCalledWith("u-1", "co-a");
    expect(readClients).not.toHaveBeenCalled();
    expect(within(block()).getByText("1 off track · 1 at risk · 1 unknown · 1 on track · 1 quiet")).toBeInTheDocument();
  });

  it("lists the clients that need a person, worst first, each with its chip, short reason and link", async () => {
    board.mockResolvedValue(ok(MIX));
    render(await ClientHealth(props()));
    const items = within(block()).getAllByRole("listitem");
    expect(items.map((li) => li.getAttribute("data-client"))).toEqual(["c-off", "c-risk", "c-unk"]);
    expect(items[0]).toHaveTextContent("Off track");
    expect(items[0]).toHaveTextContent("Waiting on us 14+ days");
    expect(within(items[0]).getByRole("link", { name: "Late Co" })).toHaveAttribute("href", "/clients/c-off");
    expect(items[1]).toHaveTextContent("At risk");
    // On track and quiet clients are counted, never listed.
    expect(within(block()).queryByText("Fine Co")).toBeNull();
    expect(within(block()).queryByText("Quiet Co")).toBeNull();
  });

  it("links to the health board", async () => {
    board.mockResolvedValue(ok(MIX));
    render(await ClientHealth(props()));
    expect(within(block()).getByRole("link", { name: "Open the health board" })).toHaveAttribute("href", "/clients/health");
  });

  it("shows at most five clients and says how many more need a look", async () => {
    const many = Array.from({ length: 8 }, (_, i) => row(`c-${i}`, `Client ${i}`, "at_risk"));
    board.mockResolvedValue(ok(many));
    render(await ClientHealth(props()));
    expect(within(block()).getAllByRole("listitem")).toHaveLength(MAX_CLIENT_HEALTH_ROWS);
    expect(within(block()).getByText("and 3 more clients that need a look")).toBeInTheDocument();
  });

  it("says 'All N on track' and lists nobody when nothing is wrong", async () => {
    board.mockResolvedValue(ok([row("a", "A", "on_track"), row("b", "B", "on_track"), row("c", "C", "on_track")]));
    render(await ClientHealth(props()));
    expect(within(block()).getByText("All 3 on track")).toBeInTheDocument();
    expect(within(block()).queryAllByRole("listitem")).toHaveLength(0);
  });

  it("does not claim 'All on track' when some clients are only quiet, and omits zero states", async () => {
    board.mockResolvedValue(ok([row("a", "A", "on_track"), row("q", "Q", "quiet")]));
    render(await ClientHealth(props()));
    expect(within(block()).queryByText(/^All/)).toBeNull();
    expect(within(block()).getByText("1 on track · 1 quiet")).toBeInTheDocument();
  });

  it("says 'No clients yet' only after a successful read of an empty board", async () => {
    board.mockResolvedValue(ok([]));
    render(await ClientHealth(props()));
    expect(within(block()).getByText("No clients yet.")).toBeInTheDocument();
    expect(block()).toHaveAttribute("data-state", "empty");
  });

  it("names the sources that could not be read, in one line, and the counts still show", async () => {
    board.mockResolvedValue(ok(MIX, ["site", "invoices"]));
    render(await ClientHealth(props()));
    expect(within(block()).getByRole("status")).toHaveTextContent("Could not be read: site monitoring, invoices.");
    expect(within(block()).getByText(/1 off track/)).toBeInTheDocument();
  });

  it("has no note when every source was read", async () => {
    board.mockResolvedValue(ok(MIX));
    render(await ClientHealth(props()));
    expect(within(block()).queryByRole("status")).toBeNull();
  });
});

describe("ClientHealth (widget): a refused or failed read is 'Unavailable', never an empty board", () => {
  for (const [name, result] of [["refused", refused], ["failed", failed]] as const) {
    it(`says Unavailable for a ${name} board read, with no count, no list and no 'No clients'`, async () => {
      board.mockResolvedValue(result);
      render(await ClientHealth(props()));
      const b = block();
      expect(b).toHaveAttribute("data-state", "unavailable");
      expect(within(b).getByText("Unavailable")).toBeInTheDocument();
      expect(within(b).queryAllByRole("listitem")).toHaveLength(0);
      expect(within(b).queryByText(/No clients/)).toBeNull();
      expect(within(b).queryByText(/on track/i)).toBeNull();
      expect(within(b).queryByRole("link")).toBeNull();
    });

    it(`says Unavailable when the department's clients cannot be read (${name}), never the whole board under its name`, async () => {
      board.mockResolvedValue(ok(MIX));
      readClients.mockResolvedValue(result);
      render(await ClientHealth(props({ deptId: "d-web" })));
      expect(within(block()).getByText("Unavailable")).toBeInTheDocument();
      expect(within(block()).queryByText("Late Co")).toBeNull();
    });
  }
});

describe("ClientHealth (widget): a department workspace", () => {
  it("narrows the board to the clients list's own department facet, and counts only those", async () => {
    board.mockResolvedValue(ok(MIX));
    readClients.mockResolvedValue(clientsOk(["c-off", "c-ok"]));
    render(await ClientHealth(props({ deptId: "d-web" })));
    expect(readClients).toHaveBeenCalledWith("u-1", "co-a", "d-web");
    expect(within(block()).getByText("1 off track · 1 on track")).toBeInTheDocument();
    expect(within(block()).getAllByRole("listitem").map((li) => li.getAttribute("data-client"))).toEqual(["c-off"]);
    expect(within(block()).queryByText("Risky Co")).toBeNull();
  });

  it("opens the board narrowed to the department", async () => {
    board.mockResolvedValue(ok(MIX));
    readClients.mockResolvedValue(clientsOk(["c-off"]));
    render(await ClientHealth(props({ deptId: "d-web" })));
    expect(within(block()).getByRole("link", { name: "Open the health board" })).toHaveAttribute("href", "/clients/health?department=d-web");
  });

  it("says 'No clients in this department' after a successful read that finds none of the board's clients there", async () => {
    board.mockResolvedValue(ok(MIX));
    readClients.mockResolvedValue(clientsOk([]));
    render(await ClientHealth(props({ deptId: "d-web" })));
    expect(within(block()).getByText("No clients in this department.")).toBeInTheDocument();
  });

  it("says 'All N on track' for the department's clients alone", async () => {
    board.mockResolvedValue(ok(MIX));
    readClients.mockResolvedValue(clientsOk(["c-ok"]));
    render(await ClientHealth(props({ deptId: "d-web" })));
    expect(within(block()).getByText("All 1 on track")).toBeInTheDocument();
  });
});

describe("clientHealthView / ClientHealthBlock (pure)", () => {
  it("counts one client in the singular, and names a sole unknown client without a reason", () => {
    const view = clientHealthView(ok([row("u", "Un", "unknown")]), null);
    expect(view).toMatchObject({ kind: "ok", total: 1, allOnTrack: false, rows: [{ clientId: "u", reason: "" }] });
    render(<ClientHealthBlock view={view} />);
    expect(within(block()).getByText("1 unknown")).toBeInTheDocument();
  });

  it("an unavailable view draws Unavailable whatever else is around", () => {
    render(<ClientHealthBlock view={{ kind: "unavailable" }} departmentId="d" />);
    expect(within(block()).getByText("Unavailable")).toBeInTheDocument();
  });
});

describe("where the block is placed (DW-10d)", () => {
  const placed = resolveMyWorkspaces({ me: person, tenantId: "co-a", root: agencyTree({ frontend: ["u-1"] }) });
  const webDev = subjectOfRef(placed.mine[0]);

  it("is placed for a department with a unit and for the company frame, and not for a workspace with no unit that is not the company", () => {
    expect(clientHealthWidgetPlaced("client-health", webDev)).toBe(true);
    expect(clientHealthWidgetPlaced("client-health", COMPANY_SUBJECT)).toBe(true);
    expect(clientHealthWidgetPlaced("client-health", { ...webDev, deptId: null })).toBe(false);
    // Other keys are not this rule's business.
    expect(clientHealthWidgetPlaced("pulse", { ...webDev, deptId: null })).toBe(true);
  });

  it("is off by default, and on only after the person switches it on; the gate still decides", () => {
    const ctx = { me: person, tenantId: "co-a", unitPath: webDev.unitPath };
    const keys = (prefs?: { hide: string[]; show: string[] }) =>
      selectBands(webDev.widgets, ctx, (k) => hasOverviewWidget(k), prefs).flatMap((b) => b.widgets.map((w) => w.key));
    expect(keys()).not.toContain("client-health");
    expect(keys({ hide: [], show: ["client-health"] })).toContain("client-health");
    // A company with no agency pack has no Clients row: the gate keeps the block out, switched on or not.
    const hotel = { me: meFixture([member("co-h")], [HOTEL]), tenantId: "co-h", unitPath: ["d-web"] };
    const noPack = selectBands(webDev.widgets, hotel, (k) => hasOverviewWidget(k), { hide: [], show: ["client-health"] }).flatMap((b) => b.widgets.map((w) => w.key));
    expect(noPack).not.toContain("client-health");
  });
});
