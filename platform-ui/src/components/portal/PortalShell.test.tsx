import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

vi.mock("./PortalTabs", () => ({ PortalTabs: () => null }));
vi.mock("./PortalLive", () => ({ PortalLive: () => null }));
vi.mock("./PortalUserMenu", () => ({ PortalUserMenu: () => null }));

import { PortalShell } from "./PortalShell";

const base = { clientName: null, userName: "Dana", userInitials: "D", projectsBadge: 0, billingBadge: 0 };

describe("PortalShell brand", () => {
  it("shows the serving company's name, never the holding's", () => {
    const { container } = render(<PortalShell {...base} companyName="Gaia Digital Agency"><p>x</p></PortalShell>);
    expect(container.querySelector(".cp-brand__mark")?.textContent).toBe("Gaia Digital Agency");
    expect(screen.getByText("Client Portal")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/syrowatka/i);
  });
  it("falls back to 'Client Portal' alone when there is no company", () => {
    const { container } = render(<PortalShell {...base} companyName={null}><p>x</p></PortalShell>);
    expect(container.querySelector(".cp-brand__mark")?.textContent).toBe("Client Portal");
    expect(container.querySelector(".cp-brand__sub")).toBeNull();
    expect(container.textContent).not.toMatch(/syrowatka/i);
  });
});
