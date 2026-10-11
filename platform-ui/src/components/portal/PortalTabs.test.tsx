import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

let path = "/portal/company";
vi.mock("next/navigation", () => ({ usePathname: () => path }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

import { PortalTabs } from "./PortalTabs";

describe("PortalTabs: the Website tab (WSK-49d)", () => {
  it("is NOT offered without the website-editor grant (default)", () => {
    path = "/portal/company";
    render(<PortalTabs projectsBadge={0} billingBadge={0} />);
    expect(screen.queryByRole("link", { name: "Website" })).toBeNull();
    // The Business area then has one tab, so no second row of tabs is drawn at all.
    expect(screen.queryByRole("navigation", { name: /Business pages/ })).toBeNull();
  });

  it("is offered, in the Business area's second row, with the grant", () => {
    path = "/portal/company";
    render(<PortalTabs projectsBadge={0} billingBadge={0} showWebsite />);
    const row = screen.getByRole("navigation", { name: "Business pages" });
    expect(row.querySelectorAll("a")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "Website" })).toHaveAttribute("href", "/portal/website");
  });

  it("lights Website on any Website route, and the Business area with it", () => {
    path = "/portal/website/gaiada/site-1/service/service.seo";
    render(<PortalTabs projectsBadge={0} billingBadge={0} showWebsite />);
    expect(screen.getByRole("link", { name: "Website" })).toHaveAttribute("aria-current", "page");
    const area = screen.getByRole("navigation", { name: "Portal sections" }).querySelector('a[aria-current="page"]');
    expect(area?.textContent).toBe("Business");
  });

  it("the five area links are unchanged by the grant", () => {
    path = "/portal";
    const { container, rerender } = render(<PortalTabs projectsBadge={0} billingBadge={0} />);
    const names = () => [...container.querySelectorAll("nav.cp-tabs a")].map((a) => a.textContent);
    const without = names();
    rerender(<PortalTabs projectsBadge={0} billingBadge={0} showWebsite />);
    expect(names()).toEqual(without);
    expect(without).toEqual(["Overview", "Projects", "Business", "Contracts & billing", "People"]);
  });
});
