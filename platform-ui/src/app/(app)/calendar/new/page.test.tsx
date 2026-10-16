import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// DW-10c-2/3 (BFF section 59.3, 59.4): the schedule form offers "My department: <unit>" for the units the person is placed in or leads, and
// the department calendar's "Add an event" link (`?visibility=department&unit=<id>`) preselects that unit when it is among the choices.
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", async (orig) => ({ ...(await orig<typeof import("@/lib/platform")>()), getMe: vi.fn() }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("@/lib/campaigns-data", () => ({ readOrgRoot: vi.fn() }));
vi.mock("@/lib/entities", () => ({ listMembers: vi.fn(), listClients: vi.fn(), listProjects: vi.fn() }));
vi.mock("@/lib/calendarEventsActions", () => ({ createEventAction: vi.fn(), loadBusyAction: vi.fn() }));

import { getMe } from "@/lib/platform";
import { readOrgRoot } from "@/lib/campaigns-data";
import { listClients, listMembers, listProjects } from "@/lib/entities";
import { agencyTree, lead, me as meFixture, member } from "@/lib/workspaceFixtures";
import NewEventPage from "./page";

const mount = async (search: Record<string, string> = {}, who = meFixture([member()])) => {
  vi.mocked(getMe).mockResolvedValue(who);
  return render(await NewEventPage({ searchParams: Promise.resolve(search) }));
};
const select = () => screen.getByLabelText("Who can see it") as HTMLSelectElement;
const options = () => [...select().options].map((o) => [o.value, o.textContent]);

beforeEach(() => {
  vi.mocked(readOrgRoot).mockReset().mockResolvedValue(agencyTree({ web: ["u-1"] }) as never);
  vi.mocked(listMembers).mockReset().mockResolvedValue([{ user_id: "u-1", name: "Me" }, { user_id: "u-2", name: "Dewi" }] as never);
  vi.mocked(listClients).mockReset().mockResolvedValue([] as never);
  vi.mocked(listProjects).mockReset().mockResolvedValue([] as never);
});

describe("the department choice of the schedule form", () => {
  it("offers 'My department: <unit>' for the unit the person is placed in, after the two company choices", async () => {
    await mount();
    expect(options()).toEqual([
      ["attendees", "Only the people invited"], ["company", "Everyone in the company"], ["department:d-web", "My department: Web Dev"],
    ]);
    expect(select().value).toBe("attendees");
  });

  it("offers a unit the person leads as well", async () => {
    await mount({}, meFixture([member(), lead("d-seo")]));
    expect(options().map(([v]) => v)).toEqual(["attendees", "company", "department:d-web", "department:d-seo"]);
  });

  it("offers nothing to a person with no unit, and the form still works", async () => {
    await mount({}, { ...meFixture([member()]), userId: "u-9" });
    expect(options().map(([v]) => v)).toEqual(["attendees", "company"]);
  });

  it("offers nothing when the org tree cannot be read, rather than failing the page", async () => {
    vi.mocked(readOrgRoot).mockResolvedValue(null);
    await mount();
    expect(options().map(([v]) => v)).toEqual(["attendees", "company"]);
  });
});

describe("?visibility=department&unit= (the department calendar's 'Add an event')", () => {
  it("preselects the unit when it is among the person's choices", async () => {
    await mount({ visibility: "department", unit: "d-web" });
    expect(select().value).toBe("department:d-web");
  });

  it("offers and preselects a unit the person only asked for, labelled as a department rather than 'mine' (the server still narrows)", async () => {
    await mount({ visibility: "department", unit: "d-seo" });
    expect(options()).toContainEqual(["department:d-seo", "Department: SEO"]);
    expect(select().value).toBe("department:d-seo");
  });

  it("ignores a unit that is not in the tree, the root, and a unit without visibility=department", async () => {
    const first = await mount({ visibility: "department", unit: "nowhere" });
    expect(select().value).toBe("attendees");
    first.unmount();
    const second = await mount({ visibility: "department", unit: "root" });
    expect(select().value).toBe("attendees");
    second.unmount();
    await mount({ unit: "d-web" });
    expect(select().value).toBe("attendees");
  });
});
