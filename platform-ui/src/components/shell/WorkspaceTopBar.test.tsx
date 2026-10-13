import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorkspaceTopBar } from "./WorkspaceTopBar";
import { listNotifications, type NotificationItem } from "@/lib/entities";
import { setShellLayoutAction, setThemeAction } from "@/lib/prefsActions";
import { me, member } from "@/lib/workspaceFixtures";
import type { Me } from "@/lib/platform";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/app/(app)/account/actions", () => ({ logout: vi.fn() }));
vi.mock("@/lib/prefsActions", () => ({ setShellLayoutAction: vi.fn(async () => {}), setThemeAction: vi.fn(async () => {}) }));
vi.mock("@/lib/entities", () => ({ listNotifications: vi.fn() }));

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const note = (id: string, title: string, ageMs: number): NotificationItem => ({
  id, type: "approval", payload: { title }, read_at: null, created_at: ago(ageMs),
});

const person: Me = me([member()], undefined, { name: "Rina Vale", title: "Designer" });

type Props = Partial<Parameters<typeof WorkspaceTopBar>[0]>;
async function draw(props: Props = {}) {
  const ui = await WorkspaceTopBar({ me: person, tenantId: "co-a", theme: "light", shell: "workspaces", special: false, unrestricted: false, ...props });
  return render(ui);
}
const bell = () => screen.getByRole("button", { name: /^Notifications/ });
const openAvatar = () => fireEvent.click(screen.getByRole("button", { name: "Rina Vale" }));

beforeEach(() => {
  vi.mocked(listNotifications).mockReset();
  vi.mocked(listNotifications).mockResolvedValue([]);
  vi.mocked(setThemeAction).mockClear();
  vi.mocked(setShellLayoutAction).mockClear();
  document.documentElement.removeAttribute("data-theme");
});

describe("WorkspaceTopBar: what it draws", () => {
  it("has one search form, the bell and the avatar, and nothing of the classic bar", async () => {
    const { container } = await draw();
    expect(screen.getAllByRole("search")).toHaveLength(1);
    expect(screen.getByRole("searchbox", { name: "Search" })).toHaveAttribute("name", "q");
    expect(bell()).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rina Vale" })).toBeInTheDocument();
    // Removed: the label, the date, the separate theme and palette buttons.
    expect(container.querySelector(".erp-top__meta, .erp-top__date, .erp-top__divider")).toBeNull();
    expect(screen.queryByText("My Workspace")).toBeNull();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open command palette" })).toBeNull();
    expect(screen.queryByText("Jump to…")).toBeNull();
    // The bell is a button here, not the classic link.
    expect(screen.queryByRole("link", { name: /^Notifications/ })).toBeNull();
  });

  it("keeps the phone's navigation toggle", async () => {
    await draw();
    expect(screen.getByRole("button", { name: "Open navigation" })).toBeInTheDocument();
  });
});

describe("WorkspaceTopBar: the bell's data", () => {
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
    await draw();
    expect(listNotifications).toHaveBeenCalledWith("u-1", "co-a", true);
    expect(bell()).toHaveAccessibleName("Notifications, 7 unread");
    fireEvent.click(bell());
    const titles = within(screen.getByRole("region", { name: "Notifications" })).getAllByRole("listitem").map((li) => li.querySelector(".erp-bell__title")?.textContent);
    expect(titles).toEqual(["Newest", "Second", "Fourth", "Fifth", "Sixth"]);
  });

  it("falls back to the notification's type when a row has no title, never an invented one", async () => {
    vi.mocked(listNotifications).mockResolvedValue([{ id: "n1", type: "comment.mention", payload: {}, read_at: null, created_at: ago(1000) }]);
    await draw();
    fireEvent.click(bell());
    expect(screen.getByText("comment.mention")).toBeInTheDocument();
  });

  it("says Nothing new when there is no unread", async () => {
    await draw();
    expect(bell()).toHaveAccessibleName("Notifications");
    fireEvent.click(bell());
    expect(screen.getByText("Nothing new")).toBeInTheDocument();
  });

  it("shows no count and says it could not load when the read throws", async () => {
    vi.mocked(listNotifications).mockRejectedValue(new Error("down"));
    await draw();
    expect(bell()).toHaveAccessibleName("Notifications");
    expect(bell()).not.toHaveTextContent(/\d/);
    fireEvent.click(bell());
    expect(screen.getByText("Couldn't load notifications")).toBeInTheDocument();
    expect(screen.queryByText("Nothing new")).toBeNull();
  });

  it("makes no read without a company", async () => {
    await draw({ tenantId: null });
    expect(listNotifications).not.toHaveBeenCalled();
    fireEvent.click(bell());
    expect(screen.getByText("Nothing new")).toBeInTheDocument();
  });
});

describe("WorkspaceTopBar: the avatar menu", () => {
  it("holds Theme, Account, Sign out and the layout switch, and no Client view for a plain staff member", async () => {
    await draw();
    openAvatar();
    const menu = screen.getByRole("menu", { name: "Account menu" });
    expect(within(menu).getByRole("group", { name: "Theme" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Account settings" })).toHaveAttribute("href", "/account");
    expect(within(menu).getByRole("menuitem", { name: "Back to the classic layout" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Sign out" })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Client view" })).toBeNull();
  });

  it("shows Client view under the same condition as the classic bar", async () => {
    await draw({ me: { ...person, clientOf: [{ companyId: "co-x", companyName: "Acme" }] } });
    openAvatar();
    expect(screen.getByRole("menuitem", { name: "Client view" })).toHaveAttribute("href", "/portal");
  });

  it("the Theme control is the same one: it pins the theme on the page and stores the choice", async () => {
    await draw({ theme: "light" });
    openAvatar();
    const theme = screen.getByRole("group", { name: "Theme" });
    expect(within(theme).getByRole("radio", { name: "Light" })).toBeChecked();
    fireEvent.click(within(theme).getByRole("radio", { name: "Dark" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(within(theme).getByRole("radio", { name: "Dark" })).toBeChecked();
    await waitFor(() => expect(setThemeAction).toHaveBeenCalledWith("dark"));
  });
});

describe("WorkspaceTopBar: the access chip", () => {
  it("is absent for an ordinary person", async () => {
    await draw();
    expect(screen.queryByText("Unrestricted")).toBeNull();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("is a small chip whose accessible description is the strip's whole sentence", async () => {
    const { container } = await draw({ special: true, unrestricted: true });
    const chip = screen.getByText("Unrestricted");
    expect(chip).toHaveAccessibleDescription("Every company, editable — actions are logged and reported.");
    expect(chip).toHaveAttribute("tabindex", "0");
    // A chip in the bar, not the full-width strip.
    expect(container.querySelector(".erp-special")).toBeNull();
    expect(container.querySelector(".erp-top .erp-top__chip")).not.toBeNull();
  });

  it("says Elevated, without 'editable', for a view-all account that is not unrestricted", async () => {
    await draw({ special: true, unrestricted: false });
    const chip = screen.getByText("Elevated");
    expect(chip).toHaveAccessibleDescription("Every company — actions are logged and reported.");
  });
});
