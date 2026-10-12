import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import service from "../../../../e2e/webdesk-stub/compositions/service.json";
import type { CollectionSummary, ItemDetail, ItemRef, TenantRef, SiteRef, WdResult } from "@/lib/webdeskContentModel";
import type { EditorBundle } from "@/lib/webdeskContent";
import type { EditorialInitial } from "@/lib/webdeskEditorialModel";
import type { AssistResult } from "@/lib/webdeskAssistModel";

// M5-W6: the assist drawer inside the editor. The drawer's own behaviour is in AssistDrawer.test.tsx; here: that the editor offers it only
// from the item read's `allowed.update` (never in client mode, never for a deleted item), and that Apply puts the text into the form as an
// UNSAVED edit: the "Unsaved changes" indicator lights, NOTHING is saved, and the normal Save then sends it with `baseVersion`.

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
vi.mock("@/lib/webdeskAssistActions", () => ({ assistAction: vi.fn() }));
vi.mock("./PublishBar", () => ({ PublishBar: () => <div data-testid="pb" /> }));

import * as A from "@/lib/webdeskContentActions";
import * as AA from "@/lib/webdeskAssistActions";
import * as E from "@/lib/webdeskEditorialActions";
import { ItemEditor } from "./ItemEditor";

const a = vi.mocked(A);
const assist = vi.mocked(AA.assistAction);
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
const review = (allowed: Record<string, boolean> | undefined): EditorialInitial => ({
  editorial: { reviewRequired: false, state: "draft", approvedVersion: null, submittedVersion: null, authorSub: "u1" },
  allowed, history: null, historyProblem: null,
});
const mount = (extra: Partial<React.ComponentProps<typeof ItemEditor>> = {}, d: ItemDetail = detail()) =>
  render(<ItemEditor mode="edit" scope={SCOPE} routeBase={ROUTE} collection={coll} tenant={tenant} site={site} bundle={bundle(d)} authors={{ u1: "Ayu" }} readOnlyReason={null} editorial={review({ read: true, update: true })} {...extra} />);
const click = async (el: Element) => { await act(async () => { fireEvent.click(el); }); };

const DESC = "We help hotels in Bali rank for local searches and win more direct bookings.";
const META: AssistResult = { ok: true, data: { kind: "meta_description", itemId: "i1", version: 3, headVersion: 3, locale: "en", suggestions: [{ id: "s1", kind: "meta_description", target: "/seo/description", text: DESC, length: 76 }], notice: null, provider: "p", usage: null } };

beforeEach(() => {
  [...Object.values(a), ...Object.values(e), assist].forEach((f) => (f as ReturnType<typeof vi.fn>).mockReset());
  // after a save the review panel re-reads its state
  e.loadEditorialStateAction.mockResolvedValue(ok({ headVersion: 4, editorial: undefined, allowed: { read: true, update: true }, history: null, historyProblem: null }));
});
afterEach(cleanup);

async function askForMeta() {
  await click(screen.getByTestId("assist-toggle"));
  await click(screen.getByTestId("assist-run-meta_description"));
}

describe("ItemEditor: the assist drawer is offered from `allowed.update`", () => {
  it("is shown when the item read says the caller may update", () => {
    mount();
    expect(screen.getByTestId("assist-drawer")).toBeTruthy();
  });
  it("is not shown for a read-only caller", () => {
    mount({ editorial: review({ read: true, update: false, comment: true }) });
    expect(screen.queryByTestId("assist-drawer")).toBeNull();
  });
  it("is not shown when `allowed` did not arrive", () => {
    mount({ editorial: review(undefined) });
    expect(screen.queryByTestId("assist-drawer")).toBeNull();
  });
  it("is not shown when the page passed no `editorial` at all (an older page, tests that predate it)", () => {
    mount({ editorial: undefined });
    expect(screen.queryByTestId("assist-drawer")).toBeNull();
  });
  it("is never shown in the client portal's editor, even when handed `allowed.update`", () => {
    const clientMode = { clientId: "c1", viewerId: "u-me", editable: { fields: {} }, driver: { refreshEditor: vi.fn(), getItemHead: vi.fn(), saveItem: vi.fn(), createAndOpen: vi.fn(), previewItem: vi.fn() }, mediaDriver: { list: vi.fn(), mintToken: vi.fn(), update: vi.fn() }, renderPublish: () => null };
    mount({ clientMode: clientMode as never });
    expect(screen.queryByTestId("assist-drawer")).toBeNull();
  });
  it("is not shown for a deleted item", () => {
    mount({ readOnlyReason: "deleted" }, detail({ item: ref({ deletedAt: "2026-10-11T00:00:00Z" }) }));
    expect(screen.queryByTestId("assist-drawer")).toBeNull();
  });
  it("is not shown while creating", () => {
    render(<ItemEditor mode="create" scope={SCOPE} routeBase={ROUTE} collection={coll} tenant={tenant} site={site} seed={{ locale: "en", twinOf: null, slug: "", fields: {}, seo: {}, extraBlocks: [] }} authors={{}} readOnlyReason={null} editorial={review({ update: true })} />);
    expect(screen.queryByTestId("assist-drawer")).toBeNull();
  });
});

describe("ItemEditor: Apply is an unsaved edit, and Save stays the editor's", () => {
  it("Apply fills the SEO description, lights 'Unsaved changes', and saves NOTHING", async () => {
    assist.mockResolvedValue(META);
    mount();
    const field = document.querySelector('[data-pointer="/seo/description"]') as HTMLTextAreaElement;
    expect(field.value).toBe("");
    expect(screen.getByTestId("save-status").textContent).toBe("No changes");
    expect((screen.getByTestId("save") as HTMLButtonElement).disabled).toBe(true);

    await askForMeta();
    expect(assist).toHaveBeenCalledWith(SCOPE, "i1", "meta_description");
    expect(field.value).toBe(""); // asking changes nothing
    await click(screen.getByTestId("apply-s1"));

    expect(field.value).toBe(DESC);
    expect(screen.getByTestId("save-status").textContent).toBe("Unsaved changes");
    expect(screen.getByTestId("save-status").getAttribute("data-dirty")).toBe("true");
    expect(a.saveItemAction).not.toHaveBeenCalled(); // the drawer never saves
    expect(a.createItemAndOpenAction).not.toHaveBeenCalled();
    expect((screen.getByTestId("save") as HTMLButtonElement).disabled).toBe(false);
  });

  it("the normal Save then sends it, with the version the editor is on", async () => {
    assist.mockResolvedValue(META);
    a.saveItemAction.mockResolvedValue(ok({ item: ref({ headVersion: 4 }), version: { version: 4 }, lint: noLint, unchanged: false } as never));
    mount();
    await askForMeta();
    await click(screen.getByTestId("apply-s1"));
    await click(screen.getByTestId("save"));
    expect(a.saveItemAction).toHaveBeenCalledTimes(1);
    const [scope, itemId, input] = a.saveItemAction.mock.calls[0];
    expect(scope).toEqual(SCOPE);
    expect(itemId).toBe("i1");
    expect(input).toMatchObject({ baseVersion: 3, seo: { title: "T", description: DESC } });
  });

  it("the user can still edit the applied text before saving", async () => {
    assist.mockResolvedValue(META);
    mount();
    await askForMeta();
    await click(screen.getByTestId("apply-s1"));
    const field = document.querySelector('[data-pointer="/seo/description"]') as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: `${DESC} Book a call.` } });
    expect(field.value).toBe(`${DESC} Book a call.`);
  });

  it("an outline goes to the end of the body, as an unsaved edit", async () => {
    assist.mockResolvedValue({ ok: true, data: { kind: "outline", itemId: "i1", version: 3, headVersion: 3, locale: "en", suggestions: [{ id: "s1", kind: "outline", headings: [{ level: 2, text: "Intro" }], markdown: "## Intro" }], notice: null, provider: null, usage: null } });
    mount();
    await click(screen.getByTestId("assist-toggle"));
    await click(screen.getByTestId("assist-run-outline"));
    await click(screen.getByTestId("apply-s1"));
    // the markdown field opens as the visual editor or as source; either way the draft is dirty and nothing was saved
    expect(screen.getByTestId("save-status").textContent).toBe("Unsaved changes");
    expect(a.saveItemAction).not.toHaveBeenCalled();
  });

  it("when the editor is stale (WebDesk is not answering) Apply is off, with the editor's words", async () => {
    assist.mockResolvedValue(META);
    a.refreshEditorAction.mockResolvedValue({ kind: "unavailable", code: "editorial_unavailable", reason: "circuit_open" });
    mount();
    await click(screen.getByTestId("refresh-now"));
    expect(screen.getByTestId("stale-banner")).toBeTruthy();
    await askForMeta();
    expect((screen.getByTestId("apply-s1") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("apply-blocked-s1").textContent).toBe("Disabled until WebDesk answers again.");
    expect(screen.getByTestId("copy-s1")).toBeTruthy(); // Copy still works
  });

  it("a read-only form keeps Apply off", async () => {
    assist.mockResolvedValue(META);
    mount({ readOnlyReason: "You can read this item but not change it." });
    await askForMeta();
    expect((screen.getByTestId("apply-s1") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("apply-blocked-s1").textContent).toBe("Read-only.");
    expect(a.saveItemAction).not.toHaveBeenCalled();
  });

  it("unsaved edits are named in the drawer's words, so the user knows what the assistant did not see", async () => {
    mount();
    fireEvent.change(document.querySelector('[data-pointer="/blocks/0/props/h1"]') as HTMLInputElement, { target: { value: "SEO Agency Bali" } });
    await click(screen.getByTestId("assist-toggle"));
    expect(screen.getByTestId("assist-panel").textContent).toMatch(/not from your unsaved edits/);
  });
});
