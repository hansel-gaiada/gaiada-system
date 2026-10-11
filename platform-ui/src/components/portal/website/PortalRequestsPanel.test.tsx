import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { WdResult } from "@/lib/webdeskContentModel";
import type { PortalApproveResult, RequestView } from "@/lib/portalWebsiteModel";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
vi.mock("@/lib/portalWebsiteActions", () => ({ portalApproveRequestAction: vi.fn(), portalWithdrawRequestAction: vi.fn() }));

import * as A from "@/lib/portalWebsiteActions";
import { PortalRequestsPanel } from "./PortalRequestsPanel";

const acts = vi.mocked(A);
const ok = <T,>(data: T): WdResult<T> => ({ kind: "ok", data });
const req = (id: string, over: Partial<RequestView> = {}): RequestView => ({
  approvalId: id, status: "pending", createdAt: "2026-10-11T08:00:00Z", tenantSlug: "gaiada", siteId: "s1", itemCount: 2, itemIds: ["i1", "i2"],
  requestedBy: { userId: "u-dewi", name: "Dewi" }, requestedByMe: false, canApprove: true, executionStatus: null, siteName: "gaiada.com",
  items: [{ itemId: "i1", title: "Home", headVersion: 4, available: true }, { itemId: "i2", title: "About", headVersion: 2, available: true }], ...over,
});
const executed = (reconciled: boolean | null = true): PortalApproveResult => ({ approvalId: "a1", status: "approved", executionStatus: "executed", selfPublish: false, reconciled, error: null });
const mount = (rows: RequestView[] | null, problem: string | null = null) => render(<PortalRequestsPanel clientId="c1" requests={rows} loadProblem={problem} />);
const card = (id: string) => screen.getByTestId(`request-${id}`);

beforeEach(() => { cleanup(); Object.values(acts).forEach((f) => (f as ReturnType<typeof vi.fn>).mockReset()); refresh.mockReset(); });

describe("each request: who filed it, its pages and versions, its state", () => {
  it("shows the requester, the time, the pages with their latest draft version, the site and the state", () => {
    mount([req("a1")]);
    const c = card("a1");
    expect(within(c).getByTestId("request-who").textContent).toContain("Filed by Dewi");
    expect(within(c).getByText("Home")).toBeTruthy();
    expect(within(c).getByText(/latest draft v4/)).toBeTruthy();
    expect(within(c).getByText(/on gaiada\.com/)).toBeTruthy();
    expect(within(c).getByTestId("request-state").textContent).toBe("Waiting for approval");
  });

  it("the viewer's own request reads 'Filed by You'; a page that cannot be read is named as unavailable, not dropped; more pages are counted", () => {
    mount([req("a1", { requestedByMe: true, itemCount: 8, items: [{ itemId: "i1", title: "i1", headVersion: null, available: false }, { itemId: "i2", title: "About", headVersion: 2, available: true }] })]);
    expect(within(card("a1")).getByTestId("request-who").textContent).toContain("Filed by You");
    expect(within(card("a1")).getByText("A page that is no longer available")).toBeTruthy();
    expect(within(card("a1")).getByText("and 6 more")).toBeTruthy();
  });

  it("decided requests say what actually happened: published, not approved, withdrawn, approved-but-failed, approved-and-publishing", () => {
    mount([
      req("d1", { status: "approved", executionStatus: "executed" }), req("d2", { status: "rejected" }), req("d3", { status: "cancelled" }),
      req("d4", { status: "approved", executionStatus: "failed" }), req("d5", { status: "approved", executionStatus: null }),
    ]);
    const label = (id: string) => within(card(id)).getByTestId("request-state").textContent;
    expect([label("d1"), label("d2"), label("d3"), label("d4"), label("d5")]).toEqual(["Approved and sent", "Not approved", "Withdrawn", "Approved, but publishing failed", "Approved, publishing"]);
    // none of them can be acted on
    expect(screen.queryByRole("button", { name: /approve|withdraw/i })).toBeNull();
  });

  it("no requests at all is said, and a load that FAILED is not the same as having none", () => {
    mount([]);
    expect(screen.getByTestId("requests-none").textContent).toBe("There are no requests waiting for approval.");
    cleanup();
    mount(null, "The website service can't be reached right now.");
    const box = screen.getByTestId("requests-unavailable");
    expect(box.textContent).toContain("Couldn't load your publish requests.");
    expect(box.textContent).toContain("This is not the same as having none.");
    expect(screen.queryByTestId("requests-none")).toBeNull();
  });
});

describe("Approve appears only on ANOTHER editor's request (D58)", () => {
  it("hidden on the viewer's own request (even a single-item one the server's hint would allow); there is a reason and a Withdraw", () => {
    mount([req("own", { requestedByMe: true, canApprove: false }), req("own1", { requestedByMe: true, canApprove: true, itemCount: 1 })]);
    for (const id of ["own", "own1"]) {
      expect(within(card(id)).queryByTestId(`approve-${id}`)).toBeNull();
      expect(within(card(id)).getByTestId("needs-colleague").textContent).toBe("Waiting for another person from your company to approve.");
      expect(within(card(id)).getByTestId(`withdraw-${id}`)).toBeTruthy();
    }
  });

  it("shown on a colleague's pending request, which has no Withdraw", () => {
    mount([req("theirs")]);
    expect(within(card("theirs")).getByTestId("approve-theirs")).toBeTruthy();
    expect(within(card("theirs")).queryByTestId("withdraw-theirs")).toBeNull();
    expect(within(card("theirs")).queryByTestId("needs-colleague")).toBeNull();
  });

  it("follows the server's hint: no Approve when canApprove is false", () => {
    mount([req("x", { canApprove: false })]);
    expect(within(card("x")).queryByTestId("approve-x")).toBeNull();
  });

  it("Approve asks once, then approves THAT request, and an executed publish says it", async () => {
    acts.portalApproveRequestAction.mockResolvedValue(ok(executed()));
    mount([req("a1")]);
    fireEvent.click(screen.getByTestId("approve-a1"));
    expect(acts.portalApproveRequestAction).not.toHaveBeenCalled();
    expect(screen.getByTestId("approve-a1-ask").textContent).toContain("Approve and publish 2 pages now?");
    await act(async () => { fireEvent.click(screen.getByTestId("approve-a1-confirm")); });
    expect(acts.portalApproveRequestAction).toHaveBeenCalledWith("c1", "a1");
    expect(screen.getByTestId("request-notice").textContent).toBe("Published. Your site updates in a few minutes.");
    expect(refresh).toHaveBeenCalled();
  });

  it("executed but NOT reconciled: says it was sent and can't yet be seen as live, never 'Published'", async () => {
    acts.portalApproveRequestAction.mockResolvedValue(ok(executed(null)));
    mount([req("a1")]);
    fireEvent.click(screen.getByTestId("approve-a1"));
    await act(async () => { fireEvent.click(screen.getByTestId("approve-a1-confirm")); });
    const t = screen.getByTestId("request-notice").textContent!;
    expect(t).toBe("The publish went through, but we can't yet see it as live. It may still be on its way: reload in a minute to check.");
    expect(t).not.toContain("Published");
  });

  it("focus: after a confirmed Approve (the button is gone once the list refreshes) it moves to the outcome line; Cancel returns it to the opener", async () => {
    acts.portalApproveRequestAction.mockResolvedValue(ok(executed()));
    mount([req("a1")]);
    const ask = screen.getByTestId("approve-a1");
    ask.focus();
    fireEvent.click(ask);
    fireEvent.click(screen.getByTestId("approve-a1-cancel"));
    expect(document.activeElement).toBe(screen.getByTestId("approve-a1"));
    fireEvent.click(screen.getByTestId("approve-a1"));
    await act(async () => { fireEvent.click(screen.getByTestId("approve-a1-confirm")); });
    expect(document.activeElement).toBe(screen.getByTestId("request-notice"));
    expect(screen.getByTestId("request-notice").textContent).toContain("Published.");
  });

  it("a 403 on a COLLEAGUE's request is not 'another person must approve' (the grant may have been revoked)", async () => {
    acts.portalApproveRequestAction.mockResolvedValue({ kind: "forbidden", reason: "forbidden" });
    mount([req("a1")]);
    fireEvent.click(screen.getByTestId("approve-a1"));
    await act(async () => { fireEvent.click(screen.getByTestId("approve-a1-confirm")); });
    expect(screen.getByTestId("request-notice").textContent).toBe("You no longer have website editing access for this company. Ask your company's admin.");
  });

  it("422 publish-not-client-editable on approve (the live page moved since filing): the owner's words, naming the page", async () => {
    acts.portalApproveRequestAction.mockResolvedValue({ kind: "invalid", slug: "publish-not-client-editable", message: "m", issues: [{ path: "/items/0/seo/title", message: "x" }] });
    mount([req("a1")]);
    fireEvent.click(screen.getByTestId("approve-a1"));
    await act(async () => { fireEvent.click(screen.getByTestId("approve-a1-confirm")); });
    const t = screen.getByTestId("request-notice").textContent!;
    expect(t).toContain("This draft includes changes only Gaiada can publish. Gaiada will publish it, or you can restore the live version and edit again.");
    expect(t).toContain("Home: Search appearance (SEO)");
  });

  it("409 approval_not_pending: 'already decided', and the list is refreshed", async () => {
    acts.portalApproveRequestAction.mockResolvedValue({ kind: "conflict", slug: "approval_not_pending", message: "m", currentHeadVersion: null, currentContentHash: null, updatedAt: null });
    mount([req("a1")]);
    fireEvent.click(screen.getByTestId("approve-a1"));
    await act(async () => { fireEvent.click(screen.getByTestId("approve-a1-confirm")); });
    expect(screen.getByTestId("request-notice").textContent).toContain("already been decided");
    expect(refresh).toHaveBeenCalled();
  });

  it("approved but the execution failed: 'approved, but publishing didn't complete', never 'Published'", async () => {
    acts.portalApproveRequestAction.mockResolvedValue(ok({ ...executed(), executionStatus: "failed", error: "version-conflict" }));
    mount([req("a1")]);
    fireEvent.click(screen.getByTestId("approve-a1"));
    await act(async () => { fireEvent.click(screen.getByTestId("approve-a1-confirm")); });
    const t = screen.getByTestId("request-notice").textContent!;
    expect(t).toContain("Approved, but publishing didn't complete.");
    expect(t).not.toContain("Published.");
  });
});

describe("Withdraw (the requester's own pending request)", () => {
  it("withdraws THAT request on THAT site, and says nothing was published", async () => {
    acts.portalWithdrawRequestAction.mockResolvedValue(ok({ approvalId: "own", status: "cancelled" }));
    mount([req("own", { requestedByMe: true, canApprove: false })]);
    await act(async () => { fireEvent.click(screen.getByTestId("withdraw-own")); });
    expect(acts.portalWithdrawRequestAction).toHaveBeenCalledWith("c1", { tenantSlug: "gaiada", siteId: "s1" }, "own");
    expect(screen.getByTestId("request-notice").textContent).toBe("Request withdrawn. Nothing was published.");
    expect(refresh).toHaveBeenCalled();
  });

  it("a request someone already decided cannot be withdrawn: the server says so and the list refreshes", async () => {
    acts.portalWithdrawRequestAction.mockResolvedValue({ kind: "conflict", slug: "approval_not_pending", message: "m", currentHeadVersion: null, currentContentHash: null, updatedAt: null });
    mount([req("own", { requestedByMe: true, canApprove: false })]);
    await act(async () => { fireEvent.click(screen.getByTestId("withdraw-own")); });
    expect(screen.getByTestId("request-notice").textContent).toContain("already been decided");
    expect(refresh).toHaveBeenCalled();
  });

  it("every action names the request it acts on", () => {
    mount([req("own", { requestedByMe: true, canApprove: false, itemCount: 3 }), req("theirs")]);
    expect(screen.getByTestId("withdraw-own").getAttribute("aria-label")).toBe("Withdraw your request for 3 pages");
    expect(screen.getByTestId("approve-theirs").getAttribute("aria-label")).toBe("Approve Dewi's request for 2 pages");
  });
});
