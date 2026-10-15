import { describe, it, expect, vi, beforeEach } from "vitest";

// DW-8g: the calendar-event writes and readers. The platform's refusals are put in words; nothing here decides who may
// do what (Cerbos does).
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn(async () => "u1") }));
vi.mock("./platform", async () => {
  const actual = await vi.importActual<typeof import("./platform")>("./platform");
  return {
    ...actual, platformFetch: vi.fn(),
    getMe: vi.fn(async () => ({ userId: "u1", assurance: "high", roles: [{ role: "member", scopeType: "company", scopeId: "co-a" }], companies: [{ id: "co-a", name: "Agency", type: "agency" }] })),
  };
});

import { platformFetch, PlatformError } from "./platform";
import { cancelEventAction, createEventAction, loadBusyAction, loadBusyExcludingEventAction, respondEventAction, updateEventAction } from "./calendarEventsActions";
import { getEvent, listMyEvents, EVENT_NOT_FOUND } from "./calendarEvents-data";
import { defaultFormInput } from "./calendarEvents";

const fetchMock = vi.mocked(platformFetch);
const input = { ...defaultFormInput("2026-10-14", "09:12"), title: "Kickoff", attendeeIds: ["u-made"] };
const refused = (status: number, reason: string, body?: unknown) => new PlatformError(status, reason, undefined, undefined, reason, body);

beforeEach(() => fetchMock.mockReset());

describe("createEventAction", () => {
  it("POSTs the checked body to the company and returns the event page's href", async () => {
    fetchMock.mockResolvedValue({ id: "e1" });
    const r = await createEventAction("co-a", input);
    expect(r).toEqual({ ok: true, id: "e1", href: "/calendar/events/e1?company=co-a" });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-a/calendar/events");
    const body = JSON.parse(String(fetchMock.mock.calls[0][2]?.body));
    expect(body).toMatchObject({ title: "Kickoff", attendeeIds: ["u-made"], visibility: "attendees" });
    expect(body.startsAt).toMatch(/Z$/);
  });

  it("checks the form before any request", async () => {
    const r = await createEventAction("co-a", { ...input, title: "" });
    expect(r).toEqual({ ok: false, error: "Give the meeting a title.", field: "title" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("names the person in a 422 when they are in the members list the page holds", async () => {
    fetchMock.mockRejectedValueOnce(refused(422, "attendee_not_member", { error: "attendee_not_member", detail: { userId: "u-made" } }));
    const r = await createEventAction("co-a", input, { "u-made": "Made Putra" });
    expect(r).toEqual({ ok: false, error: "Made Putra isn't an active member of this company, so they can't be invited." });
  });

  it("words a 403 as a refusal to schedule, not as an edit refusal", async () => {
    fetchMock.mockRejectedValueOnce(refused(403, "forbidden"));
    expect(await createEventAction("co-a", input)).toMatchObject({ ok: false, error: "You can't schedule meetings in this company." });
  });

  it("refuses a company the caller is not in, without calling the platform", async () => {
    expect(await createEventAction("co-zzz", input)).toEqual({ ok: false, error: "Select a company first." });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("updateEventAction", () => {
  it("PATCHes, clearing a blank place with null, and never sends record", async () => {
    fetchMock.mockResolvedValue({});
    const r = await updateEventAction("co-a", "e1", { ...input, record: true });
    expect(r).toMatchObject({ ok: true, href: "/calendar/events/e1?company=co-a" });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-a/calendar/events/e1");
    expect(fetchMock.mock.calls[0][2]?.method).toBe("PATCH");
    const body = JSON.parse(String(fetchMock.mock.calls[0][2]?.body));
    expect(body.location).toBeNull();
    expect(body).not.toHaveProperty("record");
  });

  it("words 409 on a cancelled event, 404 and 400", async () => {
    fetchMock.mockRejectedValueOnce(refused(409, "event_cancelled"));
    expect(await updateEventAction("co-a", "e1", input)).toMatchObject({ error: expect.stringMatching(/was cancelled/) });
    fetchMock.mockRejectedValueOnce(refused(404, "not_found"));
    expect(await updateEventAction("co-a", "e1", input)).toMatchObject({ error: "This event doesn't exist or isn't visible to you." });
    fetchMock.mockRejectedValueOnce(refused(400, "time_span_too_long"));
    expect(await updateEventAction("co-a", "e1", input)).toMatchObject({ error: expect.stringMatching(/14 days/) });
  });
});

describe("cancelEventAction and respondEventAction", () => {
  it("POSTs to /cancel with no body", async () => {
    fetchMock.mockResolvedValue({});
    expect(await cancelEventAction("co-a", "e1")).toMatchObject({ ok: true });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-a/calendar/events/e1/cancel");
    expect(fetchMock.mock.calls[0][2]?.body).toBeUndefined();
  });

  it("POSTs the answer to /respond", async () => {
    fetchMock.mockResolvedValue({});
    expect(await respondEventAction("co-a", "e1", "tentative")).toMatchObject({ ok: true });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-a/calendar/events/e1/respond");
    expect(JSON.parse(String(fetchMock.mock.calls[0][2]?.body))).toEqual({ response: "tentative" });
  });

  it("refuses an answer that is not one of the three, and words a 409 on a cancelled event", async () => {
    // @ts-expect-error a value the type forbids
    expect(await respondEventAction("co-a", "e1", "needs_action")).toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRejectedValueOnce(refused(409, "event_cancelled"));
    expect(await respondEventAction("co-a", "e1", "accepted")).toMatchObject({ ok: false, error: expect.stringMatching(/cancelled/) });
  });
});

describe("readers", () => {
  it("listMyEvents asks for the window and scope, and is unavailable (not empty) when the endpoint fails", async () => {
    fetchMock.mockResolvedValueOnce({ items: [], companies: [{ id: "co-a", name: "Agency", included: true }] });
    const ok = await listMyEvents("u1", { from: "2026-10-13T16:00:00.000Z", to: "2026-10-14T16:00:00.000Z", scope: "all" });
    expect(ok.unavailable).toBe(false);
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/calendar/events/mine?from=2026-10-13T16%3A00%3A00.000Z&to=2026-10-14T16%3A00%3A00.000Z&scope=all");
    fetchMock.mockRejectedValueOnce(new PlatformError(500, "boom"));
    const down = await listMyEvents("u1", { from: "a", to: "b" });
    expect(down.unavailable).toBe(true);
    expect(down.envelope.items).toEqual([]);
  });

  it("getEvent turns a 404 into the one sentence, a 403 into forbidden, and a failure into unavailable", async () => {
    fetchMock.mockRejectedValueOnce(refused(404, "not_found"));
    expect(await getEvent("u1", "co-a", "e1")).toEqual({ kind: "unavailable", reason: EVENT_NOT_FOUND });
    expect(EVENT_NOT_FOUND).toBe("This event doesn't exist or isn't visible to you.");
    fetchMock.mockRejectedValueOnce(refused(403, "forbidden"));
    expect(await getEvent("u1", "co-a", "e1")).toEqual({ kind: "forbidden" });
    fetchMock.mockRejectedValueOnce(new Error("socket hang up"));
    expect(await getEvent("u1", "co-a", "e1")).toEqual({ kind: "unavailable", reason: "socket hang up" });
    fetchMock.mockResolvedValueOnce({ id: "e1" });
    expect(await getEvent("u1", "co-a", "e1")).toEqual({ kind: "ok", data: { id: "e1" } });
  });
});

describe("loadBusyAction (DW-8o, BFF §47.4)", () => {
  const U1 = "0190a000-0000-7000-8000-000000000001", U2 = "0190a000-0000-7000-8000-000000000002";
  const FROM = "2026-10-13T16:00:00.000Z", TO = "2026-10-14T16:00:00.000Z";
  const answer = { busy: [{ userId: U1, intervals: [{ startsAt: "2026-10-14T02:00:00.000Z", endsAt: "2026-10-14T03:00:00.000Z" }] }, { userId: U2, intervals: [] }] };

  it("GETs /api/<company>/calendar/busy with the comma list and the window, and returns the people's times", async () => {
    fetchMock.mockResolvedValueOnce(answer);
    const r = await loadBusyAction("co-a", [U1, U2], FROM, TO);
    expect(r).toEqual({ ok: true, busy: answer.busy });
    const [url, , init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/co-a/calendar/busy?userIds=${U1},${U2}&from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`);
    expect(init).toBeUndefined(); // a plain GET: no method, no body
  });

  it("passes excludeEventId when given (the edit page), and the bound edit action puts the event id there", async () => {
    fetchMock.mockResolvedValue(answer);
    await loadBusyAction("co-a", [U1], FROM, TO, "ev-1");
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/&excludeEventId=ev-1$/);
    await loadBusyExcludingEventAction("co-a", "ev-2", [U1], FROM, TO);
    expect(String(fetchMock.mock.calls[1][0])).toMatch(/&excludeEventId=ev-2$/);
  });

  it("never throws into the form: a refusal, a failure, a malformed answer, a company the caller is not in and a bad list are each { ok: false }", async () => {
    fetchMock.mockRejectedValueOnce(refused(403, "forbidden"));
    expect(await loadBusyAction("co-a", [U1], FROM, TO)).toEqual({ ok: false });
    fetchMock.mockRejectedValueOnce(new Error("socket hang up"));
    expect(await loadBusyAction("co-a", [U1], FROM, TO)).toEqual({ ok: false });
    fetchMock.mockRejectedValueOnce(refused(422, "user_not_member", { error: "user_not_member", detail: { userId: U2 } }));
    expect(await loadBusyAction("co-a", [U1, U2], FROM, TO)).toEqual({ ok: false });
    for (const bad of [null, {}, { busy: "x" }, { busy: [{ userId: U1 }] }, { busy: [{ userId: U1, intervals: [{ startsAt: 1, endsAt: "x" }] }] }]) {
      fetchMock.mockResolvedValueOnce(bad);
      expect(await loadBusyAction("co-a", [U1], FROM, TO), JSON.stringify(bad)).toEqual({ ok: false });
    }
    fetchMock.mockClear();
    expect(await loadBusyAction("co-zzz", [U1], FROM, TO)).toEqual({ ok: false });
    expect(await loadBusyAction("co-a", [], FROM, TO)).toEqual({ ok: false });
    expect(await loadBusyAction("co-a", Array.from({ length: 21 }, (_, i) => `u${i}`), FROM, TO)).toEqual({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is a read: it revalidates nothing", async () => {
    const { revalidatePath } = await import("next/cache");
    vi.mocked(revalidatePath).mockClear();
    fetchMock.mockResolvedValueOnce(answer);
    await loadBusyAction("co-a", [U1], FROM, TO);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
