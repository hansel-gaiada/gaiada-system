import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

// SCP-5 W5-A6 (BFF §63.24.9): the Report automation section. One card per schedule with the kind, clients, timing in words, owner, state (paused said in text), next and last run and the spend;
// the add and edit dialog with every field of the server's body and a computed "Next runs"; pause, resume, delete (with a confirm) and Run now (naming the period). The writes go to the server
// actions and a refusal is shown in words beside what made it, never a bare code. There is no cap or limit control anywhere.
const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/socialReportSchedulesActions", () => ({ saveSchedule: vi.fn(), editSchedule: vi.fn(), setScheduleOn: vi.fn(), deleteSchedule: vi.fn(), runScheduleNow: vi.fn(), getRunProgress: vi.fn() }));

import { deleteSchedule, editSchedule, getRunProgress, runScheduleNow, saveSchedule, setScheduleOn } from "@/lib/socialReportSchedulesActions";
import { asSchedule, scheduleRefusalText, type ReportSchedule } from "@/lib/socialReportSchedules";
import { ReportAutomation } from "./ReportAutomation";
import { ReportAutomationBoard } from "./ReportAutomationBoard";

const zero = { runs: 0, calls: 0, promptTokens: 0, completionTokens: 0, costUsd: null };
const sched = (over: Record<string, unknown> = {}): ReportSchedule => asSchedule({
  id: "s1", kind: "weekly", scope: "all", clients: [], timing: { weekday: 1, at: "08:00" }, timingText: "Every Monday at 08:00, for the week before", enabled: true, pausedReason: null,
  owner: { id: "u1", name: "Mock Owner" }, nextRunAt: "2026-10-19T08:00:00.000Z", nextPeriod: "2026-W42", lastRunAt: "2026-10-12T08:00:00.000Z", lastPeriod: "2026-W41",
  lastRun: { runId: "r1", status: "done", created: 9, existing: 2, skipped: 1, failed: 0, missed: 0 },
  spend: { last30Days: { runs: 3, calls: 36, promptTokens: 54000, completionTokens: 18000, costUsd: 0.24 }, monthToDate: zero }, ...over,
});
const paused = (): ReportSchedule => sched({
  id: "s2", kind: "monthly", scope: "chosen", clients: [{ engagementId: "e1", clientName: "Mock Bakery" }, { engagementId: "e2", clientName: "Mock Surf School" }],
  timing: { on: "working_day", n: 3, at: "08:00" }, timingText: "On the 3rd working day of each month at 08:00, for the month before", enabled: false, pausedReason: "owner_not_allowed",
  nextRunAt: null, nextPeriod: null, owner: { id: "u2", name: "Mock Former Owner" }, lastRun: { runId: "r2", status: "done", created: 2, existing: 0, skipped: 0, failed: 0, missed: 1 }, lastPeriod: "2026-09",
});
const CLIENTS = [{ engagementId: "e1", clientName: "Mock Bakery" }, { engagementId: "e2", clientName: "Mock Surf School" }, { engagementId: "e3", clientName: "Mock Studio" }];
const mount = (schedules: ReportSchedule[] = [sched(), paused()], clients: typeof CLIENTS | null = CLIENTS) => render(<ReportAutomationBoard deptId="d-soc" schedules={schedules} clients={clients} />);
const card = (name: string) => screen.getByRole("listitem", { name });
const dialog = () => screen.getByRole("dialog");
const refusal = (error: string, status = 409, extra: Record<string, unknown> = {}) => ({ ok: false as const, refusal: { status, error, ...extra }, message: scheduleRefusalText({ status, error, ...extra }, "save") });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-14T04:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("the cards", () => {
  it("draws the kind, clients, timing in words, owner, state, next run, last run and spend", () => {
    mount();
    const w = card("Weekly report");
    expect(w).toHaveTextContent("All clients");
    expect(w).toHaveTextContent("Every Monday at 08:00, for the week before");
    expect(w).toHaveTextContent("Mock Owner");
    expect(w).toHaveTextContent("On");
    expect(w).toHaveTextContent("for the week of 12 to 18 October 2026");
    expect(w).toHaveTextContent("Finished: 9 drafts made, 2 already there, 1 skipped, 0 failed");
    expect(within(w).getByRole("link", { name: "See the results" })).toHaveAttribute("href", "/departments/d-soc/social-reports?run=r1");
    expect(w).toHaveTextContent("Last 30 days: 3 runs, 36 AI calls, 72,000 tokens, cost $0.2400.");
    expect(w).toHaveTextContent("This month: No runs.");
  });
  it("says a paused schedule's reason in text, names its clients, shows no next run and says the missed periods", () => {
    mount();
    const m = card("Monthly report");
    expect(m).toHaveTextContent("Paused: its owner may no longer run it");
    expect(m).toHaveTextContent("2 clients: Mock Bakery, Mock Surf School");
    expect(m).toHaveTextContent("None while it is paused");
    expect(m).toHaveTextContent("1 earlier period missed");
    expect(within(m).getByRole("button", { name: "Resume the monthly report schedule" })).toBeInTheDocument();
  });
  it("says spend is tracked and never capped, and has no limit or cap control", () => {
    mount();
    expect(screen.getAllByText("AI spend is tracked, never capped.").length).toBeGreaterThan(0);
    expect(screen.queryByLabelText(/limit|cap|budget/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add a schedule" }));
    expect(within(dialog()).queryByLabelText(/limit|cap|budget/i)).toBeNull();
  });
  it("says there is nothing yet, in words, for an empty list", () => {
    mount([]);
    expect(screen.getByRole("status")).toHaveTextContent("No report is drafted by itself yet");
  });
  it("shows the last run's cost on request", async () => {
    vi.mocked(getRunProgress).mockResolvedValue({ ok: true, run: { runId: "r1", kind: "weekly", period: "2026-W41", status: "done", total: 12, done: 12, usage: { calls: 11, promptTokens: 19800, completionTokens: 7150, costUsd: 0.0671 } } });
    mount();
    fireEvent.click(within(card("Weekly report")).getByRole("button", { name: /Show this run/ }));
    await waitFor(() => expect(card("Weekly report")).toHaveTextContent("This run finished, 12 of 12 clients: 11 AI calls, 26,950 tokens, cost $0.0671."));
    expect(getRunProgress).toHaveBeenCalledWith("r1");
  });
});

describe("the add dialog", () => {
  const open = () => { mount(); fireEvent.click(screen.getByRole("button", { name: "Add a schedule" })); };

  it("opens as a labelled dialog with every control labelled, and shows the computed next runs", () => {
    open();
    const d = dialog();
    expect(d).toHaveAccessibleName("Add a report schedule");
    for (const label of ["Kind of report", "Day of the week", "Time of day"]) expect(within(d).getByLabelText(label)).toBeInTheDocument();
    expect(within(d).getByRole("radio", { name: /All clients/ })).toBeChecked();
    expect(d).toHaveTextContent("Next runs:");
    expect(d).toHaveTextContent("Monday 19 October at 08:00, for the week of 12 to 18 October 2026");
    expect(d).toHaveTextContent("Worked out here with Monday to Friday as working days");
    expect(d).toHaveTextContent("never capped");
  });
  it("shows the timing fields of the kind: a day of the month or the N-th working day for the long kinds", () => {
    open();
    const d = dialog();
    fireEvent.change(within(d).getByLabelText("Kind of report"), { target: { value: "monthly" } });
    expect(within(d).queryByLabelText("Day of the week")).toBeNull();
    expect(within(d).getByLabelText(/Which working day/)).toHaveValue("3");
    expect(d).toHaveTextContent("Wednesday 4 November at 08:00, for October 2026");
    fireEvent.change(within(d).getByLabelText("Runs on"), { target: { value: "day" } });
    fireEvent.change(within(d).getByLabelText(/Day of the month/), { target: { value: "15" } });
    expect(d).toHaveTextContent("Sunday 15 November at 08:00, for October 2026");
    fireEvent.change(within(d).getByLabelText("Kind of report"), { target: { value: "daily" } });
    expect(within(d).queryByLabelText(/Day of the month/)).toBeNull();
    expect(d).toHaveTextContent("Every day at 08:00, for the day before");
  });
  it("lists the open clients when only some are chosen, and refuses none chosen before the round trip", () => {
    open();
    const d = dialog();
    fireEvent.click(within(d).getByRole("radio", { name: /Only these clients/ }));
    expect(within(d).getAllByRole("checkbox").filter((c) => (c as HTMLInputElement).type === "checkbox")).toHaveLength(CLIENTS.length + 1); // the clients, and "switch it on now"
    fireEvent.click(screen.getByRole("button", { name: "Add schedule" }));
    expect(within(d).getByRole("alert")).toHaveTextContent("Choose at least one client");
    expect(saveSchedule).not.toHaveBeenCalled();
  });
  it("puts a bad time next to its field and does not call the server", () => {
    open();
    const d = dialog();
    fireEvent.change(within(d).getByLabelText("Time of day"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Add schedule" }));
    const at = within(d).getByLabelText("Time of day");
    expect(at).toHaveAttribute("aria-invalid", "true");
    expect(d).toHaveTextContent("Choose a time of day, from 00:00 to 23:59.");
    expect(saveSchedule).not.toHaveBeenCalled();
  });
  it("sends the server's body with a fresh id, then closes and refreshes", async () => {
    vi.mocked(saveSchedule).mockResolvedValue({ ok: true, schedule: sched({ kind: "daily" }), created: true });
    open();
    const d = dialog();
    fireEvent.change(within(d).getByLabelText("Kind of report"), { target: { value: "daily" } });
    fireEvent.change(within(d).getByLabelText("Time of day"), { target: { value: "06:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Add schedule" }));
    await waitFor(() => expect(saveSchedule).toHaveBeenCalledTimes(1));
    const body = vi.mocked(saveSchedule).mock.calls[0][0];
    expect(body).toMatchObject({ kind: "daily", scope: "all", timing: { at: "06:30" }, enabled: true });
    expect(typeof body.id).toBe("string");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(nav.refresh).toHaveBeenCalled();
    expect(screen.getByText(/Schedule added/)).toBeInTheDocument();
  });
  it("sends a chosen client list and a paused start when asked", async () => {
    vi.mocked(saveSchedule).mockResolvedValue({ ok: true, schedule: sched(), created: true });
    open();
    const d = dialog();
    fireEvent.click(within(d).getByRole("radio", { name: /Only these clients/ }));
    fireEvent.click(within(d).getByRole("checkbox", { name: "Mock Studio" }));
    fireEvent.click(within(d).getByRole("checkbox", { name: /Switch it on now/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add schedule" }));
    await waitFor(() => expect(saveSchedule).toHaveBeenCalled());
    expect(vi.mocked(saveSchedule).mock.calls[0][0]).toMatchObject({ scope: "chosen", engagementIds: ["e3"], enabled: false });
  });
  it("shows a 400 that names a field beside that field, and a 409 as a sentence", async () => {
    vi.mocked(saveSchedule).mockResolvedValueOnce(refusal("invalid_field", 400, { field: "timing.at" })).mockResolvedValueOnce(refusal("schedule_exists", 409, { detail: { scheduleId: "s1" } }));
    open();
    const d = dialog();
    fireEvent.click(screen.getByRole("button", { name: "Add schedule" }));
    await waitFor(() => expect(within(d).getByLabelText("Time of day")).toHaveAttribute("aria-invalid", "true"));
    fireEvent.click(await screen.findByRole("button", { name: "Add schedule" }));
    await waitFor(() => expect(within(d).getByRole("alert")).toHaveTextContent("already has an all-clients schedule for that report kind"));
    expect(d.textContent).not.toMatch(/schedule_exists/);
  });
  it("keeps focus in the dialog and closes on Escape", () => {
    open();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the edit dialog", () => {
  const open = (s = sched()) => { mount([s]); fireEvent.click(screen.getByRole("button", { name: /^Edit the/ })); };

  it("fixes the kind, fills the form from the schedule and sends only what changed", async () => {
    vi.mocked(editSchedule).mockResolvedValue({ ok: true });
    open();
    const d = dialog();
    expect(d).toHaveAccessibleName("Change the weekly schedule");
    expect(within(d).getByLabelText("Kind of report")).toBeDisabled();
    expect(within(d).getByLabelText("Time of day")).toHaveValue("08:00");
    fireEvent.change(within(d).getByLabelText("Time of day"), { target: { value: "09:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(editSchedule).toHaveBeenCalledWith("s1", { timing: { weekday: 1, at: "09:30" } }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText(/You are now its owner/)).toBeInTheDocument();
  });
  it("closes without a call when nothing changed", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(editSchedule).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("keeps a chosen client the list no longer offers, so an edit never drops it silently", () => {
    open(paused());
    const d = dialog();
    expect(within(d).getByRole("radio", { name: /Only these clients/ })).toBeChecked();
    expect(within(d).getByRole("checkbox", { name: "Mock Bakery" })).toBeChecked();
    expect(within(d).getByRole("checkbox", { name: "Mock Studio" })).not.toBeChecked();
  });
});

describe("pause, resume, delete and Run now", () => {
  it("pauses and resumes, saying who owns it after", async () => {
    vi.mocked(setScheduleOn).mockResolvedValue({ ok: true });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Pause the weekly report schedule" }));
    await waitFor(() => expect(setScheduleOn).toHaveBeenCalledWith("s1", false));
    await waitFor(() => expect(card("Weekly report")).toHaveTextContent("Paused. It will not run until someone resumes it."));
    const resume = await screen.findByRole("button", { name: "Resume the monthly report schedule" });
    await waitFor(() => expect(resume).toBeEnabled());
    fireEvent.click(resume);
    await waitFor(() => expect(setScheduleOn).toHaveBeenCalledWith("s2", true));
    await waitFor(() => expect(card("Monthly report")).toHaveTextContent("You are now its owner"));
    expect(nav.refresh).toHaveBeenCalled();
  });
  it("shows a refused resume in words on its card", async () => {
    vi.mocked(setScheduleOn).mockResolvedValue({ ok: false, refusal: { status: 409, error: "ai_drafting_off" }, message: scheduleRefusalText({ status: 409, error: "ai_drafting_off" }, "resume") });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Resume the monthly report schedule" }));
    await waitFor(() => expect(within(card("Monthly report")).getByRole("alert")).toHaveTextContent("drafted by hand"));
  });
  it("asks before deleting, and deletes only on the confirm", async () => {
    vi.mocked(deleteSchedule).mockResolvedValue({ ok: true });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Delete the weekly report schedule" }));
    expect(dialog()).toHaveAccessibleName("Delete this schedule?");
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(deleteSchedule).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete the weekly report schedule" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete schedule" }));
    await waitFor(() => expect(deleteSchedule).toHaveBeenCalledWith("s1"));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("was deleted"));
  });
  it("names the period Run now will draft, starts the run and links to its progress", async () => {
    vi.mocked(runScheduleNow).mockResolvedValue({ ok: true, answer: { started: true, runId: "r9", kind: "weekly", period: "2026-W41", total: 12 } });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Run the weekly report schedule now" }));
    expect(dialog()).toHaveTextContent("the week of 5 to 11 October 2026");
    expect(dialog()).toHaveTextContent("whether the schedule is on or paused");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Run now" }));
    await waitFor(() => expect(runScheduleNow).toHaveBeenCalledWith("s1"));
    await waitFor(() => expect(card("Weekly report")).toHaveTextContent("Started: drafting 12 clients for the week of 5 to 11 October 2026."));
    expect(within(card("Weekly report")).getByRole("link", { name: "See its progress and results" })).toHaveAttribute("href", "/departments/d-soc/social-reports?run=r9");
  });
  it("says so when the period was already run, linking to that run", async () => {
    vi.mocked(runScheduleNow).mockResolvedValue({ ok: true, answer: { started: false, runId: "r2", period: "2026-09" } });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Run the monthly report schedule now" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Run now" }));
    await waitFor(() => expect(card("Monthly report")).toHaveTextContent("already drafted September 2026, so nothing new was started"));
    expect(within(card("Monthly report")).getByRole("link", { name: "See that run's results" })).toHaveAttribute("href", "/departments/d-soc/social-reports?run=r2");
  });
  it("shows a Run now refusal in words", async () => {
    vi.mocked(runScheduleNow).mockResolvedValue({ ok: false, refusal: { status: 409, error: "generation_running", detail: { runId: "r5" } }, message: scheduleRefusalText({ status: 409, error: "generation_running" }, "run") });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Run the weekly report schedule now" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Run now" }));
    await waitFor(() => expect(within(card("Weekly report")).getByRole("alert")).toHaveTextContent("already being drafted"));
  });
});

describe("the section", () => {
  const section = (schedules: Parameters<typeof ReportAutomation>[0]["schedules"]) => <ReportAutomation deptId="d-soc" schedules={schedules} clients={CLIENTS} />;
  it("is hidden when nothing was read, because the person may not plan", () => {
    const { container } = render(section(null));
    expect(container).toBeEmptyDOMElement();
  });
  it("is hidden when the server refuses the read, never an empty section that implies there is nothing", () => {
    const { container } = render(section({ kind: "forbidden" }));
    expect(container).toBeEmptyDOMElement();
  });
  it("says it cannot tell when the read fails, and draws no empty list", () => {
    render(section({ kind: "unavailable", reason: "the server did not answer" }));
    expect(screen.getByRole("heading", { name: "Report automation" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("cannot be shown right now (the server did not answer)");
    expect(screen.queryByText(/No report is drafted/)).toBeNull();
  });
  it("draws the cards when the read is ok", () => {
    render(section({ kind: "ok", data: [sched()] }));
    expect(card("Weekly report")).toBeInTheDocument();
  });
});
