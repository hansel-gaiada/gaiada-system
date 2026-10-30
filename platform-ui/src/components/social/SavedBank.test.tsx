import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

// SCP-5e (BFF §63.26): the content bank's two interactive pieces. "Add to the bank": the form's own checks name a mistake before any request, the body is the server's own shape (a video is a Drive link),
// and a refusal is said in words with who may. An item's card: edit sends only what changed, delete asks first, and a refusal (403 not_officer_or_approver, 404) is said beside the control.
const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));
vi.mock("@/lib/socialSavedActions", () => ({ addSavedItem: vi.fn(), updateSavedItem: vi.fn(), deleteSavedItem: vi.fn() }));

import { addSavedItem, deleteSavedItem, updateSavedItem } from "@/lib/socialSavedActions";
import { asCollections, asSavedItem, savedRefusalText, SAVED_ADD_REASON, SAVED_CHANGE_REASON } from "@/lib/socialSaved";
import { REFUSAL_WORDS } from "@/lib/socialPipeline";
import { SavedAddForm } from "./SavedAddForm";
import { SavedItemCard } from "./SavedItemCard";

const COLS = asCollections({
  collections: [
    { key: "photos", label: "Photos and videos", holds: ["asset", "link"], derived: true, count: 0, previews: [] },
    { key: "posts", label: "Approved posts", holds: [], derived: true, count: 0, previews: [] },
    { key: "captions", label: "Captions", holds: ["text"], derived: false, count: 0, previews: [] },
  ],
  canAdd: true,
}).collections;
const ASSETS = [{ groupId: "g1", versionId: "v1", versionNo: 2, name: "Autumn hero" }];
const mountAdd = (o: Partial<React.ComponentProps<typeof SavedAddForm>> = {}) =>
  render(<SavedAddForm engagementId="e1" collections={COLS} canAdd pillars={["Behind the scenes", "Product stories"]} assets={ASSETS} initialCategory="captions" {...o} />);
const created = (title = "T", created = true) => ({ ok: true as const, created, item: asSavedItem({ id: "i1", category: "captions", holds: "text", title, body: "B" }) });
const refused = (status: number, error: string, kind: "add" | "change" | "delete", field?: string) => {
  const refusal = { status, error, ...(field ? { field } : {}) };
  return { ok: false as const, refusal, message: savedRefusalText(refusal, kind) };
};

/** Clicks a button once it is back and enabled (a write in flight disables it and changes its label). */
const press = async (name: string) => {
  const b = await screen.findByRole("button", { name });
  await waitFor(() => expect(b).toBeEnabled());
  fireEvent.click(b);
};

beforeEach(() => { vi.clearAllMocks(); });

describe("SavedAddForm", () => {
  it("says who may add, and draws no form, when the server says canAdd is false", () => {
    mountAdd({ canAdd: false });
    expect(screen.queryByRole("form", { name: "Add to the content bank" })).toBeNull();
    expect(screen.getByText(new RegExp(SAVED_ADD_REASON))).toBeInTheDocument();
  });
  it("offers only the collections that store something (never approved posts or hashtag sets)", () => {
    mountAdd();
    const options = [...(screen.getByLabelText("Collection") as HTMLSelectElement).options].map((o) => o.textContent);
    expect(options).toEqual(["Photos and videos", "Captions"]);
  });
  it("adds a text with a fresh id, then says so and refreshes the page", async () => {
    vi.mocked(addSavedItem).mockResolvedValue(created("Sale ends"));
    mountAdd();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: " Sale ends " } });
    fireEvent.change(screen.getByLabelText("Text"), { target: { value: "Last day, come in." } });
    fireEvent.click(screen.getByRole("button", { name: "Save to the bank" }));
    expect(await screen.findByRole("status")).toHaveTextContent('Saved "Sale ends".');
    const [eng, body] = vi.mocked(addSavedItem).mock.calls[0];
    expect(eng).toBe("e1");
    expect(body).toMatchObject({ category: "captions", holds: "text", title: "Sale ends", body: "Last day, come in." });
    expect(body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4/);
    expect(refresh).toHaveBeenCalled();
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("");
  });
  it("a video is a Drive link: the form says so, and the body carries the link, its source and that it is a video", async () => {
    vi.mocked(addSavedItem).mockResolvedValue(created("Walkthrough"));
    mountAdd({ initialCategory: "photos" });
    expect(screen.getByText(/Videos are kept as a Drive link: the Asset Library stores images only/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Walkthrough" } });
    fireEvent.change(screen.getByLabelText("Link"), { target: { value: "https://drive.example.com/walk" } });
    fireEvent.change(screen.getByLabelText("It points at"), { target: { value: "video" } });
    fireEvent.change(screen.getByLabelText("Where it comes from"), { target: { value: "own" } });
    fireEvent.click(screen.getByRole("button", { name: "Save to the bank" }));
    await waitFor(() => expect(addSavedItem).toHaveBeenCalled());
    expect(vi.mocked(addSavedItem).mock.calls[0][1]).toMatchObject({ category: "photos", holds: "link", url: "https://drive.example.com/walk", media: "video", source: "own" });
  });
  it("a link made with AI asks for its note, and a bad link is named before any request", () => {
    mountAdd({ initialCategory: "photos" });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Reel" } });
    fireEvent.change(screen.getByLabelText("Link"), { target: { value: "ftp://nope" } });
    fireEvent.change(screen.getByLabelText("Where it comes from"), { target: { value: "ai" } });
    fireEvent.click(screen.getByRole("button", { name: "Save to the bank" }));
    expect(screen.getByRole("alert")).toHaveTextContent("The link must start with http:// or https://");
    fireEvent.change(screen.getByLabelText("Link"), { target: { value: "https://a.example/x" } });
    fireEvent.click(screen.getByRole("button", { name: "Save to the bank" }));
    expect(screen.getByRole("alert")).toHaveTextContent("a link made with AI needs a note");
    expect(screen.getByLabelText("AI note")).toBeInTheDocument();
    expect(addSavedItem).not.toHaveBeenCalled();
  });
  it("keeps an Asset Library photo by its group, and says when the library cannot be read or has nothing", async () => {
    vi.mocked(addSavedItem).mockResolvedValue(created("Autumn hero", false));
    const a = mountAdd({ initialCategory: "photos" });
    fireEvent.change(screen.getByLabelText("What you are saving"), { target: { value: "asset" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Autumn hero" } });
    fireEvent.change(screen.getByLabelText("Asset Library photo"), { target: { value: "g1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save to the bank" }));
    expect(await screen.findByRole("status")).toHaveTextContent("was already in the bank, so nothing new was added");
    expect(vi.mocked(addSavedItem).mock.calls[0][1]).toMatchObject({ holds: "asset", assetGroupId: "g1" });
    a.unmount();
    mountAdd({ initialCategory: "photos", assets: null });
    fireEvent.change(screen.getByLabelText("What you are saving"), { target: { value: "asset" } });
    expect(screen.getByRole("status")).toHaveTextContent("The Asset Library could not be read just now");
    expect(screen.getByRole("button", { name: "Save to the bank" })).toBeDisabled();
  });
  it("says a refusal in words, naming who may add, and does not refresh", async () => {
    vi.mocked(addSavedItem).mockResolvedValue(refused(403, "forbidden", "add"));
    mountAdd();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "T" } });
    fireEvent.change(screen.getByLabelText("Text"), { target: { value: "B" } });
    fireEvent.click(screen.getByRole("button", { name: "Save to the bank" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(`You cannot do this. ${SAVED_ADD_REASON}`);
    expect(refresh).not.toHaveBeenCalled();
    vi.mocked(addSavedItem).mockResolvedValue(refused(404, "asset_not_found", "add"));
    await press("Save to the bank");
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(REFUSAL_WORDS.asset_not_found));
  });
});

describe("SavedItemCard", () => {
  const item = (o: Record<string, unknown> = {}) => asSavedItem({
    id: "i1", category: "captions", holds: "text", title: "Opener", body: "The harvest is in.", pillar: "Product stories", useCount: 0, used: false,
    addedBy: { id: "u-copy", name: "Citra" }, addedAt: "2026-10-10T00:00:00Z", ...o,
  });
  const mount = (i = item(), viewerId = "u-1") => render(<SavedItemCard item={i} viewerId={viewerId} pillars={["Behind the scenes", "Product stories"]} collections={COLS} />);

  it("says who may change an item that is not the viewer's own, and marks the viewer's", () => {
    mount();
    expect(screen.getByText(SAVED_CHANGE_REASON)).toBeInTheDocument();
    expect(screen.getByText(/Added by Citra on /)).toBeInTheDocument();
    mount(item(), "u-copy");
    expect(screen.getByText(/Added by Citra \(you\)/)).toBeInTheDocument();
  });
  it("edits: only what changed is sent, and the form closes and the page refreshes", async () => {
    vi.mocked(updateSavedItem).mockResolvedValue({ ok: true });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Harvest opener" } });
    fireEvent.change(screen.getByLabelText("Pillar"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateSavedItem).toHaveBeenCalledWith("i1", { title: "Harvest opener", pillar: null }));
    expect(refresh).toHaveBeenCalled();
  });
  it("names a mistake, and a change that is none, before any request", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Nothing has changed.");
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Give it a title.");
    expect(updateSavedItem).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "Edit Opener" })).toBeNull();
  });
  it("an edit the server refuses (another member) says who may, beside the control, and the form stays open", async () => {
    vi.mocked(updateSavedItem).mockResolvedValue(refused(403, "not_officer_or_approver", "change"));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "New" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(REFUSAL_WORDS.not_officer_or_approver);
    expect(screen.getByRole("form", { name: "Edit Opener" })).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });
  it("delete asks first; 'Keep it' sends nothing; 'Yes, delete it' deletes and refreshes", async () => {
    vi.mocked(deleteSavedItem).mockResolvedValue({ ok: true });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const group = screen.getByRole("group", { name: "Delete Opener" });
    fireEvent.click(within(group).getByRole("button", { name: "Keep it" }));
    expect(deleteSavedItem).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete it" }));
    await waitFor(() => expect(deleteSavedItem).toHaveBeenCalledWith("i1"));
    expect(refresh).toHaveBeenCalled();
  });
  it("a delete the server refuses, or an item already gone, is said in words", async () => {
    vi.mocked(deleteSavedItem).mockResolvedValueOnce(refused(403, "not_officer_or_approver", "delete"));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete it" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(REFUSAL_WORDS.not_officer_or_approver);
    vi.mocked(deleteSavedItem).mockResolvedValueOnce(refused(404, "saved_item_not_found", "delete"));
    await press("Yes, delete it");
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(REFUSAL_WORDS.saved_item_not_found));
    expect(refresh).not.toHaveBeenCalled();
  });
  it("a link made with AI shows its note; a link edit asks for the note when the source becomes AI; an item left under Other can be moved", async () => {
    vi.mocked(updateSavedItem).mockResolvedValue({ ok: true });
    mount(item({ holds: "link", body: null, url: "https://a.example", source: "own", category: "photos", title: "Ref" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Where it comes from"), { target: { value: "ai" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent("a link made with AI needs a note");
    fireEvent.change(screen.getByLabelText("AI note"), { target: { value: "Made with a model." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateSavedItem).toHaveBeenCalledWith("i1", { source: "ai", aiNote: "Made with a model." }));
    document.body.innerHTML = "";
    mount(item({ category: "retired", title: "Orphan" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Move to"), { target: { value: "captions" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateSavedItem).toHaveBeenLastCalledWith("i1", { category: "captions" }));
  });
});
