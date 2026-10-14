import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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
