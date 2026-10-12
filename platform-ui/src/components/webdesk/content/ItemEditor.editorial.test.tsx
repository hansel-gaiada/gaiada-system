import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import service from "../../../../e2e/webdesk-stub/compositions/service.json";
import type { CollectionSummary, ItemDetail, ItemRef, TenantRef, SiteRef, WdResult } from "@/lib/webdeskContentModel";
import type { EditorBundle } from "@/lib/webdeskContent";
import type { EditorialInitial } from "@/lib/webdeskEditorialModel";

// M5-W2e: the editor's Review panel. The panel's own behaviour is in editorial/EditorialPanel.test.tsx; here: that the editor mounts it
// with the right state, tells it about unsaved edits and about a failing WebDesk, and never shows it in the client portal or on create.

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/webdeskContentActions", () => ({
  createItemAndOpenAction: vi.fn(), deleteItemAction: vi.fn(), getItemHeadAction: vi.fn(), previewItemAction: vi.fn(), refreshEditorAction: vi.fn(), saveItemAction: vi.fn(),
}));
vi.mock("@/lib/webdeskMediaActions", () => ({
  listMediaAction: vi.fn(), mediaUsageAction: vi.fn(), mintUploadTokenAction: vi.fn(), updateMediaAction: vi.fn(), deleteMediaAction: vi.fn(),
}));
vi.mock("@/lib/webdeskEditorialActions", () => ({
  addCommentAction: vi.fn(), approveAction: vi.fn(), assignAction: vi.fn(), loadEditorialStateAction: vi.fn(), requestChangesAction: vi.fn(),
  resolveCommentAction: vi.fn(), seoSignoffAction: vi.fn(), submitForReviewAction: vi.fn(), withdrawFromReviewAction: vi.fn(),
}));
vi.mock("./PublishBar", () => ({ PublishBar: () => <div data-testid="pb" /> }));

import * as A from "@/lib/webdeskContentActions";
import * as E from "@/lib/webdeskEditorialActions";
import { ItemEditor } from "./ItemEditor";

const a = vi.mocked(A);
const e = vi.mocked(E);
const SCOPE = { tenantSlug: "gaiada", siteId: "s1" };
const ROUTE = "/departments/d1/website/content/gaiada/s1";
const ok = <T,>(data: T): WdResult<T> => ({ kind: "ok", data });
const noLint = { unresolvedTokens: [], markers: {} };
const tenant: TenantRef = { slug: "gaiada", status: "active", defaultLocale: "en", locales: ["en", "id"], sites: [] };
const site: SiteRef = { siteId: "s1", name: "gaiada.com", kind: "static", environments: [] };
const coll: CollectionSummary = { key: "service", composition: service as never, vocabularyVersion: "1.1.0", counts: { items: 1, byLocale: { en: 1 }, live: 0, pendingChanges: 1 }, updatedAt: "t" };
const ref = (over: Partial<ItemRef> = {}): ItemRef => ({ itemId: "i1", collectionKey: "service", locale: "en", slug: "service.seo", localizationGroupId: "g", headVersion: 3, publishedVersion: null, publishState: "draft", publishAt: null, unpublishAt: null, deletedAt: null, updatedAt: "2026-10-10T08:00:00Z", ...over });
const FIELDS = { url: "/services/seo/", source_path: "content/en/seo.md", template: "service", section: "service", language: "en-GB", h1: "SEO Agency", phase: "L", publish_ready: false, visibility: "shown", plan: { action: "SHOW" }, body: "# SEO" };
const detail = (over: Partial<ItemDetail> = {}): ItemDetail => ({
  item: ref(), version: { n: 3, contentHash: "h", createdAt: "2026-10-10T08:00:00Z", createdBy: "u1", note: null, blocks: [{ type: "fields", props: FIELDS }], seo: { title: "T" } },
  group: [{ locale: "en", itemId: "i1", slug: "service.seo", headVersion: 3, publishedVersion: null, publishState: "draft" }], lint: noLint, ...over,
});
const bundle = (d: ItemDetail): EditorBundle => ({ tenant, site, collection: coll, detail: d, authoritative: null, authoritativeProblem: null, pendingRequests: [], pendingProblem: null, build: null, buildProblem: null, loadedAt: "2026-10-10T08:30:00Z" });
const review = (over: Partial<EditorialInitial> = {}): EditorialInitial => ({
  editorial: { reviewRequired: true, state: "in_review", approvedVersion: null, submittedVersion: 3, authorSub: "u1" },
  allowed: { read: true, approve: true, request_changes: true, comment: true }, history: { itemId: "i1", collectionKey: "service", headVersion: 3, deleted: false, editorial: { reviewRequired: true, state: "in_review", approvedVersion: null }, events: [], eventsTruncated: false, comments: [], commentsTruncated: false }, historyProblem: null, ...over,
});
const mount = (extra: Partial<React.ComponentProps<typeof ItemEditor>> = {}, d: ItemDetail = detail()) =>
  render(<ItemEditor mode="edit" scope={SCOPE} routeBase={ROUTE} collection={coll} tenant={tenant} site={site} bundle={bundle(d)} authors={{ u1: "Ayu" }} readOnlyReason={null} editorial={review()} {...extra} />);
const click = async (el: Element) => { await act(async () => { fireEvent.click(el); }); };

beforeEach(() => { [...Object.values(a), ...Object.values(e)].forEach((f) => (f as ReturnType<typeof vi.fn>).mockReset()); });
afterEach(cleanup);

describe("ItemEditor: the Review panel", () => {
  it("shows the panel in the side column with the state and the actions `allowed` gives", () => {
    mount();
    expect(screen.getByTestId("editorial-panel")).toBeTruthy();
    expect(screen.getByTestId("review-state").getAttribute("data-state")).toBe("in_review");
    expect(screen.getByTestId("act-approve")).toBeTruthy();
    expect(screen.getByTestId("act-request-changes")).toBeTruthy();
    expect(screen.queryByTestId("act-submit")).toBeNull();
    expect(screen.queryByTestId("act-seo-signoff")).toBeNull(); // not in `allowed`
  });

  it("no `editorial` prop (create mode, an older page): no panel", () => {
    mount({ editorial: undefined });
    expect(screen.queryByTestId("editorial-panel")).toBeNull();
  });

  it("the client portal's editor never shows it, even when handed one", () => {
    const clientMode = { clientId: "c1", viewerId: "u-me", editable: { fields: {} }, driver: { refreshEditor: vi.fn(), getItemHead: vi.fn(), saveItem: vi.fn(), createAndOpen: vi.fn(), previewItem: vi.fn() }, mediaDriver: { list: vi.fn(), mintToken: vi.fn(), update: vi.fn() }, renderPublish: () => null };
    mount({ clientMode: clientMode as never });
    expect(screen.queryByTestId("editorial-panel")).toBeNull();
  });

  it("unsaved edits reach the panel: approve waits, with words", () => {
    mount();
    expect((screen.getByTestId("act-approve") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(document.querySelector('[data-pointer="/blocks/0/props/h1"]') as HTMLInputElement, { target: { value: "SEO Agency Bali" } });
    expect((screen.getByTestId("act-approve") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("review-block-why").textContent).toMatch(/Save your changes first/);
  });

  it("a deleted item shows its review state but freezes every command", () => {
    mount({ readOnlyReason: "deleted" }, detail({ item: ref({ deletedAt: "2026-10-11T00:00:00Z" }) }));
    expect(screen.getByTestId("review-state")).toBeTruthy();
    expect((screen.getByTestId("act-approve") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("review-block-why").textContent).toBe("This item has been deleted.");
  });

  it("the editor's refresh also re-reads the review state", async () => {
    a.refreshEditorAction.mockResolvedValue(ok({ ...bundle(detail()), loadedAt: "2026-10-10T09:00:00Z" }));
    e.loadEditorialStateAction.mockResolvedValue(ok({ headVersion: 3, editorial: { reviewRequired: true, state: "approved", approvedVersion: 3, submittedVersion: 3 }, allowed: { read: true }, history: null, historyProblem: "x" }));
    mount();
    await click(screen.getByTestId("refresh-now"));
    expect(e.loadEditorialStateAction).toHaveBeenCalledWith(SCOPE, "i1");
    expect(screen.getByTestId("review-state").getAttribute("data-state")).toBe("approved");
  });

  it("the editor going stale freezes the panel's commands, with the editor's own words", async () => {
    a.refreshEditorAction.mockResolvedValue({ kind: "unavailable", code: "editorial_unavailable", reason: "circuit_open" });
    mount();
    await click(screen.getByTestId("refresh-now"));
    expect(screen.getByTestId("stale-banner")).toBeTruthy();
    expect((screen.getByTestId("act-approve") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("review-block-why").textContent).toBe("Disabled until WebDesk answers again.");
  });
});
