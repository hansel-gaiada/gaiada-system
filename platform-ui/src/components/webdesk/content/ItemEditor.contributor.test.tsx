import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import service from "../../../../e2e/webdesk-stub/compositions/service.json";
import type { CollectionSummary, ItemDetail, ItemRef, TenantRef, SiteRef, WdResult } from "@/lib/webdeskContentModel";
import type { EditorBundle } from "@/lib/webdeskContent";
import type { EditorialInitial } from "@/lib/webdeskEditorialModel";

// M5-W1f: the editor in CONTRIBUTOR MODE. What it hides, and that what the review panel offers still comes from `allowed` (never a role).

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/webdeskContentActions", () => ({
  createItemAndOpenAction: vi.fn(), deleteItemAction: vi.fn(), getItemHeadAction: vi.fn(), previewItemAction: vi.fn(), refreshEditorAction: vi.fn(), saveItemAction: vi.fn(),
}));
vi.mock("@/lib/contributorActions", () => ({ refreshContributorEditorAction: vi.fn() }));
vi.mock("@/lib/webdeskMediaActions", () => ({
  listMediaAction: vi.fn(), mediaUsageAction: vi.fn(), mintUploadTokenAction: vi.fn(), updateMediaAction: vi.fn(), deleteMediaAction: vi.fn(),
}));
vi.mock("@/lib/webdeskEditorialActions", () => ({
  addCommentAction: vi.fn(), approveAction: vi.fn(), assignAction: vi.fn(), loadEditorialStateAction: vi.fn(), requestChangesAction: vi.fn(),
  resolveCommentAction: vi.fn(), seoSignoffAction: vi.fn(), submitForReviewAction: vi.fn(), withdrawFromReviewAction: vi.fn(),
}));
vi.mock("./PublishBar", () => ({ PublishBar: () => <div data-testid="pb" /> }));
vi.mock("./AssistDrawer", () => ({ AssistDrawer: () => <div data-testid="assist" /> }));

import * as A from "@/lib/webdeskContentActions";
import * as C from "@/lib/contributorActions";
import * as E from "@/lib/webdeskEditorialActions";
import { ItemEditor } from "./ItemEditor";

const a = vi.mocked(A);
const c = vi.mocked(C);
const e = vi.mocked(E);
const SCOPE = { tenantSlug: "gaiada", siteId: "s1" };
const ROUTE = "/contributor/items/gaiada/s1";
const noLint = { unresolvedTokens: [], markers: {} };
const tenant: TenantRef = { slug: "gaiada", status: "active", defaultLocale: "en", locales: ["en"], sites: [] };
const site: SiteRef = { siteId: "s1", name: "gaiada.com", kind: "static", environments: [] };
const coll: CollectionSummary = { key: "service", composition: service as never, vocabularyVersion: "1.1.0", counts: { items: 1, byLocale: { en: 1 }, live: 0, pendingChanges: 1 }, updatedAt: "t" };
const ref = (): ItemRef => ({ itemId: "i1", collectionKey: "service", locale: "en", slug: "service.seo", localizationGroupId: "g", headVersion: 3, publishedVersion: null, publishState: "draft", publishAt: null, unpublishAt: null, deletedAt: null, updatedAt: "2026-10-10T08:00:00Z" });
const FIELDS = { url: "/services/seo/", source_path: "content/en/seo.md", template: "service", section: "service", language: "en-GB", h1: "SEO Agency", phase: "L", publish_ready: false, visibility: "shown", plan: { action: "SHOW" }, body: "# SEO" };
const detail = (): ItemDetail => ({
  item: ref(), version: { n: 3, contentHash: "h", createdAt: "2026-10-10T08:00:00Z", createdBy: "u1", note: null, blocks: [{ type: "fields", props: FIELDS }], seo: { title: "T" } },
  group: [{ locale: "en", itemId: "i1", slug: "service.seo", headVersion: 3, publishedVersion: null, publishState: "draft" }], lint: noLint,
});
const bundle = (d: ItemDetail): EditorBundle => ({ tenant, site, collection: coll, detail: d, authoritative: null, authoritativeProblem: null, pendingRequests: null, pendingProblem: null, build: null, buildProblem: null, loadedAt: "2026-10-10T08:30:00Z" });
const review = (allowed: Record<string, boolean>, state = "draft"): EditorialInitial => ({
  editorial: { reviewRequired: true, state, approvedVersion: null, submittedVersion: state === "in_review" ? 3 : null, authorSub: "u1" },
  allowed,
  history: { itemId: "i1", collectionKey: "service", headVersion: 3, deleted: false, editorial: { reviewRequired: true, state, approvedVersion: null }, events: [], eventsTruncated: false, comments: [], commentsTruncated: false },
  historyProblem: null,
});
const mount = (allowed: Record<string, boolean>, over: Partial<React.ComponentProps<typeof ItemEditor>> = {}, state = "draft") =>
  render(<ItemEditor mode="edit" scope={SCOPE} routeBase={ROUTE} collection={coll} tenant={tenant} site={site} bundle={bundle(detail())} authors={{ u1: "Ayu" }} readOnlyReason={null} editorial={review(allowed, state)} {...over} />);

beforeEach(() => { [...Object.values(a), ...Object.values(c), ...Object.values(e)].forEach((f) => (f as ReturnType<typeof vi.fn>).mockReset()); });
afterEach(cleanup);

describe("ItemEditor, contributor mode: what is left out", () => {
  const ALL = { read: true, update: true, submit: true, comment: true, request_changes: true, seo_signoff: true, approve: true, assign: true, delete: true, request_publish: true };

  it("has no publish bar, no delete, no writing assistant, no history link and no media library, even when `allowed` says yes to everything", () => {
    mount(ALL, { contributorMode: true });
    expect(screen.queryByTestId("pb")).toBeNull();
    expect(screen.queryByTestId("assist")).toBeNull();
    expect(screen.queryByText(/Delete draft/)).toBeNull();
    expect(screen.queryByText("Version history")).toBeNull();
    expect(screen.queryByTestId("media-choose")).toBeNull();
    expect(screen.queryByText(/Upload/i)).toBeNull();
  });

  it("the staff editor is unchanged: same item, publish bar and delete are there", () => {
    mount(ALL);
    expect(screen.getByTestId("pb")).toBeTruthy();
    expect(screen.getByTestId("assist")).toBeTruthy();
    expect(screen.getByText(/Delete draft/)).toBeTruthy();
    expect(screen.getByText("Version history")).toBeTruthy();
  });

  it("keeps what a writer needs: save, the preview and the review panel", () => {
    mount(ALL, { contributorMode: true });
    expect(screen.getByTestId("save")).toBeTruthy();
    expect(screen.getByTestId("editorial-panel")).toBeTruthy();
    expect(screen.getAllByText(/Preview/i).length).toBeGreaterThan(0);
  });
});

describe("ItemEditor, contributor mode: the review actions follow `allowed`", () => {
  it("offers submit when `allowed.submit` is true, and never approve or assign (closed routes) even if `allowed` says so", () => {
    mount({ read: true, submit: true, comment: true, approve: true, assign: true }, { contributorMode: true });
    expect(screen.getByTestId("act-submit")).toBeTruthy();
    expect(screen.queryByTestId("act-approve")).toBeNull();
    expect(screen.queryByTestId("act-assign")).toBeNull();
  });

  it("offers nothing the backend did not allow: no `submit` in `allowed` means no submit button", () => {
    mount({ read: true, comment: true }, { contributorMode: true });
    expect(screen.queryByTestId("act-submit")).toBeNull();
  });

  it("an SEO reviewer's `seo_signoff` and `request_changes` come from `allowed` too", () => {
    mount({ read: true, comment: true, seo_signoff: true, request_changes: true }, { contributorMode: true }, "in_review");
    expect(screen.getByTestId("act-seo-signoff")).toBeTruthy();
    expect(screen.getByTestId("act-request-changes")).toBeTruthy();
  });

  it("refreshing uses the contributor's own action (no publish reads), not the staff one", async () => {
    c.refreshContributorEditorAction.mockResolvedValue({ kind: "unavailable", code: "network", reason: "x" } as WdResult<EditorBundle>);
    mount({ read: true, update: true }, { contributorMode: true });
    await act(async () => { fireEvent.click(screen.getByTestId("refresh-now")); });
    expect(c.refreshContributorEditorAction).toHaveBeenCalledTimes(1);
    expect(a.refreshEditorAction).not.toHaveBeenCalled();
  });
});
