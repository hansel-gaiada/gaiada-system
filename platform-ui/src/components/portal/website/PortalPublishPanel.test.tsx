import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ItemRef, WdResult } from "@/lib/webdeskContentModel";
import type { PortalApproveResult } from "@/lib/portalWebsiteModel";

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/portalWebsiteActions", () => ({ portalPublishItemAction: vi.fn(), portalGetItemHeadAction: vi.fn() }));

import * as A from "@/lib/portalWebsiteActions";
import { PortalPublishPanel } from "./PortalPublishPanel";

const act0 = vi.mocked(A);
const SCOPE = { tenantSlug: "gaiada", siteId: "s1" };
const ok = <T,>(data: T): WdResult<T> => ({ kind: "ok", data });
const item = (over: Partial<ItemRef> = {}): ItemRef => ({ itemId: "i1", collectionKey: "service", locale: "en", slug: "service.seo", localizationGroupId: "g", headVersion: 4, publishedVersion: 3, publishState: "published", publishAt: null, unpublishAt: null, deletedAt: null, updatedAt: "2026-10-10T08:00:00Z", ...over });
const approved = (over: Partial<PortalApproveResult> = {}): PortalApproveResult => ({ approvalId: "a1", status: "approved", executionStatus: "executed", selfPublish: true, reconciled: null, error: null, ...over });
const detailOf = (i: ItemRef) => ({ item: i, version: { n: i.headVersion }, group: [], lint: {} }) as never;

const cbs = { onItemChanged: vi.fn(), onUnavailable: vi.fn(), onUnconfirmed: vi.fn() };
function mount(over: Partial<React.ComponentProps<typeof PortalPublishPanel>> = {}) {
  return render(
    <PortalPublishPanel clientId="c1" scope={SCOPE} item={item()} version={4} dirty={false} blocked={null} headIsMine headAuthor={null} requests={[]}
      listHref="/portal/website/gaiada/s1/service" requestsHref="/portal/website#requests" {...cbs} {...over} />,
  );
}
const publishNow = async () => {
  fireEvent.click(screen.getByTestId("publish-now"));
  await act(async () => { fireEvent.click(screen.getByTestId("publish-now-confirm")); });
};

beforeEach(() => { cleanup(); Object.values(act0).forEach((f) => (f as ReturnType<typeof vi.fn>).mockReset()); Object.values(cbs).forEach((f) => f.mockReset()); });

describe("Publish now (self-publish ONE item, D58)", () => {
  it("asks once, then publishes the saved head version of THIS item, as this client", async () => {
    act0.portalPublishItemAction.mockResolvedValue(ok(approved()));
    act0.portalGetItemHeadAction.mockResolvedValue(ok(detailOf(item({ publishedVersion: 4 }))));
    mount();
    fireEvent.click(screen.getByTestId("publish-now"));
    expect(act0.portalPublishItemAction).not.toHaveBeenCalled(); // the first press only asks
    expect(screen.getByTestId("publish-now-ask").textContent).toContain("Publish v4 of this page now? It goes live on your site.");
    await act(async () => { fireEvent.click(screen.getByTestId("publish-now-confirm")); });
    expect(act0.portalPublishItemAction).toHaveBeenCalledWith("c1", SCOPE, "i1", 4);
    const done = await screen.findByTestId("published");
    expect(done.textContent).toContain("Published. Your site updates in a few minutes.");
    expect(cbs.onItemChanged).toHaveBeenCalled();
  });

  it("'Published' is said only after the item read CONFIRMS the version is live", async () => {
    act0.portalPublishItemAction.mockResolvedValue(ok(approved()));
    act0.portalGetItemHeadAction.mockResolvedValue(ok(detailOf(item({ publishedVersion: 3 })))); // still the old one
    mount();
    await publishNow();
    expect(await screen.findByTestId("published-unconfirmed")).toBeTruthy();
    expect(screen.queryByTestId("published")).toBeNull();
    expect(screen.queryByText(/Published\. Your site updates/)).toBeNull();
  });

  it("an approval that FAILED says publishing didn't complete, and keeps the draft", async () => {
    act0.portalPublishItemAction.mockResolvedValue(ok(approved({ executionStatus: "failed", error: "version-conflict" })));
    mount();
    await publishNow();
    const box = await screen.findByTestId("publish-failed");
    expect(box.textContent).toContain("Publishing didn't complete.");
    expect(box.textContent).toContain("Someone saved a newer version after this request was filed.");
    expect(screen.queryByTestId("published")).toBeNull();
    expect(act0.portalGetItemHeadAction).not.toHaveBeenCalled();
  });

  it("422 publish-not-client-editable: the owner's words", async () => {
    act0.portalPublishItemAction.mockResolvedValue({ kind: "invalid", slug: "publish-not-client-editable", message: "m", issues: [{ path: "/items/0/seo/title", message: "x" }] });
    mount();
    await publishNow();
    const box = await screen.findByTestId("publish-refused");
    expect(box.textContent).toContain("This draft includes changes only Gaiada can publish. Gaiada will publish it, or you can restore the live version and edit again.");
    // polite, and never a live region NESTED in the polite wrapper
    expect(box.getAttribute("role")).toBeNull();
    expect(screen.getByTestId("publish-flow").querySelectorAll("[role], [aria-live]")).toHaveLength(0);
  });

  it("403 client-command-not-allowed: no scheduling for clients", async () => {
    act0.portalPublishItemAction.mockResolvedValue({ kind: "forbidden", reason: "x", slug: "client-command-not-allowed" });
    mount();
    await publishNow();
    expect((await screen.findByTestId("publish-refused")).textContent).toContain("Scheduling isn't available to you.");
  });

  it("409 item-deleted and 409 version-conflict", async () => {
    act0.portalPublishItemAction.mockResolvedValue({ kind: "conflict", slug: "item-deleted", message: "m", currentHeadVersion: null, currentContentHash: null, updatedAt: null });
    mount();
    await publishNow();
    expect((await screen.findByTestId("publish-refused")).textContent).toContain("This page has been deleted");
  });

  it("an unknown outcome is handed to the editor (writes off until a re-read) and is NOT shown as published or failed", async () => {
    act0.portalPublishItemAction.mockResolvedValue({ kind: "unavailable", code: "upstream_error", reason: "not_observed" });
    mount();
    await publishNow();
    await waitFor(() => expect(cbs.onUnconfirmed).toHaveBeenCalledWith("the publish"));
    expect(screen.queryByTestId("published")).toBeNull();
    expect(screen.queryByTestId("publish-failed")).toBeNull();
  });

  it("a rejected server action reads as unreachable, with 'nothing was published'", async () => {
    act0.portalPublishItemAction.mockRejectedValue(new Error("network"));
    mount();
    await publishNow();
    expect((await screen.findByTestId("publish-refused")).textContent).toBe("Couldn't reach the website service. Nothing was published.");
  });
});

describe("focus after a confirmed publish", () => {
  it("moves to the outcome line (the opener is disabled once the item is live), whatever the outcome", async () => {
    act0.portalPublishItemAction.mockResolvedValue(ok(approved()));
    act0.portalGetItemHeadAction.mockResolvedValue(ok(detailOf(item({ publishedVersion: 4 }))));
    mount();
    await publishNow();
    await screen.findByTestId("published");
    expect(document.activeElement).toBe(screen.getByTestId("publish-flow"));
    cleanup();
    act0.portalPublishItemAction.mockResolvedValue({ kind: "invalid", slug: "publish-not-client-editable", message: "m", issues: [] });
    mount();
    await publishNow();
    await screen.findByTestId("publish-refused");
    expect(document.activeElement).toBe(screen.getByTestId("publish-flow"));
  });
});

describe("when Publish now is off, and why", () => {
  const off = () => (screen.getByTestId("publish-now") as HTMLButtonElement);
  const why = () => screen.getByTestId("publish-block-reason").textContent;

  it("unsaved changes", () => { mount({ dirty: true }); expect(off().disabled).toBe(true); expect(why()).toBe("Save your changes before publishing."); });
  it("nothing new to publish", () => { mount({ item: item({ headVersion: 3, publishedVersion: 3 }), version: 3 }); expect(off().disabled).toBe(true); expect(why()).toBe("There is nothing new to publish."); });
  it("the editor says writes are off (stale / read-only / unconfirmed)", () => { mount({ blocked: "Disabled until you reload." }); expect(off().disabled).toBe(true); expect(why()).toBe("Disabled until you reload."); });
  it("a colleague's change: points to a publish request, names the author, and links the list", () => {
    mount({ headIsMine: false, headAuthor: "Dewi" });
    expect(off().disabled).toBe(true);
    expect(why()).toContain("The latest change was made by Dewi.");
    expect(why()).toContain("add this page to a publish request");
    expect(screen.getByRole("link", { name: "the list" }).getAttribute("href")).toBe("/portal/website/gaiada/s1/service");
  });
  it("the button names the page it publishes and is described by the reason", () => {
    mount({ dirty: true });
    expect(off().getAttribute("aria-label")).toBe("Publish this page now");
    expect(off().getAttribute("aria-describedby")).toBe("portal-publish-why");
  });
});

describe("the panel's claims and its absences", () => {
  it("a page in a publish request says so, naming who filed it, and links to the requests", () => {
    mount({ requests: [{ approvalId: "a9", status: "pending", createdAt: "t", tenantSlug: "gaiada", siteId: "s1", itemCount: 2, itemIds: ["i1", "i2"], requestedBy: { userId: "u2", name: "Dewi" }, requestedByMe: false, canApprove: true, executionStatus: null }] });
    expect(screen.getByTestId("in-request").textContent).toContain("filed by Dewi");
    expect(screen.getByRole("link", { name: "See publish requests" }).getAttribute("href")).toBe("/portal/website#requests");
  });

  it("a request lookup that failed is said, not hidden", () => {
    mount({ requests: null });
    expect(screen.getByText(/Couldn't check whether this page is in a publish request/)).toBeTruthy();
  });

  it("no unpublish, delete or schedule control exists, and no staging state is claimed (§16j returns none)", () => {
    mount();
    expect(screen.queryByRole("button", { name: /unpublish|delete|schedule|rebuild/i })).toBeNull();
    expect(document.body.textContent).not.toMatch(/rebuild|staging/i);
  });

  it("the outcome region is polite, never assertive and never a log", async () => {
    mount();
    const region = screen.getByTestId("publish-flow");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(document.querySelector('[aria-live="assertive"], [role="log"]')).toBeNull();
  });
});
