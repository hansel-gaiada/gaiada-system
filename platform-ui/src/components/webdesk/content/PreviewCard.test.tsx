import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { PreviewLink, WdResult } from "@/lib/webdeskContentModel";

vi.mock("@/lib/webdeskContentActions", () => ({ previewItemAction: vi.fn() }));

import * as A from "@/lib/webdeskContentActions";
import { PreviewCard } from "./PreviewCard";

// WSK-46 — the editor's Preview control. The REAL BFF is driven through the same parser and action by platform-nest's
// webdesk-content-preview.test.ts; here the action is the seam, and the rendering of every state is the subject.

const preview = vi.mocked(A.previewItemAction);
const SCOPE = { tenantSlug: "gaiada", siteId: "s1" };
const LINK: PreviewLink = { previewUrl: "https://stg.example/preview/#t=SECRETTOKEN", expiresAt: "2026-10-11T09:00:00Z", version: 3 };
const ok = <T,>(data: T): WdResult<T> => ({ kind: "ok", data });
const conflict = (slug: string, message = "x"): WdResult<PreviewLink> => ({ kind: "conflict", slug, message, currentHeadVersion: null, currentContentHash: null, updatedAt: null });

function setup(over: Partial<React.ComponentProps<typeof PreviewCard>> = {}) {
  return render(<PreviewCard scope={SCOPE} itemId="i1" version={3} dirty={false} blocked={null} {...over} />);
}
const btn = () => screen.getByTestId("preview") as HTMLButtonElement;
const click = async () => { await act(async () => { fireEvent.click(btn()); }); };

let open: MockInstance<typeof window.open>;
beforeEach(() => { preview.mockReset(); open = vi.spyOn(window, "open").mockReturnValue(null); });
afterEach(() => { open.mockRestore(); });

describe("PreviewCard: the button and what it opens", () => {
  it("has an accessible name, is a real button, and starts enabled with no notice", () => {
    setup();
    expect(btn().tagName).toBe("BUTTON");
    expect(btn().type).toBe("button");
    expect(screen.getByRole("button", { name: /Preview draft/ })).toBe(btn());
    expect(btn().textContent).toContain("opens in a new tab");
    expect(btn().disabled).toBe(false);
    expect(screen.queryByTestId("preview-notice")).toBeNull();
    expect(screen.queryByTestId("preview-ready")).toBeNull();
  });

  it("OK: asks for the version the editor is on, opens the link in a NEW tab with noopener,noreferrer, and says when it stops working", async () => {
    preview.mockResolvedValue(ok(LINK));
    setup({ version: 3 });
    await click();
    expect(preview).toHaveBeenCalledWith(SCOPE, "i1", 3);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(LINK.previewUrl, "_blank", "noopener,noreferrer");
    expect(screen.getByTestId("preview-expiry").textContent).toMatch(/^Link valid until .+ · shows v3$/);
    expect(screen.queryByTestId("preview-notice")).toBeNull();
  });

  it("keeps the link on screen as an anchor (a blocked pop-up cannot be detected with noopener), also noopener noreferrer", async () => {
    preview.mockResolvedValue(ok(LINK));
    setup();
    await click();
    const a = screen.getByTestId("preview-open-again") as HTMLAnchorElement;
    expect(a.href).toBe(LINK.previewUrl);
    expect(a.target).toBe("_blank");
    expect(a.rel).toBe("noopener noreferrer");
  });

  it("is keyboard-operable: a native, focusable button (Enter and Space activate it)", async () => {
    preview.mockResolvedValue(ok(LINK));
    setup();
    btn().focus();
    expect(document.activeElement).toBe(btn());
    expect(btn().tabIndex).toBeGreaterThanOrEqual(0);
    await click(); // jsdom maps Enter/Space on a <button> to click; a non-button would need handlers and would fail the tag check above
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("a failure clears an earlier link (never an old link next to a new refusal)", async () => {
    preview.mockResolvedValueOnce(ok(LINK));
    setup();
    await click();
    expect(screen.getByTestId("preview-ready")).toBeTruthy();
    preview.mockResolvedValueOnce(conflict("preview_page_missing"));
    await click();
    expect(screen.queryByTestId("preview-ready")).toBeNull();
    expect(screen.getByTestId("preview-notice")).toBeTruthy();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("does not double-submit while the link is being made", async () => {
    let release!: (r: WdResult<PreviewLink>) => void;
    preview.mockReturnValue(new Promise((res) => { release = res; }));
    setup();
    await click();
    expect(btn().disabled).toBe(true);
    expect(btn().getAttribute("aria-busy")).toBe("true");
    await click();
    expect(preview).toHaveBeenCalledTimes(1);
    await act(async () => { release(ok(LINK)); });
    expect(btn().disabled).toBe(false);
  });
});

describe("PreviewCard: plain-words notices, never a broken tab", () => {
  it.each([
    ["preview_not_configured", /Preview isn't set up for this site yet/],
    ["preview_page_missing", /doesn't have a preview page yet/],
  ])("409 %s: a notice in plain words, nothing opened", async (slug, re) => {
    preview.mockResolvedValue(conflict(slug));
    setup();
    await click();
    const n = screen.getByTestId("preview-notice");
    expect(n.textContent).toMatch(re);
    expect(n.getAttribute("data-tone")).toBe("info");
    expect(n.getAttribute("role")).toBe("status");
    expect(open).not.toHaveBeenCalled();
    expect(screen.queryByTestId("preview-ready")).toBeNull();
    expect(screen.queryByTestId("preview-open-again")).toBeNull();
  });

  it.each<[string, WdResult<PreviewLink>, RegExp]>([
    ["item deleted", conflict("item-deleted"), /has been deleted/],
    ["forbidden", { kind: "forbidden", reason: "x" }, /don't have permission/],
    ["item gone", { kind: "not_found", slug: "item-not-found" }, /no longer exists/],
    ["site did not answer", { kind: "unavailable", code: "upstream_error", reason: "preview_site_unreachable" }, /site didn't answer/],
    ["webdesk down", { kind: "unavailable", code: "editorial_unavailable", reason: "circuit_open" }, /Couldn't reach WebDesk/],
    ["outcome unknown (ambiguous)", { kind: "unavailable", code: "upstream_error", reason: "webdesk_ambiguous" }, /couldn't confirm/],
    ["contract drift", { kind: "unavailable", code: "contract_drift", reason: "preview.previewUrl: expected an https URL" }, /answered unexpectedly/],
  ])("%s: a retry-able notice (alert), nothing opened", async (_n, result, re) => {
    preview.mockResolvedValue(result);
    setup();
    await click();
    const n = screen.getByTestId("preview-notice");
    expect(n.textContent).toMatch(re);
    expect(n.getAttribute("role")).toBe("alert");
    expect(open).not.toHaveBeenCalled();
    expect(btn().disabled).toBe(false); // can try again
  });

  it("a rejected server action (network, a deploy in flight) is the same plain words, not an unhandled error", async () => {
    preview.mockRejectedValue(new Error("fetch failed"));
    setup();
    await click();
    expect(screen.getByTestId("preview-notice").textContent).toMatch(/Couldn't reach WebDesk/);
    expect(open).not.toHaveBeenCalled();
  });

  it("never prints the token or the link in a notice", async () => {
    preview.mockResolvedValue({ kind: "unavailable", code: "contract_drift", reason: "preview.previewUrl: expected an https URL, got malformed" });
    setup();
    await click();
    expect(document.body.textContent).not.toContain("SECRETTOKEN");
  });
});

describe("PreviewCard: disabled exactly when Save is", () => {
  it.each([
    ["read-only", "Read-only."],
    ["stale", "Disabled until WebDesk answers again."],
    ["unconfirmed", "Disabled until you reload."],
  ])("%s: the button is disabled, says why, and does nothing", async (_n, why) => {
    setup({ blocked: why });
    expect(btn().disabled).toBe(true);
    expect(screen.getByTestId("preview-why").textContent).toContain(why);
    expect(btn().getAttribute("aria-describedby")).toBe("wc-preview-why");
    await click();
    expect(preview).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("unsaved edits do NOT disable it, but it says the link shows the last saved version, not the edits", () => {
    setup({ dirty: true, version: 4 });
    expect(btn().disabled).toBe(false);
    expect(screen.getByTestId("preview-why").textContent).toBe("Shows the last saved version (v4), not your unsaved changes.");
  });
});
