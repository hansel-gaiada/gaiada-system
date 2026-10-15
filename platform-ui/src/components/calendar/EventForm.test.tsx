import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));

import { EventForm, type SaveEventAction } from "./EventForm";
import { defaultFormInput } from "@/lib/calendarEvents";

const members = [{ id: "u-me", name: "Clement Hansel" }, { id: "u-dewi", name: "Dewi Santoso" }, { id: "u-made", name: "Made Putra" }];
const initial = { ...defaultFormInput("2026-10-14", "09:12"), title: "Kickoff" };

const draw = (over: Partial<Parameters<typeof EventForm>[0]> = {}) => {
  const save = vi.fn<SaveEventAction>(async () => ({ ok: true, id: "e1", href: "/calendar/events/e1?company=co-a" }));
  render(
    <EventForm
      mode="create" initial={initial} members={members} clients={[{ id: "c1", name: "Northwind" }, { id: "c2", name: "Cedar" }]}
      projects={[{ id: "p1", name: "Web redesign", clientId: "c1" }, { id: "p2", name: "SEO", clientId: "c2" }]}
      canRecord={false} hiddenPersonId="u-me" zoneLabel="Asia/Singapore" save={save} cancelHref="/calendar" {...over}
    />,
  );
  return save;
};
const submit = () => fireEvent.click(screen.getByRole("button", { name: /Schedule|Save changes/ }));

beforeEach(() => push.mockClear());
afterEach(cleanup);

describe("EventForm", () => {
  it("says which clock the times are in", () => {
    draw();
    expect(screen.getByText("Times are in Asia/Singapore.")).toBeInTheDocument();
  });

  it("answers an empty title with its sentence, and does not call the platform", () => {
    const save = draw({ initial: { ...initial, title: "" } });
    submit();
    expect(screen.getByRole("alert")).toHaveTextContent("Give the meeting a title.");
    expect(save).not.toHaveBeenCalled();
  });

  it("answers an end before the start with its sentence", () => {
    const save = draw();
    fireEvent.change(screen.getByLabelText("Ends"), { target: { value: "09:00" } });
    submit();
    expect(screen.getByRole("alert")).toHaveTextContent("The end must be after the start.");
    expect(save).not.toHaveBeenCalled();
  });

  it("answers a non-https video link with its sentence", () => {
    draw();
    fireEvent.change(screen.getByLabelText("Video link"), { target: { value: "http://meet.example.com" } });
    submit();
    expect(screen.getByRole("alert")).toHaveTextContent("The video link must be a web address starting with https://.");
  });

  it("switches to first and last day for an all-day event and checks them", () => {
    draw({ initial: { ...initial, allDay: true, startDate: "2026-10-16", endDate: "2026-10-15" } });
    expect(screen.queryByLabelText("Starts")).not.toBeInTheDocument();
    submit();
    expect(screen.getByRole("alert")).toHaveTextContent("The last day can't be before the first day.");
  });

  it("does not list the organizer as someone to invite, and sends the people ticked", async () => {
    const save = draw();
    expect(screen.queryByLabelText("Clement Hansel")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Dewi Santoso"));
    submit();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0].attendeeIds).toEqual(["u-dewi"]);
    // The members list goes along, so a 422 can name the person.
    expect(save.mock.calls[0][1]).toMatchObject({ "u-dewi": "Dewi Santoso" });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/calendar/events/e1?company=co-a"));
  });

  it("shows the platform's refusal in words and stays on the form", async () => {
    const save = draw();
    save.mockResolvedValueOnce({ ok: false, error: "Made Putra isn't an active member of this company, so they can't be invited." });
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("Made Putra isn't an active member");
    expect(push).not.toHaveBeenCalled();
  });

  it("offers 'Record this meeting' only where the Meetings row is, with the visibility line", () => {
    draw({ canRecord: false });
    expect(screen.queryByLabelText("Record this meeting")).not.toBeInTheDocument();
    cleanup();
    draw({ canRecord: true });
    expect(screen.getByLabelText(/Record this meeting/)).toBeInTheDocument();
    expect(screen.getByText(/Recordings are visible to everyone in the company\./)).toBeInTheDocument();
  });

  it("does not offer recording when editing", () => {
    draw({ mode: "edit", canRecord: true });
    expect(screen.queryByLabelText(/Record this meeting/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument();
  });

  it("names both visibilities as the contract words them", () => {
    draw();
    const sel = screen.getByLabelText("Who can see it") as HTMLSelectElement;
    expect([...sel.options].map((o) => o.textContent)).toEqual(["Only the people invited", "Everyone in the company"]);
  });

  it("narrows the projects to the chosen client", () => {
    draw();
    const client = screen.getByLabelText("Client (optional)");
    fireEvent.change(client, { target: { value: "c2" } });
    const proj = screen.getByLabelText("Project (optional)") as HTMLSelectElement;
    expect([...proj.options].map((o) => o.textContent)).toEqual(["No project", "SEO"]);
  });
});

// DW-8o (§47.4, DW-D28): "Busy that day". The display zone is Asia/Singapore (UTC+8), so 2026-10-14 is 2026-10-13T16:00Z to
// 2026-10-14T16:00Z and 10:00 there is 02:00Z.
describe("EventForm: busy that day", () => {
  type LB = NonNullable<Parameters<typeof EventForm>[0]["loadBusy"]>;
  const mine = { userId: "u-me", intervals: [{ startsAt: "2026-10-14T02:00:00.000Z", endsAt: "2026-10-14T03:30:00.000Z" }] }; // 10:00-11:30
  const dewi = { userId: "u-dewi", intervals: [{ startsAt: "2026-10-14T06:00:00.000Z", endsAt: "2026-10-14T07:00:00.000Z" }, { startsAt: "2026-10-14T01:00:00.000Z", endsAt: "2026-10-14T01:30:00.000Z" }] }; // 09:00-09:30, 14:00-15:00
  const made = { userId: "u-made", intervals: [] };
  const answer = (...busy: (typeof mine)[]) => vi.fn<LB>(async () => ({ ok: true, busy }));
  const withTimes = { ...initial, startTime: "10:00", endTime: "11:00", attendeeIds: ["u-dewi", "u-made"] };
  const block = () => screen.getByRole("region", { name: "Busy that day" });

  it("shows each person's busy times for the picked day in the display zone, 'Free', and 'You' for the organizer", async () => {
    const loadBusy = answer(mine, dewi, made);
    draw({ initial: withTimes, loadBusy });
    expect(await within(block()).findByText("Dewi Santoso")).toBeInTheDocument();
    const rows = within(block()).getAllByRole("listitem").map((li) => li.textContent);
    expect(rows).toEqual([
      "You 10:00-11:30 Clashes with the chosen time",
      "Dewi Santoso 09:00-09:30, 14:00-15:00",
      "Made Putra Free",
    ]);
    expect(within(block()).getByRole("heading", { name: "Busy that day" })).toBeInTheDocument();
    // the window is the picked day, 00:00 to 24:00 in the display zone, and the people are the organizer then the invited
    expect(loadBusy).toHaveBeenCalledTimes(1);
    expect(loadBusy).toHaveBeenCalledWith(["u-me", "u-dewi", "u-made"], "2026-10-13T16:00:00.000Z", "2026-10-14T16:00:00.000Z");
  });

  it("calls a clash out in words, only on the people it touches, and follows the chosen time without another request", async () => {
    const loadBusy = answer(mine, dewi, made);
    draw({ initial: { ...withTimes, startTime: "14:30", endTime: "15:30" }, loadBusy });
    await within(block()).findByText("Dewi Santoso");
    const clashing = () => within(block()).queryAllByText("Clashes with the chosen time").map((n) => n.closest("li")?.textContent);
    expect(clashing()).toEqual(["Dewi Santoso 09:00-09:30, 14:00-15:00 Clashes with the chosen time"]);
    fireEvent.change(screen.getByLabelText("Starts"), { target: { value: "11:30" } });
    fireEvent.change(screen.getByLabelText("Ends"), { target: { value: "12:30" } });
    expect(clashing()).toEqual([]); // touching at 11:30 is not a clash
    expect(loadBusy).toHaveBeenCalledTimes(1);
  });

  it("says it is checking while it waits, and 'unavailable' when the read fails: never an empty block that reads as everyone free", async () => {
    let release: (r: Awaited<ReturnType<LB>>) => void = () => {};
    const loadBusy = vi.fn<LB>(() => new Promise((res) => { release = res; }));
    draw({ initial: withTimes, loadBusy });
    expect(block()).toHaveTextContent("Checking busy times...");
    expect(screen.queryByText("Free")).not.toBeInTheDocument();
    await waitFor(() => expect(loadBusy).toHaveBeenCalled());
    release({ ok: false });
    expect(await screen.findByText("Busy times are unavailable right now.")).toBeInTheDocument();
    expect(screen.queryByText("Free")).not.toBeInTheDocument();
    expect(within(block()).queryAllByRole("listitem")).toHaveLength(0);
  });

  it("a read that throws is also 'unavailable'", async () => {
    draw({ initial: withTimes, loadBusy: vi.fn<LB>(async () => { throw new Error("boom"); }) });
    expect(await screen.findByText("Busy times are unavailable right now.")).toBeInTheDocument();
  });

  it("draws no block for an all-day event, and none when the form has no loadBusy", async () => {
    const loadBusy = answer(mine);
    draw({ initial: { ...withTimes, allDay: true }, loadBusy });
    expect(screen.queryByRole("region", { name: "Busy that day" })).not.toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 600));
    expect(loadBusy).not.toHaveBeenCalled();
    cleanup();
    draw({ initial: withTimes });
    expect(screen.queryByText("Busy that day")).not.toBeInTheDocument();
    expect(screen.queryByText("Checking busy times...")).not.toBeInTheDocument();
  });

  it("a day change reads again, and the slow answer for the OLD day is ignored", async () => {
    let first: (r: Awaited<ReturnType<LB>>) => void = () => {};
    const loadBusy = vi.fn<LB>()
      .mockImplementationOnce(() => new Promise((res) => { first = res; }))
      .mockResolvedValue({ ok: true, busy: [{ userId: "u-me", intervals: [] }, { userId: "u-dewi", intervals: [] }, made] });
    draw({ initial: withTimes, loadBusy });
    await waitFor(() => expect(loadBusy).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-10-15" } });
    await waitFor(() => expect(loadBusy).toHaveBeenCalledTimes(2));
    expect(loadBusy.mock.calls[1].slice(1)).toEqual(["2026-10-14T16:00:00.000Z", "2026-10-15T16:00:00.000Z"]);
    await waitFor(() => expect(within(block()).getAllByText("Free")).toHaveLength(3));
    // the slow answer for 14 October arrives last: it must not replace the 15th's
    await act(async () => { first({ ok: true, busy: [mine, dewi, made] }); });
    expect(within(block()).getAllByText("Free")).toHaveLength(3);
    expect(within(block()).queryByText("Clashes with the chosen time")).not.toBeInTheDocument();
  });

  it("waits ~400 ms after the last change before it asks, so typing a day or ticking people is one read", async () => {
    const loadBusy = answer(mine, dewi, made);
    draw({ initial: withTimes, loadBusy });
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-10-15" } });
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-10-16" } });
    await new Promise((r) => setTimeout(r, 150));
    expect(loadBusy).not.toHaveBeenCalled();
    await waitFor(() => expect(loadBusy).toHaveBeenCalledTimes(1));
    expect(loadBusy.mock.calls[0][1]).toBe("2026-10-15T16:00:00.000Z");
  });

  it("reads again when a person is ticked, and the organizer is included even with nobody invited", async () => {
    const loadBusy = vi.fn<LB>(async (ids) => ({ ok: true, busy: ids.map((userId) => ({ userId, intervals: [] })) }));
    draw({ initial: { ...initial, attendeeIds: [] }, loadBusy });
    await waitFor(() => expect(loadBusy).toHaveBeenCalledTimes(1));
    expect(loadBusy.mock.calls[0][0]).toEqual(["u-me"]);
    expect(await within(block()).findByText("You")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Dewi Santoso"));
    await waitFor(() => expect(loadBusy).toHaveBeenCalledTimes(2));
    expect(loadBusy.mock.calls[1][0]).toEqual(["u-me", "u-dewi"]);
  });

  it("on the edit page a company admin who is not the organizer is named, not 'You', and the organizer is read", async () => {
    const loadBusy = vi.fn<LB>(async (ids) => ({ ok: true, busy: ids.map((userId) => ({ userId, intervals: [] })) }));
    draw({ mode: "edit", initial: { ...withTimes, attendeeIds: ["u-dewi"] }, hiddenPersonId: "u-made", viewerId: "u-me", loadBusy });
    await within(block()).findByText("Dewi Santoso");
    expect(within(block()).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Made Putra Free", "Dewi Santoso Free"]);
  });

  it("does not ask for more than 20 people, and says so", async () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ id: `u-${i}`, name: `Person ${i}` }));
    const loadBusy = answer(mine);
    draw({ members: [...members, ...many], initial: { ...withTimes, attendeeIds: many.map((m) => m.id) }, loadBusy });
    expect(screen.getByText(/Busy times are shown for up to 20 people at a time\./)).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 600));
    expect(loadBusy).not.toHaveBeenCalled();
  });
});
