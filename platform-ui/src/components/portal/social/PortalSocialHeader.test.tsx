import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

// SCP-2: the server-rendered header of the approval page: the counts, the filters (a plain GET form), and the tabs (links).
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
import { PortalSocialCountsBar, PortalSocialFilters, PortalSocialTabs } from "./PortalSocialHeader";

const q = { tab: "to_review" as const, month: null, clientId: null };

describe("the counts", () => {
  it("shows to approve, approved and changes asked, each a link to the tab that lists them, keeping the month and the client", () => {
    render(<PortalSocialCountsBar counts={{ toReview: 4, approved: 7, changesAsked: 1 }} q={{ tab: "to_review", month: "2026-10", clientId: "cl-1" }} />);
    const list = screen.getByRole("list", { name: "Where your posts stand" });
    const links = within(list).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["4To approve", "7Approved", "1Changes asked"]);
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/portal/social?month=2026-10&clientId=cl-1",
      "/portal/social?tab=approved&month=2026-10&clientId=cl-1",
      "/portal/social?tab=grid&month=2026-10&clientId=cl-1",
    ]);
  });
});

describe("the filters: a plain GET form", () => {
  it("a month switcher with 'All months' first; no client filter for a contact of one client", () => {
    render(<PortalSocialFilters q={q} todayMonth="2026-10" clients={[{ id: "cl-1", name: "Northwind Traders" }]} />);
    const form = screen.getByRole("form", { name: "Choose the month and the client" });
    expect(form).toHaveAttribute("method", "get");
    expect(form).toHaveAttribute("action", "/portal/social");
    const month = within(form).getByLabelText("Month") as HTMLSelectElement;
    expect([...month.options].map((o) => o.textContent)).toEqual(["All months", "August 2026", "September 2026", "October 2026", "November 2026", "December 2026"]);
    expect(month.value).toBe("");
    expect(within(form).queryByLabelText("Client")).toBeNull();
    expect(within(form).getByRole("button", { name: "Show" })).toBeInTheDocument();
  });

  it("a client filter appears with more than one client; the selection and the tab are carried", () => {
    render(<PortalSocialFilters q={{ tab: "grid", month: "2026-11", clientId: "cl-2" }} todayMonth="2026-10" clients={[{ id: "cl-1", name: "Northwind Traders" }, { id: "cl-2", name: "Another Brand" }]} />);
    const form = screen.getByRole("form", { name: "Choose the month and the client" });
    expect((within(form).getByLabelText("Month") as HTMLSelectElement).value).toBe("2026-11");
    expect((within(form).getByLabelText("Client") as HTMLSelectElement).value).toBe("cl-2");
    expect(form.querySelector('input[name="tab"]')).toHaveAttribute("value", "grid");
  });
});

describe("the tabs: links, in order, with the current one marked", () => {
  it("To review, Grid preview and Approved; each a real link to `?tab=`, the default one without a parameter", () => {
    render(<PortalSocialTabs q={{ tab: "grid", month: "2026-10", clientId: null }} />);
    const nav = screen.getByRole("navigation", { name: "Post groups" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["To review", "Grid preview", "Approved"]);
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/portal/social?month=2026-10", "/portal/social?tab=grid&month=2026-10", "/portal/social?tab=approved&month=2026-10"]);
    expect(links.map((l) => l.getAttribute("aria-current"))).toEqual([null, "page", null]);
  });
});
