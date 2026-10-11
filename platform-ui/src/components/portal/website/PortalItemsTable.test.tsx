import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ItemSummary, WdResult } from "@/lib/webdeskContentModel";
import type { PortalApproveResult } from "@/lib/portalWebsiteModel";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/portalWebsiteActions", () => ({ portalPublishItemAction: vi.fn(), portalRequestPublishAction: vi.fn(), portalGetItemHeadAction: vi.fn() }));

import * as A from "@/lib/portalWebsiteActions";
import { PortalItemsTable } from "./PortalItemsTable";

const acts = vi.mocked(A);
const SCOPE = { tenantSlug: "gaiada", siteId: "s1" };
const ok = <T,>(data: T): WdResult<T> => ({ kind: "ok", data });
const row = (n: number, over: Partial<ItemSummary> = {}): ItemSummary => ({
  itemId: `i${n}`, slug: `page-${n}`, locale: "en", localizationGroupId: `g${n}`, title: null, headVersion: 4, publishedVersion: 3, publishState: "published", publishAt: null, unpublishAt: null,
  deletedAt: null, updatedAt: "2026-10-10T08:00:00Z", headCreatedAt: "2026-10-10T08:00:00Z", headCreatedBy: "u-me", pendingChanges: true, ...over,
});
const approved = (): PortalApproveResult => ({ approvalId: "a1", status: "approved", executionStatus: "executed", selfPublish: true, reconciled: null, error: null });
const labelOf = { i1: "Home", i2: "About", i3: "Pricing", i4: "Contact", i5: "Careers" };

function mount(items: ItemSummary[], pendingIds: string[] = [], viewerId = "u-me") {
  return render(<PortalItemsTable clientId="c1" scope={SCOPE} editorBase="/portal/website/gaiada/s1/service" items={items} pendingIds={pendingIds} viewerId={viewerId} authors={{ "u-me": "Dana (you)", "u-dewi": "Dewi" }} labelOf={labelOf} />);
}
const rowOf = (slug: string) => screen.getByTestId(`item-row-${slug}`);
const box = (slug: string) => within(rowOf(slug)).getByRole("checkbox") as HTMLInputElement;

beforeEach(() => { cleanup(); Object.values(acts).forEach((f) => (f as ReturnType<typeof vi.fn>).mockReset()); refresh.mockReset(); });

describe("each item's state, in words", () => {
  it("live · live with changes not published · draft · waiting for approval", () => {
    mount([
      row(1, { headVersion: 3, pendingChanges: false }),
      row(2),
      row(3, { publishedVersion: null, publishState: "draft", headVersion: 1 }),
      row(4),
    ], ["i4"]);
    expect(rowOf("page-1").dataset.state).toBe("live");
    expect(within(rowOf("page-1")).getByText("Live")).toBeTruthy();
    expect(within(rowOf("page-2")).getByText("Live, with changes not published")).toBeTruthy();
    expect(within(rowOf("page-3")).getByText("Draft, not live yet")).toBeTruthy();
    expect(within(rowOf("page-4")).getByText("Waiting for approval")).toBeTruthy();
  });

  it("links to the editor with the language, shows the name, and credits the author through authorLabel", () => {
    mount([row(1, { headCreatedBy: "u-dewi" })]);
    expect(screen.getByRole("link", { name: "Home" }).getAttribute("href")).toBe("/portal/website/gaiada/s1/service/page-1?locale=en");
    expect(within(rowOf("page-1")).getByText(/by Dewi/)).toBeTruthy();
  });

  it("there is no delete, unpublish or schedule control anywhere", () => {
    mount([row(1), row(2)]);
    expect(screen.queryByRole("button", { name: /delete|unpublish|schedule/i })).toBeNull();
  });
});

describe("self-publish ONE item vs request publish for a batch (D58)", () => {
  it("Publish now is offered on the item the VIEWER changed, and not on a colleague's", () => {
    mount([row(1), row(2, { headCreatedBy: "u-dewi" })]);
    expect(within(rowOf("page-1")).getByTestId("publish-now-page-1")).toBeTruthy();
    expect(within(rowOf("page-2")).queryByTestId("publish-now-page-2")).toBeNull();
    expect(within(rowOf("page-2")).getByText("Add to a request")).toBeTruthy();
  });

  it("Publish now asks once, then publishes exactly ONE item at its head version, and files no request", async () => {
    acts.portalPublishItemAction.mockResolvedValue(ok({ ...approved(), reconciled: true }));
    mount([row(1), row(2)]);
    fireEvent.click(screen.getByTestId("publish-now-page-1"));
    expect(acts.portalPublishItemAction).not.toHaveBeenCalled();
    expect(screen.getByTestId("publish-now-page-1-ask").textContent).toContain("Publish v4 of Home now?");
    await act(async () => { fireEvent.click(screen.getByTestId("publish-now-page-1-confirm")); });
    expect(acts.portalPublishItemAction).toHaveBeenCalledTimes(1);
    expect(acts.portalPublishItemAction).toHaveBeenCalledWith("c1", SCOPE, "i1", 4);
    expect(acts.portalRequestPublishAction).not.toHaveBeenCalled();
    expect(screen.getByTestId("items-notice").textContent).toContain("Home: Published. Your site updates in a few minutes.");
    expect(refresh).toHaveBeenCalled();
  });

  it("executed but not reconciled: an item read that shows the version live says 'Published'; one that does not says it was sent", async () => {
    acts.portalPublishItemAction.mockResolvedValue(ok(approved()));
    acts.portalGetItemHeadAction.mockResolvedValue(ok({ item: { publishedVersion: 4 } } as never));
    mount([row(1)]);
    fireEvent.click(screen.getByTestId("publish-now-page-1"));
    await act(async () => { fireEvent.click(screen.getByTestId("publish-now-page-1-confirm")); });
    expect(acts.portalGetItemHeadAction).toHaveBeenCalledWith("c1", SCOPE, "i1");
    expect(screen.getByTestId("items-notice").textContent).toContain("Home: Published. Your site updates in a few minutes.");
    cleanup();
    acts.portalGetItemHeadAction.mockResolvedValue(ok({ item: { publishedVersion: 3 } } as never));
    mount([row(1)]);
    fireEvent.click(screen.getByTestId("publish-now-page-1"));
    await act(async () => { fireEvent.click(screen.getByTestId("publish-now-page-1-confirm")); });
    const t = screen.getByTestId("items-notice").textContent!;
    expect(t).toContain("The publish went through, but we can't yet see it as live.");
    expect(t).not.toContain("Published.");
  });

  it("a batch: select several, ONE request lists every selected item at its head version, and nothing is published", async () => {
    acts.portalRequestPublishAction.mockResolvedValue(ok({ approvalId: "a2", command: "content.publish", itemCount: 2 }));
    mount([row(1), row(2), row(3, { headVersion: 7 })]);
    const send = screen.getByTestId("request-publish") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(box("page-1"));
    fireEvent.click(box("page-3"));
    expect(send.textContent).toBe("Request publish (2)");
    await act(async () => { fireEvent.click(send); });
    expect(acts.portalRequestPublishAction).toHaveBeenCalledTimes(1);
    expect(acts.portalRequestPublishAction).toHaveBeenCalledWith("c1", SCOPE, [{ itemId: "i1", version: 4 }, { itemId: "i3", version: 7 }]);
    expect(acts.portalPublishItemAction).not.toHaveBeenCalled();
    expect(screen.getByTestId("items-notice").textContent).toBe("Request filed for 2 pages. Another person from your company needs to approve it before anything goes live.");
    expect(refresh).toHaveBeenCalled();
    expect(box("page-1").checked).toBe(false); // the selection is cleared once filed
  });

  it("only items with something to publish, and not already in a request, can be selected", () => {
    mount([row(1, { headVersion: 3, pendingChanges: false }), row(2), row(3)], ["i3"]);
    expect(box("page-1").disabled).toBe(true);
    expect(box("page-2").disabled).toBe(false);
    expect(box("page-3").disabled).toBe(true);
    expect(box("page-3").title).toBe("Already in a publish request");
  });

  it("every checkbox has an accessible name that says which page", () => {
    mount([row(1)]);
    expect(box("page-1").getAttribute("aria-label")).toBe("Select Home (en) for a publish request");
  });

  it("a batch with one item Gaiada must publish: 422 publish-not-client-editable names that item", async () => {
    acts.portalRequestPublishAction.mockResolvedValue({ kind: "invalid", slug: "publish-not-client-editable", message: "m", issues: [{ path: "/items/1/seo/title", message: "x" }] });
    mount([row(1), row(2)]);
    fireEvent.click(box("page-1"));
    fireEvent.click(box("page-2"));
    await act(async () => { fireEvent.click(screen.getByTestId("request-publish")); });
    const text = screen.getByTestId("items-notice").textContent!;
    expect(text).toContain("This draft includes changes only Gaiada can publish.");
    expect(text).toContain("About: Search appearance (SEO)");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("403 client-command-not-allowed on a request: no scheduling for clients", async () => {
    acts.portalRequestPublishAction.mockResolvedValue({ kind: "forbidden", reason: "x", slug: "client-command-not-allowed" });
    mount([row(1)]);
    fireEvent.click(box("page-1"));
    await act(async () => { fireEvent.click(screen.getByTestId("request-publish")); });
    expect(screen.getByTestId("items-notice").textContent).toContain("Scheduling isn't available to you.");
  });

  it("a publish that executed but failed says so (and never 'Published')", async () => {
    acts.portalPublishItemAction.mockResolvedValue(ok({ ...approved(), executionStatus: "failed", error: "version-conflict" }));
    mount([row(1)]);
    fireEvent.click(screen.getByTestId("publish-now-page-1"));
    await act(async () => { fireEvent.click(screen.getByTestId("publish-now-page-1-confirm")); });
    const text = screen.getByTestId("items-notice").textContent!;
    expect(text).toContain("Publishing Home didn't complete.");
    expect(text).not.toContain("Published.");
  });

  it("the notice region is polite", () => {
    mount([row(1)]);
    expect(screen.getByTestId("items-notice").getAttribute("aria-live")).toBe("polite");
    expect(document.querySelector('[aria-live="assertive"], [role="log"]')).toBeNull();
  });
});

describe("a list that has a pending-request lookup problem", () => {
  it("is the page's to say; the table itself never marks an item as pending without evidence", () => {
    mount([row(1)], []);
    expect(within(rowOf("page-1")).queryByText("Waiting for approval")).toBeNull();
  });
});
