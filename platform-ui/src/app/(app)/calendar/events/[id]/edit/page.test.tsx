import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// DW-10c-2 (BFF section 59.3): the edit form holds a department event's department, and offers it even when the editor (a company admin who is
// not placed there) would not be offered it as "mine".
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", async (orig) => ({ ...(await orig<typeof import("@/lib/platform")>()), getMe: vi.fn() }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("@/lib/campaigns-data", () => ({ readOrgRoot: vi.fn() }));
vi.mock("@/lib/entities", () => ({ listMembers: vi.fn(), listClients: vi.fn(), listProjects: vi.fn() }));
vi.mock("@/lib/calendarEvents-data", () => ({ EVENT_NOT_FOUND: "This event doesn't exist or isn't visible to you.", getEvent: vi.fn() }));
vi.mock("@/lib/calendarEventsActions", () => ({ updateEventAction: vi.fn(), loadBusyExcludingEventAction: vi.fn() }));

import { getMe } from "@/lib/platform";
import { readOrgRoot } from "@/lib/campaigns-data";
import { listClients, listMembers, listProjects } from "@/lib/entities";
import { getEvent } from "@/lib/calendarEvents-data";
import { agencyTree, me as meFixture, member } from "@/lib/workspaceFixtures";
import type { CalendarEventDetail } from "@/lib/calendarEvents";
import EditEventPage from "./page";

const detail = (over: Partial<CalendarEventDetail> = {}): CalendarEventDetail => ({
  id: "e1", tenantId: "co-a", title: "Sprint review", description: "", startsAt: "2026-10-14T06:00:00.000Z", endsAt: "2026-10-14T07:00:00.000Z", allDay: false,
  startsOn: null, endsOn: null, location: null, videoUrl: null, visibility: "department", unitNodeId: "d-seo", status: "confirmed", cancelledAt: null,
  organizer: { id: "u-2", name: "Ketut Arta" }, attendees: [], attendeeCount: 0, myResponse: null, recording: null, client: null, project: null,
  href: "/calendar/events/e1?company=co-a", canEdit: true, canCancel: true, canRespond: false, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", ...over,
});
const mount = async (ev: CalendarEventDetail) => {
  vi.mocked(getEvent).mockResolvedValue({ kind: "ok", data: ev });
  return render(await EditEventPage({ params: Promise.resolve({ id: ev.id }), searchParams: Promise.resolve({}) }));
};
const select = () => screen.getByLabelText("Who can see it") as HTMLSelectElement;

beforeEach(() => {
  vi.mocked(getMe).mockReset().mockResolvedValue(meFixture([member()]));
  vi.mocked(readOrgRoot).mockReset().mockResolvedValue(agencyTree({ web: ["u-1"] }) as never);
  vi.mocked(listMembers).mockReset().mockResolvedValue([{ user_id: "u-2", name: "Ketut Arta" }] as never);
  vi.mocked(listClients).mockReset().mockResolvedValue([] as never);
  vi.mocked(listProjects).mockReset().mockResolvedValue([] as never);
});

describe("the edit form of a department event", () => {
  it("holds the event's department, offered as a department (not 'mine') when the editor is not in it", async () => {
    await mount(detail());
    expect(select().value).toBe("department:d-seo");
    expect([...select().options].map((o) => [o.value, o.textContent])).toEqual([
      ["attendees", "Only the people invited"], ["company", "Everyone in the company"], ["department:d-web", "My department: Web Dev"], ["department:d-seo", "Department: SEO"],
    ]);
  });

  it("holds the department the editor is in as 'My department', once", async () => {
    await mount(detail({ unitNodeId: "d-web" }));
    expect(select().value).toBe("department:d-web");
    expect([...select().options].filter((o) => o.value === "department:d-web")).toHaveLength(1);
  });

  it("keeps an option for a department that has left the tree, so the select still shows what the event holds", async () => {
    await mount(detail({ unitNodeId: "gone" }));
    expect(select().value).toBe("department:gone");
    expect(select().selectedOptions[0]).toHaveTextContent("A department no longer in the structure");
  });

  it("holds a company event as before, with the editor's own units on offer", async () => {
    await mount(detail({ visibility: "company", unitNodeId: null }));
    expect(select().value).toBe("company");
    expect([...select().options].map((o) => o.value)).toEqual(["attendees", "company", "department:d-web"]);
  });
});
