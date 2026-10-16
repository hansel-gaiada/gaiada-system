import { render, screen, fireEvent, within, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorkspaceTopBar } from "./WorkspaceTopBar";
import { setThemeAction } from "@/lib/prefsActions";
import { me, member } from "@/lib/workspaceFixtures";
import type { Me } from "@/lib/platform";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/app/(app)/account/actions", () => ({ logout: vi.fn() }));
vi.mock("@/lib/prefsActions", () => ({ setThemeAction: vi.fn(async () => {}) }));
// The bell's read is an async server child behind <Suspense> (its own tests: WorkspaceTopBarBell.test.tsx). An async component cannot render in
// jsdom's client React, so it is stood in for: by a settled bell, or, when `stream.pending`, by one that never resolves, so the bar shows the
// fallback bell exactly as it does while the read streams.
const stream = vi.hoisted(() => ({ pending: false }));
vi.mock("./WorkspaceTopBarBell", async () => {
  const { use } = await import("react");
  const { NotificationBell } = await import("./NotificationBell");
  return { WorkspaceTopBarBell: () => { if (stream.pending) use(new Promise<never>(() => {})); return <NotificationBell unread={0} items={[]} />; } };
});

const person: Me = me([member()], undefined, { name: "Rina Vale", title: "Designer" });

type Props = Partial<Parameters<typeof WorkspaceTopBar>[0]>;
// The bar is synchronous now: the bell's read streams behind a <Suspense> (its fallback is the bell with no count).
function draw(props: Props = {}) {
  return render(<WorkspaceTopBar me={person} tenantId="co-a" theme="light" special={false} unrestricted={false} {...props} />);
}
const bell = () => screen.getByRole("button", { name: /^Notifications/ });
const openAvatar = () => fireEvent.click(screen.getByRole("button", { name: "Rina Vale" }));

beforeEach(() => {
  stream.pending = false;
  vi.mocked(setThemeAction).mockClear();
  document.documentElement.removeAttribute("data-theme");
});

describe("WorkspaceTopBar: what it draws", () => {
  it("has one search form, the bell and the avatar, and nothing of the old bar", async () => {
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
    // The bell is a button here, not a plain link.
    expect(screen.queryByRole("link", { name: /^Notifications/ })).toBeNull();
  });

  it("draws the bell at once with no count while its read streams, never a made-up 0", async () => {
    stream.pending = true;
    // The read is an async server child under <Suspense>: until it resolves the bar shows the fallback bell and the pop-over says it is loading.
    await act(async () => { draw(); });
    expect(bell()).toHaveAccessibleName("Notifications");
    expect(bell()).not.toHaveTextContent(/\d/);
    fireEvent.click(bell());
    expect(screen.getByText("Loading notifications…")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load notifications")).toBeNull();
    expect(screen.queryByText("Nothing new")).toBeNull();
  });

  it("keeps the phone's navigation toggle", async () => {
    await draw();
    expect(screen.getByRole("button", { name: "Open navigation" })).toBeInTheDocument();
  });
});

describe("WorkspaceTopBar: the avatar menu", () => {
  it("holds Theme, Account and Sign out, no layout switch, and no Client view for a plain staff member", async () => {
    await draw();
    openAvatar();
    const menu = screen.getByRole("menu", { name: "Account menu" });
    expect(within(menu).getByRole("group", { name: "Theme" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Account settings" })).toHaveAttribute("href", "/account");
    expect(within(menu).queryByRole("menuitem", { name: /layout/i })).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "Sign out" })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Client view" })).toBeNull();
  });

  it("shows Client view for a staff member who is also a client contact", async () => {
    await draw({ me: { ...person, clientOf: [{ companyId: "co-x", companyName: "Acme" }] } });
    openAvatar();
    expect(screen.getByRole("menuitem", { name: "Client view" })).toHaveAttribute("href", "/portal");
  });

  it("the Theme control is the same one: it pins the theme on the page and stores the choice", async () => {
    await draw({ theme: "light" });
    openAvatar();
    const theme = screen.getByRole("group", { name: "Theme" });
    // Menu radios inside the menu (DW-9b-2: a radiogroup may not sit in role="menu").
    expect(within(theme).getByRole("menuitemradio", { name: "Light" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(within(theme).getByRole("menuitemradio", { name: "Dark" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(within(theme).getByRole("menuitemradio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");
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
