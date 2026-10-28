import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, render, screen, within, fireEvent, waitFor } from "@testing-library/react";

// SCP-3e (BFF §63.10; plan §8 row 3e): the Social Media calendar's grid. Every client's posts on a Monday-first month, a chip edged in its phase, holidays and leave
// beside them, the Composer's posts kept read-only; a date moves by the server's `dateMove` on each item (an edit, or Reschedule with the client asked again, or
// locked), by drag and by the keyboard path; and a day's "+", offered to a client's officer or an approver, plans a post through the client page's create flow.
const refresh = vi.fn();
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
vi.mock("@/lib/socialPipelineActions", () => ({ runPostAction: vi.fn(), savePostFields: vi.fn() }));
vi.mock("@/lib/socialClientActions", () => ({ createClientPost: vi.fn(), bulkPostAction: vi.fn() }));

import { runPostAction, savePostFields, type WriteResult } from "@/lib/socialPipelineActions";
import { createClientPost } from "@/lib/socialClientActions";
import { asComposerEntries, placeItem, planClients, type DayItem, type DayNote } from "@/lib/socialCalendar";
import type { AllocationRow } from "@/lib/socialAllocation";
import { SocialCalendar } from "./SocialCalendar";

const run = vi.mocked(runPostAction);
const save = vi.mocked(savePostFields);
const create = vi.mocked(createClientPost);

const ok = (): WriteResult => ({ ok: true, post: null, applied: null, warnings: [], alreadyApplied: false, designId: null });
const refused = (error: string, message: string, extra: Record<string, unknown> = {}): WriteResult => ({ ok: false, refusal: { status: 409, error, ...extra }, message });

type Move = Pick<DayItem, "dateMove" | "dateMoveRefusal">;
const EDIT: Move = { dateMove: "edit", dateMoveRefusal: null };
const RESCHEDULE: Move = { dateMove: "reschedule", dateMoveRefusal: null };
const LOCKED: Move = { dateMove: "locked", dateMoveRefusal: "field_locked" };
const LIVE: Move = { dateMove: "locked", dateMoveRefusal: "post_is_live" };
const item = (over: Partial<DayItem> & Move & { postId: string; pipelineStatus: string; phase: string | null; scheduledAt: string }): DayItem => placeItem({
  clientName: "Brand Alpha", title: `Post ${over.postId}`, format: "feed", simulated: false, ...over,
});
// 09:30 in Singapore is 01:30 UTC.
const at = (day: string) => `${day}T01:30:00.000Z`;
const items: DayItem[] = [
  item({ postId: "p-draft", title: "Harvest teaser", pipelineStatus: "drafting", phase: "brief", scheduledAt: at("2026-10-20"), ...EDIT }),
  item({ postId: "p-appr", title: "Studio day", pipelineStatus: "approved", phase: "client_approved", scheduledAt: at("2026-10-21"), ...RESCHEDULE }),
  item({ postId: "p-sched", title: "Open late", pipelineStatus: "scheduled", phase: "client_approved", scheduledAt: at("2026-10-22"), ...RESCHEDULE }),
  item({ postId: "p-client", title: "With the client", pipelineStatus: "client", phase: "with_client", scheduledAt: at("2026-10-23"), simulated: true, ...LOCKED }),
  item({ postId: "p-live", title: "Gone live", pipelineStatus: "live", phase: "posted", scheduledAt: at("2026-10-14"), ...LIVE }),
  item({ postId: "p-cchg", title: "Client changes", pipelineStatus: "changes", phase: "client_changes", scheduledAt: at("2026-10-26"), ...LOCKED }),
  item({ postId: "p-tchg", title: "Team fix", pipelineStatus: "changes", phase: "brief", scheduledAt: at("2026-10-19"), ...EDIT }),
];
const notes: Record<string, DayNote[]> = {
  "2026-10-09": [{ key: "h", kind: "holiday", label: "Nyepi", detail: "Public holiday" }],
  "2026-10-13": [{ key: "a", kind: "away", label: "Maya Putri · vacation", detail: "" }],
};
const composer = asComposerEntries([{ id: "c-1", title: "Weekly promo", status: "approved", engagementId: "e-1", scheduledAt: at("2026-10-27"), pipelineStatus: null }]);
const row = (over: Partial<AllocationRow> = {}): AllocationRow => ({
  engagementId: "e-alpha", clientId: "c-alpha", clientName: "Brand Alpha", status: "active", officer: { id: "u-2", name: "Sam Officer" }, postsPerCycle: 5,
  creativeSource: "creatives", deliveryBatch: "A", reportFormat: "email", reportDueDay: 5, platforms: ["instagram", "tiktok"], formats: ["feed"], defaultPostTime: "09:30",
  stepEstimates: {}, thisCycle: { cycleId: "cy-1", month: "2026-10", target: 5, counted: 1, extra: 0, stories: 0 }, canPlan: false, ...over,
});
// The viewer, u-2, is the officer of Alpha and Beta (Beta has no cycle this month); Gamma's officer is somebody else, so the viewer may not plan for it.
const clients = planClients([
  row(), row({ engagementId: "e-beta", clientName: "Brand Beta", thisCycle: null }),
  row({ engagementId: "e-gamma", clientName: "Brand Gamma", officer: { id: "u-9", name: "Other Officer" } }),
], null, "2026-10", "u-2");

const mount = (over: Partial<Parameters<typeof SocialCalendar>[0]> = {}) => render(
  <SocialCalendar deptId="d-soc" month="2026-10" today="2026-10-16" items={items} composer={composer} notes={notes} clients={clients} summary="7 pipeline posts." {...over} />,
);
const cell = (day: string) => document.querySelector<HTMLElement>(`td[data-day="${day}"]`)!;
const chip = (title: string) => screen.getByRole("link", { name: new RegExp(title) });
const dt = () => ({ dataTransfer: { setData: vi.fn(), getData: vi.fn(), effectAllowed: "move" } });
function drag(title: string, day: string) {
  fireEvent.dragStart(chip(title), dt());
  fireEvent.dragOver(cell(day), dt());
  fireEvent.drop(cell(day), dt());
}

beforeEach(() => { refresh.mockReset(); run.mockReset().mockResolvedValue(ok()); save.mockReset().mockResolvedValue(ok()); create.mockReset(); });

describe("the grid", () => {
  it("is a table, Monday first, with the month in its caption and today marked", () => {
    mount();
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(within(table).getByText(/October 2026, weeks start on Monday\. 7 pipeline posts\./)).toBeInTheDocument();
    // 1 October 2026 is a Thursday: the first row starts on Monday 28 September.
    expect(table.querySelector("tbody tr td")!.getAttribute("data-day")).toBe("2026-09-28");
    expect(cell("2026-10-16").className).toContain("scp-cal__today");
    expect(within(cell("2026-10-16")).getByText("(today)")).toBeInTheDocument();
    expect(cell("2026-09-30").className).toContain("scp-cal__out");
  });

  it("draws each post as a link to its page, edged in its phase, with its phase and status said in words", () => {
    mount();
    const c = chip("Harvest teaser");
    expect(c).toHaveAttribute("href", "/departments/d-soc/posts/p-draft");
    expect(c.getAttribute("data-phase")).toBe("brief");
    expect(c.getAttribute("style")).toContain("--scp-phase: var(--status-idle)");
    expect(c).toHaveTextContent("09:30");
    expect(c).toHaveTextContent("Brand Alpha");
    expect(c).toHaveTextContent("Brief, Drafting");
    expect(chip("Studio day").getAttribute("style")).toContain("var(--status-ok)");
    expect(chip("With the client").getAttribute("style")).toContain("var(--status-info)");
    expect(chip("Client changes").getAttribute("style")).toContain("var(--status-warning)");
    expect(chip("Gone live").getAttribute("style")).toContain("var(--status-neutral)");
  });

  it("marks a simulated post SIMULATED", () => {
    mount();
    expect(chip("With the client")).toHaveTextContent("SIMULATED");
    expect(chip("Harvest teaser")).not.toHaveTextContent("SIMULATED");
  });

  it("shows a holiday and a colleague on leave in words, as information and not as links", () => {
    mount();
    expect(within(cell("2026-10-09")).getByText("Nyepi")).toBeInTheDocument();
    expect(within(cell("2026-10-09")).getByText("Holiday:")).toBeInTheDocument();
    expect(within(cell("2026-10-13")).getByText("Away:")).toBeInTheDocument();
    expect(within(cell("2026-10-13")).getByText("Maya Putri · vacation")).toBeInTheDocument();
    expect(within(cell("2026-10-13")).queryByRole("link")).toBeNull();
  });

  it("keeps the Composer's posts, as read-only links to the Composer that cannot be dragged", () => {
    mount();
    const c = screen.getByRole("link", { name: /Weekly promo/ });
    expect(c).toHaveAttribute("href", "/departments/d-soc/composer/c-1");
    expect(c).toHaveTextContent("Composer post, approved");
    expect(c.getAttribute("draggable")).not.toBe("true");
    expect(within(cell("2026-10-27")).queryByRole("button", { name: /Move to date/ })).toBeNull();
  });
});

describe("dragging a date by the fixture's rule", () => {
  it("makes only the posts whose date the server says can move draggable, and says why in the title of the others", () => {
    mount();
    for (const t of ["Harvest teaser", "Studio day", "Open late", "Team fix"]) expect(chip(t), t).toHaveAttribute("draggable", "true");
    for (const t of ["With the client", "Gone live", "Client changes"]) expect(chip(t), t).toHaveAttribute("draggable", "false");
    expect(chip("Gone live").getAttribute("title")).toContain("Date locked: The post is live, so its date cannot change.");
    expect(chip("With the client").getAttribute("title")).toContain("Date locked: The client is looking at it.");
    expect(chip("Client changes").getAttribute("title")).toContain("Date locked: The post is back for a design change or a change the client asked for");
    expect(chip("Gone live")).toHaveTextContent("date locked");
  });

  it("tells a team copy change (an edit) from a locked change by the server's answer, not by the status or the phase", () => {
    // Both are `changes` in In production; the page cannot tell them apart, the server does.
    mount({ items: [
      item({ postId: "a", title: "Team copy fix", pipelineStatus: "changes", phase: "in_production", scheduledAt: at("2026-10-20"), ...EDIT }),
      item({ postId: "b", title: "Design change", pipelineStatus: "changes", phase: "in_production", scheduledAt: at("2026-10-21"), ...LOCKED }),
    ] });
    expect(chip("Team copy fix")).toHaveAttribute("draggable", "true");
    expect(chip("Design change")).toHaveAttribute("draggable", "false");
  });

  it("says why a locked post cannot move when it is dropped on a day, and sends nothing", async () => {
    mount();
    drag("Gone live", "2026-10-28");
    expect(await screen.findByText(/"Gone live" cannot be moved\. The post is live, so its date cannot change\./)).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("moves a drafting post at once by editing its date, keeping the time of day, and refreshes", async () => {
    mount();
    drag("Harvest teaser", "2026-10-27");
    await waitFor(() => expect(save).toHaveBeenCalledWith("p-draft", "drafting", { scheduledAt: "2026-10-27T01:30:00.000Z" }));
    expect(run).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(await screen.findByText('Moved "Harvest teaser" to Tue 27 Oct 2026 at 09:30.')).toBeInTheDocument();
  });

  it("does nothing for a drop on the day the post is already on, or on nothing", () => {
    mount();
    drag("Harvest teaser", "2026-10-20");
    fireEvent.drop(cell("2026-10-27"), dt());
    expect(save).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("asks before moving an approved post: the client will be asked again, and nothing is sent until it is confirmed", async () => {
    mount();
    drag("Studio day", "2026-10-28");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/The client will be asked to approve Wed 28 Oct 2026 at 09:30 again, on every network/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/unscheduled first/)).toBeNull();
    expect(within(dialog).getByLabelText("New date")).toHaveValue("2026-10-28");
    expect(run).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Move and ask the client again" }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(run).toHaveBeenCalledWith("p-appr", { action: "reschedule", expectedStatus: "approved", actionId: expect.stringMatching(/^[0-9a-f-]{36}$/), at: "2026-10-28T01:30:00.000Z" });
    expect(save).not.toHaveBeenCalled();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(await screen.findByText(/Moved "Studio day" to Wed 28 Oct 2026 at 09:30\. The client will be asked to approve it again\./)).toBeInTheDocument();
  });

  it("says a scheduled post is unscheduled first, and reschedules it with the status the page showed", async () => {
    mount();
    drag("Open late", "2026-10-29");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/unscheduled first, and any dispatch queued for the old date is cancelled/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Move and ask the client again" }));
    await waitFor(() => expect(run).toHaveBeenCalledWith("p-sched", expect.objectContaining({ action: "reschedule", expectedStatus: "scheduled", at: "2026-10-29T01:30:00.000Z" })));
  });

  it("sends nothing when the confirm is cancelled", async () => {
    mount();
    drag("Studio day", "2026-10-28");
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(run).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("shows the server's refusal in words, with the dialog still open for a confirmed move", async () => {
    run.mockResolvedValue(refused("dispatch_in_flight", "A network is publishing this post right now. Try again in a moment."));
    mount();
    drag("Open late", "2026-10-29");
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Move and ask the client again" }));
    expect(await screen.findByText("A network is publishing this post right now. Try again in a moment.")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("shows the refusal of an edit on the page, and refreshes when someone has moved the post on", async () => {
    save.mockResolvedValue(refused("status_changed", "Someone moved this post while you were looking at it. It is now at Proofread. The page has been refreshed.", { detail: { status: "proofread" } }));
    mount();
    drag("Harvest teaser", "2026-10-27");
    expect(await screen.findByText(/Someone moved this post while you were looking at it/)).toBeInTheDocument();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});

describe("the keyboard path: Move to date…", () => {
  it("is a button on every post, named for the post, so a date can move without a pointer", () => {
    mount();
    expect(screen.getAllByRole("button", { name: /^Move to date: / })).toHaveLength(items.length);
    expect(screen.getByRole("button", { name: "Move to date: Brand Alpha, Harvest teaser" })).toBeEnabled();
  });

  it("moves an editable post to the chosen date, from the keyboard alone", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Move to date: Brand Alpha, Harvest teaser" }));
    const dialog = await screen.findByRole("dialog", { name: "Move to date" });
    expect(within(dialog).getByText(/Harvest teaser/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText("New date")).toHaveValue("2026-10-20");
    // The same day is not a move.
    fireEvent.click(within(dialog).getByRole("button", { name: "Move" }));
    expect(await within(dialog).findByText("Choose a different day from the one it is on.")).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText("New date"), { target: { value: "2026-10-30" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Move" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith("p-draft", "drafting", { scheduledAt: "2026-10-30T01:30:00.000Z" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(refresh).toHaveBeenCalled();
  });

  it("asks for the confirm on an approved post and says the client will be asked again before the date is chosen", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Move to date: Brand Alpha, Studio day" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/A new date means the client will be asked to approve it again, on every network/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("New date"), { target: { value: "2026-10-30" } });
    expect(within(dialog).getByText(/The client will be asked to approve Fri 30 Oct 2026 at 09:30 again/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Move and ask the client again" }));
    await waitFor(() => expect(run).toHaveBeenCalledWith("p-appr", expect.objectContaining({ action: "reschedule", at: "2026-10-30T01:30:00.000Z" })));
  });

  it("opens the reason, with no way to submit, for a post whose date is locked", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Move to date: Brand Alpha, Gone live" }));
    const dialog = await screen.findByRole("dialog", { name: "The date is locked" });
    expect(within(dialog).getByText("The post is live, so its date cannot change.")).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("New date")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Move" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(save).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("explains why the client's own change is locked, and what to do after their next approval", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Move to date: Brand Alpha, Client changes" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/the date stays as the client saw it. After the next approval, Reschedule asks the client again\./)).toBeInTheDocument();
  });

  it("shows the server's 409 field_locked in words if it refuses an edit the page offered", async () => {
    save.mockResolvedValue(refused("field_locked", "Date and time cannot be changed at Changes asked.", { detail: { field: "scheduledAt", status: "changes" } }));
    mount({ items: [item({ postId: "p-prod", title: "Final fix", pipelineStatus: "changes", phase: "in_production", scheduledAt: at("2026-10-20"), ...EDIT })] });
    fireEvent.click(screen.getByRole("button", { name: "Move to date: Brand Alpha, Final fix" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("New date"), { target: { value: "2026-10-22" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Move" }));
    expect(await within(dialog).findByText("Date and time cannot be changed at Changes asked.")).toBeInTheDocument();
  });
});

describe("planning a post on a day", () => {
  it("offers a + on each day of the month on show, and none on the dimmed days of the neighbouring months", () => {
    mount();
    expect(within(cell("2026-10-15")).getByRole("button", { name: "Plan a post on Thu 15 Oct 2026" })).toBeInTheDocument();
    expect(within(cell("2026-09-30")).queryByRole("button", { name: /Plan a post/ })).toBeNull();
    expect(within(cell("2026-11-01")).queryByRole("button", { name: /Plan a post/ })).toBeNull();
  });

  it("offers none when the clients could not be read", () => {
    mount({ clients: null });
    expect(screen.queryByRole("button", { name: /Plan a post/ })).toBeNull();
  });

  it("offers none to someone who is neither a client's officer nor an approver, and lists only the clients the viewer may plan for", async () => {
    mount({ clients: planClients([row({ canPlan: false }), row({ engagementId: "e-gamma", clientName: "Brand Gamma", officer: { id: "u-9", name: "Other Officer" } })], null, "2026-10", "u-other") });
    expect(screen.queryByRole("button", { name: /Plan a post/ })).toBeNull();
    cleanup();
    mount();
    fireEvent.click(within(cell("2026-10-15")).getByRole("button", { name: "Plan a post on Thu 15 Oct 2026" }));
    const select = within(await screen.findByRole("dialog")).getByLabelText("Client");
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Brand Alpha (yours)", "Brand Beta (yours) — no cycle in October 2026"]);
  });

  it("offers every client to an approver", async () => {
    mount({ clients: planClients([row({ canPlan: true }), row({ engagementId: "e-gamma", clientName: "Brand Gamma", canPlan: true, officer: { id: "u-9", name: "Other Officer" } })], null, "2026-10", "u-head") });
    fireEvent.click(within(cell("2026-10-15")).getByRole("button", { name: "Plan a post on Thu 15 Oct 2026" }));
    const select = within(await screen.findByRole("dialog")).getByLabelText("Client");
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Brand Alpha", "Brand Gamma"]);
  });

  it("chooses the client, lists one with no cycle as unavailable with its reason, and creates the post in that client's cycle at the default time", async () => {
    create.mockResolvedValue({ ok: true, postId: "new-1", created: true });
    mount();
    fireEvent.click(within(cell("2026-10-15")).getByRole("button", { name: "Plan a post on Thu 15 Oct 2026" }));
    const dialog = await screen.findByRole("dialog", { name: "Plan a post on Thu 15 Oct 2026" });
    const select = within(dialog).getByLabelText("Client");
    expect(within(select).getByRole("option", { name: /Brand Beta \(yours\) — no cycle in October 2026/ })).toBeDisabled();
    expect(within(select).getByRole("option", { name: "Brand Alpha (yours)" })).not.toBeDisabled();
    expect(within(select).queryByRole("option", { name: /Gamma/ })).toBeNull();
    expect(within(dialog).getByText(/Dated/)).toHaveTextContent("Thu 15 Oct 2026 at 09:30, Brand Alpha's default post time. Placed on Instagram, TikTok.");
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Pumpkin spice story" } });
    fireEvent.change(within(dialog).getByLabelText("Format"), { target: { value: "reel" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add to the plan" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledWith("cy-1", expect.objectContaining({
      title: "Pumpkin spice story", format: "reel", isExtra: false, scheduledAt: "2026-10-15T01:30:00.000Z", placement: ["instagram", "tiktok"], id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).toBeNull();
    const line = await screen.findByText(/Planned "Pumpkin spice story" for Brand Alpha on Thu 15 Oct 2026\./);
    expect(within(line.closest("p")!).getByRole("link", { name: "Open it" })).toHaveAttribute("href", "/departments/d-soc/posts/new-1");
  });

  it("asks for a title first, and shows the server's refusal in words", async () => {
    create.mockResolvedValue({ ok: false, error: "not_officer_or_approver", message: "Only this client's officer, the Social Media head, the GM, the owner or the superadmin can add a post to the cycle." });
    mount();
    fireEvent.click(within(cell("2026-10-15")).getByRole("button", { name: "Plan a post on Thu 15 Oct 2026" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Add to the plan" }));
    expect(await within(dialog).findByText("Give the post a title of 1 to 200 characters.")).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "A post" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add to the plan" }));
    expect(await within(dialog).findByText(/Only this client's officer, the Social Media head/)).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("says so, and disables adding, when no client has a cycle in the month", async () => {
    mount({ clients: planClients([row({ thisCycle: null })], null, "2026-10", "u-2") });
    fireEvent.click(within(cell("2026-10-15")).getByRole("button", { name: "Plan a post on Thu 15 Oct 2026" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/No client has a cycle in October 2026/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Add to the plan" })).toBeDisabled();
  });
});
