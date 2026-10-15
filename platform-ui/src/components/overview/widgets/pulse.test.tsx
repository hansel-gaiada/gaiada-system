import { render, screen, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { OVERVIEW_WIDGETS, hasOverviewWidget, type OverviewWidgetProps } from "./index";
import { Pulse } from "./Pulse";
import { WidgetBoundary } from "../WidgetBoundary";
import { COMPANY_SUBJECT, subjectOfRef } from "@/lib/overview";
import { builtPulseTiles, payrollRunsWaiting, readingOfAllResults, readingOfPayrollRuns, readingOfSummary, runsWaiting } from "@/lib/overviewPulse";
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
  for (const m of [listRequests, listGates, summary, posts, accounts, leave, hrCases, payroll, devices]) m.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("the registry's built tiles (DW-3e)", () => {
  it("builds exactly Web Dev's three, Social Media's two, HR's four and IT's two, and no other", () => {
    const built: string[] = [];
    for (const w of [...WORKSPACES, GENERIC_WORKSPACE]) for (const t of w.pulse) if (!isPlanned(t)) built.push(`${w.key}/${t.key}`);
    expect(built.sort()).toEqual([
      "hr/leave-pending",
      "hr/onboarding",
      "hr/open-cases",
      "hr/payroll-status",
      "it/account-requests",
      "it/devices-offline",
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
        const path = t.href!.replaceAll("{dept}", "[deptId]");
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
    expect(tilesOf("it").map((t) => t.key)).toEqual(["devices-offline", "account-requests"]);
    expect(tilesOf("hr").map((t) => t.key)).toEqual(["leave-pending", "onboarding", "open-cases", "payroll-status"]);
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
