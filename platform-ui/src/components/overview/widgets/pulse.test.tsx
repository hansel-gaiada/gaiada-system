import { render, screen, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { OVERVIEW_WIDGETS, hasOverviewWidget, type OverviewWidgetProps } from "./index";
import { Pulse } from "./Pulse";
import { WidgetBoundary } from "../WidgetBoundary";
import { COMPANY_SUBJECT, subjectOfRef } from "@/lib/overview";
import { builtPulseTiles, readingOfSummary, runsWaiting } from "@/lib/overviewPulse";
import { GENERIC_WORKSPACE, WORKSPACES, isPlanned, type PulseTile } from "@/lib/workspaces";
import { resolveMyWorkspaces } from "@/lib/workspaceAccess";
import { agencyTree, me as meFixture, member } from "@/lib/workspaceFixtures";
import * as cr from "@/lib/webdevChangeRequests-data";
import * as pipeline from "@/lib/pipeline";
import * as monitoring from "@/lib/monitoring";
import * as social from "@/lib/social";
import * as itAccounts from "@/lib/it-accounts";
import type { MonitoringSummary } from "@/lib/monitoringShared";
import type { SocialPost } from "@/lib/socialShared";
import type { PipelineGate } from "@/lib/pipeline";

vi.mock("@/lib/webdevChangeRequests-data", () => ({ listChangeRequests: vi.fn() }));
vi.mock("@/lib/pipeline", () => ({ listInternalPendingGates: vi.fn() }));
vi.mock("@/lib/monitoring", () => ({ getSummary: vi.fn() }));
vi.mock("@/lib/social", () => ({ listPosts: vi.fn() }));
vi.mock("@/lib/it-accounts", async (orig) => ({ ...(await orig<typeof import("@/lib/it-accounts")>()), listAccounts: vi.fn() }));

const person = meFixture([member()]);
const listRequests = vi.mocked(cr.listChangeRequests);
const listGates = vi.mocked(pipeline.listInternalPendingGates);
const summary = vi.mocked(monitoring.getSummary);
const posts = vi.mocked(social.listPosts);
const accounts = vi.mocked(itAccounts.listAccounts);

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
  for (const m of [listRequests, listGates, summary, posts, accounts]) m.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("the registry's built tiles (DW-3e)", () => {
  it("builds exactly Web Dev's three, Social Media's two and IT's one, and no other", () => {
    const built: string[] = [];
    for (const w of [...WORKSPACES, GENERIC_WORKSPACE]) for (const t of w.pulse) if (!isPlanned(t)) built.push(`${w.key}/${t.key}`);
    expect(built.sort()).toEqual([
      "it/account-requests",
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
    expect(tilesOf("it").map((t) => t.key)).toEqual(["account-requests"]);
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
    expect([listRequests, listGates, summary, posts, accounts].every((m) => m.mock.calls.length === 0)).toBe(true);
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

describe("the pure mappers", () => {
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
