import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { PortalSocialReview } from "@/lib/portal";

// SMM-32 — the same regression class as the contract signature (Next 16.3 applies the refresh after a
// server action): deciding revalidates this page, the refreshed review is no longer `pending`, and the
// decide form — the only holder of "your decision is recorded" — is no longer mounted. The page itself
// must therefore render the confirmation from the recorded decision.

vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => { throw new Error("redirect"); }),
  notFound: vi.fn(() => { throw new Error("notFound"); }),
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-client") }));
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(async () => ({ userId: "u-client" })) }));
vi.mock("@/lib/portal-company", () => ({ getActivePortalCompany: vi.fn(async () => ({ id: "northwind" })) }));
vi.mock("@/lib/portal-data", () => ({ getPortalSocialReview: vi.fn() }));
vi.mock("@/lib/portalActions", () => ({ portalDecideSocialReview: vi.fn() }));
vi.mock("@/components/portal/PortalLive", () => ({ PortalLive: () => null }));

import { getPortalSocialReview } from "@/lib/portal-data";
import PortalSocialReviewPage from "./page";

const reviewMock = vi.mocked(getPortalSocialReview);

const PENDING: PortalSocialReview = {
  id: "cr-1", status: "pending", comment: null, requestedAt: "2026-10-09T00:00:00Z", decidedAt: null,
  variantId: "v-1", body: "Autumn drop is here.", media: [], settings: {}, scheduledAt: null,
  network: "instagram", postTitle: "Autumn drop",
};

const mount = async (r: PortalSocialReview) => {
  reviewMock.mockResolvedValue(r);
  render(await PortalSocialReviewPage({ params: Promise.resolve({ reviewId: r.id }) }));
};

beforeEach(() => reviewMock.mockReset());

describe("social review page: decision confirmation", () => {
  it("pending: the decide form, no confirmation", async () => {
    await mount(PENDING);
    expect(screen.getByRole("button", { name: /looks good/i })).toBeInTheDocument();
    expect(screen.queryByText(/your decision is recorded/i)).toBeNull();
  });

  it.each([
    ["approved", /your decision is recorded: approved/i],
    ["changes_requested", /your decision is recorded: changes requested/i],
  ] as const)("after the decide action's refresh (%s): the page itself confirms it, once, with no buttons", async (status, text) => {
    await mount({ ...PENDING, status, decidedAt: "2026-10-11T03:00:00Z" });
    expect(screen.getAllByText(text)).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /looks good|request changes/i })).toBeNull();
  });

  it("withdrawn by the team: no 'your decision is recorded' — the client decided nothing", async () => {
    await mount({ ...PENDING, status: "withdrawn" });
    expect(screen.queryByText(/your decision is recorded/i)).toBeNull();
  });
});
