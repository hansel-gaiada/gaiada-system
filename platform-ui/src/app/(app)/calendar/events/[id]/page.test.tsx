import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// DW-10c-2 (BFF section 59.3): the event page says who can see an event. A department event reads "Visible to <unit>", the unit's name coming
// from the org tree; a unit that has left the tree (or a tree that could not be read) is still said, never left blank.
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", async (orig) => ({ ...(await orig<typeof import("@/lib/platform")>()), getMe: vi.fn() }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("@/lib/campaigns-data", () => ({ readOrgRoot: vi.fn() }));
vi.mock("@/lib/calendarEvents-data", () => ({ EVENT_NOT_FOUND: "This event doesn't exist or isn't visible to you.", getEvent: vi.fn() }));
vi.mock("@/lib/calendarEventsActions", () => ({ cancelEventAction: vi.fn(), respondEventAction: vi.fn() }));

import { getMe } from "@/lib/platform";
import { readOrgRoot } from "@/lib/campaigns-data";
import { getEvent } from "@/lib/calendarEvents-data";
import { agencyTree, me as meFixture, member } from "@/lib/workspaceFixtures";
import type { CalendarEventDetail } from "@/lib/calendarEvents";
import EventPage from "./page";

const detail = (over: Partial<CalendarEventDetail> = {}): CalendarEventDetail => ({
  id: "e1", tenantId: "co-a", title: "Sprint review", description: "", startsAt: "2026-10-14T06:00:00.000Z", endsAt: "2026-10-14T07:00:00.000Z", allDay: false,
  startsOn: null, endsOn: null, location: null, videoUrl: null, visibility: "attendees", unitNodeId: null, status: "confirmed", cancelledAt: null,
  organizer: { id: "u-2", name: "Ketut Arta" }, attendees: [], attendeeCount: 0, myResponse: null, recording: null, client: null, project: null,
  href: "/calendar/events/e1?company=co-a", canEdit: false, canCancel: false, canRespond: false, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", ...over,
});
const mount = async (ev: CalendarEventDetail) => {
  vi.mocked(getEvent).mockResolvedValue({ kind: "ok", data: ev });
  return render(await EventPage({ params: Promise.resolve({ id: ev.id }), searchParams: Promise.resolve({}) }));
};
const who = () => screen.getByText("Who can see it").nextElementSibling;

beforeEach(() => {
  vi.mocked(getMe).mockReset().mockResolvedValue(meFixture([member()]));
  vi.mocked(readOrgRoot).mockReset().mockResolvedValue(agencyTree() as never);
  vi.mocked(getEvent).mockReset();
});

describe("Who can see it", () => {
  it("says 'Visible to <unit>' for a department event, with the unit's name from the org tree", async () => {
    await mount(detail({ visibility: "department", unitNodeId: "d-web" }));
    expect(who()).toHaveTextContent("Visible to Web Dev");
    expect(readOrgRoot).toHaveBeenCalledWith(expect.anything(), "co-a");
  });

  it("names a division too", async () => {
    await mount(detail({ visibility: "department", unitNodeId: "dv-fe" }));
    expect(who()).toHaveTextContent("Visible to Frontend");
  });

  it("still says it for a unit that has left the tree, and when the tree cannot be read", async () => {
    const first = await mount(detail({ visibility: "department", unitNodeId: "gone" }));
    expect(who()).toHaveTextContent("Visible to its department");
    first.unmount();
    vi.mocked(readOrgRoot).mockResolvedValue(null);
    await mount(detail({ visibility: "department", unitNodeId: "d-web" }));
    expect(who()).toHaveTextContent("Visible to its department");
  });

  it("keeps the two older sentences, and does not read the org tree for them", async () => {
    const first = await mount(detail({ visibility: "company" }));
    expect(who()).toHaveTextContent("Everyone in the company");
    first.unmount();
    await mount(detail({ visibility: "attendees" }));
    expect(who()).toHaveTextContent("Only the people invited");
    expect(readOrgRoot).not.toHaveBeenCalled();
  });
});
