import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { plainMember } from "@/lib/itSecurityFixtures";

// DW-7i-1 (BFF §52.12, DW-D37): the Failing workflows page. Pinned: the failed runs are listed (workflow, started, stopped, mode) for
// 24h or 7d with the count, "at least" when the server capped it, each workflow opens in n8n when the address is known; a refusal is
// the sentence naming who the page is for; not_configured and unavailable are said in words and draw no figure; a real zero is only
// said when n8n answered.
vi.mock("next/navigation", () => ({ redirect: vi.fn(() => { throw new Error("redirect"); }) }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(async () => plainMember), PlatformError: class extends Error {} }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("@/lib/automationFailures", async (orig) => ({ ...(await orig<typeof import("@/lib/automationFailures")>()), listFailuresResult: vi.fn() }));

import { listFailuresResult, type FailedRun } from "@/lib/automationFailures";
import FailingWorkflowsPage from "./page";

const read = vi.mocked(listFailuresResult);
const mount = async (sp: { window?: string } = {}) => render(await FailingWorkflowsPage({ searchParams: Promise.resolve(sp) }));
const run = (over: Partial<FailedRun> = {}): FailedRun => ({
  executionId: "9021", workflowId: "wf-1", workflowName: "Invoice chaser", startedAt: "2026-10-16T08:00:00Z", stoppedAt: "2026-10-16T08:00:04Z", mode: "trigger", ...over,
});
const on = (over: Record<string, unknown> = {}) =>
  ({ kind: "ok", data: { asOf: "2026-10-16T09:00:00Z", window: "24h", state: "on", failed: [run()], count: 1, capped: false, editorUrl: "https://n8n.example.test", ...over } }) as never;
const kpi = (label: string) => [...document.querySelectorAll<HTMLElement>(".lux-kpi")].find((el) => el.textContent?.startsWith(label))!;

beforeEach(() => { read.mockReset().mockResolvedValue(on()); });

describe("Failing workflows: the list", () => {
  it("lists each failed run with its workflow, start, stop and mode, and counts them", async () => {
    read.mockResolvedValue(on({ failed: [run(), run({ executionId: "9017", workflowId: "wf-2", workflowName: "WhatsApp lead intake", mode: "webhook", stoppedAt: null })], count: 2 }));
    await mount();
    expect(read).toHaveBeenCalledWith("u-1", "co-a", "24h");
    expect(screen.getByText("Invoice chaser")).toBeInTheDocument();
    expect(screen.getByText("WhatsApp lead intake")).toBeInTheDocument();
    expect(screen.getByText("Trigger")).toBeInTheDocument();
    expect(screen.getByText("Webhook")).toBeInTheDocument();
    expect(within(kpi("Failed runs")).getByText("2")).toBeInTheDocument();
  });

  it("sorts newest first whatever order the server sent", async () => {
    read.mockResolvedValue(on({ failed: [run({ workflowName: "Older", startedAt: "2026-10-16T01:00:00Z" }), run({ workflowName: "Newer", startedAt: "2026-10-16T08:30:00Z" })], count: 2 }));
    await mount();
    const names = [...document.querySelectorAll("a[href*='/workflow/']")].map((a) => a.textContent);
    expect(names).toEqual(["Newer", "Older"]);
  });

  it("links each workflow to the n8n editor when the backend says where it is", async () => {
    await mount();
    expect(screen.getByRole("link", { name: "Invoice chaser" })).toHaveAttribute("href", "https://n8n.example.test/workflow/wf-1");
  });

  it("shows the name as plain text when the editor address is not known", async () => {
    read.mockResolvedValue(on({ editorUrl: undefined }));
    await mount();
    expect(screen.getByText("Invoice chaser")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Invoice chaser" })).toBeNull();
  });

  it("offers 24 hours and 7 days only, and reads the one asked for", async () => {
    await mount({ window: "7d" });
    expect(read).toHaveBeenCalledWith("u-1", "co-a", "7d");
    expect(screen.getByRole("link", { name: "Last 24 hours" })).toHaveAttribute("href", "/workflows/failures?window=24h");
    expect(screen.getByRole("link", { name: "Last 7 days" })).toHaveAttribute("href", "/workflows/failures?window=7d");
    expect(screen.queryByRole("link", { name: "Last 15 minutes" })).toBeNull();
  });

  it("falls back to 24 hours for a window it does not know, rather than forwarding it", async () => {
    await mount({ window: "1y" });
    expect(read).toHaveBeenCalledWith("u-1", "co-a", "24h");
  });

  it("says 'at least' with a bar when the server's page cap cut the window short, and how many are shown", async () => {
    read.mockResolvedValue(on({ count: 1250, capped: true, reason: "The window holds more failed runs than the 5 pages read; the count is at least 1250" }));
    await mount();
    expect(within(kpi("Failed runs")).getByText("At least 1250")).toBeInTheDocument();
    expect(screen.getByText("More than shown")).toBeInTheDocument();
    expect(screen.getByText(/Showing the newest 1 of at least 1250 failed runs/)).toBeInTheDocument();
  });

  it("a real zero (n8n answered) is said as a real zero", async () => {
    read.mockResolvedValue(on({ failed: [], count: 0 }));
    await mount();
    expect(screen.getByText(/No failed runs in this window \(last 24 hours\).*n8n answered, so this is a real zero/)).toBeInTheDocument();
    expect(within(kpi("Failed runs")).getByText("0")).toBeInTheDocument();
  });
});

describe("Failing workflows: not in the audience, and states with no data", () => {
  it("a 403 says who the page is for and draws no figure", async () => {
    read.mockResolvedValue({ kind: "forbidden" });
    await mount();
    expect(screen.getByText(/This page is for the owner, the GM, the PM and the platform operator\./)).toBeInTheDocument();
    expect(document.querySelector(".lux-kpi")).toBeNull();
  });

  it("not_configured is said in words and is not 'no failures'", async () => {
    read.mockResolvedValue({ kind: "ok", data: { asOf: "a", window: "24h", state: "not_configured", reason: "The automation service has no URL or no API key" } } as never);
    await mount();
    expect(screen.getByText("Automation is not set up")).toBeInTheDocument();
    expect(screen.getByText(/The automation service has no URL or no API key/)).toBeInTheDocument();
    expect(screen.queryByText(/real zero/)).toBeNull();
    expect(document.querySelector(".lux-kpi")).toBeNull();
  });

  it("unavailable carries the reason and is not 'no failures'", async () => {
    read.mockResolvedValue({ kind: "ok", data: { asOf: "a", window: "24h", state: "unavailable", reason: "n8n did not answer the failed runs (HTTP 502)" } } as never);
    await mount();
    expect(screen.getByText("Automation cannot be read")).toBeInTheDocument();
    expect(screen.getByText(/n8n did not answer the failed runs \(HTTP 502\)/)).toBeInTheDocument();
    expect(screen.queryByText(/real zero/)).toBeNull();
    expect(document.querySelector(".lux-kpi")).toBeNull();
  });

  it("a failed read (module off, 5xx) says we cannot tell, and is not an empty list", async () => {
    read.mockResolvedValue({ kind: "unavailable", reason: "automation-console is not enabled for this company" });
    await mount();
    expect(screen.getByText(/cannot be read right now/)).toBeInTheDocument();
    expect(screen.getByText(/automation-console is not enabled for this company/)).toBeInTheDocument();
    expect(screen.queryByText(/real zero/)).toBeNull();
    expect(document.querySelector(".lux-kpi")).toBeNull();
  });
});
