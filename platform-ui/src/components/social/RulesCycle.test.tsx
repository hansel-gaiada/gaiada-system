import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

// SCP-5 W5-C5 (BFF §63.30.5, §63.27.2): the Monthly cycle section. The steps are listed in order with their default beside them; a step's due rule and close condition are the server's menus; a save sends the
// whole `cycle` section against its version; a refused field is said beside its control; the preview dates the next cycle's steps for a chosen client.
const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));
vi.mock("@/lib/socialRulesActions", () => ({ saveRules: vi.fn(), resetRules: vi.fn(), previewRules: vi.fn(), loadRulesHistory: vi.fn() }));

import { previewRules, resetRules, saveRules } from "@/lib/socialRulesActions";
import { asPreview, type RulesDoc } from "@/lib/socialRules";
import { RulesCycle } from "./RulesCycle";
import { CLIENTS, failure, rulesAnswer, seedDoc } from "./rulesTestKit";

const mount = (over: Parameters<typeof rulesAnswer>[0] = {}, clients: typeof CLIENTS | null = CLIENTS) => render(<RulesCycle answer={rulesAnswer(over)} clients={clients} />);
const step = (n: number) => screen.getByRole("listitem", { name: new RegExp(`^Step ${n}:`) });
const save = () => screen.getByRole("button", { name: "Save cycle steps" });
const sent = (): RulesDoc["cycle"] => vi.mocked(saveRules).mock.calls[0][2] as RulesDoc["cycle"];
const saved = (version: number) => ({ ok: true as const, answer: rulesAnswer({ version }) });

beforeEach(() => vi.clearAllMocks());

describe("the steps", () => {
  it("lists the six default steps in order, each with its title, due rule and close condition and the default beside it", () => {
    mount();
    expect(screen.getAllByRole("listitem", { name: /^Step \d+:/ })).toHaveLength(6);
    const s1 = within(step(1));
    expect(s1.getByLabelText("Title")).toHaveValue("Monthly report for {month-2}");
    expect(s1.getByLabelText("Due")).toHaveValue("report_due_day");
    expect(s1.getByLabelText("Months before the content month")).toHaveValue(1);
    expect(s1.getByLabelText("Closes")).toHaveValue("report_delivered");
    expect(s1.getByLabelText("Report of how many months back")).toHaveValue(2);
    expect(s1.getByText("Default: Monthly report for {month-2}")).toBeInTheDocument();
    expect(s1.getByText("Default: On the client's report day, 1 month before the content month")).toBeInTheDocument();
    expect(s1.getByText("Default: When the monthly report is delivered for 2 months before the content month")).toBeInTheDocument();
    const s2 = within(step(2));
    expect(s2.getByLabelText("Due")).toHaveValue("ready_by");
    expect(s2.getByLabelText("Count back the estimates from")).toHaveValue("proofread");
    expect(s2.getByLabelText("And extra working days")).toHaveValue(0);
    expect(within(step(6)).getByLabelText("Count back the estimates from")).toHaveValue("");
  });
  it("lists the defaults in words under the editor, and says a step of your own has no default", () => {
    mount();
    fireEvent.click(screen.getByText("The default steps (6)"));
    expect(screen.getByText(/^\{month\} copy locked\. Due: the ready-by date less the estimates from design on\. Closes: when the copy is locked\.$/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add a step" }));
    expect(within(step(7)).getByText("A step of your own: there is no default for it.")).toBeInTheDocument();
  });
  it("offers every close condition of the menu, and nothing else", () => {
    mount();
    const opts = within(within(step(2)).getByLabelText("Closes")).getAllByRole("option").map((o) => (o as HTMLOptionElement).value);
    expect(opts).toEqual(["manual", "report_delivered", "plan_laid_out", "copy_locked", "artwork_done", "client_approved", "all_scheduled"]);
  });
  it("saves a retitled step, a changed due rule and a step set to close by hand, as the server's shapes, against the version", async () => {
    vi.mocked(saveRules).mockResolvedValue(saved(4));
    mount({ version: 3 });
    fireEvent.change(within(step(2)).getByLabelText("Title"), { target: { value: "  The {month} content plan " } });
    fireEvent.change(within(step(2)).getByLabelText("And extra working days"), { target: { value: "2" } });
    fireEvent.change(within(step(3)).getByLabelText("Due"), { target: { value: "none" } });
    fireEvent.change(within(step(4)).getByLabelText("Closes"), { target: { value: "manual" } });
    fireEvent.change(within(step(1)).getByLabelText("Months before the content month"), { target: { value: "2" } });
    fireEvent.click(save());
    await waitFor(() => expect(saveRules).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveRules).mock.calls[0].slice(0, 2)).toEqual(["cycle", 3]);
    const v = sent();
    expect(v.steps[1].title).toBe("  The {month} content plan ");
    expect(v.steps[1].due).toEqual({ rule: "ready_by", lessEstimatesFrom: "proofread", lessWorkingDays: 2 });
    expect(v.steps[2].due).toEqual({ rule: "none" });
    expect(v.steps[3].autoClose).toEqual({ rule: "manual" });
    expect(v.steps[0].due).toEqual({ rule: "report_due_day", monthOffset: -2 });
    expect(v.steps[0].autoClose).toEqual(seedDoc().cycle.steps[0].autoClose);
    expect(await screen.findByText(/Saved as version 4/)).toBeInTheDocument();
  });
  it("sends a month offset of zero as 0, not minus zero", async () => {
    vi.mocked(saveRules).mockResolvedValue(saved(1));
    mount();
    fireEvent.change(within(step(1)).getByLabelText("Months before the content month"), { target: { value: "0" } });
    fireEvent.click(save());
    await waitFor(() => expect(saveRules).toHaveBeenCalled());
    expect(JSON.stringify(sent().steps[0].due)).toBe('{"rule":"report_due_day","monthOffset":0}');
  });
  it("builds a step due and a close rule with only the keys the server takes when the rule changes", async () => {
    vi.mocked(saveRules).mockResolvedValue(saved(1));
    mount();
    fireEvent.change(within(step(2)).getByLabelText("Due"), { target: { value: "report_due_day" } });
    fireEvent.change(within(step(1)).getByLabelText("Closes"), { target: { value: "report_delivered" } });
    fireEvent.change(within(step(5)).getByLabelText("Closes"), { target: { value: "all_scheduled" } });
    fireEvent.click(save());
    await waitFor(() => expect(saveRules).toHaveBeenCalled());
    expect(sent().steps[1].due).toEqual({ rule: "report_due_day", monthOffset: 0 });
    expect(sent().steps[0].autoClose).toEqual({ rule: "report_delivered", reportMonthOffset: 0 });
    expect(sent().steps[4].autoClose).toEqual({ rule: "all_scheduled" });
  });

  it("adds a step with a fresh key, moves one and removes one, and keeps between one and twelve", async () => {
    vi.mocked(saveRules).mockResolvedValue(saved(1));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Add a step" }));
    expect(screen.getAllByRole("listitem", { name: /^Step \d+:/ })).toHaveLength(7);
    fireEvent.change(within(step(7)).getByLabelText("Title"), { target: { value: "Brief the designers" } });
    fireEvent.click(screen.getByRole("button", { name: "Move step 7, Brief the designers up" }));
    fireEvent.click(screen.getByRole("button", { name: /^Remove step 1, Monthly report/ }));
    fireEvent.click(save());
    await waitFor(() => expect(saveRules).toHaveBeenCalled());
    const keys = sent().steps.map((s) => s.key);
    expect(keys).toEqual(["planning", "copy_lock", "artwork", "client_window", "step", "deploy"]);
    expect(keys).toHaveLength(6);
    expect(keys[4]).toBe("step");
    expect(new Set(keys).size).toBe(6);
    expect(sent().steps[4]).toEqual({ key: "step", title: "Brief the designers", due: { rule: "none" }, autoClose: { rule: "manual" } });
  });
  it("stops at twelve steps", () => {
    mount();
    for (let i = 0; i < 6; i++) fireEvent.click(screen.getByRole("button", { name: "Add a step" }));
    expect(screen.getByRole("button", { name: "Add a step" })).toBeDisabled();
    expect(screen.getByText("Steps (12 of 12)")).toBeInTheDocument();
  });
  it("keeps the first Up and the last Down off", () => {
    mount();
    expect(screen.getByRole("button", { name: /^Move step 1, .* up$/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Move step 6, .* down$/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Move step 2, .* up$/ })).toBeEnabled();
  });
  it("is labelled throughout: every control has a name", () => {
    mount();
    for (const c of screen.getAllByRole("combobox")) expect(c).toHaveAccessibleName();
    for (const c of screen.getAllByRole("textbox")) expect(c).toHaveAccessibleName();
    for (const c of screen.getAllByRole("spinbutton")) expect(c).toHaveAccessibleName();
    for (const c of screen.getAllByRole("button")) expect(c).toHaveAccessibleName();
  });
});

describe("a refused field, in words, beside its control", () => {
  it("names the step's title and focuses it", async () => {
    vi.mocked(saveRules).mockResolvedValue(failure("invalid_field", 400, { field: "cycle.steps.1.title" }));
    mount();
    fireEvent.change(within(step(2)).getByLabelText("Title"), { target: { value: "Plan for {mnth}" } });
    fireEvent.click(save());
    const box = within(step(2)).getByLabelText("Title");
    await waitFor(() => expect(box).toHaveFocus());
    expect(box).toHaveAccessibleDescription(/Step 2, the title is not valid\. It needs some words, within its length limit and without special characters\./);
    expect(within(step(3)).getByLabelText("Title")).toHaveAttribute("aria-invalid", "false");
  });
  it("names the step count at the list when it is refused as a whole", async () => {
    vi.mocked(saveRules).mockResolvedValue(failure("invalid_field", 400, { field: "cycle.steps" }));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Add a step" }));
    fireEvent.click(save());
    const group = await screen.findByRole("group", { name: /^Steps \(7 of 12\)/ });
    await waitFor(() => expect(group).toHaveFocus());
    expect(group).toHaveTextContent("Keep one to 12 steps.");
  });
});

describe("409 rules_changed, Reset to default and read-only", () => {
  it("says someone else saved first, and lists the person's edits", async () => {
    vi.mocked(saveRules).mockResolvedValue(failure("rules_changed", 409, { detail: { currentVersion: 6 } }));
    mount({ version: 5 });
    fireEvent.change(within(step(2)).getByLabelText("Title"), { target: { value: "Plan" } });
    fireEvent.click(save());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Someone else saved the rules first (now version 6), so nothing was saved.");
    expect(alert).toHaveTextContent("Step 2, the title: {month} plan to Plan");
    expect(nav.refresh).toHaveBeenCalled();
  });
  it("resets the cycle steps to the seed behind a confirm", async () => {
    vi.mocked(resetRules).mockResolvedValue(saved(3));
    const c = seedDoc().cycle;
    c.steps.pop();
    mount({ version: 2, rules: { cycle: c } });
    expect(screen.getByText("Changed from the default")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Reset to default" }));
    await waitFor(() => expect(resetRules).toHaveBeenCalledWith("cycle", 2));
  });
  it("reads the steps with disabled controls and no Save, Reset or Add for a person who may not edit", () => {
    mount({ canEdit: false });
    expect(within(step(2)).getByLabelText("Title")).toBeDisabled();
    expect(within(step(2)).getByLabelText("Due")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add a step" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset to default" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Preview the next cycle's steps" })).toBeNull();
  });
});

describe("the preview of the next cycle's steps", () => {
  const answer = asPreview({
    section: "cycle", engagementId: "e1", cycle: { cycleId: "c1", month: "2026-11", readyBy: "2026-10-14" },
    steps: [{ key: "report", title: "Monthly report for September 2026", due: "2026-10-05", autoClose: "report_delivered" }, { key: "deploy", title: "November 2026 scheduled", due: null, autoClose: "manual" }],
  });
  it("needs a client, then dates the steps under the unsaved value", async () => {
    vi.mocked(previewRules).mockResolvedValue({ ok: true, preview: answer });
    mount();
    const btn = screen.getByRole("button", { name: "Preview the next cycle's steps" });
    expect(btn).toBeDisabled();
    expect(screen.getByText("Choose a client first.")).toBeInTheDocument();
    fireEvent.change(within(step(2)).getByLabelText("Title"), { target: { value: "Plan for {month}" } });
    fireEvent.change(screen.getByLabelText("For client"), { target: { value: "e1" } });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    await waitFor(() => expect(previewRules).toHaveBeenCalledTimes(1));
    const [section, value, client] = vi.mocked(previewRules).mock.calls[0];
    expect([section, client]).toEqual(["cycle", "e1"]);
    expect((value as RulesDoc["cycle"]).steps[1].title).toBe("Plan for {month}");
    const t = await screen.findByRole("table", { name: /next cycle.s steps/ });
    expect(screen.getByText("Steps for the 2026-11 cycle, ready by 14 Oct 2026.")).toBeInTheDocument();
    expect(within(t).getByRole("row", { name: /Monthly report for September 2026/ })).toHaveTextContent("5 Oct 2026");
    expect(within(t).getByRole("row", { name: /Monthly report for September 2026/ })).toHaveTextContent("When the monthly report is delivered");
    expect(within(t).getByRole("row", { name: /November 2026 scheduled/ })).toHaveTextContent("No due date");
  });
  it("says a client with no next cycle has no dates, in words", async () => {
    vi.mocked(previewRules).mockResolvedValue({ ok: true, preview: asPreview({ section: "cycle", engagementId: "e1", cycle: null, steps: [], reason: "no_next_cycle" }) });
    mount();
    fireEvent.change(screen.getByLabelText("For client"), { target: { value: "e1" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview the next cycle's steps" }));
    expect(await screen.findByText("This client has no cycle after this month yet, so there are no dates to show.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });
  it("words a refused preview, and a client the server no longer knows", async () => {
    vi.mocked(previewRules).mockResolvedValue(failure("engagement_not_found", 404, {}, "preview"));
    mount();
    fireEvent.change(screen.getByLabelText("For client"), { target: { value: "e2" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview the next cycle's steps" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This client is no longer on the list.");
  });
});
