import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

// SCP-5 W5-C5 (BFF §63.30.5, §63.26): the Saved section. The six default categories with what each holds; photos, posts and hashtags can be renamed, moved or hidden but not removed and hold what they hold; a
// company's own categories are added, edited and removed; a save sends the whole `saved` section; a refused field is said beside its control.
const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));
vi.mock("@/lib/socialRulesActions", () => ({ saveRules: vi.fn(), resetRules: vi.fn(), previewRules: vi.fn(), loadRulesHistory: vi.fn() }));

import { resetRules, saveRules } from "@/lib/socialRulesActions";
import type { RulesDoc } from "@/lib/socialRules";
import { RulesSaved } from "./RulesSaved";
import { failure, rulesAnswer, seedDoc } from "./rulesTestKit";

const mount = (over: Parameters<typeof rulesAnswer>[0] = {}) => render(<RulesSaved answer={rulesAnswer(over)} />);
const cat = (n: number) => screen.getByRole("listitem", { name: new RegExp(`^Category ${n}:`) });
const save = () => screen.getByRole("button", { name: "Save saved categories" });
const sent = (): RulesDoc["saved"] => vi.mocked(saveRules).mock.calls[0][2] as RulesDoc["saved"];
const saved = (version: number) => ({ ok: true as const, answer: rulesAnswer({ version }) });

beforeEach(() => vi.clearAllMocks());

describe("the categories", () => {
  it("lists the six defaults with their names and what each holds, and says the three read from elsewhere are fixed", () => {
    mount();
    expect(screen.getAllByRole("listitem", { name: /^Category \d:/ })).toHaveLength(6);
    expect(within(cat(1)).getByLabelText("Name")).toHaveValue("Photos and videos");
    expect(within(cat(1)).getByText(/Holds files and links, and that is fixed\. Also shows the client's design photos\./)).toBeInTheDocument();
    expect(within(cat(2)).getByText(/Holds what it reads from elsewhere, and that is fixed\./)).toBeInTheDocument();
    expect(within(cat(1)).queryByRole("group", { name: "What it holds" })).toBeNull();
    const captions = within(cat(3));
    expect(captions.getByLabelText("Name")).toHaveValue("Captions");
    expect(captions.getByLabelText("Text")).toBeChecked();
    expect(captions.getByLabelText("Files")).not.toBeChecked();
    expect(captions.getByText("Default: text.")).toBeInTheDocument();
    expect(within(cat(6)).getByLabelText("Links")).toBeChecked();
    expect(within(cat(6)).getByLabelText("Files")).toBeChecked();
    expect(within(cat(3)).getByLabelText("Show this category in the menu")).toBeChecked();
    expect(within(cat(3)).getByText("Default: shown")).toBeInTheDocument();
  });
  it("will not remove a category that is read from elsewhere, and says why; removes one of the company's own", async () => {
    vi.mocked(saveRules).mockResolvedValue(saved(1));
    mount();
    const rm = within(cat(1)).getByRole("button", { name: /^Remove category 1,/ });
    expect(rm).toBeDisabled();
    expect(rm).toHaveAttribute("title", "This category is read from elsewhere, so it can be hidden but not removed.");
    fireEvent.click(within(cat(3)).getByRole("button", { name: "Remove category 3, Captions" }));
    fireEvent.click(save());
    await waitFor(() => expect(saveRules).toHaveBeenCalled());
    expect(sent().categories.map((c) => c.key)).toEqual(["photos", "posts", "hashtags", "templates", "references"]);
  });
  it("renames, reorders and hides a category and a hidden category keeps its place", async () => {
    vi.mocked(saveRules).mockResolvedValue(saved(5));
    mount({ version: 4 });
    fireEvent.change(within(cat(1)).getByLabelText("Name"), { target: { value: "Pictures" } });
    fireEvent.click(within(cat(2)).getByLabelText("Show this category in the menu"));
    fireEvent.click(screen.getByRole("button", { name: "Move category 3, Captions up" }));
    fireEvent.click(save());
    await waitFor(() => expect(saveRules).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveRules).mock.calls[0].slice(0, 2)).toEqual(["saved", 4]);
    expect(sent().categories.map((c) => [c.key, c.label, c.enabled])).toEqual([
      ["photos", "Pictures", true], ["captions", "Captions", true], ["posts", "Approved posts", false], ["hashtags", "Hashtag sets", true], ["templates", "Templates", true], ["references", "References", true],
    ]);
    expect(sent().categories[0].holds).toEqual(["asset", "link"]);
    expect(await screen.findByText(/Saved as version 5/)).toBeInTheDocument();
  });
  it("adds a category of its own that holds text, edits what it holds in the server's order, and keeps a key not used", async () => {
    vi.mocked(saveRules).mockResolvedValue(saved(1));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Add a category" }));
    expect(screen.getAllByRole("listitem", { name: /^Category \d:/ })).toHaveLength(7);
    const c7 = within(cat(7));
    fireEvent.change(c7.getByLabelText("Name"), { target: { value: "Competitor ideas" } });
    fireEvent.click(c7.getByLabelText("Links"));
    fireEvent.click(c7.getByLabelText("Files"));
    expect(c7.getByText("A category of your own: there is no default for it.")).toBeInTheDocument();
    fireEvent.click(save());
    await waitFor(() => expect(saveRules).toHaveBeenCalled());
    expect(sent().categories[6]).toEqual({ key: "category", label: "Competitor ideas", holds: ["asset", "link", "text"], enabled: true });
  });
  it("counts the company's own categories, and stops at twelve of them", () => {
    mount();
    expect(screen.getByText("Categories (3 of your own, up to 12)")).toBeInTheDocument();
    for (let i = 0; i < 9; i++) fireEvent.click(screen.getByRole("button", { name: "Add a category" }));
    expect(screen.getByRole("button", { name: "Add a category" })).toBeDisabled();
    expect(screen.getByText("Categories (12 of your own, up to 12)")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem", { name: /^Category \d+:/ })).toHaveLength(15);
  });
  it("is labelled throughout", () => {
    mount();
    for (const c of [...screen.getAllByRole("textbox"), ...screen.getAllByRole("checkbox"), ...screen.getAllByRole("button")]) expect(c).toHaveAccessibleName();
  });
});

describe("a refused field, in words, beside its control", () => {
  it("names a category that holds nothing at its own group, and focuses it", async () => {
    vi.mocked(saveRules).mockResolvedValue(failure("invalid_field", 400, { field: "saved.categories.2.holds" }));
    mount();
    fireEvent.click(within(cat(3)).getByLabelText("Text"));
    fireEvent.click(save());
    const g = await waitFor(() => {
      const x = within(cat(3)).getByRole("group", { name: "What it holds" });
      expect(x).toHaveFocus();
      return x;
    }, { timeout: 4000 });
    expect(g).toHaveTextContent("Category 3, what it holds is not valid. A category must hold something, and photos, posts and hashtags keep what they hold.");
  });
  it("names a category's name at its own box", async () => {
    vi.mocked(saveRules).mockResolvedValue(failure("invalid_field", 400, { field: "saved.categories.0.label" }));
    mount();
    fireEvent.change(within(cat(1)).getByLabelText("Name"), { target: { value: " " } });
    fireEvent.click(save());
    await waitFor(() => expect(within(cat(1)).getByLabelText("Name")).toHaveFocus(), { timeout: 4000 });
    expect(within(cat(1)).getByLabelText("Name")).toHaveAccessibleDescription(/Category 1, the name is not valid\./);
  });
});

describe("409 rules_changed, Reset to default and read-only", () => {
  it("says someone else saved first and lists the person's edits", async () => {
    vi.mocked(saveRules).mockResolvedValue(failure("rules_changed", 409, { detail: { currentVersion: 2 } }));
    mount({ version: 1 });
    fireEvent.change(within(cat(3)).getByLabelText("Name"), { target: { value: "Quotes" } });
    fireEvent.click(save());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Someone else saved the rules first (now version 2), so nothing was saved.");
    expect(alert).toHaveTextContent("Category 3, the name: Captions to Quotes");
  });
  it("resets Saved to the seed behind a confirm", async () => {
    vi.mocked(resetRules).mockResolvedValue(saved(3));
    const s = seedDoc().saved;
    s.categories[2].label = "Quotes";
    mount({ version: 2, rules: { saved: s } });
    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Reset to default" }));
    await waitFor(() => expect(resetRules).toHaveBeenCalledWith("saved", 2));
  });
  it("reads the categories with disabled controls and no Save, Reset or history for a person who may not edit", () => {
    mount({ canEdit: false });
    expect(within(cat(3)).getByLabelText("Name")).toBeDisabled();
    expect(within(cat(3)).getByLabelText("Show this category in the menu")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add a category" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset to default" })).toBeNull();
    expect(screen.queryByText("History of this section")).toBeNull();
  });
});
