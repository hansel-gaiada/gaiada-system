import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { WdResult } from "@/lib/webdeskContentModel";

// WSK-49d — restore, preview and the history table in CLIENT MODE. New tests in a new file: the staff suites run unchanged.
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/webdeskContentActions", () => ({ restoreVersionAndOpenAction: vi.fn(), previewItemAction: vi.fn() }));

import * as A from "@/lib/webdeskContentActions";
import { RestoreButton } from "./RestoreButton";
import { PreviewCard } from "./PreviewCard";
import { HistoryPanel } from "./HistoryPanel";

const staff = vi.mocked(A);
const SCOPE = { tenantSlug: "gaiada", siteId: "s1" };

beforeEach(() => { staff.restoreVersionAndOpenAction.mockReset(); staff.previewItemAction.mockReset(); push.mockReset(); });

async function restoreWith(r: WdResult<never>) {
  const portal = vi.fn().mockResolvedValue(r);
  render(<RestoreButton scope={SCOPE} itemId="i1" version={2} baseVersion={3} editorHref="/portal/website/g/s/c/p" restoreAndOpen={portal} clientMode />);
  fireEvent.click(screen.getByTestId("restore-2"));
  await act(async () => { fireEvent.click(screen.getByTestId("confirm-restore-2")); });
  return portal;
}

describe("RestoreButton in client mode", () => {
  it("calls the portal's restore with the same arguments, never the staff one", async () => {
    const portal = await restoreWith({ kind: "invalid", issues: [], message: "x" });
    expect(portal).toHaveBeenCalledWith(SCOPE, "i1", 2, 3, "/portal/website/g/s/c/p", "Restored from v2");
    expect(staff.restoreVersionAndOpenAction).not.toHaveBeenCalled();
  });

  it("409 version-conflict: the owner's words", async () => {
    await restoreWith({ kind: "conflict", slug: "version-conflict", message: "m", currentHeadVersion: 5, currentContentHash: null, updatedAt: null });
    expect(screen.getByRole("status").textContent).toBe("This page changed since you opened it. Reload to see the latest, then make your change again.");
  });

  it("422 field-not-client-editable: names what only Gaiada can change", async () => {
    await restoreWith({ kind: "invalid", slug: "field-not-client-editable", message: "m", issues: [{ path: "/seo/title", message: "x" }] });
    expect(screen.getByRole("status").textContent).toContain("These can only be changed by Gaiada: Search appearance (SEO).");
    expect(screen.getByRole("status").textContent).toContain("Nothing was restored.");
  });

  it("an unknown outcome is 'couldn't confirm', never 'restored' or 'failed'", async () => {
    await restoreWith({ kind: "unavailable", code: "upstream_error", reason: "reconcile_failed" });
    expect(screen.getByRole("status").textContent).toBe("We couldn't confirm the restore. Reload to see what happened.");
  });

  it("a redirect from the server is success: no error", async () => {
    const portal = vi.fn().mockRejectedValue(Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;push;/x;307;" }));
    render(<RestoreButton scope={SCOPE} itemId="i1" version={2} baseVersion={3} editorHref="/portal/website/g/s/c/p" restoreAndOpen={portal} clientMode />);
    fireEvent.click(screen.getByTestId("restore-2"));
    await act(async () => { fireEvent.click(screen.getByTestId("confirm-restore-2")); });
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("PreviewCard with the portal's call", () => {
  it("uses it instead of the staff action", async () => {
    const preview = vi.fn().mockResolvedValue({ kind: "conflict", slug: "preview_page_missing", message: "m", currentHeadVersion: null, currentContentHash: null, updatedAt: null });
    render(<PreviewCard scope={SCOPE} itemId="i1" version={4} dirty={false} blocked={null} preview={preview} />);
    await act(async () => { fireEvent.click(screen.getByTestId("preview")); });
    expect(preview).toHaveBeenCalledWith(SCOPE, "i1", 4);
    expect(staff.previewItemAction).not.toHaveBeenCalled();
    expect(screen.getByTestId("preview-notice").textContent).toContain("This site doesn't have a preview page yet.");
  });
});

describe("HistoryPanel in client mode", () => {
  const item = { itemId: "i1", slug: "p", locale: "en", localizationGroupId: "g", title: "P", headVersion: 3, publishedVersion: 2, publishState: "published", publishAt: null, unpublishAt: null, deletedAt: null, updatedAt: "t", headCreatedAt: null, headCreatedBy: null, pendingChanges: true };
  const versions = { versions: [{ version: 3, contentHash: "abcdef0123456789", createdAt: "2026-10-10T08:00:00Z", createdBy: "u-me", note: null }, { version: 2, contentHash: "0123456789abcdef", createdAt: "2026-10-09T08:00:00Z", createdBy: "u-gaia", note: "import" }], page: { cursor: null, hasMore: false, limit: 100 } };
  const props = { scope: SCOPE, item, versions, authors: { "u-me": "Dana (you)" }, historyHref: "/h?locale=en", editorHref: "/e?locale=en", compare: null };

  it("shows authors through authorLabel, hides the content hash, and restore uses the portal's action", () => {
    render(<HistoryPanel {...props} clientMode restoreAndOpen={vi.fn()} />);
    expect(screen.getByText("Dana (you)")).toBeTruthy();
    expect(screen.getByText("user u-gaia")).toBeTruthy(); // a name the portal cannot resolve reads as authorLabel's short id
    expect(screen.queryByText("Hash")).toBeNull();
    expect(document.body.textContent).not.toContain("abcdef0123");
    expect(screen.getByTestId("restore-2")).toBeTruthy();
    expect(screen.queryByTestId("restore-3")).toBeNull(); // the head itself needs no restore
  });

  it("the staff history is unchanged: hash column present", () => {
    render(<HistoryPanel {...props} />);
    expect(screen.getByText("Hash")).toBeTruthy();
    expect(document.body.textContent).toContain("abcdef0123");
  });
});
