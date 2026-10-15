import { render, screen, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { OVERVIEW_WIDGETS, hasOverviewWidget, type OverviewWidgetProps } from "./index";
import { Pulse } from "./Pulse";
import { WidgetBoundary } from "../WidgetBoundary";
import { COMPANY_SUBJECT, subjectOfRef } from "@/lib/overview";
import {
  builtPulseTiles, currentPeriod, overdueOfAging, payrollRunsWaiting, readingOfAllResults, readingOfIntegrity, readingOfPayrollRuns, readingOfSummary,
  runsWaiting,
} from "@/lib/overviewPulse";
import { GENERIC_WORKSPACE, WORKSPACES, isPlanned, type PulseTile } from "@/lib/workspaces";
import { resolveMyWorkspaces } from "@/lib/workspaceAccess";
import { agencyTree, me as meFixture, member } from "@/lib/workspaceFixtures";
import * as cr from "@/lib/webdevChangeRequests-data";
import * as pipeline from "@/lib/pipeline";
import * as monitoring from "@/lib/monitoring";
import * as social from "@/lib/social";
import * as itAccounts from "@/lib/it-accounts";
import * as hrData from "@/lib/hr-data";
import * as hrFullData from "@/lib/hr-full-data";
import * as itData from "@/lib/it-data";
import * as itSecurity from "@/lib/itSecurity";
import * as automation from "@/lib/automationFailures";
import * as finData from "@/lib/finance-data";
import type { MonitoringSummary } from "@/lib/monitoringShared";
import type { SocialPost } from "@/lib/socialShared";
import type { PipelineGate } from "@/lib/pipeline";

vi.mock("@/lib/webdevChangeRequests-data", () => ({ listChangeRequests: vi.fn() }));
vi.mock("@/lib/pipeline", () => ({ listInternalPendingGates: vi.fn() }));
vi.mock("@/lib/monitoring", () => ({ getSummary: vi.fn() }));
vi.mock("@/lib/social", () => ({ listPosts: vi.fn() }));
vi.mock("@/lib/it-accounts", async (orig) => ({ ...(await orig<typeof import("@/lib/it-accounts")>()), listAccounts: vi.fn() }));

vi.mock("@/lib/hr-data", () => ({ listLeaveResult: vi.fn(), listCasesResult: vi.fn() }));
vi.mock("@/lib/hr-full-data", () => ({ listPayrollRunsResult: vi.fn() }));
vi.mock("@/lib/it-data", () => ({ listDevicesResult: vi.fn() }));
vi.mock("@/lib/itSecurity", () => ({ listAlertsResult: vi.fn() }));
vi.mock("@/lib/automationFailures", () => ({ listFailuresResult: vi.fn() }));
vi.mock("@/lib/finance-data", () => ({
  listPendingPaymentsResult: vi.fn(), getArAgingResult: vi.fn(), listPeriodsResult: vi.fn(), getCloseReadinessResult: vi.fn(),
  verifyLedgerResult: vi.fn(), reconcileArResult: vi.fn(), reconcileApResult: vi.fn(), reconcileAssetsResult: vi.fn(),
  reconcileTreasuryResult: vi.fn(), getTrialBalanceResult: vi.fn(),
}));

const person = meFixture([member()]);
const listRequests = vi.mocked(cr.listChangeRequests);
const listGates = vi.mocked(pipeline.listInternalPendingGates);
const summary = vi.mocked(monitoring.getSummary);
const posts = vi.mocked(social.listPosts);
const accounts = vi.mocked(itAccounts.listAccounts);
const leave = vi.mocked(hrData.listLeaveResult);
const hrCases = vi.mocked(hrData.listCasesResult);
const payroll = vi.mocked(hrFullData.listPayrollRunsResult);
const devices = vi.mocked(itData.listDevicesResult);
const alerts = vi.mocked(itSecurity.listAlertsResult);
const failures = vi.mocked(automation.listFailuresResult);
const pendingPayments = vi.mocked(finData.listPendingPaymentsResult);
const arAging = vi.mocked(finData.getArAgingResult);
const periodsRead = vi.mocked(finData.listPeriodsResult);
const closeRead = vi.mocked(finData.getCloseReadinessResult);
const integrityReads = {
  ledger: vi.mocked(finData.verifyLedgerResult), ar: vi.mocked(finData.reconcileArResult), ap: vi.mocked(finData.reconcileApResult),
  assets: vi.mocked(finData.reconcileAssetsResult), treasury: vi.mocked(finData.reconcileTreasuryResult), tb: vi.mocked(finData.getTrialBalanceResult),
};

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i}` })) as never;
const gate = (id: string, run: string) => ({ id, run_id: run }) as unknown as PipelineGate;
const sum = (over: Partial<MonitoringSummary> = {}): MonitoringSummary => ({
  total: 10, up: 8, down: 1, degraded: 1, maintenance: 0, unknown: 0, openIncidents: 2, lastSweepAt: "2026-10-13T08:00:00Z", ...over,
});
const post = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i}` }) as unknown as SocialPost);
const account = (state: string) => ({
  userId: state, email: "", name: state, employmentStatus: null, keycloakId: null, enabled: null, emailVerified: null,
  linked: false, linkVerified: false, state, actionable: true,
});

const placed = resolveMyWorkspaces({ me: person, tenantId: "co-a", root: agencyTree({ web: ["u-1"] }) });
const webDev = subjectOfRef(placed.mine[0]);
const tilesOf = (key: string) => builtPulseTiles({ workspaceKey: key });
const props = (pulse: readonly PulseTile[] | undefined, extra: Partial<OverviewWidgetProps> = {}): OverviewWidgetProps => ({
  me: person, tenantId: "co-a", period: "month", deptId: "d-web", unitPath: ["d-web"], tools: [],
  widget: { key: "pulse", band: "department", label: "Pulse" }, pulse, ...extra,
});
const tile = (name: string) => within(screen.getByRole("region", { name: "Pulse" })).getByText(name).closest("li")!;

beforeEach(() => {
  for (const m of [listRequests, listGates, summary, posts, accounts, leave, hrCases, payroll, devices, alerts, failures, pendingPayments, arAging, periodsRead, closeRead, ...Object.values(integrityReads)]) m.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("the registry's built tiles (DW-3e)", () => {
  it("builds exactly Web Dev's three, Social Media's two, HR's four, Finance's four and IT's four, and no other", () => {
    const built: string[] = [];
    for (const w of [...WORKSPACES, GENERIC_WORKSPACE]) for (const t of w.pulse) if (!isPlanned(t)) built.push(`${w.key}/${t.key}`);
    expect(built.sort()).toEqual([
      "finance/close-progress",
      "finance/integrity-findings",
      "finance/overdue-receivables",
      "finance/payments-to-confirm",
      "hr/leave-pending",
      "hr/onboarding",
      "hr/open-cases",
      "hr/payroll-status",
      "it/account-requests",
      "it/devices-offline",
      "it/failing-workflows",
      "it/threat-alerts",
      "social-media/failed-posts",
      "social-media/posts-scheduled",
      "web-dev/requests-waiting",
      "web-dev/runs-waiting-approval",
      "web-dev/sites-with-a-problem",
    ]);
  });

  it("gives a built tile its reader and its page, and every other tile still carries a ticket", () => {
    for (const w of [...WORKSPACES, GENERIC_WORKSPACE]) {
      for (const t of w.pulse) {
        if (isPlanned(t)) {
          expect(t.source, `${w.key}/${t.key}`).toBeUndefined();
          expect(t.ticket, `${w.key}/${t.key}`).toMatch(/^DW-\d+[a-z]?\b/);
        } else {
          expect(t.source, `${w.key}/${t.key}`).toBeDefined();
          expect(t.href?.startsWith("/"), `${w.key}/${t.key}`).toBe(true);
        }
      }
    }
  });

  it("links every built tile to an existing page", () => {
    const app = resolve(__dirname, "../../../app/(app)");
    for (const w of WORKSPACES) {
      for (const t of w.pulse.filter((p) => !isPlanned(p))) {
        const path = t.href!.split(/[?#]/)[0].replaceAll("{dept}", "[deptId]");
        expect(existsSync(resolve(app, `.${path}`, "page.tsx")), `${w.key}/${t.key} -> ${t.href}`).toBe(true);
      }
    }
  });

  it("is registered in the host and no longer ticketed in the department frame", () => {
    expect(hasOverviewWidget("pulse")).toBe(true);
    expect(OVERVIEW_WIDGETS.pulse).toBe(Pulse);
    for (const w of WORKSPACES.filter((x) => x.overview.some((o) => o.key === "pulse"))) {
      expect(isPlanned(w.overview.find((o) => o.key === "pulse")!), w.key).toBe(false);
    }
  });

  it("keys the subject by its workspace (null for Company)", () => {
    expect(webDev.workspaceKey).toBe("web-dev");
    expect(COMPANY_SUBJECT.workspaceKey).toBeNull();
  });

  it("finds the built tiles of the workspace the subject belongs to, and none for Company, SEO, Creatives or a generic department", () => {
    expect(builtPulseTiles(webDev).map((t) => t.key)).toEqual(["requests-waiting", "sites-with-a-problem", "runs-waiting-approval"]);
    expect(tilesOf("social-media").map((t) => t.key)).toEqual(["posts-scheduled", "failed-posts"]);
    expect(tilesOf("it").map((t) => t.key)).toEqual(["devices-offline", "threat-alerts", "account-requests", "failing-workflows"]);
    expect(tilesOf("hr").map((t) => t.key)).toEqual(["leave-pending", "onboarding", "open-cases", "payroll-status"]);
    // The company Overview the GM sees has no Pulse widget, so the GM reaches failing workflows through IT's tile and the page.
    expect(tilesOf("gm").map((t) => t.key)).toEqual([]);
    expect(tilesOf("seo")).toEqual([]);
    expect(tilesOf("creatives")).toEqual([]);
    expect(builtPulseTiles(COMPANY_SUBJECT)).toEqual([]);
    // A generic department, even one named like a built workspace, is keyed "generic" and has none.
    const generic = subjectOfRef({ ...placed.mine[0], workspace: { ...GENERIC_WORKSPACE, label: "Web Dev" } });
    expect(generic.workspaceKey).toBe("generic");
    expect(builtPulseTiles(generic)).toEqual([]);
  });
});

describe("Pulse, Web Dev (the widget)", () => {
  it("reads each source once, as the signed-in person, and draws a count per tile with a link to its page", async () => {
    listRequests.mockResolvedValue({ kind: "ok", data: rows(3) });
    listGates.mockResolvedValue({ kind: "ok", data: [gate("g1", "run-a"), gate("g2", "run-a"), gate("g3", "run-b")] });
    summary.mockResolvedValue(sum());
    render(await Pulse(props(builtPulseTiles(webDev))));
    expect(listRequests).toHaveBeenCalledTimes(1);
    expect(listRequests).toHaveBeenCalledWith("u-1", "co-a", { status: "new" });
    expect(listGates).toHaveBeenCalledTimes(1);
    expect(listGates).toHaveBeenCalledWith("u-1", "co-a");
    expect(summary).toHaveBeenCalledTimes(1);
    expect(summary).toHaveBeenCalledWith("u-1", "co-a");
    expect(within(tile("Requests waiting")).getByText("3")).toBeInTheDocument();
    // Two gates on one run are one run waiting.
    expect(within(tile("Runs waiting approval")).getByText("2")).toBeInTheDocument();
    const sites = tile("Sites with a problem");
    expect(within(sites).getByText("2")).toBeInTheDocument();
    expect(within(sites).getByText("1 down, 1 degraded")).toBeInTheDocument();
    expect(within(tile("Requests waiting")).getByRole("link")).toHaveAttribute("href", "/departments/d-web/requests");
    expect(within(sites).getByRole("link")).toHaveAttribute("href", "/monitoring");
    expect(within(tile("Runs waiting approval")).getByRole("link")).toHaveAttribute("href", "/pipeline");
  });

  it("says a real zero for an empty queue", async () => {
    listRequests.mockResolvedValue({ kind: "ok", data: [] });
    listGates.mockResolvedValue({ kind: "ok", data: [] });
    summary.mockResolvedValue(sum({ down: 0, degraded: 0 }));
    render(await Pulse(props(builtPulseTiles(webDev))));
    expect(within(tile("Requests waiting")).getByText("0")).toBeInTheDocument();
    expect(within(tile("Runs waiting approval")).getByText("0")).toBeInTheDocument();
    expect(within(tile("Sites with a problem")).getByText("0")).toBeInTheDocument();
  });

  it("maps a refusal to No access, with no link, and a failure to Unavailable, never 0", async () => {
    listRequests.mockResolvedValue({ kind: "forbidden" });
    listGates.mockResolvedValue({ kind: "unavailable", reason: "502" });
    summary.mockResolvedValue(sum());
    render(await Pulse(props(builtPulseTiles(webDev))));
    const denied = tile("Requests waiting");
    expect(within(denied).getByText("No access")).toBeInTheDocument();
    expect(within(denied).queryByRole("link")).toBeNull();
    const failed = tile("Runs waiting approval");
    expect(within(failed).getByText("Unavailable")).toBeInTheDocument();
    expect(within(failed).queryByText("0")).toBeNull();
    // The tile that read still draws.
    expect(within(tile("Sites with a problem")).getByText("2")).toBeInTheDocument();
  });

  it("maps a monitoring backend that is not connected (null) to Unavailable, not a clean board", async () => {
    listRequests.mockResolvedValue({ kind: "ok", data: rows(1) });
    listGates.mockResolvedValue({ kind: "ok", data: [] });
    summary.mockResolvedValue(null);
    render(await Pulse(props(builtPulseTiles(webDev))));
    expect(within(tile("Sites with a problem")).getByText("Unavailable")).toBeInTheDocument();
  });

  it("lets one reader throw without blanking the other tiles", async () => {
    listRequests.mockRejectedValue(new Error("boom"));
    listGates.mockResolvedValue({ kind: "ok", data: [gate("g1", "run-a")] });
    summary.mockResolvedValue(sum());
    render(await Pulse(props(builtPulseTiles(webDev))));
    expect(within(tile("Requests waiting")).getByText("Unavailable")).toBeInTheDocument();
    expect(within(tile("Runs waiting approval")).getByText("1")).toBeInTheDocument();
    expect(within(tile("Sites with a problem")).getByText("2")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("throws to the boundary only when every tile failed", async () => {
    listRequests.mockRejectedValue(new Error("boom"));
    listGates.mockResolvedValue({ kind: "unavailable", reason: "502" });
    summary.mockResolvedValue(null);
    const failure = await Pulse(props(builtPulseTiles(webDev))).then(() => null, (e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);

    vi.spyOn(console, "error").mockImplementation(() => {});
    const Boom = () => { throw failure; };
    render(<WidgetBoundary title="Pulse"><Boom /></WidgetBoundary>);
    expect(screen.getByRole("heading", { name: "Pulse" })).toBeInTheDocument();
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
  });

  it("does not throw when the tiles are refused: a refusal is an answer", async () => {
    listRequests.mockResolvedValue({ kind: "forbidden" });
    listGates.mockResolvedValue({ kind: "forbidden" });
    summary.mockRejectedValue(new Error("boom"));
    render(await Pulse(props(builtPulseTiles(webDev))));
    expect(screen.getAllByText("No access")).toHaveLength(2);
    expect(screen.getAllByText("Unavailable")).toHaveLength(1);
  });

  it("draws nothing, and reads nothing, for a workspace with no built tile", async () => {
    expect(await Pulse(props([]))).toBeNull();
    expect(await Pulse(props(undefined))).toBeNull();
    expect([listRequests, listGates, summary, posts, accounts, leave, hrCases, payroll, devices].every((m) => m.mock.calls.length === 0)).toBe(true);
  });
});

describe("Pulse, Social Media and IT (the widget)", () => {
  const social2 = () => tilesOf("social-media");

  it("counts scheduled and failed posts by the reader's own status filter", async () => {
    posts.mockImplementation(async (_u, _t, p) => ({ data: post(p?.status === "scheduled" ? 4 : 1), forbidden: false }));
    render(await Pulse(props(social2())));
    expect(posts).toHaveBeenCalledWith("u-1", "co-a", { status: "scheduled" });
    expect(posts).toHaveBeenCalledWith("u-1", "co-a", { status: "failed" });
    expect(within(tile("Posts scheduled")).getByText("4")).toBeInTheDocument();
    expect(within(tile("Failed posts")).getByText("1")).toBeInTheDocument();
    expect(within(tile("Failed posts")).getByRole("link")).toHaveAttribute("href", "/departments/d-web/calendar");
  });

  it("maps a 403 (forbidden) to No access and a throw (5xx) to Unavailable, per tile", async () => {
    posts.mockImplementation(async (_u, _t, p) => {
      if (p?.status === "failed") throw new Error("500");
      return { data: [], forbidden: true };
    });
    render(await Pulse(props(social2())));
    expect(within(tile("Posts scheduled")).getByText("No access")).toBeInTheDocument();
    expect(within(tile("Failed posts")).getByText("Unavailable")).toBeInTheDocument();
  });

  it("counts the accounts that still need a login for IT, and maps the typed refusals", async () => {
    const it = tilesOf("it");
    accounts.mockResolvedValue({ kind: "ok", accounts: [account("missing"), account("missing"), account("enabled"), account("leaver_still_enabled")] as never });
    const first = render(await Pulse(props(it, { deptId: null })));
    expect(within(tile("Account requests")).getByText("2")).toBeInTheDocument();
    expect(within(tile("Account requests")).getByRole("link")).toHaveAttribute("href", "/it/accounts");
    first.unmount();

    accounts.mockResolvedValue({ kind: "forbidden" });
    const second = render(await Pulse(props(it, { deptId: null })));
    expect(within(tile("Account requests")).getByText("No access")).toBeInTheDocument();
    second.unmount();

    accounts.mockResolvedValue({ kind: "unavailable", reason: "503" });
    // The only tile failed, so the block goes to the boundary.
    await expect(Pulse(props(it, { deptId: null }))).rejects.toThrow();
  });
});

describe("Pulse, HR and IT devices (the widget, DW-7e)", () => {
  const hr = () => tilesOf("hr");
  const hrStaff = meFixture([member(), { role: "hr_staff", scopeType: "company", scopeId: "co-a" }]);
  const hrProps = (over: Partial<OverviewWidgetProps> = {}) => props(hr(), { me: hrStaff, deptId: null, ...over });
  const leaveRows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `l${i}` })) as never;
  const caseRows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}` })) as never;
  const run = (status: string) => ({ id: status, status }) as never;
  const device = (status: string) => ({ id: status, name: status, status }) as never;

  it("counts each HR tile from its own read, as the signed-in person, with the page it links to", async () => {
    leave.mockResolvedValue({ kind: "ok", data: leaveRows(3) });
    hrCases.mockImplementation(async (_u, _t, q) => ({ kind: "ok", data: caseRows(q?.kind === "onboarding" ? (q.status === "open" ? 2 : 1) : 5) }));
    payroll.mockResolvedValue({ kind: "ok", data: [run("calculated"), run("approved"), run("approved"), run("paid"), run("draft")] });
    render(await Pulse(hrProps()));
    expect(leave).toHaveBeenCalledWith("u-1", "co-a", { status: "pending" });
    expect(hrCases).toHaveBeenCalledWith("u-1", "co-a", { kind: "onboarding", status: "open" });
    expect(hrCases).toHaveBeenCalledWith("u-1", "co-a", { kind: "onboarding", status: "in_progress" });
    expect(hrCases).toHaveBeenCalledWith("u-1", "co-a", { status: "open" });
    expect(payroll).toHaveBeenCalledWith("u-1", "co-a");
    expect(within(tile("Leave pending")).getByText("3")).toBeInTheDocument();
    // Onboarding is open (2) plus in progress (1).
    expect(within(tile("Onboarding")).getByText("3")).toBeInTheDocument();
    expect(within(tile("Open cases")).getByText("5")).toBeInTheDocument();
    // One calculated run to approve, two approved runs to pay; draft and paid wait on no one.
    const pay = tile("Payroll runs waiting");
    expect(within(pay).getByText("3")).toBeInTheDocument();
    expect(within(pay).getByText("1 to approve, 2 to pay")).toBeInTheDocument();
    expect(within(tile("Leave pending")).getByRole("link")).toHaveAttribute("href", "/hr/leave");
    expect(within(tile("Onboarding")).getByRole("link")).toHaveAttribute("href", "/hr/onboarding");
    expect(within(tile("Open cases")).getByRole("link")).toHaveAttribute("href", "/hr/cases");
    expect(within(pay).getByRole("link")).toHaveAttribute("href", "/hr/payroll");
  });

  it("says a real zero for an empty queue", async () => {
    leave.mockResolvedValue({ kind: "ok", data: [] });
    hrCases.mockResolvedValue({ kind: "ok", data: [] });
    payroll.mockResolvedValue({ kind: "ok", data: [run("paid")] });
    render(await Pulse(hrProps()));
    for (const name of ["Leave pending", "Onboarding", "Open cases", "Payroll runs waiting"]) {
      expect(within(tile(name)).getByText("0")).toBeInTheDocument();
    }
  });

  it("maps a refusal to No access and a failure to Unavailable on every HR tile, never 0", async () => {
    leave.mockResolvedValue({ kind: "forbidden" });
    hrCases.mockResolvedValue({ kind: "unavailable", reason: "502" });
    payroll.mockResolvedValue({ kind: "forbidden" });
    render(await Pulse(hrProps()));
    expect(within(tile("Leave pending")).getByText("No access")).toBeInTheDocument();
    expect(within(tile("Onboarding")).getByText("Unavailable")).toBeInTheDocument();
    expect(within(tile("Open cases")).getByText("Unavailable")).toBeInTheDocument();
    expect(within(tile("Payroll runs waiting")).getByText("No access")).toBeInTheDocument();
    expect(screen.queryByText("0")).toBeNull();
  });

  it("never sums a failed onboarding leg as 0: one status read failing fails the tile", async () => {
    leave.mockResolvedValue({ kind: "ok", data: [] });
    payroll.mockResolvedValue({ kind: "ok", data: [] });
    hrCases.mockImplementation(async (_u, _t, q) =>
      q?.kind === "onboarding" && q.status === "in_progress" ? { kind: "unavailable", reason: "503" } : { kind: "ok", data: caseRows(4) });
    render(await Pulse(hrProps()));
    const onboarding = tile("Onboarding");
    expect(within(onboarding).getByText("Unavailable")).toBeInTheDocument();
    expect(within(onboarding).queryByText("4")).toBeNull();
    expect(within(tile("Open cases")).getByText("4")).toBeInTheDocument();
  });

  it("shows No access, and reads nothing, for leave and cases to a viewer outside the HR scope", async () => {
    // The server answers such a viewer with their OWN rows; those must not pass as the department's count.
    leave.mockResolvedValue({ kind: "ok", data: leaveRows(1) });
    hrCases.mockResolvedValue({ kind: "ok", data: caseRows(1) });
    payroll.mockResolvedValue({ kind: "forbidden" });
    render(await Pulse(hrProps({ me: person })));
    expect(leave).not.toHaveBeenCalled();
    expect(hrCases).not.toHaveBeenCalled();
    for (const name of ["Leave pending", "Onboarding", "Open cases", "Payroll runs waiting"]) {
      expect(within(tile(name)).getByText("No access")).toBeInTheDocument();
    }
  });

  it("counts offline devices for IT (not degraded, not unknown), and maps the typed refusals", async () => {
    const it = tilesOf("it");
    devices.mockResolvedValue({ kind: "ok", data: [device("offline"), device("offline"), device("degraded"), device("unknown"), device("online")] });
    accounts.mockResolvedValue({ kind: "ok", accounts: [] });
    const first = render(await Pulse(props(it, { deptId: null })));
    expect(devices).toHaveBeenCalledWith("u-1", "co-a");
    const counted = tile("Devices offline");
    expect(within(counted).getByText("2")).toBeInTheDocument();
    expect(within(counted).getByText("of 5 devices")).toBeInTheDocument();
    expect(within(counted).getByRole("link")).toHaveAttribute("href", "/it/devices");
    first.unmount();

    devices.mockResolvedValue({ kind: "forbidden" });
    const second = render(await Pulse(props(it, { deptId: null })));
    expect(within(tile("Devices offline")).getByText("No access")).toBeInTheDocument();
    second.unmount();

    devices.mockResolvedValue({ kind: "unavailable", reason: "404" });
    render(await Pulse(props(it, { deptId: null })));
    const failed = tile("Devices offline");
    expect(within(failed).getByText("Unavailable")).toBeInTheDocument();
    expect(within(failed).queryByText("0")).toBeNull();
  });

  it("does not read a registry with no devices as an all-clear", async () => {
    devices.mockResolvedValue({ kind: "ok", data: [] });
    accounts.mockResolvedValue({ kind: "ok", accounts: [] });
    render(await Pulse(props(tilesOf("it"), { deptId: null })));
    const t = tile("Devices offline");
    expect(within(t).getByText("0")).toBeInTheDocument();
    expect(within(t).getByText("No devices registered yet")).toBeInTheDocument();
  });
});

describe("Pulse, IT threat alerts (the widget, DW-7h)", () => {
  const alert = (severity: string) => ({ kind: "new_device", severity, at: "2026-10-15T08:00:00Z", subject: {}, detail: "", count: 1 }) as never;
  const answer = (signIns: "on" | "off" | "unavailable", list: string[]) => ({ asOf: "2026-10-15T09:00:00Z", window: "24h", signIns, alerts: list.map(alert) }) as never;
  const readsOnly = () => {
    devices.mockResolvedValue({ kind: "ok", data: [] });
    accounts.mockResolvedValue({ kind: "ok", accounts: [] });
  };

  it("counts high plus medium alerts in the last 24 hours (not low), and links the Alerts tab", async () => {
    readsOnly();
    alerts.mockResolvedValue({ kind: "ok", data: answer("on", ["high", "high", "medium", "low", "low", "low"]) });
    render(await Pulse(props(tilesOf("it"), { deptId: null })));
    expect(alerts).toHaveBeenCalledWith("u-1", "co-a", "24h");
    const t = tile("Threat alerts");
    expect(within(t).getByText("3")).toBeInTheDocument();
    expect(within(t).getByText("2 high, 1 medium")).toBeInTheDocument();
    expect(within(t).getByRole("link")).toHaveAttribute("href", "/it/network/threats");
  });

  it("does not read 0 under sign-in rules that could not run as an all-clear", async () => {
    readsOnly();
    alerts.mockResolvedValue({ kind: "ok", data: answer("off", []) });
    render(await Pulse(props(tilesOf("it"), { deptId: null })));
    const t = tile("Threat alerts");
    expect(within(t).getByText("0")).toBeInTheDocument();
    expect(within(t).getByText("Failed sign-ins are not being read")).toBeInTheDocument();
  });

  it("a refused read is No access and a failed one is Unavailable, never 0", async () => {
    readsOnly();
    alerts.mockResolvedValue({ kind: "forbidden" });
    const first = render(await Pulse(props(tilesOf("it"), { deptId: null })));
    expect(within(tile("Threat alerts")).getByText("No access")).toBeInTheDocument();
    first.unmount();

    alerts.mockResolvedValue({ kind: "unavailable", reason: "500" });
    render(await Pulse(props(tilesOf("it"), { deptId: null })));
    const failed = tile("Threat alerts");
    expect(within(failed).getByText("Unavailable")).toBeInTheDocument();
    expect(within(failed).queryByText("0")).toBeNull();
  });

  it("a reader that throws is this tile's failure and does not blank the others", async () => {
    readsOnly();
    alerts.mockRejectedValue(new Error("socket hang up"));
    render(await Pulse(props(tilesOf("it"), { deptId: null })));
    expect(within(tile("Threat alerts")).getByText("Unavailable")).toBeInTheDocument();
    expect(within(tile("Devices offline")).getByText("0")).toBeInTheDocument();
  });
});

describe("Pulse, Finance (the widget, DW-7e-2)", () => {
  const fin = () => tilesOf("finance");
  const finProps = () => props(fin(), { deptId: null });
  const pay = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i}` })) as never;
  const aging = (...rowsOwed: Array<[string, string, string, string, string]>) =>
    rowsOwed.map(([current, a, b, c, d], i) => ({ customerCode: `C${i}`, customerName: `C${i}`, current, d1To30: a, d31To60: b, d61To90: c, d90Plus: d, totalOutstanding: "0" })) as never;
  const period = (over: Record<string, unknown> = {}) =>
    ({ id: "per-10", periodNo: 10, name: "Oct 2026", startDate: "2000-01-01", endDate: "2999-12-31", state: "OPEN", signedOff: false, fiscalYear: "FY2026", ...over }) as never;
  const verdict = (clean: boolean) => ({ kind: "ok", data: { problems: [], clean } }) as never;
  const allIntegrity = (clean: boolean) => {
    for (const r of Object.values(integrityReads)) r.mockResolvedValue(r === integrityReads.tb ? ({ kind: "ok", data: { balanced: clean } } as never) : verdict(clean));
  };
  const happy = () => {
    pendingPayments.mockResolvedValue({ kind: "ok", data: pay(3) });
    arAging.mockResolvedValue({ kind: "ok", data: aging(["100", "0", "0", "0", "0"]) });
    periodsRead.mockResolvedValue({ kind: "ok", data: [period()] });
    closeRead.mockResolvedValue({ kind: "ok", data: { blockers: [], ready: true } });
    allIntegrity(true);
  };

  it("counts each tile from its own read, as the signed-in person, with the page it links to", async () => {
    pendingPayments.mockResolvedValue({ kind: "ok", data: pay(4) });
    // Two customers owe something overdue (40M + 25M); a third owes only what is not yet due.
    arAging.mockResolvedValue({ kind: "ok", data: aging(["120000000", "0", "0", "0", "0"], ["0", "40000000", "0", "0", "0"], ["0", "0", "0", "0", "25000000"]) });
    periodsRead.mockResolvedValue({ kind: "ok", data: [period({ id: "per-9", name: "Sep 2026", startDate: "2000-01-01", endDate: "2000-01-31" }), period()] });
    closeRead.mockResolvedValue({ kind: "ok", data: { blockers: [{ blocker: "NO_ACCOUNTANT_SIGNOFF", detail: "x" }, { blocker: "AP_RECONCILIATION", detail: "y" }], ready: false } });
    integrityReads.ledger.mockResolvedValue(verdict(true));
    integrityReads.ar.mockResolvedValue(verdict(true));
    integrityReads.ap.mockResolvedValue(verdict(false));
    integrityReads.assets.mockResolvedValue(verdict(true));
    integrityReads.treasury.mockResolvedValue(verdict(false));
    integrityReads.tb.mockResolvedValue({ kind: "ok", data: { balanced: true } } as never);
    render(await Pulse(finProps()));

    expect(pendingPayments).toHaveBeenCalledWith("u-1", "co-a");
    expect(arAging).toHaveBeenCalledWith("u-1", "co-a");
    // Only the period today falls in is asked about, by its id.
    expect(closeRead).toHaveBeenCalledTimes(1);
    expect(closeRead).toHaveBeenCalledWith("u-1", "co-a", "per-10");

    expect(within(tile("Client payments to confirm")).getByText("4")).toBeInTheDocument();
    const overdue = tile("Overdue receivables");
    expect(within(overdue).getByText("2")).toBeInTheDocument();
    expect(within(overdue).getByText(/customers · .*65,000,000 overdue/)).toBeInTheDocument();
    const close = tile("Close progress");
    expect(within(close).getByText("2")).toBeInTheDocument();
    expect(within(close).getByText("Oct 2026")).toBeInTheDocument();
    const integrity = tile("Integrity findings");
    expect(within(integrity).getByText("2")).toBeInTheDocument();
    expect(within(integrity).getByText("Payables, Treasury")).toBeInTheDocument();

    expect(within(tile("Client payments to confirm")).getByRole("link")).toHaveAttribute("href", "/finance/receivables#payments-to-confirm");
    expect(within(overdue).getByRole("link")).toHaveAttribute("href", "/finance/receivables");
    expect(within(close).getByRole("link")).toHaveAttribute("href", "/finance/close");
    expect(within(integrity).getByRole("link")).toHaveAttribute("href", "/finance");
  });

  it("says a real zero: nothing waiting, nothing overdue, ready to close, every check tying", async () => {
    pendingPayments.mockResolvedValue({ kind: "ok", data: [] });
    arAging.mockResolvedValue({ kind: "ok", data: aging(["100", "0", "0", "0", "0"]) });
    periodsRead.mockResolvedValue({ kind: "ok", data: [period()] });
    closeRead.mockResolvedValue({ kind: "ok", data: { blockers: [], ready: true } });
    allIntegrity(true);
    render(await Pulse(finProps()));
    for (const name of ["Client payments to confirm", "Overdue receivables", "Close progress", "Integrity findings"]) {
      expect(within(tile(name)).getByText("0"), name).toBeInTheDocument();
    }
    expect(within(tile("Close progress")).getByText("Ready to close")).toBeInTheDocument();
    expect(within(tile("Integrity findings")).getByText("6 of 6 checks tie")).toBeInTheDocument();
  });

  it("says No access for a refusal and Unavailable for a failure on every tile, never 0", async () => {
    pendingPayments.mockResolvedValue({ kind: "forbidden" });
    arAging.mockResolvedValue({ kind: "unavailable", reason: "404" });
    periodsRead.mockResolvedValue({ kind: "forbidden" });
    allIntegrity(true);
    integrityReads.ledger.mockResolvedValue({ kind: "forbidden" });
    render(await Pulse(finProps()));
    expect(within(tile("Client payments to confirm")).getByText("No access")).toBeInTheDocument();
    expect(within(tile("Overdue receivables")).getByText("Unavailable")).toBeInTheDocument();
    expect(within(tile("Close progress")).getByText("No access")).toBeInTheDocument();
    expect(within(tile("Integrity findings")).getByText("No access")).toBeInTheDocument();
    expect(closeRead).not.toHaveBeenCalled();
    expect(screen.queryByText("0")).toBeNull();
  });

  it("maps a failed pending-payments and aging read to Unavailable, and the other tiles still read", async () => {
    happy();
    pendingPayments.mockResolvedValue({ kind: "unavailable", reason: "502" });
    arAging.mockRejectedValue(new Error("boom"));
    render(await Pulse(finProps()));
    expect(within(tile("Client payments to confirm")).getByText("Unavailable")).toBeInTheDocument();
    expect(within(tile("Overdue receivables")).getByText("Unavailable")).toBeInTheDocument();
    expect(within(tile("Close progress")).getByText("Ready to close")).toBeInTheDocument();
  });

  it("is Unavailable with 'No current period' when today is in no period, and reads no readiness", async () => {
    happy();
    periodsRead.mockResolvedValue({ kind: "ok", data: [period({ startDate: "2000-01-01", endDate: "2000-01-31" })] });
    render(await Pulse(finProps()));
    const close = tile("Close progress");
    expect(within(close).getByText("Unavailable")).toBeInTheDocument();
    expect(within(close).getByText("No current period")).toBeInTheDocument();
    expect(within(close).queryByText("Ready to close")).toBeNull();
    expect(within(close).queryByText("0")).toBeNull();
    expect(closeRead).not.toHaveBeenCalled();
  });

  it("is Unavailable, never 'Ready to close', when the periods list is empty or the readiness read fails", async () => {
    happy();
    periodsRead.mockResolvedValue({ kind: "ok", data: [] });
    const first = render(await Pulse(finProps()));
    expect(within(tile("Close progress")).getByText("Unavailable")).toBeInTheDocument();
    first.unmount();

    periodsRead.mockResolvedValue({ kind: "ok", data: [period()] });
    closeRead.mockResolvedValue({ kind: "unavailable", reason: "500" });
    const second = render(await Pulse(finProps()));
    const failed = tile("Close progress");
    expect(within(failed).getByText("Unavailable")).toBeInTheDocument();
    expect(within(failed).queryByText("Ready to close")).toBeNull();
    second.unmount();

    closeRead.mockResolvedValue({ kind: "forbidden" });
    render(await Pulse(finProps()));
    expect(within(tile("Close progress")).getByText("No access")).toBeInTheDocument();
  });

  it("never counts an unreadable integrity check as passed: one failed read makes the tile Unavailable", async () => {
    happy();
    integrityReads.treasury.mockResolvedValue({ kind: "unavailable", reason: "404" });
    integrityReads.ap.mockResolvedValue(verdict(false));
    render(await Pulse(finProps()));
    const t = tile("Integrity findings");
    expect(within(t).getByText("Unavailable")).toBeInTheDocument();
    // Not "1": the Payables failure is real but the tile cannot say how many findings there are.
    expect(within(t).queryByText("1")).toBeNull();
    expect(within(t).queryByText(/checks tie/)).toBeNull();
  });

  it("is Unavailable when a check's payload has no verdict", async () => {
    happy();
    integrityReads.tb.mockResolvedValue({ kind: "ok", data: {} } as never);
    render(await Pulse(finProps()));
    expect(within(tile("Integrity findings")).getByText("Unavailable")).toBeInTheDocument();
  });

  it("flags a full page of pending payments as '300 or more', not a total", async () => {
    happy();
    pendingPayments.mockResolvedValue({ kind: "ok", data: pay(300) });
    render(await Pulse(finProps()));
    const t = tile("Client payments to confirm");
    expect(within(t).getByText("300")).toBeInTheDocument();
    expect(within(t).getByText("300 or more")).toBeInTheDocument();
  });
});

describe("the Finance mappers", () => {
  it("counts a customer as overdue by any bucket past current, and ignores current", () => {
    expect(overdueOfAging([
      { current: "9", d1To30: "0", d31To60: "0", d61To90: "0", d90Plus: "0" },
      { current: "0", d1To30: "5", d31To60: "0", d61To90: "0", d90Plus: "0" },
      { current: "1", d1To30: "0", d31To60: "2", d61To90: "3", d90Plus: "4" },
    ] as never)).toEqual({ customers: 2, amount: 14 });
  });

  it("finds the period today falls in, inclusive of both ends, and none outside", () => {
    const periods = [{ id: "a", startDate: "2026-09-01", endDate: "2026-09-30" }, { id: "b", startDate: "2026-10-01", endDate: "2026-10-31" }] as never;
    expect(currentPeriod(periods, "2026-10-01")?.id).toBe("b");
    expect(currentPeriod(periods, "2026-09-30")?.id).toBe("a");
    expect(currentPeriod(periods, "2026-11-01")).toBeNull();
  });

  it("counts failed integrity checks; a refusal outranks a failure; a non-boolean verdict is no verdict", () => {
    const ok = (clean: unknown) => ({ kind: "ok", data: { clean } }) as never;
    expect(readingOfIntegrity([{ label: "A", result: ok(true) }, { label: "B", result: ok(false) }])).toEqual({ kind: "ok", value: 1, detail: "B" });
    expect(readingOfIntegrity([{ label: "A", result: ok(true) }])).toEqual({ kind: "ok", value: 0, detail: "1 of 1 checks tie" });
    expect(readingOfIntegrity([{ label: "A", result: { kind: "unavailable", reason: "x" } }, { label: "B", result: { kind: "forbidden" } }])).toEqual({ kind: "forbidden" });
    expect(readingOfIntegrity([{ label: "A", result: ok(undefined) }])).toEqual({ kind: "unavailable" });
  });
});

describe("the pure mappers", () => {
  it("counts payroll runs that wait on someone: to approve (calculated, pending_approval) and to pay (approved)", () => {
    expect(payrollRunsWaiting([{ status: "draft" }, { status: "calculated" }, { status: "pending_approval" }, { status: "approved" }, { status: "paid" }, { status: "cancelled" }]))
      .toEqual({ toApprove: 2, toPay: 1 });
    expect(readingOfPayrollRuns({ kind: "ok", data: [] })).toEqual({ kind: "ok", value: 0 });
    expect(readingOfPayrollRuns({ kind: "forbidden" })).toEqual({ kind: "forbidden" });
    expect(readingOfPayrollRuns({ kind: "unavailable", reason: "x" })).toEqual({ kind: "unavailable" });
  });

  it("sums several reads only when every one answered, and a refusal outranks a failure", () => {
    const ok = (n: number) => ({ kind: "ok", data: Array.from({ length: n }) }) as never;
    expect(readingOfAllResults([ok(2), ok(1)])).toEqual({ kind: "ok", value: 3 });
    expect(readingOfAllResults([ok(2), { kind: "unavailable", reason: "x" }])).toEqual({ kind: "unavailable" });
    expect(readingOfAllResults([{ kind: "unavailable", reason: "x" }, { kind: "forbidden" }])).toEqual({ kind: "forbidden" });
  });


  it("never reads an unconnected or unswept monitoring board as an all-clear", () => {
    expect(readingOfSummary(null)).toEqual({ kind: "unavailable" });
    expect(readingOfSummary(sum({ total: 0, up: 0, down: 0, degraded: 0 }))).toEqual({ kind: "ok", value: 0, detail: "No monitors yet" });
    expect(readingOfSummary(sum({ down: 0, degraded: 0, lastSweepAt: null }))).toEqual({ kind: "ok", value: 0, detail: "No sweep reported yet" });
    expect(readingOfSummary(sum({ down: 3, degraded: 0 }))).toEqual({ kind: "ok", value: 3, detail: "3 down" });
  });

  it("counts distinct runs", () => {
    expect(runsWaiting([gate("1", "a"), gate("2", "a"), gate("3", "b")])).toBe(2);
    expect(runsWaiting([])).toBe(0);
  });
});

describe("Pulse, Failing workflows (the widget, DW-7i-1, BFF §52.12)", () => {
  const on = (count: number, over: Record<string, unknown> = {}) =>
    ({ asOf: "2026-10-16T09:00:00Z", window: "24h", state: "on", failed: [], count, capped: false, ...over }) as never;
  const readsOnly = () => {
    devices.mockResolvedValue({ kind: "ok", data: [] });
    accounts.mockResolvedValue({ kind: "ok", accounts: [] });
    alerts.mockResolvedValue({ kind: "ok", data: { asOf: "x", window: "24h", signIns: "on", alerts: [] } as never });
  };
  const hasTile = (name: string) => within(screen.getByRole("region", { name: "Pulse" })).queryByText(name);

  it("is on IT's Pulse, with its reader and page", () => {
    const t = tilesOf("it").find((x) => x.key === "failing-workflows")!;
    expect(t).toMatchObject({ label: "Failing workflows", source: "automation-failures", href: "/workflows/failures" });
    expect(t.ticket).toBeUndefined();
  });

  it("counts the failed runs of the last 24 hours and links the page", async () => {
    readsOnly();
    failures.mockResolvedValue({ kind: "ok", data: on(3) });
    render(await Pulse(props(tilesOf("it"), { deptId: null })));
    expect(failures).toHaveBeenCalledWith("u-1", "co-a", "24h");
    const t = tile("Failing workflows");
    expect(within(t).getByText("3")).toBeInTheDocument();
    expect(within(t).getByRole("link")).toHaveAttribute("href", "/workflows/failures");
  });

  it("a real zero reads 0 (n8n answered), and a capped count says it is a lower bound", async () => {
    readsOnly();
    failures.mockResolvedValue({ kind: "ok", data: on(0) });
    const first = render(await Pulse(props(tilesOf("it"), { deptId: null })));
    expect(within(tile("Failing workflows")).getByText("0")).toBeInTheDocument();
    first.unmount();
    failures.mockResolvedValue({ kind: "ok", data: on(1000, { capped: true }) });
    render(await Pulse(props(tilesOf("it"), { deptId: null })));
    expect(within(tile("Failing workflows")).getByText("At least; the window holds more")).toBeInTheDocument();
  });

  it("a 403 HIDES the tile (it is not for everyone) while every other tile still says No access", async () => {
    readsOnly();
    failures.mockResolvedValue({ kind: "forbidden" });
    const first = render(await Pulse(props(tilesOf("it"), { deptId: null })));
    expect(hasTile("Failing workflows")).toBeNull();
    expect(screen.queryByText("No access")).toBeNull();
    expect(within(tile("Devices offline")).getByText("0")).toBeInTheDocument();
    first.unmount();

    // the option is the tile's own: a refusal on another source keeps its words
    alerts.mockResolvedValue({ kind: "forbidden" });
    render(await Pulse(props(tilesOf("it"), { deptId: null })));
    expect(within(tile("Threat alerts")).getByText("No access")).toBeInTheDocument();
    expect(hasTile("Failing workflows")).toBeNull();
  });

  it("draws no Pulse at all when the only tile is hidden (the GM's, for someone outside the audience)", async () => {
    failures.mockResolvedValue({ kind: "forbidden" });
    expect(await Pulse(props(tilesOf("gm"), { deptId: null }))).toBeNull();
  });

  it("not configured or unavailable reads Unavailable with the reason, never 0", async () => {
    readsOnly();
    failures.mockResolvedValue({ kind: "ok", data: { asOf: "x", window: "24h", state: "not_configured", reason: "The automation service has no URL or no API key" } as never });
    const first = render(await Pulse(props(tilesOf("it"), { deptId: null })));
    let t = tile("Failing workflows");
    expect(within(t).getByText("Unavailable")).toBeInTheDocument();
    expect(within(t).getByText("The automation service has no URL or no API key")).toBeInTheDocument();
    expect(within(t).queryByText("0")).toBeNull();
    first.unmount();

    failures.mockResolvedValue({ kind: "ok", data: { asOf: "x", window: "24h", state: "unavailable", reason: "n8n did not answer" } as never });
    const second = render(await Pulse(props(tilesOf("it"), { deptId: null })));
    t = tile("Failing workflows");
    expect(within(t).getByText("Unavailable")).toBeInTheDocument();
    expect(within(t).getByText("n8n did not answer")).toBeInTheDocument();
    second.unmount();

    failures.mockResolvedValue({ kind: "unavailable", reason: "500" });
    render(await Pulse(props(tilesOf("it"), { deptId: null })));
    expect(within(tile("Failing workflows")).getByText("Unavailable")).toBeInTheDocument();
  });

  it("a reader that throws is this tile's failure and does not blank the others", async () => {
    readsOnly();
    failures.mockRejectedValue(new Error("socket hang up"));
    render(await Pulse(props(tilesOf("it"), { deptId: null })));
    expect(within(tile("Failing workflows")).getByText("Unavailable")).toBeInTheDocument();
    expect(within(tile("Devices offline")).getByText("0")).toBeInTheDocument();
  });
});
