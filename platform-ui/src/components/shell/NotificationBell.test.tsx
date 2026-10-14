import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { NotificationBell, formatAge, type BellItem } from "./NotificationBell";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ITEMS: BellItem[] = [
  { id: "n1", title: "Approval requested: Q4 budget", createdAt: ago(5 * 60_000) },
  { id: "n2", title: "Mia mentioned you", createdAt: ago(3 * 3_600_000) },
];
const bell = () => screen.getByRole("button", { name: /^Notifications/ });
const pop = () => screen.queryByRole("region", { name: "Notifications" });

describe("formatAge", () => {
  const now = Date.parse("2026-10-13T12:00:00Z");
  it("reads as a short age, then a date", () => {
    expect(formatAge("2026-10-13T11:59:40Z", now)).toBe("Just now");
    expect(formatAge("2026-10-13T11:55:00Z", now)).toBe("5 min ago");
    expect(formatAge("2026-10-13T09:00:00Z", now)).toBe("3 h ago");
    expect(formatAge("2026-10-11T12:00:00Z", now)).toBe("2 d ago");
    expect(formatAge("2026-09-01T12:00:00Z", now)).toMatch(/^1 Sep/);
  });
  it("is empty for a date it cannot read", () => {
    expect(formatAge("", now)).toBe("");
    expect(formatAge("soon", now)).toBe("");
  });
});

describe("NotificationBell", () => {
  it("is a closed disclosure button with the unread count in its name and badge", () => {
    render(<NotificationBell unread={3} items={ITEMS} />);
    expect(bell()).toHaveAttribute("aria-expanded", "false");
    expect(bell()).toHaveAccessibleName("Notifications, 3 unread");
    expect(bell()).toHaveTextContent("3");
    expect(pop()).toBeNull();
  });

  it("caps the badge at 9+", () => {
    render(<NotificationBell unread={14} items={ITEMS} />);
    expect(bell()).toHaveTextContent("9+");
  });

  it("opens to the latest unread (title and age) with Open inbox", () => {
    render(<NotificationBell unread={2} items={ITEMS} />);
    fireEvent.click(bell());
    expect(bell()).toHaveAttribute("aria-expanded", "true");
    const panel = pop() as HTMLElement;
    expect(within(panel).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Approval requested: Q4 budget5 min ago",
      "Mia mentioned you3 h ago",
    ]);
    expect(within(panel).getByRole("link", { name: "Open inbox" })).toHaveAttribute("href", "/me/inbox");
  });

  it("says Nothing new, with the link, when there is no unread", () => {
    render(<NotificationBell unread={0} items={[]} />);
    expect(bell()).toHaveAccessibleName("Notifications");
    fireEvent.click(bell());
    const panel = pop() as HTMLElement;
    expect(within(panel).getByText("Nothing new")).toBeInTheDocument();
    expect(within(panel).getByRole("link", { name: "Open inbox" })).toHaveAttribute("href", "/me/inbox");
  });

  it("shows no count and says it could not load when the read failed, never a 0", () => {
    render(<NotificationBell unread={null} items={[]} />);
    expect(bell()).toHaveAccessibleName("Notifications");
    expect(bell()).not.toHaveTextContent(/\d/);
    fireEvent.click(bell());
    const panel = pop() as HTMLElement;
    expect(within(panel).getByText("Couldn't load notifications")).toBeInTheDocument();
    expect(within(panel).queryByText("Nothing new")).toBeNull();
    expect(within(panel).getByRole("link", { name: "Open inbox" })).toBeInTheDocument();
  });

  it("closes on Escape and hands focus back to the button", () => {
    render(<NotificationBell unread={2} items={ITEMS} />);
    fireEvent.click(bell());
    const link = screen.getByRole("link", { name: "Open inbox" });
    link.focus();
    fireEvent.keyDown(link, { key: "Escape" });
    expect(pop()).toBeNull();
    expect(bell()).toHaveFocus();
    expect(bell()).toHaveAttribute("aria-expanded", "false");
  });

  it("closes on a click outside, and stays open on a click inside", () => {
    render(<><NotificationBell unread={2} items={ITEMS} /><p>page</p></>);
    fireEvent.click(bell());
    fireEvent.mouseDown(screen.getByText("Mia mentioned you"));
    expect(pop()).not.toBeNull();
    fireEvent.mouseDown(screen.getByText("page"));
    expect(pop()).toBeNull();
  });

  it("toggles on a second click of the bell, and closes when Open inbox is followed", () => {
    render(<NotificationBell unread={2} items={ITEMS} />);
    fireEvent.click(bell());
    fireEvent.click(bell());
    expect(pop()).toBeNull();
    fireEvent.click(bell());
    fireEvent.click(screen.getByRole("link", { name: "Open inbox" }));
    expect(pop()).toBeNull();
  });
});
