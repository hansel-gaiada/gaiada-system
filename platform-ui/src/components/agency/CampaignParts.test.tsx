import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { CampaignPart } from "@/lib/campaigns";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/campaignActions", () => ({
  addPartAction: vi.fn(), removePartAction: vi.fn(), updatePartAction: vi.fn(),
}));

vi.mock("@/lib/figmaActions", () => ({ addFigmaLinkAction: vi.fn(), removeFigmaLinkAction: vi.fn(), exportFigmaLinkAction: vi.fn() }));

import { CampaignParts, type CampaignPartsProps } from "./CampaignParts";
import { formatBudget } from "@/lib/format";

const part = (over: Partial<CampaignPart> = {}): CampaignPart => ({
  id: "p1", unitId: "d-social", unitName: "Social Media", unitMissing: false, ownerId: "u1", ownerName: "Ayu",
  status: "active", brief: "Launch <b>reels</b>", dueOn: "2026-11-01", budgetMinor: 250_000,
  links: { searchCampaigns: [], socialCampaigns: [{ id: "s1", name: "Reels push", status: "active" }] },
  requests: { open: 2, delivered: 1, declined: 0 }, ...over,
});

const props = (over: Partial<CampaignPartsProps> = {}): CampaignPartsProps => ({
  campaignId: "c1", currency: "USD", hasBudget: true, canManage: false,
  parts: [{ part: part(), canEdit: false }],
  departments: [{ id: "d-seo", name: "SEO" }, { id: "d-social", name: "Social Media" }],
  people: [{ id: "u1", name: "Ayu" }],
  linkAccess: { searchCampaigns: "ok", socialCampaigns: "ok" },
  ...over,
});

describe("CampaignParts", () => {
  it("shows a part's owner, status, due date, allocation (as the server sent it) and request counts", () => {
    render(<CampaignParts {...props()} />);
    const card = screen.getByRole("article", { name: "Part: Social Media" });
    expect(within(card).getByText("Ayu")).toBeTruthy();
    expect(within(card).getByText(formatBudget(250_000, "USD"))).toBeTruthy();
    expect(within(card).getByText("2 open, 1 delivered, 0 declined")).toBeTruthy();
    expect(within(card).getByText("Reels push")).toBeTruthy();
  });

  it("renders the brief as plain text, never as markup", () => {
    const { container } = render(<CampaignParts {...props()} />);
    expect(container.querySelector(".cmp-part__brief")?.textContent).toBe("Launch <b>reels</b>");
    expect(container.querySelector(".cmp-part__brief b")).toBeNull();
  });

  it("says the list cannot be seen, instead of 'none linked', when the caller may not read that kind of campaign", () => {
    render(<CampaignParts {...props({ linkAccess: { searchCampaigns: "forbidden", socialCampaigns: "module_off" } })} />);
    expect(screen.getByText("You cannot see SEO campaigns.")).toBeTruthy();
    expect(screen.getByText(/Social Media module is off/)).toBeTruthy();
    expect(screen.queryByText("None linked.")).toBeNull();
  });

  it("says 'None linked.' only when the read was allowed and empty", () => {
    render(<CampaignParts {...props({ parts: [{ part: part({ links: { searchCampaigns: [], socialCampaigns: [] } }), canEdit: false }] })} />);
    expect(screen.getAllByText("None linked.")).toHaveLength(2);
  });

  it("names a department that has left the org chart", () => {
    render(<CampaignParts {...props({ parts: [{ part: part({ unitName: null, unitMissing: true }), canEdit: false }] })} />);
    expect(screen.getAllByText(/no longer in the org chart/).length).toBeGreaterThan(0);
  });

  it("offers no controls to someone who may not edit or manage", () => {
    render(<CampaignParts {...props()} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers Edit part to a part's owner or head, but not allocation, removal or adding a department", () => {
    render(<CampaignParts {...props({ parts: [{ part: part(), canEdit: true }] })} />);
    expect(screen.getByRole("button", { name: "Edit part" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Set allocation" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add a department" })).toBeNull();
  });

  it("offers every control to a manager", () => {
    render(<CampaignParts {...props({ canManage: true, parts: [{ part: part(), canEdit: true }] })} />);
    for (const name of ["Edit part", "Set allocation", "Remove", "Add a department"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
  });

  it("says when no department has a part yet", () => {
    render(<CampaignParts {...props({ parts: [] })} />);
    expect(screen.getByText("No department has a part in this campaign yet.")).toBeTruthy();
  });
});

// DW-6k: each part carries its own Designs section when the page read its Figma links.
describe("CampaignParts · Designs (DW-6k)", () => {
  const figmaLink = {
    id: "fl1", targetKind: "campaign_part" as const, targetId: "p1", fileKey: "k", nodeId: null, url: "https://www.figma.com/design/k",
    title: "Reels kit", lastModified: null, openComments: null, cachedAt: null, assetGroupId: null, stale: false, refreshError: null,
  };

  it("draws no Designs section for a part whose links were not read", () => {
    render(<CampaignParts {...props()} />);
    expect(screen.queryByRole("region", { name: "Designs" })).toBeNull();
  });

  it("shows the part's links, with an unread comment count as 'not read yet' and never 0", () => {
    const figma = { kind: "ok" as const, data: { figmaConnected: false, items: [figmaLink] } };
    render(<CampaignParts {...props({ parts: [{ part: part(), canEdit: false, figma }], now: Date.now() })} />);
    const card = screen.getByRole("article", { name: "Part: Social Media" });
    expect(within(card).getByText("Reels kit")).toBeTruthy();
    expect(within(card).getByText("Comments not read yet")).toBeTruthy();
    expect(within(card).getByText(/Figma isn't connected for this company/)).toBeTruthy();
  });

  it("says a refused links read is refused, not 'no designs'", () => {
    render(<CampaignParts {...props({ parts: [{ part: part(), canEdit: false, figma: { kind: "forbidden" as const } }] })} />);
    expect(screen.getByText("You can't see the designs linked here.")).toBeTruthy();
    expect(screen.queryByText(/No Figma designs/)).toBeNull();
  });
});
