import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

// SCP-5 W5-C5 (BFF §63.30.5, §63.28.1): the Audit scorecard section. Dimensions, bands and the benchmark with the default beside each; a save sends the whole `audit` section; a refused field is said beside its
// control; the preview scores a chosen client under the unsaved scorecard.
const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));
vi.mock("@/lib/socialRulesActions", () => ({ saveRules: vi.fn(), resetRules: vi.fn(), previewRules: vi.fn(), loadRulesHistory: vi.fn() }));

import { previewRules, resetRules, saveRules } from "@/lib/socialRulesActions";
import { asPreview, type RulesDoc } from "@/lib/socialRules";
import { RulesAudit } from "./RulesAudit";
import { CLIENTS, failure, rulesAnswer, seedDoc } from "./rulesTestKit";

const mount = (over: Parameters<typeof rulesAnswer>[0] = {}, clients: typeof CLIENTS | null = CLIENTS) => render(<RulesAudit answer={rulesAnswer(over)} clients={clients} />);
const dim = (n: number) => screen.getByRole("listitem", { name: new RegExp(`^Dimension ${n}:`) });
const band = (n: number) => screen.getByRole("listitem", { name: new RegExp(`^Band ${n}:`) });
const save = () => screen.getByRole("button", { name: "Save scorecard" });
const sent = (): RulesDoc["audit"] => vi.mocked(saveRules).mock.calls[0][2] as RulesDoc["audit"];
const saved = (version: number) => ({ ok: true as const, answer: rulesAnswer({ version }) });

beforeEach(() => vi.clearAllMocks());

describe("the scorecard", () => {
  it("lists the twelve dimensions, the three bands and the benchmark, each with the default beside it", () => {
    mount();
    expect(screen.getAllByRole("listitem", { name: /^Dimension \d+:/ })).toHaveLength(12);
    expect(screen.getAllByRole("listitem", { name: /^Band \d:/ })).toHaveLength(3);
    const d1 = within(dim(1));
    expect(d1.getByLabelText("Name")).toHaveValue("Posting consistency");
    expect(d1.getByLabelText("Weight")).toHaveValue(1);
    expect(d1.getByLabelText("Where its score comes from")).toHaveValue("consistency");
    expect(d1.getByText("Default: Automatic: posting consistency")).toBeInTheDocument();
    expect(within(dim(7)).getByLabelText("Where its score comes from")).toHaveValue("typed");
    expect(within(band(1)).getByLabelText("From a score of")).toHaveValue(75);
    expect(within(band(2)).getByText("Default: 50")).toBeInTheDocument();
    expect(screen.getByLabelText("Benchmark")).toHaveValue("own_clients_median");
    expect(screen.getByText("Default: The median of our own clients")).toBeInTheDocument();
  });
  it("marks an automatic source another dimension already uses, in words", () => {
    mount();
    const opts = within(within(dim(7)).getByLabelText("Where its score comes from")).getAllByRole("option").map((o) => o.textContent);
    expect(opts).toContain("Automatic: reels (used by another dimension)");
    expect(opts).toContain("Typed by the person scoring");
    const own = within(within(dim(4)).getByLabelText("Where its score comes from")).getAllByRole("option").map((o) => o.textContent);
    expect(own).toContain("Automatic: reels");
  });
  it("saves a changed weight, a retitled band and a typed benchmark as the server's shapes", async () => {
    vi.mocked(saveRules).mockResolvedValue(saved(2));
    mount({ version: 1 });
    fireEvent.change(within(dim(1)).getByLabelText("Weight"), { target: { value: "2.5" } });
    fireEvent.change(within(dim(7)).getByLabelText("Advice shown when it scores low"), { target: { value: "Tidy the bio." } });
    fireEvent.change(within(band(2)).getByLabelText("From a score of"), { target: { value: "60" } });
    fireEvent.change(within(band(3)).getByLabelText("Name"), { target: { value: "Start here" } });
    fireEvent.change(screen.getByLabelText("Benchmark"), { target: { value: "typed" } });
    fireEvent.change(screen.getByLabelText("General: engagement rate"), { target: { value: "0.05" } });
    fireEvent.change(screen.getByLabelText("Add a business type"), { target: { value: "Restaurant" } });
    fireEvent.click(screen.getByRole("button", { name: "Add the business type" }));
    fireEvent.click(save());
    await waitFor(() => expect(saveRules).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveRules).mock.calls[0].slice(0, 2)).toEqual(["audit", 1]);
    const v = sent();
    expect(v.dimensions[0].weight).toBe(2.5);
    expect(v.dimensions[6].advice).toBe("Tidy the bio.");
    expect(v.bands.map((b) => [b.key, b.from, b.label])).toEqual([["strong", 75, "Strong"], ["fair", 60, "Fair"], ["needs_work", 0, "Start here"]]);
    expect(v.benchmark).toEqual({ source: "typed", rates: { General: 0.05, Restaurant: 0.03 } });
    expect(await screen.findByText(/Saved as version 2/)).toBeInTheDocument();
  });
  it("goes back to the median of our own clients with no rates left in the value", async () => {
    vi.mocked(saveRules).mockResolvedValue(saved(2));
    const a = seedDoc().audit;
    a.benchmark = { source: "typed", rates: { Cafe: 0.04, Bakery: 0.02 } };
    mount({ version: 1, rules: { audit: a } });
    expect(screen.getByLabelText("Cafe: engagement rate")).toHaveValue(0.04);
    fireEvent.click(screen.getByRole("button", { name: "Remove the rate for Cafe" }));
    expect(screen.getByRole("button", { name: "Remove the rate for Bakery" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Benchmark"), { target: { value: "own_clients_median" } });
    fireEvent.click(save());
    await waitFor(() => expect(saveRules).toHaveBeenCalled());
    expect(sent().benchmark).toEqual({ source: "own_clients_median" });
  });
  it("will not add a business type twice or an empty one", () => {
    const a = seedDoc().audit;
    a.benchmark = { source: "typed", rates: { Cafe: 0.04 } };
    mount({ version: 1, rules: { audit: a } });
    const add = screen.getByRole("button", { name: "Add the business type" });
    expect(add).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Add a business type"), { target: { value: " Cafe " } });
    expect(add).toBeDisabled();
    expect(screen.getByText("That business type already has a rate.")).toBeInTheDocument();
  });
  it("adds a dimension with a fresh key, and removes and moves one; up to twenty and never fewer than one", async () => {
    vi.mocked(saveRules).mockResolvedValue(saved(1));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Add a dimension" }));
    expect(screen.getAllByRole("listitem", { name: /^Dimension \d+:/ })).toHaveLength(13);
    fireEvent.change(within(dim(13)).getByLabelText("Name"), { target: { value: "Link in bio" } });
    fireEvent.click(screen.getByRole("button", { name: "Move dimension 13, Link in bio up" }));
    fireEvent.click(screen.getByRole("button", { name: /^Remove dimension 1, Posting consistency$/ }));
    fireEvent.click(save());
    await waitFor(() => expect(saveRules).toHaveBeenCalled());
    const keys = sent().dimensions.map((d) => d.key);
    expect(keys).toHaveLength(12);
    expect(keys[11]).toBe("cross_platform");
    expect(keys[10]).toBe("dimension");
    expect(new Set(keys).size).toBe(12);
    for (let i = 0; i < 8; i++) fireEvent.click(screen.getByRole("button", { name: "Add a dimension" }));
    expect(screen.getByRole("button", { name: "Add a dimension" })).toBeDisabled();
    expect(screen.getByText("Dimensions (20 of 20)")).toBeInTheDocument();
  });
  it("says a dimension of your own has no default", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Add a dimension" }));
    expect(within(dim(13)).getByText("A dimension of your own: there is no default for it.")).toBeInTheDocument();
  });
  it("adds bands up to five and keeps at least two", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Add a band" }));
    fireEvent.click(screen.getByRole("button", { name: "Add a band" }));
    expect(screen.getByRole("button", { name: "Add a band" })).toBeDisabled();
    expect(screen.getByText("Bands (5 of 5)")).toBeInTheDocument();
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole("button", { name: /^Remove band 1,/ }));
    expect(screen.getAllByRole("listitem", { name: /^Band \d:/ })).toHaveLength(2);
    expect(screen.getByRole("button", { name: /^Remove band 1,/ })).toBeDisabled();
  });
  it("is labelled throughout", () => {
    mount();
    for (const c of [...screen.getAllByRole("combobox"), ...screen.getAllByRole("textbox"), ...screen.getAllByRole("spinbutton"), ...screen.getAllByRole("button")]) expect(c).toHaveAccessibleName();
  });
});

describe("a refused field, in words, beside its control", () => {
  it("names a dimension's weight and focuses it", async () => {
    vi.mocked(saveRules).mockResolvedValue(failure("invalid_field", 400, { field: "audit.dimensions.2.weight" }));
    mount();
    fireEvent.change(within(dim(3)).getByLabelText("Weight"), { target: { value: "11" } });
    fireEvent.click(save());
    const box = within(dim(3)).getByLabelText("Weight");
    await waitFor(() => expect(box).toHaveFocus());
    expect(box).toHaveAccessibleDescription(/Dimension 3, the weight is not valid\. A weight is 0 to 10, with at most two decimals\./);
  });
  it("names the bands as a group when their order is refused", async () => {
    vi.mocked(saveRules).mockResolvedValue(failure("invalid_field", 400, { field: "audit.bands" }));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Add a band" }));
    fireEvent.click(save());
    const g = await screen.findByRole("group", { name: /^Bands \(4 of 5\)/ });
    await waitFor(() => expect(g).toHaveFocus());
    expect(g).toHaveTextContent("The bands must run from the highest starting score down, each starting lower than the one before, and the last one must start at 0.");
  });
  it("names a typed rate in words", async () => {
    vi.mocked(saveRules).mockResolvedValue(failure("invalid_field", 400, { field: "audit.benchmark.rates.Cafe" }));
    const a = seedDoc().audit;
    a.benchmark = { source: "typed", rates: { Cafe: 0.04 } };
    mount({ version: 1, rules: { audit: a } });
    fireEvent.change(screen.getByLabelText("Cafe: engagement rate"), { target: { value: "4" } });
    fireEvent.click(save());
    await waitFor(() => expect(screen.getByLabelText("Cafe: engagement rate")).toHaveFocus(), { timeout: 4000 });
    expect(screen.getByLabelText("Cafe: engagement rate")).toHaveAccessibleDescription(/is not valid\. A typed rate is a fraction from 0 to 1/);
  });
});

describe("409 rules_changed, Reset to default and read-only", () => {
  it("says someone else saved first and lists the person's edits", async () => {
    vi.mocked(saveRules).mockResolvedValue(failure("rules_changed", 409, { detail: { currentVersion: 8 } }));
    mount({ version: 7 });
    fireEvent.change(within(dim(1)).getByLabelText("Weight"), { target: { value: "3" } });
    fireEvent.click(save());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Someone else saved the rules first (now version 8), so nothing was saved.");
    expect(alert).toHaveTextContent("Dimension 1, the weight: 1 to 3");
  });
  it("resets to the seed behind a confirm", async () => {
    vi.mocked(resetRules).mockResolvedValue(saved(3));
    const a = seedDoc().audit;
    a.bands[1].from = 40;
    mount({ version: 2, rules: { audit: a } });
    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Reset to default" }));
    await waitFor(() => expect(resetRules).toHaveBeenCalledWith("audit", 2));
  });
  it("reads the scorecard with disabled controls and no Save, Reset, Add or preview for a person who may not edit", () => {
    mount({ canEdit: false });
    expect(within(dim(1)).getByLabelText("Weight")).toBeDisabled();
    expect(screen.getByLabelText("Benchmark")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add a dimension" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset to default" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Preview a client's score" })).toBeNull();
  });
});

describe("the preview of a client's score", () => {
  const scored = asPreview({
    section: "audit", engagementId: "e1",
    audit: { month: "2026-09", overall: 62, band: "fair", bandLabel: "Fair", scored: 6, total: 12, dimensions: [{ key: "consistency", label: "Posting consistency", weight: 1, used: 3.5 }, { key: "profile", label: "Profile, bio and link", weight: 1, used: null }] },
  });
  it("needs a client, then scores the unsaved scorecard and saves nothing", async () => {
    vi.mocked(previewRules).mockResolvedValue({ ok: true, preview: scored });
    mount();
    const btn = screen.getByRole("button", { name: "Preview a client's score" });
    expect(btn).toBeDisabled();
    fireEvent.change(within(dim(1)).getByLabelText("Weight"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("For client"), { target: { value: "e1" } });
    fireEvent.click(btn);
    await waitFor(() => expect(previewRules).toHaveBeenCalledTimes(1));
    const [section, value, client] = vi.mocked(previewRules).mock.calls[0];
    expect([section, client]).toEqual(["audit", "e1"]);
    expect((value as RulesDoc["audit"]).dimensions[0].weight).toBe(4);
    expect(await screen.findByText("Score 62 out of 100, band: Fair. 6 of 12 dimensions are scored.")).toBeInTheDocument();
    const t = screen.getByRole("table", { name: /Each dimension.s score/ });
    expect(within(t).getByRole("row", { name: /Posting consistency/ })).toHaveTextContent("3.5");
    expect(within(t).getByRole("row", { name: /Profile, bio and link/ })).toHaveTextContent("Not scored");
    expect(saveRules).not.toHaveBeenCalled();
  });
  it("says so plainly when nothing is scored, and when the server cannot score the client", async () => {
    vi.mocked(previewRules).mockResolvedValueOnce({ ok: true, preview: asPreview({ section: "audit", engagementId: "e1", audit: { month: "2026-09", overall: null, band: null, bandLabel: null, scored: 0, total: 12, dimensions: [] } }) });
    mount();
    fireEvent.change(screen.getByLabelText("For client"), { target: { value: "e1" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview a client's score" }));
    expect(await screen.findByText("Nothing is scored yet under this scorecard (0 of 12 dimensions have a score).", {}, { timeout: 4000 })).toBeInTheDocument();
    vi.mocked(previewRules).mockResolvedValueOnce({ ok: true, preview: asPreview({ section: "audit", engagementId: "e1", audit: null }) });
    fireEvent.click(screen.getByRole("button", { name: "Preview a client's score" }));
    expect(await screen.findByText("A score cannot be previewed for this client right now.", {}, { timeout: 4000 })).toBeInTheDocument();
  });
  it("words a refusal of the preview", async () => {
    vi.mocked(previewRules).mockResolvedValue(failure("invalid_field", 400, { field: "audit.bands" }, "preview"));
    mount();
    fireEvent.change(screen.getByLabelText("For client"), { target: { value: "e1" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview a client's score" }));
    expect(await screen.findByRole("alert", {}, { timeout: 4000 })).toHaveTextContent("The bands is not valid.");
  });
});
