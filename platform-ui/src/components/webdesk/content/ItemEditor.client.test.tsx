import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import service from "../../../../e2e/webdesk-stub/compositions/service.json";
import type { CollectionSummary, ItemDetail, ItemWriteResult, ItemRef, TenantRef, SiteRef, WdResult } from "@/lib/webdeskContentModel";
import type { EditorBundle } from "@/lib/webdeskContent";
import type { ClientEditable, ClientModeCfg, EditorDriver } from "@/lib/webdeskEditorDriver";

// WSK-49d — the item editor in CLIENT MODE. A new file on purpose: ItemEditor.test.tsx (the staff editor) runs UNCHANGED.
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
// The staff actions must NEVER be called in client mode: any call to one of these fails the test below.
vi.mock("@/lib/webdeskContentActions", () => ({
  createItemAndOpenAction: vi.fn(), deleteItemAction: vi.fn(), getItemHeadAction: vi.fn(), previewItemAction: vi.fn(), refreshEditorAction: vi.fn(), saveItemAction: vi.fn(),
}));
vi.mock("@/lib/webdeskMediaActions", () => ({
  listMediaAction: vi.fn(), mediaUsageAction: vi.fn(), mintUploadTokenAction: vi.fn(), updateMediaAction: vi.fn(), deleteMediaAction: vi.fn(),
}));
vi.mock("./PublishBar", () => ({ PublishBar: () => <div data-testid="staff-publish-bar" /> }));

import * as A from "@/lib/webdeskContentActions";
import { ItemEditor } from "./ItemEditor";

const SCOPE = { tenantSlug: "gaiada", siteId: "s1" };
const ROUTE = "/portal/website/gaiada/s1";
const ok = <T,>(data: T): WdResult<T> => ({ kind: "ok", data });
const noLint = { unresolvedTokens: [], markers: {} };
const tenant: TenantRef = { slug: "gaiada", status: "active", defaultLocale: "en", locales: ["en", "id"], sites: [] };
const site: SiteRef = { siteId: "s1", name: "gaiada.com", kind: "static", environments: [] };
const coll = (composition: unknown): CollectionSummary => ({ key: "service", composition: composition as never, vocabularyVersion: "1.2.0", counts: { items: 1, byLocale: { en: 1 }, live: 0, pendingChanges: 1 }, updatedAt: "t" });
const ref = (over: Partial<ItemRef> = {}): ItemRef => ({ itemId: "i1", collectionKey: "service", locale: "en", slug: "service.seo", localizationGroupId: "g", headVersion: 3, publishedVersion: 2, publishState: "published", publishAt: null, unpublishAt: null, deletedAt: null, updatedAt: "2026-10-10T08:00:00Z", ...over });
const FIELDS = { url: "/services/seo/", source_path: "content/en/seo.md", template: "service", section: "service", language: "en-GB", h1: "SEO Agency", phase: "L", publish_ready: false, visibility: "shown", plan: { action: "SHOW", why: "core" }, body: "# SEO" };
const SEO = { title: "Agency SEO", description: "The agency's own words." };
const detail = (over: Partial<ItemDetail> = {}, n = 3, by = "u-me"): ItemDetail => ({
  item: ref({ headVersion: n }), version: { n, contentHash: "h", createdAt: "2026-10-10T08:00:00Z", createdBy: by, note: null, blocks: [{ type: "fields", props: FIELDS }, { type: "hero", props: { x: 1 } }], seo: SEO },
  group: [{ locale: "en", itemId: "i1", slug: "service.seo", headVersion: n, publishedVersion: 2, publishState: "published" }], lint: noLint, ...over,
});
const bundle = (d: ItemDetail = detail()): EditorBundle => ({ tenant, site, collection: coll(service), detail: d, authoritative: null, authoritativeProblem: null, pendingRequests: [], pendingProblem: null, build: null, buildProblem: null, loadedAt: "2026-10-10T08:30:00Z" });
const written = (n: number): ItemWriteResult => ({ item: ref({ headVersion: n }), version: { version: n, contentHash: "h", createdAt: "t" }, unchanged: false, lint: noLint, replayed: false });

const EDITABLE: ClientEditable = {
  fields: { h1: true, body: true, plan: false, "plan.action": false, "plan.why": true, url: false, source_path: false, template: false, section: false, language: false, phase: false, publish_ready: false, visibility: false },
  blocks: false, seo: false, create: { allowed: true, reason: null, blockedBy: [] },
};

const driver = (): EditorDriver & { [K in keyof EditorDriver]: ReturnType<typeof vi.fn> } => ({
  refreshEditor: vi.fn(), getItemHead: vi.fn(), saveItem: vi.fn(), createAndOpen: vi.fn(), previewItem: vi.fn(),
}) as never;

let drv: ReturnType<typeof driver>;
const publishSlots: unknown[] = [];

function mount(b: EditorBundle | null, extra: Partial<React.ComponentProps<typeof ItemEditor>> = {}, cfg: Partial<ClientModeCfg> = {}) {
  const clientMode: ClientModeCfg = {
    clientId: "c1", viewerId: "u-me", editable: EDITABLE, driver: drv, mediaDriver: { list: vi.fn(), mintToken: vi.fn(), update: vi.fn() } as never,
    renderPublish: (slot) => { publishSlots.push(slot); return <div data-testid="client-publish" data-dirty={String(slot.dirty)} data-mine={String(slot.headIsMine)} data-author={slot.headAuthor ?? ""} data-blocked={slot.blocked ?? ""} />; },
    ...cfg,
  };
  return render(<ItemEditor mode="edit" scope={SCOPE} routeBase={ROUTE} collection={coll(service)} tenant={tenant} site={site} bundle={b ?? undefined} authors={{ "u-gaia": "Gaia staff" }} readOnlyReason={null} clientMode={clientMode} {...extra} />);
}
const field = (p: string) => document.querySelector(`[data-pointer="/blocks/0/props/${p}"]`) as HTMLInputElement;
const type = (p: string, v: string) => fireEvent.change(field(p), { target: { value: v } });
const saveBtn = () => screen.getByTestId("save") as HTMLButtonElement;
const click = async (el: Element) => { await act(async () => { fireEvent.click(el); }); };
const staff = vi.mocked(A);

beforeEach(() => { cleanup(); drv = driver(); publishSlots.length = 0; push.mockReset(); Object.values(staff).forEach((f) => (f as ReturnType<typeof vi.fn>).mockReset()); });

describe("client mode: what renders", () => {
  it("protected fields are read-only with the reason; the client's own fields edit", () => {
    mount(bundle());
    expect(field("h1").readOnly).toBe(false);
    expect(field("url").readOnly).toBe(true);
    expect(field("url").getAttribute("aria-readonly")).toBe("true");
    expect(screen.getAllByText(/Managed by Gaiada\./).length).toBeGreaterThan(0);
  });

  it("seo is NEVER editable, whatever else is: it shows, read-only, with the reason", () => {
    mount(bundle());
    const t = document.querySelector('[data-pointer="/seo/title"]') as HTMLInputElement;
    expect(t.value).toBe("Agency SEO");
    expect(t.readOnly).toBe(true);
    expect(t.getAttribute("aria-readonly")).toBe("true");
    expect((document.querySelector('[data-pointer="/seo/description"]') as HTMLTextAreaElement).readOnly).toBe(true);
    expect(screen.getByText(/in search results\. Managed by Gaiada\./)).toBeTruthy();
  });

  it("no key / schema / staff jargon: no pointer, no 'vocabulary', no delete, no unpublish, no schedule, no staff publish bar", () => {
    mount(bundle());
    expect(screen.queryByText(/^Delete$/)).toBeNull();
    expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /unpublish/i })).toBeNull();
    expect(screen.queryByText(/schedule/i)).toBeNull();
    expect(screen.queryByTestId("staff-publish-bar")).toBeNull();
    expect(screen.getByTestId("client-publish")).toBeTruthy();
    expect(screen.getByText(/1 more content block on this page is kept as it is; it can't be edited here\./)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/vocabulary|WebDesk|seo\.title/);
    expect(screen.getByText("Latest draft")).toBeTruthy();
  });

  it("a language that does not exist yet is plain text, not a Create button (a twin would copy fields only Gaiada may set)", () => {
    mount(bundle());
    expect(screen.queryByTestId("create-locale-id")).toBeNull();
    expect(screen.getByTestId("missing-locale-id").textContent).toContain("Gaiada adds new languages");
  });

  it("the publishing slot is told who wrote the head: 'mine' for the viewer's own change, with the author's name otherwise", () => {
    mount(bundle(detail({}, 3, "u-me")));
    expect(screen.getByTestId("client-publish").dataset.mine).toBe("true");
    cleanup();
    mount(bundle(detail({}, 3, "u-gaia")));
    expect(screen.getByTestId("client-publish").dataset.mine).toBe("false");
    expect(screen.getByTestId("client-publish").dataset.author).toBe("Gaia staff");
  });
});

describe("client mode: saving sends what §16j's update route expects", () => {
  it("sends { baseVersion, fields, note } and NOTHING else: no seo, no blocks; protected fields go back as they were read", async () => {
    drv.saveItem.mockResolvedValue(ok(written(4)));
    mount(bundle());
    type("h1", "SEO Agency in Bali");
    fireEvent.change(screen.getByLabelText("Change note (optional)"), { target: { value: "tighten" } });
    await click(saveBtn());
    expect(drv.saveItem).toHaveBeenCalledTimes(1);
    const [scope, itemId, input] = drv.saveItem.mock.calls[0];
    expect(scope).toEqual(SCOPE);
    expect(itemId).toBe("i1");
    expect(Object.keys(input).sort()).toEqual(["baseVersion", "fields", "note"]);
    expect(input.baseVersion).toBe(3);
    expect(input.fields.h1).toBe("SEO Agency in Bali");
    expect(input.fields.url).toBe("/services/seo/");
    expect(input.fields.plan).toEqual({ action: "SHOW", why: "core" });
    expect(staff.saveItemAction).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId("save-status").textContent).toBe("Saved v4"));
  });

  it("after a save the viewer IS the head's author, so Publish now becomes available", async () => {
    drv.saveItem.mockResolvedValue(ok(written(4)));
    mount(bundle(detail({}, 3, "u-gaia")));
    expect(screen.getByTestId("client-publish").dataset.mine).toBe("false");
    type("h1", "Mine");
    await click(saveBtn());
    await waitFor(() => expect(screen.getByTestId("client-publish").dataset.mine).toBe("true"));
  });
});

describe("client mode: refusals are states, in the client's words (never raw JSON)", () => {
  async function failWith(r: WdResult<never>) {
    drv.saveItem.mockResolvedValue(r);
    mount(bundle());
    type("h1", "Edited");
    await click(saveBtn());
  }

  it("409 version-conflict: the owner's words, a Reload button, and the unsaved text stays on screen to copy", async () => {
    await failWith({ kind: "conflict", slug: "version-conflict", message: "m", currentHeadVersion: 5, currentContentHash: null, updatedAt: null });
    const box = await screen.findByTestId("client-conflict");
    expect(box.textContent).toContain("This page changed since you opened it. Reload to see the latest, then make your change again.");
    expect(box.getAttribute("role")).toBe("alert");
    expect(screen.getByTestId("client-conflict-reload")).toBeTruthy();
    expect(field("h1").value).toBe("Edited"); // the user's text is still there
    expect(saveBtn().disabled).toBe(true); // saving again would just conflict again
    expect(screen.queryByTestId("conflict-dialog")?.hasAttribute("open") ?? false).toBe(false); // the staff "save mine on top" dialog never opens
  });

  it("Reload replaces the draft with the latest version and clears the banner", async () => {
    await failWith({ kind: "conflict", slug: "version-conflict", message: "m", currentHeadVersion: 5, currentContentHash: null, updatedAt: null });
    const latest = detail({}, 5, "u-gaia");
    latest.version.blocks = [{ type: "fields", props: { ...FIELDS, h1: "Gaiada changed it" } }];
    drv.refreshEditor.mockResolvedValue(ok({ ...bundle(latest), loadedAt: "2026-10-10T09:00:00Z" }));
    await click(await screen.findByTestId("client-conflict-reload"));
    await waitFor(() => expect(screen.queryByTestId("client-conflict")).toBeNull());
    expect(field("h1").value).toBe("Gaiada changed it");
    expect(screen.getByTestId("editor-banner").textContent).toMatch(/Reloaded the latest version \(v5\)/);
    expect(saveBtn().disabled).toBe(true); // clean again
  });

  it("a Reload that fails keeps the draft and says so in words", async () => {
    await failWith({ kind: "conflict", slug: "version-conflict", message: "m", currentHeadVersion: 5, currentContentHash: null, updatedAt: null });
    drv.refreshEditor.mockResolvedValue({ kind: "unavailable", code: "editorial_unavailable", reason: "circuit_open" });
    await click(await screen.findByTestId("client-conflict-reload"));
    expect((await screen.findByTestId("editor-banner")).textContent).toContain("Couldn't reach the website service.");
    expect(screen.getByTestId("client-conflict")).toBeTruthy();
    expect(field("h1").value).toBe("Edited");
  });

  it("422 field-not-client-editable: names the fields in plain words, keeps the edits, shows no pointer", async () => {
    await failWith({ kind: "invalid", slug: "field-not-client-editable", message: "A client editor may not ...", issues: [{ path: "/blocks/0/props/template", message: "x" }, { path: "/seo", message: "y" }] });
    const err = await screen.findByTestId("save-error");
    expect(err.textContent).toContain("These can only be changed by Gaiada: Template; Search appearance (SEO).");
    expect(err.textContent).not.toContain("/blocks");
    expect(field("h1").value).toBe("Edited");
  });

  it("422 about the CONTENT (no §16j slug) is the usual inline, per-field error", async () => {
    await failWith({ kind: "invalid", issues: [{ path: "/blocks/0/props/h1", message: "h1 is required" }], message: "refused" });
    expect(await screen.findByTestId("save-error")).toBeTruthy();
    expect(screen.getAllByText(/h1 is required/).length).toBeGreaterThan(0);
  });

  it("409 item-deleted is its own sentence", async () => {
    await failWith({ kind: "conflict", slug: "item-deleted", message: "m", currentHeadVersion: null, currentContentHash: null, updatedAt: null });
    expect((await screen.findByTestId("save-error")).textContent).toBe("This page has been deleted, so it can't be changed or published.");
  });

  it("403 turns the form read-only with the client's own sentence", async () => {
    await failWith({ kind: "forbidden", reason: "forbidden" });
    await screen.findByTestId("readonly-banner");
    expect(screen.getByTestId("readonly-banner").textContent).toContain("You don't have website editing access. Ask your company's admin.");
    expect(field("h1").readOnly).toBe(true);
  });

  it("an unknown-outcome write (502 webdesk_ambiguous) is neither saved nor failed: 'couldn't confirm', writes stay off, edits stay", async () => {
    await failWith({ kind: "unavailable", code: "upstream_error", reason: "not_observed" });
    expect((await screen.findByTestId("unconfirmed-banner")).textContent).toContain("We couldn't confirm the save.");
    expect(saveBtn().disabled).toBe(true);
    expect(field("h1").value).toBe("Edited");
  });

  it("an unreachable service is the stale state: Save and publish off, plain words, no raw reason", async () => {
    await failWith({ kind: "unavailable", code: "editorial_unavailable", reason: "circuit_open" });
    expect((await screen.findByTestId("save-error")).textContent).toContain("Couldn't reach the website service.");
    const stale = await screen.findByTestId("stale-banner");
    expect(stale.textContent).toContain("the website service answers again");
    expect(stale.textContent).not.toContain("circuit_open");
    expect(stale.textContent).not.toContain("WebDesk");
  });
});

describe("client mode: create", () => {
  const seed = { locale: "en", twinOf: null, slug: "", fields: {}, seo: {}, extraBlocks: [] };

  it("sends only the client's own fields (nothing protected, no seo, no twinOf) and lets the SERVER open the new page", async () => {
    drv.createAndOpen.mockResolvedValue({ kind: "invalid", issues: [], message: "x" });
    cleanup();
    render(<ItemEditor mode="create" scope={SCOPE} routeBase={ROUTE} collection={coll(service)} tenant={tenant} site={site} seed={seed} authors={{}} readOnlyReason={null}
      clientMode={{ clientId: "c1", viewerId: "u-me", editable: EDITABLE, driver: drv, mediaDriver: { list: vi.fn(), mintToken: vi.fn(), update: vi.fn() } as never, renderPublish: () => null }} />);
    fireEvent.change(document.getElementById("wc-slug")!, { target: { value: "service.new-page" } });
    type("h1", "Brand new");
    await click(saveBtn());
    expect(drv.createAndOpen).toHaveBeenCalledTimes(1);
    const [scope, input, routeBase] = drv.createAndOpen.mock.calls[0];
    expect(scope).toEqual(SCOPE);
    expect(routeBase).toBe(ROUTE);
    expect(input).toEqual({ collectionKey: "service", locale: "en", slug: "service.new-page", twinOf: null, fields: { body: "", h1: "Brand new" }, blocks: [], note: "" });
    expect("seo" in input).toBe(false);
    expect(staff.createItemAndOpenAction).not.toHaveBeenCalled();
  });

  it("a create refused for fields only Gaiada can fill says so in words", async () => {
    drv.createAndOpen.mockResolvedValue({ kind: "invalid", slug: "field-not-client-editable", message: "m", issues: [{ path: "/blocks/0/props/template", message: "x" }] });
    cleanup();
    render(<ItemEditor mode="create" scope={SCOPE} routeBase={ROUTE} collection={coll(service)} tenant={tenant} site={site} seed={seed} authors={{}} readOnlyReason={null}
      clientMode={{ clientId: "c1", viewerId: "u-me", editable: EDITABLE, driver: drv, mediaDriver: { list: vi.fn(), mintToken: vi.fn(), update: vi.fn() } as never, renderPublish: () => null }} />);
    fireEvent.change(document.getElementById("wc-slug")!, { target: { value: "service.new-page" } });
    type("h1", "Brand new");
    await click(saveBtn());
    expect((await screen.findByTestId("save-error")).textContent).toMatch(/Nothing was created\. These can only be changed by Gaiada: Template/);
    expect(screen.getByText(/Used in the page's address/)).toBeTruthy();
  });
});

describe("client mode: preview is the portal's, not the staff action", () => {
  it("Preview calls the driver (the saved head), and the staff preview action is never called", async () => {
    drv.previewItem.mockResolvedValue({ kind: "conflict", slug: "preview_page_missing", message: "m", currentHeadVersion: null, currentContentHash: null, updatedAt: null });
    mount(bundle());
    await click(screen.getByTestId("preview"));
    expect(drv.previewItem).toHaveBeenCalledWith(SCOPE, "i1", 3);
    expect(staff.previewItemAction).not.toHaveBeenCalled();
    // the "this site doesn't have a preview page yet" state the staff editor already has
    expect((await screen.findByTestId("preview-notice")).textContent).toContain("This site doesn't have a preview page yet.");
  });
});

describe("client mode: the staff calls are never used", () => {
  it("a refresh goes to the driver", async () => {
    drv.refreshEditor.mockResolvedValue(ok(bundle()));
    mount(bundle());
    await click(screen.getByTestId("refresh-now"));
    expect(drv.refreshEditor).toHaveBeenCalledWith(SCOPE, "service", "service.seo", "en");
    expect(staff.refreshEditorAction).not.toHaveBeenCalled();
  });
});
