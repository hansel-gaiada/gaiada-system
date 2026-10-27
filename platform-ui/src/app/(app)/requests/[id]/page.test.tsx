import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { AGENCY, me as meFixture, member } from "@/lib/workspaceFixtures";

// DW-10e (BFF §60.6, §60.9): the request page on the RECEIVING side names another company's request: the requesting company, its department and
// the client the work is billed to; and it offers no Cancel on that row (the server answers 409 `requester_side_only`: the receiver declines).
// Server page: the readers are mocked, the element tree is rendered.
vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => { throw new Error(`redirect:${to}`); }),
  notFound: vi.fn(() => { throw new Error("notFound"); }),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("next/link", () => ({ default: ({ children, href }: { children?: ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("@/lib/platform", async () => ({ ...(await vi.importActual<typeof import("@/lib/platform")>("@/lib/platform")), getMe: vi.fn() }));
vi.mock("@/lib/requests-data", () => ({ readRequestDetail: vi.fn(), readLibraryAssets: vi.fn(), readTaskAssigneeIds: vi.fn() }));
vi.mock("@/lib/requestActions", () => ({ cancelRequestAction: vi.fn(), declineRequestAction: vi.fn(), deliverRequestAction: vi.fn(), cancelOutboundRequestAction: vi.fn() }));
vi.mock("@/lib/figma-data", () => ({ readFigmaLinks: vi.fn(async () => ({ kind: "ok", data: { figmaConnected: false, items: [] } })) }));
vi.mock("@/lib/entities", () => ({ readFiles: vi.fn(async () => ({ kind: "ok", data: [] })) }));
vi.mock("@/lib/campaigns-data", () => ({ readOrgRoot: vi.fn(async () => null) }));
vi.mock("@/components/figma/Designs", () => ({ Designs: () => null }));
vi.mock("@/components/FilesPanel", () => ({ FilesPanel: () => null }));

import { getMe } from "@/lib/platform";
import { readLibraryAssets, readRequestDetail, readTaskAssigneeIds } from "@/lib/requests-data";
import { normalizeRequestDetail } from "@/lib/requests";
import RequestPage from "./page";

const wire = (over: Record<string, unknown> = {}) => ({
  id: "i1", kind: "assets", title: "Reception banners", status: "open", neededBy: null, createdAt: "2026-10-12T03:00:00.000Z", closedAt: null,
  fromUnit: null, toUnit: { id: "dept-2", name: "Creatives", unitMissing: false }, requestedBy: { id: "u-1", name: "Ni Luh Sekar" }, campaign: null,
  work: { type: "pm_task", id: "t1", projectId: null, status: "in_progress", isDone: false, responsibleName: "Putu Rani" }, assetCount: 0,
  requestingCompany: { id: "co-resort", name: "Viceroy" }, requesterUnit: { id: "hosp-dept-1", name: "Front Office" }, client: { id: "cl-viceroy", name: "Viceroy (client)" },
  brief: "Three banners.", form: { deliverables: [{ format: "image", size: "", quantity: 3 }] }, declineReason: null, assets: [], ...over,
});
const sameCompany = () => wire({
  requestingCompany: null, requesterUnit: null, client: null, fromUnit: { id: "dept-3", name: "SEO", unitMissing: false }, requestedBy: { id: "u-1", name: "Luh Ayu" },
});
const read = (w: unknown) => vi.mocked(readRequestDetail).mockResolvedValue({ kind: "ok", data: normalizeRequestDetail(w) });
const mount = async () => render(await RequestPage({ params: Promise.resolve({ id: "i1" }) }));
/** u-1 is the one who asked in both fixtures: the strongest case for "Cancel is offered". */
const asManager = () => vi.mocked(getMe).mockResolvedValue(meFixture([{ role: "manager", scopeType: "company", scopeId: "co-a" }], [AGENCY], { userId: "u-1" }));
const asMember = () => vi.mocked(getMe).mockResolvedValue(meFixture([member("co-a")], [AGENCY], { userId: "u-1" }));

beforeEach(() => {
  vi.mocked(readRequestDetail).mockReset();
  vi.mocked(readLibraryAssets).mockReset().mockResolvedValue({ kind: "ok", data: [] });
  vi.mocked(readTaskAssigneeIds).mockReset().mockResolvedValue({ kind: "ok", data: [] });
  asMember();
});

describe("the receiving side's request page names the other company", () => {
  it("names the requesting company, its department, and the client the work is billed to (linked to its page)", async () => {
    read(wire());
    await mount();
    expect(screen.getByText("Viceroy · Front Office to Creatives")).toBeInTheDocument();
    expect(screen.getByText("Requesting company")).toBeInTheDocument();
    expect(screen.getByText("Billed to client")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Viceroy (client)" })).toHaveAttribute("href", "/clients/cl-viceroy");
    expect(screen.getByText("Ni Luh Sekar")).toBeInTheDocument();
  });

  it("says nothing about another company on a same-company request, which reads as it did", async () => {
    read(sameCompany());
    await mount();
    expect(screen.getByText("SEO to Creatives")).toBeInTheDocument();
    expect(screen.queryByText("Requesting company")).toBeNull();
    expect(screen.queryByText("Billed to client")).toBeNull();
  });

  it("falls back to the company's name when the requester's department is not known", async () => {
    read(wire({ requesterUnit: null }));
    await mount();
    expect(screen.getByText("Viceroy to Creatives")).toBeInTheDocument();
  });
});

describe("Cancel on a request another company asked for", () => {
  const cancel = () => screen.queryByRole("button", { name: "Cancel request" });

  it("is not offered, even to the signed-in person the row names as the requester", async () => {
    read(wire());
    await mount();
    expect(cancel()).toBeNull();
  });

  it("is not offered to a manager either, who may deliver and decline it (the receiving side declines instead)", async () => {
    asManager();
    read(wire());
    await mount();
    expect(cancel()).toBeNull();
    expect(screen.getByRole("button", { name: "Decline" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deliver assets" })).toBeInTheDocument();
  });

  it("is still offered on a same-company request the person asked for", async () => {
    read(sameCompany());
    await mount();
    expect(cancel()).toBeInTheDocument();
  });
});

// SCP-1h (BFF §63.6.6): the request detail lists the Social Media posts that joined it (additive `socialPosts`); a request no post joined shows no card.
describe("the social posts on a request", () => {
  const post = (over: Record<string, unknown> = {}) => ({
    postId: "p-1", title: "Morning pastries", clientName: "Brand Alpha", pipelineStatus: "design", creativeState: "in_progress",
    href: "/departments/d-soc/posts/p-1", ...over,
  });

  it("lists each post as a link to its post page, with the client and where the post stands", async () => {
    read({ ...sameCompany(), socialPosts: [post(), post({ postId: "p-2", title: "Autumn bouquets", clientName: "Brand Beta", pipelineStatus: "changes", creativeState: "revision", href: "/departments/d-soc/posts/p-2" })] });
    await mount();
    const list = screen.getByRole("list", { name: "Social posts on this request" });
    expect(list).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Morning pastries" })).toHaveAttribute("href", "/departments/d-soc/posts/p-1");
    expect(screen.getByRole("link", { name: "Autumn bouquets" })).toHaveAttribute("href", "/departments/d-soc/posts/p-2");
    expect(screen.getByText("Brand Alpha")).toBeInTheDocument();
    expect(screen.getByText(/To design · in progress/)).toBeInTheDocument();
    expect(screen.getByText(/Changes asked for · revision/)).toBeInTheDocument();
  });

  it("shows a post whose page link is not known as plain text, not a dead link", async () => {
    read({ ...sameCompany(), socialPosts: [post({ href: null })] });
    await mount();
    expect(screen.queryByRole("link", { name: "Morning pastries" })).toBeNull();
    expect(screen.getByText("Morning pastries")).toBeInTheDocument();
  });

  it("shows no card for a request no post joined, or from an older backend that sends no list", async () => {
    for (const w of [{ ...sameCompany(), socialPosts: [] }, sameCompany()]) {
      read(w);
      const { unmount } = await mount();
      expect(screen.queryByRole("list", { name: "Social posts on this request" })).toBeNull();
      expect(screen.queryByText("Social posts")).toBeNull();
      unmount();
    }
  });

  it("keeps the rest of the page as it was", async () => {
    read({ ...sameCompany(), socialPosts: [post()] });
    await mount();
    expect(screen.getByText("SEO to Creatives")).toBeInTheDocument();
    expect(screen.getByText("Three banners.")).toBeInTheDocument();
  });
});
