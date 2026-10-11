import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import service from "../../../../e2e/webdesk-stub/compositions/service.json";
import navigation from "../../../../e2e/webdesk-stub/compositions/navigation.json";
import type { CollectionSummary, ItemDetail, ItemWriteResult, ItemRef, TenantRef, SiteRef, WdResult } from "@/lib/webdeskContentModel";
import type { EditorBundle } from "@/lib/webdeskContent";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/webdeskContentActions", () => ({
  createItemAndOpenAction: vi.fn(), deleteItemAction: vi.fn(), getItemHeadAction: vi.fn(), refreshEditorAction: vi.fn(), saveItemAction: vi.fn(),
}));
// The publish bar has its own suite; here it only needs to show what the editor tells it.
vi.mock("./PublishBar", () => ({
  PublishBar: (p: { dirty: boolean; blocked: string | null; version: number }) => <div data-testid="pb" data-dirty={String(p.dirty)} data-blocked={p.blocked ?? ""} data-version={p.version} />,
}));

import * as A from "@/lib/webdeskContentActions";
import { ItemEditor } from "./ItemEditor";

const a = vi.mocked(A);
const SCOPE = { tenantSlug: "gaiada", siteId: "s1" };
const ROUTE = "/departments/d1/website/content/gaiada/s1";
const ok = <T,>(data: T): WdResult<T> => ({ kind: "ok", data });
const noLint = { unresolvedTokens: [], markers: {} };

const tenant: TenantRef = { slug: "gaiada", status: "active", defaultLocale: "en", locales: ["en", "id"], sites: [] };
const site: SiteRef = { siteId: "s1", name: "gaiada.com", kind: "static", environments: [{ envId: "e", name: "staging", domain: "stg.example", status: "active" }] };
const coll = (key: string, composition: unknown): CollectionSummary => ({ key, composition: composition as never, vocabularyVersion: "1.1.0", counts: { items: 1, byLocale: { en: 1 }, live: 0, pendingChanges: 1 }, updatedAt: "t" });
const ref = (over: Partial<ItemRef> = {}): ItemRef => ({ itemId: "i1", collectionKey: "service", locale: "en", slug: "service.seo", localizationGroupId: "g", headVersion: 3, publishedVersion: 2, publishState: "published", publishAt: null, unpublishAt: null, deletedAt: null, updatedAt: "2026-10-10T08:00:00Z", ...over });
const detail = (props: Record<string, unknown>, over: Partial<ItemDetail> = {}, n = 3): ItemDetail => ({
  item: ref({ headVersion: n }), version: { n, contentHash: "h", createdAt: "2026-10-10T08:00:00Z", createdBy: "u1", note: null, blocks: [{ type: "fields", props }], seo: { title: "T" } },
  group: [{ locale: "en", itemId: "i1", slug: "service.seo", headVersion: n, publishedVersion: 2, publishState: "published" }], lint: noLint, ...over,
});
const SERVICE_FIELDS = { url: "/services/seo/", source_path: "content/en/seo.md", template: "service", section: "service", language: "en-GB", h1: "SEO Agency", phase: "L", publish_ready: false, visibility: "shown", plan: { action: "SHOW" }, body: "# SEO" };
const bundle = (d: ItemDetail, over: Partial<EditorBundle> = {}, c = coll("service", service)): EditorBundle => ({
  tenant, site, collection: c, detail: d, authoritative: null, authoritativeProblem: null, pendingRequests: [], pendingProblem: null, build: null, buildProblem: null, loadedAt: "2026-10-10T08:30:00Z", ...over,
});
const redirected = (url: string) => Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;push;${url};307;` });
const written = (n: number): ItemWriteResult => ({ item: ref({ headVersion: n }), version: { version: n, contentHash: "h", createdAt: "t" }, unchanged: false, lint: noLint, replayed: false });

function mount(b: EditorBundle, extra: Partial<React.ComponentProps<typeof ItemEditor>> = {}) {
  return render(<ItemEditor mode="edit" scope={SCOPE} routeBase={ROUTE} collection={b.collection} tenant={tenant} site={site} bundle={b} authors={{ u2: "Dewi" }} readOnlyReason={null} {...extra} />);
}
const field = (p: string) => document.querySelector(`[data-pointer="/blocks/0/props/${p}"]`) as HTMLInputElement;
const type = (p: string, v: string) => fireEvent.change(field(p), { target: { value: v } });
const status = () => screen.getByTestId("save-status").textContent;
const saveBtn = () => screen.getByTestId("save") as HTMLButtonElement;
const click = async (el: Element) => { await act(async () => { fireEvent.click(el); }); };

beforeEach(() => { Object.values(a).forEach((f) => (f as ReturnType<typeof vi.fn>).mockReset()); push.mockReset(); });

describe("dirty / saving / saved vN", () => {
  it("starts clean with Save disabled; an edit makes it dirty and tells the publish bar", () => {
    mount(bundle(detail(SERVICE_FIELDS)));
    expect(status()).toBe("No changes");
    expect(saveBtn().disabled).toBe(true);
    type("h1", "Edited");
    expect(status()).toBe("Unsaved changes");
    expect(saveBtn().disabled).toBe(false);
    expect(screen.getByTestId("pb").getAttribute("data-dirty")).toBe("true");
  });

  it("saves the WHOLE record against baseVersion, with only the keys §3.2 names, then reads 'Saved vN'", async () => {
    a.saveItemAction.mockResolvedValue(ok(written(4)));
    mount(bundle(detail(SERVICE_FIELDS)));
    type("h1", "Edited");
    await click(saveBtn());
    expect(a.saveItemAction).toHaveBeenCalledTimes(1);
    const [scope, itemId, body] = a.saveItemAction.mock.calls[0];
    expect(scope).toEqual(SCOPE);
    expect(itemId).toBe("i1");
    expect(Object.keys(body).filter((k) => k !== "note").sort()).toEqual(["baseVersion", "blocks", "fields", "seo"]); // no tenantSlug/siteId/itemId in the body
    expect(body.baseVersion).toBe(3);
    expect(body.fields).toMatchObject({ h1: "Edited", url: "/services/seo/" });
    expect(body.blocks).toEqual([]);
    expect(body.seo).toEqual({ title: "T" });
    expect(status()).toBe("Saved v4");
    expect(screen.getByTestId("pb").getAttribute("data-version")).toBe("4"); // the next publish names v4
    expect(saveBtn().disabled).toBe(true);
  });

  it("a no-op save reports that nothing changed instead of pretending a new version", async () => {
    a.saveItemAction.mockResolvedValue(ok({ ...written(3), unchanged: true }));
    mount(bundle(detail(SERVICE_FIELDS)));
    type("h1", "Edited");
    await click(saveBtn());
    expect(status()).toBe("No changes — still v3");
  });
});

describe("invalid (422)", () => {
  it("locates each issue inline by pointer, keeps the edit, and reports the count", async () => {
    a.saveItemAction.mockResolvedValue({ kind: "invalid", message: "composition-violation", issues: [{ path: "/blocks/0/props/plan/why", message: "must explain" }, { path: "/seo/title", message: "too long" }] });
    mount(bundle(detail(SERVICE_FIELDS)));
    type("h1", "Kept");
    await click(saveBtn());
    expect(screen.getByTestId("save-error").textContent).toContain("2 problems to fix");
    expect(field("plan/why").closest(".wc-field")?.textContent).toContain("must explain");
    expect(document.querySelector("#wc-seo-title")?.closest(".wc-field")?.textContent).toContain("too long");
    expect(field("h1").value).toBe("Kept");
  });
});

describe("conflict (409): the local edit is KEPT", () => {
  const conflict = { kind: "conflict" as const, slug: "version-conflict", message: "version-conflict", currentHeadVersion: 4, currentContentHash: "h4", updatedAt: "2026-10-10T10:41:00Z" };
  const theirs = detail({ ...SERVICE_FIELDS, h1: "Theirs" }, { version: { n: 4, contentHash: "h4", createdAt: "2026-10-10T10:41:00Z", createdBy: "u2", note: null, blocks: [{ type: "fields", props: { ...SERVICE_FIELDS, h1: "Theirs" } }], seo: { title: "T" } } }, 4);

  it("opens a dialog naming the newer version and its author; Keep editing leaves the draft untouched", async () => {
    a.saveItemAction.mockResolvedValue(conflict);
    a.getItemHeadAction.mockResolvedValue(ok(theirs));
    mount(bundle(detail(SERVICE_FIELDS)));
    type("h1", "Mine");
    await click(saveBtn());
    const dlg = screen.getByTestId("conflict-dialog");
    expect(dlg.textContent).toContain("v4");
    expect(dlg.textContent).toContain("Dewi");
    expect(dlg.textContent).toContain("after the v3 you started from");
    await click(screen.getByRole("button", { name: "Keep editing" }));
    expect(field("h1").value).toBe("Mine");
    expect(status()).toBe("Unsaved changes");
  });

  it("Save mine on top re-saves with the NEW baseVersion and the same local content", async () => {
    a.saveItemAction.mockResolvedValueOnce(conflict).mockResolvedValueOnce(ok(written(5)));
    a.getItemHeadAction.mockResolvedValue(ok(theirs));
    mount(bundle(detail(SERVICE_FIELDS)));
    type("h1", "Mine");
    await click(saveBtn());
    await click(screen.getByTestId("save-mine"));
    expect(a.saveItemAction).toHaveBeenCalledTimes(2);
    expect(a.saveItemAction.mock.calls[1][2].baseVersion).toBe(4);
    expect(a.saveItemAction.mock.calls[1][2].fields).toMatchObject({ h1: "Mine" });
    expect(status()).toBe("Saved v5");
  });

  it("Load theirs replaces the form with the newer version (and says mine was discarded)", async () => {
    a.saveItemAction.mockResolvedValue(conflict);
    a.getItemHeadAction.mockResolvedValue(ok(theirs));
    mount(bundle(detail(SERVICE_FIELDS)));
    type("h1", "Mine");
    await click(saveBtn());
    await click(screen.getByTestId("load-theirs"));
    expect(field("h1").value).toBe("Theirs");
    expect(screen.getByTestId("editor-banner").textContent).toContain("Your previous edits were discarded");
    expect(status()).toBe("No changes");
  });

  it("if 'theirs' cannot be fetched the dialog still opens, keeps the edit, and disables what it cannot do", async () => {
    a.saveItemAction.mockResolvedValue({ ...conflict, currentHeadVersion: null });
    a.getItemHeadAction.mockResolvedValue({ kind: "unavailable", code: "upstream_error", reason: "boom" });
    mount(bundle(detail(SERVICE_FIELDS)));
    type("h1", "Mine");
    await click(saveBtn());
    expect((screen.getByTestId("load-theirs") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("save-mine") as HTMLButtonElement).disabled).toBe(true);
    expect(field("h1").value).toBe("Mine");
  });

  it("other 409s are plain errors, not the conflict dialog", async () => {
    a.saveItemAction.mockResolvedValue({ kind: "conflict", slug: "item-deleted", message: "x", currentHeadVersion: null, currentContentHash: null, updatedAt: null });
    mount(bundle(detail(SERVICE_FIELDS)));
    type("h1", "Mine");
    await click(saveBtn());
    expect(screen.getByTestId("save-error").textContent).toContain("deleted");
    expect(document.querySelector("dialog[open]")).toBeNull();
  });
});

describe("stale: a failed read after a good load", () => {
  it("shows the banner, disables Save and Publish, keeps the draft, and recovers on a good refresh", async () => {
    a.refreshEditorAction.mockResolvedValueOnce({ kind: "unavailable", code: "editorial_unavailable", reason: "editorial_unavailable" });
    mount(bundle(detail(SERVICE_FIELDS)));
    type("h1", "Draft in progress");
    await click(screen.getByTestId("refresh-now"));
    const banner = screen.getByTestId("stale-banner");
    expect(banner.textContent).toContain("Couldn't refresh");
    expect(banner.textContent).toContain("showing what loaded at");
    expect(saveBtn().disabled).toBe(true);
    expect(screen.getByTestId("pb").getAttribute("data-blocked")).toMatch(/Disabled until WebDesk answers again/);
    expect(field("h1").value).toBe("Draft in progress");

    a.refreshEditorAction.mockResolvedValueOnce(ok(bundle(detail({ ...SERVICE_FIELDS, h1: "Server" }, {}, 3), { loadedAt: "2026-10-10T09:00:00Z" })));
    await click(screen.getByTestId("stale-banner").querySelector("button")!);
    expect(screen.queryByTestId("stale-banner")).toBeNull();
    expect(field("h1").value).toBe("Draft in progress"); // a dirty draft is never overwritten by a refresh
  });

  it("a clean form adopts the refreshed record", async () => {
    a.refreshEditorAction.mockResolvedValue(ok(bundle(detail({ ...SERVICE_FIELDS, h1: "Newer" }, {}, 4))));
    mount(bundle(detail(SERVICE_FIELDS)));
    await click(screen.getByTestId("refresh-now"));
    expect(field("h1").value).toBe("Newer");
    expect(screen.getByTestId("pb").getAttribute("data-version")).toBe("4");
  });

  it("a dirty form whose head moved is warned, not overwritten", async () => {
    a.refreshEditorAction.mockResolvedValue(ok(bundle(detail({ ...SERVICE_FIELDS, h1: "Newer" }, {}, 5))));
    mount(bundle(detail(SERVICE_FIELDS)));
    type("h1", "Mine");
    await click(screen.getByTestId("refresh-now"));
    expect(screen.getByTestId("behind-head").textContent).toContain("v5 was saved since you opened this");
    expect(field("h1").value).toBe("Mine");
  });

  it("a write that finds the API down keeps the edits and flips the page to stale", async () => {
    a.saveItemAction.mockResolvedValue({ kind: "unavailable", code: "editorial_unavailable", reason: "editorial_unavailable" });
    mount(bundle(detail(SERVICE_FIELDS)));
    type("h1", "Typed");
    await click(saveBtn());
    expect(screen.getByTestId("save-error").textContent).toContain("Your edits are kept here and nothing was saved");
    expect(screen.getByTestId("stale-banner")).toBeTruthy();
    expect(field("h1").value).toBe("Typed");
  });
});

describe("unconfirmed (502 webdesk_ambiguous): a write whose outcome is unknown", () => {
  const ambiguous: WdResult<never> = { kind: "unavailable", code: "upstream_error", reason: "not_observed" };

  it("says it couldn't confirm the save: not 'Saved', not a plain failure; keeps the edit; writes stay off until a re-read", async () => {
    a.saveItemAction.mockResolvedValue(ambiguous);
    mount(bundle(detail(SERVICE_FIELDS)));
    type("h1", "Typed");
    await click(saveBtn());
    const banner = screen.getByTestId("unconfirmed-banner");
    expect(banner.getAttribute("role")).toBe("alert");
    expect(banner.textContent).toContain("We couldn't confirm the save. Reload to see what happened.");
    expect(status()).toBe("Unsaved changes");            // not "Saved vN"
    expect(screen.queryByTestId("save-error")).toBeNull(); // not the generic failure
    expect(screen.queryByTestId("stale-banner")).toBeNull();
    expect(field("h1").value).toBe("Typed");
    expect(saveBtn().disabled).toBe(true);
    expect(screen.getByTestId("pb").getAttribute("data-blocked")).toMatch(/reload/i);
    expect(a.saveItemAction).toHaveBeenCalledTimes(1);     // never retried blind
  });

  it("Reload re-reads the item: if the save landed the editor says the head moved; either way writes come back", async () => {
    a.saveItemAction.mockResolvedValue(ambiguous);
    mount(bundle(detail(SERVICE_FIELDS)));
    type("h1", "Typed");
    await click(saveBtn());
    a.refreshEditorAction.mockResolvedValue(ok(bundle(detail({ ...SERVICE_FIELDS, h1: "Typed" }, {}, 4))));
    await click(screen.getByTestId("unconfirmed-reload"));
    expect(a.refreshEditorAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("unconfirmed-banner")).toBeNull();
    expect(screen.getByTestId("behind-head").textContent).toContain("v4 was saved since you opened this");
    expect(field("h1").value).toBe("Typed");
    expect(saveBtn().disabled).toBe(false);
  });

  it("a failed reload keeps the notice (nothing is claimed either way)", async () => {
    a.saveItemAction.mockResolvedValue(ambiguous);
    mount(bundle(detail(SERVICE_FIELDS)));
    type("h1", "Typed");
    await click(saveBtn());
    a.refreshEditorAction.mockResolvedValue({ kind: "unavailable", code: "editorial_unavailable", reason: "editorial_unavailable" });
    await click(screen.getByTestId("unconfirmed-reload"));
    expect(screen.getByTestId("unconfirmed-banner")).toBeTruthy();
    expect(saveBtn().disabled).toBe(true);
  });

  it("a delete whose outcome is unknown says the same, not 'Couldn't delete'", async () => {
    a.deleteItemAction.mockResolvedValue(ambiguous);
    mount(bundle(detail(SERVICE_FIELDS, { item: ref({ publishedVersion: null, publishState: "draft" }) })));
    await click(screen.getByRole("button", { name: "Delete draft…" }));
    await click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByTestId("unconfirmed-banner").textContent).toContain("We couldn't confirm the delete. Reload to see what happened.");
    expect(screen.queryByTestId("editor-banner")).toBeNull();
  });

  it("an unknown-outcome create has no Reload button (nothing to re-read yet) but still blocks Create", async () => {
    a.createItemAndOpenAction.mockResolvedValue(ambiguous);
    render(<ItemEditor mode="create" scope={SCOPE} routeBase={ROUTE} collection={coll("service", service)} tenant={tenant} site={site} seed={{ locale: "en", twinOf: null, slug: "", fields: {}, seo: {}, extraBlocks: [] }} authors={{}} readOnlyReason={null} />);
    fireEvent.change(document.querySelector("#wc-slug")!, { target: { value: "service.new" } });
    await click(saveBtn());
    expect(screen.getByTestId("unconfirmed-banner").textContent).toContain("We couldn't confirm the new item. Reload to see what happened.");
    expect(screen.queryByTestId("unconfirmed-reload")).toBeNull();
    expect(saveBtn().disabled).toBe(true);
  });

  it("an ordinary unavailable save is still the stale flow, not the unconfirmed notice", async () => {
    a.saveItemAction.mockResolvedValue({ kind: "unavailable", code: "upstream_error", reason: "http_500" });
    mount(bundle(detail(SERVICE_FIELDS)));
    type("h1", "Typed");
    await click(saveBtn());
    expect(screen.queryByTestId("unconfirmed-banner")).toBeNull();
    expect(screen.getByTestId("stale-banner")).toBeTruthy();
  });
});

describe("placeholders card: an empty list is a claim only when the lint actually ran", () => {
  it("lint ran and found nothing: the all-clear", () => {
    mount(bundle(detail(SERVICE_FIELDS)));
    expect(screen.getByTestId("lint-card").textContent).toContain("No unresolved placeholders.");
    expect(screen.queryByTestId("lint-unavailable")).toBeNull();
  });
  it("lint.unavailable: 'couldn't check', never the all-clear", () => {
    mount(bundle(detail(SERVICE_FIELDS, { lint: { unresolvedTokens: [], markers: {}, unavailable: "the collection's stored composition is invalid" } })));
    const card = screen.getByTestId("lint-card");
    expect(screen.getByTestId("lint-unavailable").textContent).toBe("Couldn't check for placeholders. This is not a statement that there are none.");
    expect(screen.getByTestId("lint-unavailable").getAttribute("role")).toBe("note");
    expect(card.textContent).not.toContain("No unresolved placeholders");
  });
  it("a refresh that comes back with lint.unavailable flips the card; a later good lint flips it back", async () => {
    mount(bundle(detail(SERVICE_FIELDS)));
    a.refreshEditorAction.mockResolvedValueOnce(ok(bundle(detail(SERVICE_FIELDS, { lint: { unresolvedTokens: [], markers: {}, unavailable: "x" } }))));
    await click(screen.getByTestId("refresh-now"));
    expect(screen.getByTestId("lint-unavailable")).toBeTruthy();
    a.refreshEditorAction.mockResolvedValueOnce(ok(bundle(detail(SERVICE_FIELDS))));
    await click(screen.getByTestId("refresh-now"));
    expect(screen.queryByTestId("lint-unavailable")).toBeNull();
    expect(screen.getByTestId("lint-card").textContent).toContain("No unresolved placeholders.");
  });
});

describe("read-only", () => {
  it("a 403 on save turns the whole form read-only, says why, and keeps the typed edit", async () => {
    a.saveItemAction.mockResolvedValue({ kind: "forbidden", reason: "forbidden" });
    mount(bundle(detail(SERVICE_FIELDS)));
    type("h1", "Typed");
    await click(saveBtn());
    expect(screen.getByTestId("readonly-banner").textContent).toContain("You can read this item but not change it");
    expect(field("h1").readOnly).toBe(true);
    expect(field("h1").value).toBe("Typed");
    expect(saveBtn().disabled).toBe(true);
    expect(screen.getByTestId("pb").getAttribute("data-blocked")).toBe("Read-only.");
  });
  it("a server-known reason (deleted item) opens read-only from the start", () => {
    mount(bundle(detail(SERVICE_FIELDS, { item: ref({ deletedAt: "2026-10-10" }) })), { readOnlyReason: "This item has been deleted." });
    expect(screen.getByTestId("readonly-banner").textContent).toContain("deleted");
    expect(field("h1").readOnly).toBe(true);
    expect(saveBtn().disabled).toBe(true);
  });
});

describe("locale-neutral members (id locale)", () => {
  const NAV_ID = { primary: [{ key: "s", label: "Layanan", hub: "Semua", url: "/services/", children: ["/stale/"] }], cta: { label: "Audit ID", url: "/stale-cta/" } };
  const NAV_EN = { primary: [{ key: "s", label: "Services", hub: "All", url: "/services/", children: ["/a/", "/b/"] }], cta: { label: "Audit", url: "/free-audit/" } };
  const navBundle = () => bundle(detail(NAV_ID, { item: ref({ collectionKey: "navigation", locale: "id", slug: "navigation" }) }), { authoritative: { locale: "en", fields: NAV_EN } }, coll("navigation", navigation));

  it("shows the DEFAULT locale's neutral values read-only, keeps localized text editable, and is not dirty from the overlay", () => {
    mount(navBundle());
    expect(field("primary/0/url").readOnly).toBe(true);
    expect(field("primary/0/children/0").value).toBe("/a/"); // en's, not id's stale copy
    expect(field("cta/url").value).toBe("/free-audit/");
    expect(field("primary/0/label").readOnly).toBe(false);
    expect(field("cta/label").readOnly).toBe(false);
    expect(status()).toBe("No changes");
  });

  it("writes the default value through on save", async () => {
    a.saveItemAction.mockResolvedValue(ok(written(2)));
    mount(navBundle());
    type("primary/0/label", "Layanan Kami");
    await click(saveBtn());
    const body = a.saveItemAction.mock.calls[0][2];
    expect((body.fields.primary as { label: string; children: string[] }[])[0]).toMatchObject({ label: "Layanan Kami", children: ["/a/", "/b/"] });
    expect(body.fields.cta).toEqual({ label: "Audit ID", url: "/free-audit/" });
  });

  it("warns when the default-locale copy could not be loaded", () => {
    mount(bundle(detail(NAV_ID, { item: ref({ collectionKey: "navigation", locale: "id" }) }), { authoritativeProblem: "There is no en version yet, so locale-neutral fields show this item's own copy." }, coll("navigation", navigation)));
    expect(screen.getByTestId("authoritative-problem").textContent).toMatch(/no en version yet/);
  });
});

describe("locale tabs", () => {
  it("links an existing twin and offers to create a missing one from the saved version", async () => {
    // Success navigates from the SERVER: the action redirects, so its awaited promise rejects with Next's redirect error
    // and the editor pushes nothing itself (a client push after an action was sometimes dropped).
    a.createItemAndOpenAction.mockRejectedValue(redirected(`${ROUTE}/service/service.seo?locale=id`));
    mount(bundle(detail(SERVICE_FIELDS)));
    const create = screen.getByTestId("create-locale-id");
    expect(create.textContent).toContain("not created");
    await click(create);
    expect(a.createItemAndOpenAction).toHaveBeenCalledWith(SCOPE, expect.objectContaining({ collectionKey: "service", locale: "id", slug: "service.seo", twinOf: "i1", fields: expect.objectContaining({ h1: "SEO Agency" }) }), ROUTE);
    expect(push).not.toHaveBeenCalled();
    expect(screen.queryByTestId("editor-banner")).toBeNull();
  });

  it("a twin that could not be created stays on the page and says why (the typed failure, unchanged)", async () => {
    a.createItemAndOpenAction.mockResolvedValue({ kind: "conflict", slug: "twin-locale-taken", message: "taken", currentHeadVersion: null, currentContentHash: null, updatedAt: null });
    mount(bundle(detail(SERVICE_FIELDS)));
    await click(screen.getByTestId("create-locale-id"));
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByTestId("editor-banner")).toBeTruthy();
  });
});

describe("create mode", () => {
  const seed = { locale: "en", twinOf: null, slug: "", fields: {}, seo: {}, extraBlocks: [] };
  const mountCreate = () => render(<ItemEditor mode="create" scope={SCOPE} routeBase={ROUTE} collection={coll("service", service)} tenant={tenant} site={site} seed={seed} authors={{}} readOnlyReason={null} />);

  it("refuses an invalid slug client-side, inline, without calling the BFF", async () => {
    mountCreate();
    fireEvent.change(document.querySelector("#wc-slug")!, { target: { value: "Bad Slug" } });
    await click(saveBtn());
    expect(a.createItemAndOpenAction).not.toHaveBeenCalled();
    expect(document.querySelector("#wc-slug")?.getAttribute("aria-invalid")).toBe("true");
  });

  it("creates with the typed fields and goes to the new item's editor", async () => {
    a.createItemAndOpenAction.mockRejectedValue(redirected(`${ROUTE}/service/service.new?locale=en`));
    mountCreate();
    fireEvent.change(document.querySelector("#wc-slug")!, { target: { value: "service.new" } });
    type("h1", "New");
    await click(saveBtn());
    expect(a.createItemAndOpenAction).toHaveBeenCalledWith(SCOPE, expect.objectContaining({ collectionKey: "service", locale: "en", slug: "service.new", twinOf: null, fields: expect.objectContaining({ h1: "New" }) }), ROUTE);
    expect(push).not.toHaveBeenCalled(); // the server's redirect navigates, not a client push
  });

  it("slug-taken (409) lands on the slug field", async () => {
    a.createItemAndOpenAction.mockResolvedValue({ kind: "conflict", slug: "slug-taken", message: "x", currentHeadVersion: null, currentContentHash: null, updatedAt: null });
    mountCreate();
    fireEvent.change(document.querySelector("#wc-slug")!, { target: { value: "service.seo" } });
    await click(saveBtn());
    expect(document.querySelector("#wc-slug")?.closest(".wc-field")?.textContent).toContain("already used");
  });
});
