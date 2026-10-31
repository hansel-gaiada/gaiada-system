import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

// SCP-5 W5-C5 (BFF §63.30.5): the Reports section of the company rules. Every control is a field of the server's `reports.kinds.<kind>` with the default beside it; a save sends the whole section against its
// version; a refused field is said beside its control; the preview names the next due date of each kind. Ideas settings are their own section and their own save.
const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));
vi.mock("@/lib/socialRulesActions", () => ({ saveRules: vi.fn(), resetRules: vi.fn(), previewRules: vi.fn(), loadRulesHistory: vi.fn() }));

import { previewRules, resetRules, saveRules } from "@/lib/socialRulesActions";
import { asPreview, type RulesDoc } from "@/lib/socialRules";
import { RulesReports } from "./RulesReports";
import { CLIENTS, failure, rulesAnswer, seedDoc } from "./rulesTestKit";

const mount = (over: Parameters<typeof rulesAnswer>[0] = {}, clients: typeof CLIENTS | null = CLIENTS) => render(<RulesReports answer={rulesAnswer(over)} clients={clients} />);
const panel = (section: string) => document.querySelector(`[data-rules-section="${section}"]`) as HTMLElement;
const kindEl = (k: string) => panel("reports").querySelector(`[data-kind="${k}"]`) as HTMLElement;
const saveReports = () => within(panel("reports")).getByRole("button", { name: "Save report rules" });
const saved = (version: number) => ({ ok: true as const, answer: rulesAnswer({ version }) });
const sentValue = (): RulesDoc["reports"] => vi.mocked(saveRules).mock.calls[0][2] as RulesDoc["reports"];

beforeEach(() => vi.clearAllMocks());

describe("the report rules", () => {
  it("draws the fiscal year and one section per kind, each with its due day in the summary and the default beside the control", () => {
    mount();
    const fy = within(panel("reports")).getByLabelText("The fiscal year starts in");
    expect(fy).toHaveValue("1");
    expect(within(panel("reports")).getAllByText("Default: January").length).toBeGreaterThan(0);
    for (const k of ["daily", "weekly", "monthly", "quarterly", "semester", "yearly"]) expect(kindEl(k)).toBeInTheDocument();
    expect(kindEl("weekly")).toHaveTextContent("Weekly report: on, due 1 working day after the period ends");
    expect(kindEl("monthly")).toHaveTextContent("due on the client's report day, in the month after the period");
    const weekly = within(kindEl("weekly"));
    expect(weekly.getByLabelText("Working days after the period ends")).toHaveValue(1);
    expect(weekly.getAllByText("Default: 1").length).toBeGreaterThan(0);
    expect(weekly.getByLabelText("Narrative limit (characters)")).toHaveValue(1000);
    expect(weekly.getByLabelText("A line about the next period")).toBeChecked();
    expect(weekly.getByLabelText("AI may draft this kind")).toBeChecked();
    expect(within(kindEl("monthly")).getByLabelText("No limit on the narrative")).toBeChecked();
  });
  it("shows what a company changed against the default, in words", () => {
    const r = seedDoc().reports;
    r.kinds.weekly.due = { rule: "weekday", weekday: 3, week: "next" };
    mount({ version: 2, rules: { reports: r } });
    expect(within(panel("reports")).getByText("Changed from the default")).toBeInTheDocument();
    fireEvent.click(within(panel("reports")).getByText(/What differs from the default \(/));
    expect(within(panel("reports")).getByText("Weekly report, the due date, the rule: weekday (default: working_days_after)")).toBeInTheDocument();
    expect(within(kindEl("weekly")).getByLabelText("Weekday")).toHaveValue("3");
    expect(within(kindEl("weekly")).getByText("Default: 1 working day after the period ends")).toBeInTheDocument();
  });

  it("offers only the due rules a kind can take", () => {
    mount();
    const opts = (k: string) => within(within(kindEl(k)).getByLabelText("Due rule")).getAllByRole("option").map((o) => (o as HTMLOptionElement).value);
    expect(opts("daily")).toEqual(["working_days_after"]);
    expect(opts("weekly")).toEqual(["working_days_after", "weekday"]);
    expect(opts("monthly")).toEqual(["working_days_after", "report_due_day"]);
    expect(opts("yearly")).toEqual(["working_days_after", "report_due_day"]);
  });
  it("offers the next-period line to the daily and weekly kinds only, and says why not to the others", () => {
    mount();
    expect(within(kindEl("daily")).getByLabelText("A line about the next period")).toBeInTheDocument();
    expect(within(kindEl("monthly")).queryByLabelText("A line about the next period")).toBeNull();
    expect(within(kindEl("monthly")).getByText("A line about the next period is only for the daily and weekly reports.")).toBeInTheDocument();
  });
  it("saves a changed due rule, the fiscal year and a switched-off kind in one section, against its version", async () => {
    vi.mocked(saveRules).mockResolvedValue(saved(8));
    mount({ version: 7 });
    fireEvent.change(within(kindEl("weekly")).getByLabelText("Due rule"), { target: { value: "weekday" } });
    fireEvent.change(within(kindEl("weekly")).getByLabelText("Weekday"), { target: { value: "5" } });
    fireEvent.change(within(kindEl("weekly")).getByLabelText("Of which week"), { target: { value: "same" } });
    fireEvent.change(within(panel("reports")).getByLabelText("The fiscal year starts in"), { target: { value: "4" } });
    fireEvent.click(within(kindEl("daily")).getByLabelText("Use daily reports"));
    fireEvent.click(saveReports());
    await waitFor(() => expect(saveRules).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveRules).mock.calls[0].slice(0, 2)).toEqual(["reports", 7]);
    const v = sentValue();
    expect(v.fiscalYearStartMonth).toBe(4);
    expect(v.kinds.weekly.due).toEqual({ rule: "weekday", weekday: 5, week: "same" });
    expect(v.kinds.daily.enabled).toBe(false);
    expect(v.kinds.monthly).toEqual(seedDoc().reports.kinds.monthly);
    expect(await screen.findByText(/Saved as version 8/)).toBeInTheDocument();
  });
  it("switching a due rule builds the rule the server takes, with no keys of the old one", async () => {
    vi.mocked(saveRules).mockResolvedValue(saved(1));
    mount();
    fireEvent.change(within(kindEl("monthly")).getByLabelText("Due rule"), { target: { value: "working_days_after" } });
    fireEvent.change(within(kindEl("monthly")).getByLabelText("Working days after the period ends"), { target: { value: "3" } });
    fireEvent.click(saveReports());
    await waitFor(() => expect(saveRules).toHaveBeenCalled());
    expect(sentValue().kinds.monthly.due).toEqual({ rule: "working_days_after", n: 3 });
  });
  it("takes the narrative limit off and puts one back", async () => {
    vi.mocked(saveRules).mockResolvedValue(saved(1));
    mount();
    fireEvent.click(within(kindEl("weekly")).getByLabelText("No limit on the narrative"));
    expect(within(kindEl("weekly")).queryByLabelText("Narrative limit (characters)")).toBeNull();
    fireEvent.click(within(kindEl("monthly")).getByLabelText("No limit on the narrative"));
    fireEvent.change(within(kindEl("monthly")).getByLabelText("Narrative limit (characters)"), { target: { value: "2500" } });
    fireEvent.click(saveReports());
    await waitFor(() => expect(saveRules).toHaveBeenCalled());
    expect(sentValue().kinds.weekly.content.narrative.max).toBeNull();
    expect(sentValue().kinds.monthly.content.narrative.max).toBe(2500);
  });
  it("adds and removes notes areas, and a part the report no longer holds drops out of the check", async () => {
    vi.mocked(saveRules).mockResolvedValue(saved(1));
    mount();
    const m = within(kindEl("monthly"));
    expect(m.getByLabelText("Every notes area has a note")).toBeChecked();
    for (const n of [3, 2, 1]) fireEvent.click(m.getByRole("button", { name: new RegExp(`^Remove area ${n},`) }));
    expect(m.getByLabelText("Every notes area has a note")).toBeDisabled();
    expect(m.getByLabelText("Every notes area has a note")).not.toBeChecked();
    expect(m.getByLabelText("Every notes area has a note").closest(".rules__field")).toHaveTextContent("The report does not hold this, so it cannot be required.");
    fireEvent.click(m.getByRole("button", { name: "Add a notes area" }));
    fireEvent.change(m.getByLabelText("Area 1 name"), { target: { value: "Reach" } });
    expect(m.getByLabelText("Every notes area has a note")).toBeEnabled();
    fireEvent.click(m.getByLabelText("Every notes area has a note"));
    fireEvent.click(saveReports());
    await waitFor(() => expect(saveRules).toHaveBeenCalled());
    expect(sentValue().kinds.monthly.content.notes.areas).toEqual([{ key: "area", label: "Reach" }]);
    expect(sentValue().kinds.monthly.checkRequires).toEqual(["notes"]);
  });
  it("stops at six notes areas", () => {
    mount();
    const m = within(kindEl("monthly"));
    for (let i = 0; i < 3; i++) fireEvent.click(m.getByRole("button", { name: "Add a notes area" }));
    expect(m.getByRole("button", { name: "Add a notes area" })).toBeDisabled();
    expect(m.getAllByLabelText(/^Area \d name$/)).toHaveLength(6);
  });
  it("moves a notes area up and down", async () => {
    vi.mocked(saveRules).mockResolvedValue(saved(1));
    mount();
    fireEvent.click(within(kindEl("monthly")).getByRole("button", { name: /^Move area 1, Followers down$/ }));
    fireEvent.click(saveReports());
    await waitFor(() => expect(saveRules).toHaveBeenCalled());
    expect(sentValue().kinds.monthly.content.notes.areas.map((a) => a.key)).toEqual(["engagement", "followers", "audience"]);
  });
  it("keeps the action plan's limit only while the plan is on", () => {
    mount();
    const m = within(kindEl("monthly"));
    expect(m.getByLabelText("Most action items")).toHaveValue(10);
    fireEvent.click(m.getByLabelText("An action plan"));
    expect(m.queryByLabelText("Most action items")).toBeNull();
    expect(m.getByLabelText("The action plan has at least one item")).toBeDisabled();
  });
  it("says AI drafting is a company switch and that AI only drafts", () => {
    mount();
    expect(within(kindEl("weekly")).getByText(/AI only drafts; one of the four approvers always checks and sends/)).toBeInTheDocument();
  });
  it("has no control for who may act, the one-report rule or a schedule's owner (63.30.2)", () => {
    mount();
    expect(screen.queryByLabelText(/who may|approver|owner|one report|permission/i)).toBeNull();
  });
});

describe("a refused field, in words, beside its control", () => {
  it("names the narrative limit of the weekly report and focuses it", async () => {
    vi.mocked(saveRules).mockResolvedValue(failure("invalid_field", 400, { field: "reports.kinds.weekly.content.narrative.max" }));
    mount();
    fireEvent.change(within(kindEl("weekly")).getByLabelText("Narrative limit (characters)"), { target: { value: "50" } });
    fireEvent.click(saveReports());
    const box = within(kindEl("weekly")).getByLabelText("Narrative limit (characters)");
    await waitFor(() => expect(box).toHaveFocus());
    expect(box).toHaveAccessibleDescription(/Weekly report, the content, the narrative, the limit is not valid\. A limit is a whole number from 100 to 10,000, or no limit\./);
  });
  it("sends an empty box as a value the server refuses by name, rather than guessing a number", async () => {
    vi.mocked(saveRules).mockResolvedValue(failure("invalid_field", 400, { field: "reports.kinds.weekly.due.n" }));
    mount();
    fireEvent.change(within(kindEl("weekly")).getByLabelText("Working days after the period ends"), { target: { value: "" } });
    expect(within(kindEl("weekly")).getByLabelText("Working days after the period ends")).toHaveAttribute("aria-invalid", "true");
    fireEvent.click(saveReports());
    await waitFor(() => expect(saveRules).toHaveBeenCalled());
    expect(JSON.parse(JSON.stringify(sentValue())).kinds.weekly.due.n).toBeNull();
    expect(await screen.findByText(/Weekly report, the due date, the number of days is not valid\. A number of working days is 0 to 30\./, { selector: ".rules__err" })).toBeInTheDocument();
  });
  it("names the check parts the content turned off at the check's own group", async () => {
    vi.mocked(saveRules).mockResolvedValue(failure("invalid_field", 400, { field: "reports.kinds.daily.checkRequires" }));
    mount();
    fireEvent.click(within(kindEl("daily")).getByLabelText("The narrative is written"));
    fireEvent.click(saveReports());
    const group = await waitFor(() => {
      const g = within(kindEl("daily")).getByRole("group", { name: /What the check requires/ });
      expect(g).toHaveFocus();
      return g;
    });
    expect(group).toHaveTextContent("The check can only require a part the report's content has turned on.");
  });
});

describe("409 rules_changed and Reset to default", () => {
  it("says someone else saved first and lists the person's edits", async () => {
    vi.mocked(saveRules).mockResolvedValue(failure("rules_changed", 409, { detail: { currentVersion: 3 } }));
    mount({ version: 2 });
    fireEvent.change(within(panel("reports")).getByLabelText("The fiscal year starts in"), { target: { value: "7" } });
    fireEvent.click(saveReports());
    const alert = await within(panel("reports")).findByRole("alert");
    expect(alert).toHaveTextContent("Someone else saved the rules first (now version 3), so nothing was saved.");
    expect(alert).toHaveTextContent("The fiscal year's first month: 1 to 7");
    expect(nav.refresh).toHaveBeenCalled();
  });
  it("resets only the reports section, behind a confirm", async () => {
    vi.mocked(resetRules).mockResolvedValue(saved(5));
    const r = seedDoc().reports;
    r.fiscalYearStartMonth = 4;
    mount({ version: 4, rules: { reports: r } });
    const ideas = within(panel("ideas")).getByRole("button", { name: "Reset to default" });
    expect(ideas).toBeDisabled();
    fireEvent.click(within(panel("reports")).getByRole("button", { name: "Reset to default" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Reset to default" }));
    await waitFor(() => expect(resetRules).toHaveBeenCalledWith("reports", 4));
  });
});

describe("the preview of the next due dates", () => {
  const rows = [
    { kind: "daily", enabled: true, period: "2026-10-13", range: { start: "2026-10-13", end: "2026-10-13" }, due: "2026-10-14" },
    { kind: "weekly", enabled: true, period: "2026-W42", range: { start: "2026-10-12", end: "2026-10-18" }, due: "2026-10-19" },
    { kind: "monthly", enabled: true, period: "2026-10", range: { start: "2026-10-01", end: "2026-10-31" }, due: null },
    { kind: "quarterly", enabled: false, period: "2026-Q4", range: { start: "2026-10-01", end: "2026-12-31" }, due: null },
    { kind: "semester", enabled: true, period: "2026-H2", range: { start: "2026-07-01", end: "2026-12-31" }, due: null },
    { kind: "yearly", enabled: true, period: "2026", range: { start: "2026-01-01", end: "2026-12-31" }, due: null },
  ];
  it("asks with the unsaved value and no client, and says which kinds need a client's report day", async () => {
    vi.mocked(previewRules).mockResolvedValue({ ok: true, preview: asPreview({ section: "reports", engagementId: null, reports: rows, reason: "no_client" }) });
    mount();
    fireEvent.change(within(panel("reports")).getByLabelText("The fiscal year starts in"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview the next due dates" }));
    await waitFor(() => expect(previewRules).toHaveBeenCalledTimes(1));
    const [section, value, client] = vi.mocked(previewRules).mock.calls[0];
    expect([section, client]).toEqual(["reports", null]);
    expect((value as RulesDoc["reports"]).fiscalYearStartMonth).toBe(4);
    const t = await screen.findByRole("table", { name: /next due date of each report kind/ });
    const r = (k: string) => within(t).getByRole("row", { name: new RegExp(`^${k}`) });
    expect(r("Weekly")).toHaveTextContent("2026-W42 (12 Oct 2026 to 18 Oct 2026)");
    expect(r("Weekly")).toHaveTextContent("19 Oct 2026");
    expect(r("Daily")).toHaveTextContent("2026-10-13 (13 Oct 2026)");
    expect(r("Monthly")).toHaveTextContent("Needs a client's report day: choose a client");
    expect(r("Quarterly")).toHaveTextContent("Turned off");
  });
  it("names a client when one is chosen", async () => {
    vi.mocked(previewRules).mockResolvedValue({ ok: true, preview: asPreview({ section: "reports", engagementId: "e2", reports: rows }) });
    mount();
    fireEvent.change(screen.getByLabelText("For client"), { target: { value: "e2" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview the next due dates" }));
    await waitFor(() => expect(previewRules).toHaveBeenCalledWith("reports", expect.anything(), "e2"));
    expect(await screen.findByRole("table")).toHaveTextContent("No report day set for this client");
  });
  it("says the preview is of an earlier edit once the values change, and shows a refusal in words", async () => {
    vi.mocked(previewRules).mockResolvedValueOnce({ ok: true, preview: asPreview({ section: "reports", engagementId: null, reports: rows }) });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Preview the next due dates" }));
    await screen.findByRole("table");
    fireEvent.click(within(kindEl("daily")).getByLabelText("Use daily reports"));
    expect(screen.getByText(/You have edited the values since this preview/)).toBeInTheDocument();
    vi.mocked(previewRules).mockResolvedValueOnce(failure("invalid_field", 400, { field: "reports.kinds.weekly.due.n" }, "preview"));
    fireEvent.click(screen.getByRole("button", { name: "Preview the next due dates" }));
    expect(await screen.findByText(/Weekly report, the due date, the number of days is not valid/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });
  it("cannot list clients: says so, and still previews with none", () => {
    mount({}, null);
    expect(screen.getByText(/The clients cannot be listed right now/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview the next due dates" })).toBeEnabled();
  });
  it("is not offered to a person who may not edit", () => {
    mount({ canEdit: false });
    expect(screen.queryByRole("button", { name: "Preview the next due dates" })).toBeNull();
  });
});

describe("the ideas settings", () => {
  it("are their own section with their own save, and show the default beside each switch", async () => {
    vi.mocked(saveRules).mockResolvedValue(saved(2));
    mount({ version: 1 });
    const p = within(panel("ideas"));
    expect(p.getByLabelText("An idea must name the metric it would move")).toBeChecked();
    expect(p.getByText("Default: on")).toBeInTheDocument();
    expect(p.getByText("Default: off")).toBeInTheDocument();
    fireEvent.click(p.getByLabelText("Ideas marked as shared print in the next monthly report"));
    expect(within(panel("reports")).getByRole("button", { name: "Save report rules" })).toBeDisabled();
    fireEvent.click(p.getByRole("button", { name: "Save ideas for next month" }));
    await waitFor(() => expect(saveRules).toHaveBeenCalledWith("ideas", 1, { metricRequired: true, sharedInMonthlyReport: true }));
  });
});

describe("a person who may not edit", () => {
  it("reads every kind's values with disabled controls and no Save or Reset", () => {
    const r = seedDoc().reports;
    r.kinds.weekly.due = { rule: "working_days_after", n: 4 };
    mount({ canEdit: false, rules: { reports: r } });
    expect(within(kindEl("weekly")).getByLabelText("Working days after the period ends")).toHaveValue(4);
    expect(within(kindEl("weekly")).getByLabelText("Working days after the period ends")).toBeDisabled();
    expect(within(panel("reports")).getByLabelText("The fiscal year starts in")).toBeDisabled();
    expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset to default" })).toBeNull();
    for (const b of screen.getAllByRole("button", { name: "Add a notes area" })) expect(b).toBeDisabled();
  });
});
