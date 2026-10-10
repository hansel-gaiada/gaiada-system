import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { BuildStatus, ItemRef, WdResult } from "@/lib/webdeskContentModel";

vi.mock("@/lib/webdeskContentActions", () => ({
  getItemHeadAction: vi.fn(),
  pollApprovalAction: vi.fn(),
  pollBuildStatusAction: vi.fn(),
  requestPublishAction: vi.fn(),
  requestRebuildAction: vi.fn(),
  unpublishItemAction: vi.fn(),
  withdrawPublishRequestAction: vi.fn(),
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));

import * as A from "@/lib/webdeskContentActions";
import { PublishBar } from "./PublishBar";

const a = vi.mocked(A);
const SCOPE = { tenantSlug: "gaiada", siteId: "s1" };
const item = (over: Partial<ItemRef> = {}): ItemRef => ({
  itemId: "i1", collectionKey: "service", locale: "en", slug: "service.seo", localizationGroupId: "g", headVersion: 3, publishedVersion: 2,
  publishState: "published", publishAt: null, unpublishAt: null, deletedAt: null, updatedAt: "2026-10-10T08:00:00Z", ...over,
});
const row = (over: Record<string, unknown> = {}) => ({
  id: "ap-0001-publish", workflowId: "content.publish", status: "pending", executionStatus: null, executionError: null, requestedBy: "u1", requestedByName: "Hansel",
  decidedBy: null, decidedByName: null, decidedAt: null, createdAt: "t", reason: null, toolArgs: {}, ...over,
});
const ok = <T,>(data: T): WdResult<T> => ({ kind: "ok", data });
const build = (state: BuildStatus["build"] extends infer B ? (B extends { state: infer S } ? S : never) : never): BuildStatus => ({
  build: { approvalId: "ap", kind: "publish", requestedAt: "2026-10-10T08:00:00Z", publishedAt: "2026-10-10T08:00:00Z", state, stagingUrl: "https://stg.example", verifiedAt: state === "live" ? "2026-10-10T08:05:00Z" : null },
  stagingStale: false,
});

function setup(over: Partial<React.ComponentProps<typeof PublishBar>> = {}) {
  const props = {
    scope: SCOPE, item: item(), version: 3, dirty: false, blocked: null, initialPending: null as { approvalId: string }[] | null,
    pendingProblem: null as string | null, initialBuild: null as BuildStatus | null, buildProblem: null as string | null, stagingUrl: null as string | null,
    onItemChanged: vi.fn(), onUnavailable: vi.fn(), ...over,
  };
  return { props, ...render(<PublishBar {...props} />) };
}
const flush = async (ms = 3100) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(() => { vi.useFakeTimers(); Object.values(a).forEach((f) => (f as ReturnType<typeof vi.fn>).mockReset()); a.pollBuildStatusAction.mockResolvedValue({ kind: "not_enabled", reason: "not_served" }); });
afterEach(() => { vi.useRealTimers(); });

describe("PublishBar: what it claims about the item", () => {
  it("says live vN with unpublished changes; offers Request publish", () => {
    setup();
    expect(screen.getByTestId("publish-state").textContent).toBe("Live · v2");
    expect(screen.getByText(/has unpublished changes/)).toBeTruthy();
    expect((screen.getByTestId("request-publish") as HTMLButtonElement).disabled).toBe(false);
  });
  it.each([
    ["unsaved edits", { dirty: true }, /Save your changes/],
    ["stale (blocked)", { blocked: "Disabled until WebDesk answers again." }, /Disabled until/],
    ["nothing new", { item: item({ headVersion: 2 }), version: 2 }, /nothing new to publish/],
    ["deleted", { item: item({ deletedAt: "2026-10-10" }) }, /deleted/],
  ])("Request publish is disabled, with the reason, when %s", (_n, over, why) => {
    setup(over as never);
    expect((screen.getByTestId("request-publish") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("publish-block-reason").textContent).toMatch(why);
  });
});

describe("PublishBar: request -> approval -> published -> staging", () => {
  it("files the request, shows Awaiting approval #id with Withdraw and a link, then Published vN only after the item read confirms it", async () => {
    a.requestPublishAction.mockResolvedValue(ok({ approvalId: "ap-0001-publish" }));
    a.pollApprovalAction.mockResolvedValue(ok(row({ status: "approved", executionStatus: "executed", decidedByName: "Dewi" }) as never));
    a.getItemHeadAction.mockResolvedValue(ok({ item: item({ publishedVersion: 3, headVersion: 3 }), version: {} as never, group: [], lint: { unresolvedTokens: [], markers: {} } }));
    const { props } = setup();
    await act(async () => { fireEvent.click(screen.getByTestId("request-publish")); });
    expect(a.requestPublishAction).toHaveBeenCalledWith(SCOPE, [{ itemId: "i1", version: 3 }]);
    const awaiting = screen.getByTestId("awaiting-approval");
    expect(awaiting.textContent).toContain("Awaiting approval #ap-0001-");
    expect(screen.getByRole("button", { name: "Withdraw" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open approval" }).getAttribute("href")).toBe("/approvals/ap-0001-publish");
    expect((screen.getByTestId("request-publish") as HTMLButtonElement).disabled).toBe(true);

    a.pollBuildStatusAction.mockResolvedValue(ok(build("rebuilding")));
    await flush();
    const published = screen.getByTestId("published");
    expect(published.textContent).toContain("Published v3");
    expect(published.textContent).toContain("approved by Dewi");
    expect(props.onItemChanged).toHaveBeenCalledWith(expect.objectContaining({ publishedVersion: 3 }));
    await flush(1000);
    expect(screen.getByTestId("rebuilding")).toBeTruthy();
    expect(screen.queryByTestId("live-on-staging")).toBeNull();

    a.pollBuildStatusAction.mockResolvedValue(ok(build("live")));
    await flush(4500);
    expect(screen.getByTestId("live-on-staging").textContent).toContain("Live on staging");
    expect(screen.queryByTestId("rebuilding")).toBeNull();
  });

  it("an `executed` approval is NOT 'Published vN' when the item read disagrees", async () => {
    a.requestPublishAction.mockResolvedValue(ok({ approvalId: "ap-1" }));
    a.pollApprovalAction.mockResolvedValue(ok(row({ id: "ap-1", status: "approved", executionStatus: "executed" }) as never));
    a.getItemHeadAction.mockResolvedValue(ok({ item: item({ publishedVersion: 2 }), version: {} as never, group: [], lint: { unresolvedTokens: [], markers: {} } }));
    setup();
    await act(async () => { fireEvent.click(screen.getByTestId("request-publish")); });
    await flush();
    expect(screen.queryByTestId("published")).toBeNull();
    expect(screen.getByTestId("published-unconfirmed").textContent).toContain("doesn't show v3 as live yet");
  });

  it("a build that never confirms is 'unverified', never 'live'", async () => {
    a.pollBuildStatusAction.mockResolvedValue(ok(build("unverified")));
    setup({ initialBuild: build("rebuilding") });
    await flush(1000);
    expect(screen.getByTestId("rebuild-unverified").textContent).toContain("treat staging as not updated");
    expect(screen.queryByTestId("live-on-staging")).toBeNull();
  });

  it("when the build-status route is not served it says so and claims nothing", async () => {
    a.requestPublishAction.mockResolvedValue(ok({ approvalId: "ap-1" }));
    a.pollApprovalAction.mockResolvedValue(ok(row({ id: "ap-1", status: "approved", executionStatus: "executed" }) as never));
    a.getItemHeadAction.mockResolvedValue(ok({ item: item({ publishedVersion: 3 }), version: {} as never, group: [], lint: { unresolvedTokens: [], markers: {} } }));
    setup();
    await act(async () => { fireEvent.click(screen.getByTestId("request-publish")); });
    await flush();
    await flush(1000);
    expect(screen.getByTestId("build-unavailable").textContent).toMatch(/isn't available on this deployment yet/);
    expect(screen.queryByTestId("live-on-staging")).toBeNull();
  });

  it("rejected: explains, keeps the item unpublished-by-this-request, and Request again files a new one", async () => {
    a.requestPublishAction.mockResolvedValueOnce(ok({ approvalId: "ap-1" })).mockResolvedValueOnce(ok({ approvalId: "ap-2" }));
    a.pollApprovalAction.mockResolvedValue(ok(row({ id: "ap-1", status: "rejected", decidedByName: "Dewi" }) as never));
    setup();
    await act(async () => { fireEvent.click(screen.getByTestId("request-publish")); });
    await flush();
    expect(screen.getByTestId("request-rejected").textContent).toMatch(/Rejected by Dewi.*Nothing was published/);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Request again" })); });
    expect(a.requestPublishAction).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("awaiting-approval").textContent).toContain("#ap-2");
  });

  it("failed: shows the reason token in plain words", async () => {
    a.requestPublishAction.mockResolvedValue(ok({ approvalId: "ap-1" }));
    a.pollApprovalAction.mockResolvedValue(ok(row({ id: "ap-1", status: "approved", executionStatus: "failed", executionError: "version-conflict" }) as never));
    setup();
    await act(async () => { fireEvent.click(screen.getByTestId("request-publish")); });
    await flush();
    expect(screen.getByTestId("request-failed").textContent).toContain("Someone saved a newer version after this request was filed");
  });

  it("a failed poll keeps the LAST KNOWN phase and says it could not refresh (it never resets to idle)", async () => {
    a.requestPublishAction.mockResolvedValue(ok({ approvalId: "ap-1" }));
    a.pollApprovalAction.mockResolvedValue({ kind: "unavailable", code: "upstream_error", reason: "x" });
    setup();
    await act(async () => { fireEvent.click(screen.getByTestId("request-publish")); });
    await flush();
    expect(screen.getByTestId("awaiting-approval").textContent).toMatch(/Couldn't refresh the approval/);
  });

  it("finds a pending request after a reload (initialPending) and can withdraw it", async () => {
    a.withdrawPublishRequestAction.mockResolvedValue(ok({ approvalId: "ap-9", status: "withdrawn" }));
    setup({ initialPending: [{ approvalId: "ap-9" }] });
    expect(screen.getByTestId("awaiting-approval").textContent).toContain("#ap-9");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Withdraw" })); });
    expect(a.withdrawPublishRequestAction).toHaveBeenCalledWith(SCOPE, "ap-9");
    expect(screen.queryByTestId("awaiting-approval")).toBeNull();
    expect(screen.getByTestId("publish-message").textContent).toMatch(/withdrawn/);
  });

  it("Withdraw on a backend without the route says so and leaves the request showing", async () => {
    a.withdrawPublishRequestAction.mockResolvedValue({ kind: "not_enabled", reason: "not_served" });
    setup({ initialPending: [{ approvalId: "ap-9" }] });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Withdraw" })); });
    expect(screen.getByTestId("publish-message").textContent).toMatch(/Withdraw isn't available yet/);
    expect(screen.getByTestId("awaiting-approval")).toBeTruthy();
  });

  it("a refused request surfaces the failure and tells the editor the API is unavailable", async () => {
    a.requestPublishAction.mockResolvedValue({ kind: "unavailable", code: "editorial_unavailable", reason: "editorial_unavailable" });
    const { props } = setup();
    await act(async () => { fireEvent.click(screen.getByTestId("request-publish")); });
    expect(screen.getByTestId("publish-message").textContent).toMatch(/Couldn't file the publish request/);
    expect(props.onUnavailable).toHaveBeenCalled();
    expect(screen.queryByTestId("awaiting-approval")).toBeNull();
  });
});

describe("PublishBar: unpublish needs no approval, and staging is then stale", () => {
  it("two-step unpublish, then the staging-stale warning with Request rebuild", async () => {
    a.unpublishItemAction.mockResolvedValue(ok({ item: item({ publishedVersion: null, publishState: "unpublished" }) }));
    a.requestRebuildAction.mockResolvedValue(ok({ approvalId: "ap-r" }));
    const { props } = setup();
    fireEvent.click(screen.getByTestId("unpublish"));
    expect(a.unpublishItemAction).not.toHaveBeenCalled(); // confirmation first
    await act(async () => { fireEvent.click(screen.getByTestId("confirm-unpublish")); });
    expect(a.unpublishItemAction).toHaveBeenCalledWith(SCOPE, "i1", 2);
    expect(props.onItemChanged).toHaveBeenCalled();
    expect(screen.getByTestId("staging-stale").textContent).toContain("the staging site drops it at the next rebuild");
    await act(async () => { fireEvent.click(screen.getByTestId("request-rebuild")); });
    expect(screen.getByTestId("awaiting-approval").textContent).toContain("A rebuild of the staging site was requested");
  });
  it("reads stagingStale from the build status on load too", () => {
    setup({ initialBuild: { build: null, stagingStale: true } });
    expect(screen.getByTestId("staging-stale")).toBeTruthy();
  });
  it("Unpublish is not offered for an item that is not live", () => {
    setup({ item: item({ publishedVersion: null, publishState: "draft" }), version: 3 });
    expect(screen.queryByTestId("unpublish")).toBeNull();
    expect(screen.getByTestId("publish-state").textContent).toBe("Draft · never published");
  });
});
