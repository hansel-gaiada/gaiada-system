import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorkspaceTopBarBell } from "./WorkspaceTopBarBell";
import { listNotifications, type NotificationItem } from "@/lib/entities";
import { me, member } from "@/lib/workspaceFixtures";
import type { Me } from "@/lib/platform";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("@/lib/entities", () => ({ listNotifications: vi.fn() }));

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const note = (id: string, title: string, ageMs: number): NotificationItem => ({
  id, type: "approval", payload: { title }, read_at: null, created_at: ago(ageMs),
});

const person: Me = me([member()], undefined, { name: "Rina Vale", title: "Designer" });

async function drawBell(props: Partial<Parameters<typeof WorkspaceTopBarBell>[0]> = {}) {
  return render(await WorkspaceTopBarBell({ me: person, tenantId: "co-a", ...props }));
}
const bell = () => screen.getByRole("button", { name: /^Notifications/ });

beforeEach(() => {
  vi.mocked(listNotifications).mockReset();
  vi.mocked(listNotifications).mockResolvedValue([]);
});

describe("WorkspaceTopBarBell: the bell's data", () => {
  it("counts every unread, lists the newest five with their own titles, newest first", async () => {
    vi.mocked(listNotifications).mockResolvedValue([
      note("n1", "Oldest", 9 * 3_600_000),
      note("n2", "Second", 2 * 3_600_000),
      note("n3", "Newest", 60_000),
      note("n4", "Fourth", 3 * 3_600_000),
      note("n5", "Fifth", 4 * 3_600_000),
      note("n6", "Sixth", 5 * 3_600_000),
      note("n7", "Seventh", 6 * 3_600_000),
    ]);
    await drawBell();
    expect(listNotifications).toHaveBeenCalledWith("u-1", "co-a", true);
    expect(bell()).toHaveAccessibleName("Notifications, 7 unread");
    fireEvent.click(bell());
    const titles = within(screen.getByRole("region", { name: "Notifications" })).getAllByRole("listitem").map((li) => li.querySelector(".erp-bell__title")?.textContent);
    expect(titles).toEqual(["Newest", "Second", "Fourth", "Fifth", "Sixth"]);
  });

  it("falls back to the notification's type when a row has no title, never an invented one", async () => {
    vi.mocked(listNotifications).mockResolvedValue([{ id: "n1", type: "comment.mention", payload: {}, read_at: null, created_at: ago(1000) }]);
    await drawBell();
    fireEvent.click(bell());
    expect(screen.getByText("comment.mention")).toBeInTheDocument();
  });

  it("says Nothing new when there is no unread", async () => {
    await drawBell();
    expect(bell()).toHaveAccessibleName("Notifications");
    fireEvent.click(bell());
    expect(screen.getByText("Nothing new")).toBeInTheDocument();
  });

  it("shows no count and says it could not load when the read throws", async () => {
    vi.mocked(listNotifications).mockRejectedValue(new Error("down"));
    await drawBell();
    expect(bell()).toHaveAccessibleName("Notifications");
    expect(bell()).not.toHaveTextContent(/\d/);
    fireEvent.click(bell());
    expect(screen.getByText("Couldn't load notifications")).toBeInTheDocument();
    expect(screen.queryByText("Nothing new")).toBeNull();
  });

  it("makes no read without a company", async () => {
    await drawBell({ tenantId: null });
    expect(listNotifications).not.toHaveBeenCalled();
    fireEvent.click(bell());
    expect(screen.getByText("Nothing new")).toBeInTheDocument();
  });
});
