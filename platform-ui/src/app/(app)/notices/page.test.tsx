import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

// DW-10a-2 (BFF §57.8): the company-wide notice board. Only a company admin is offered the form (a head posting company-wide is a 403), and
// its scope is fixed to the whole company.
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: vi.fn(() => { throw new Error("notFound"); }), useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/noticeActions", () => ({ postNoticeAction: vi.fn(), editNoticeAction: vi.fn(), withdrawNoticeAction: vi.fn() }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", async (orig) => ({ ...(await orig<typeof import("@/lib/platform")>()), getMe: vi.fn() }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("@/lib/notices-data", () => ({ listNotices: vi.fn() }));
vi.mock("@/components/PageHeader", () => ({ PageHeader: ({ title }: { title: string }) => <h1>{title}</h1> }));

import { getMe } from "@/lib/platform";
import { listNotices } from "@/lib/notices-data";
import { lead, me as meFixture, member } from "@/lib/workspaceFixtures";
import type { NoticeList, NoticeRow } from "@/lib/notices";
import type { ReadResult } from "@/lib/readResult";
import CompanyNoticesPage from "./page";

const row = (id: string, over: Partial<NoticeRow> = {}): NoticeRow => ({
  id, scope: "company", unitNodeId: null, unitName: null, title: `Title ${id}`, body: `Body ${id}`, pinned: false, endsOn: null, state: "current",
  author: { id: "u1", name: "Clement Hansel" }, createdAt: "2026-10-16T09:00:00.000Z", editedAt: null, canEdit: false, ...over,
});
const ok = (items: NoticeRow[]): ReadResult<NoticeList> => ({ kind: "ok", data: { items, nextCursor: null } });
const as = {
  member: meFixture([member()]),
  head: meFixture([member(), lead("d-web")]),
  admin: meFixture([{ role: "company_admin", scopeType: "company", scopeId: "co-a" }]),
};
const mount = async (who: keyof typeof as, search: Record<string, string> = {}) => {
  vi.mocked(getMe).mockResolvedValue(as[who]);
  return render(await CompanyNoticesPage({ searchParams: Promise.resolve(search) }));
};
const postButton = () => screen.queryByRole("button", { name: "Post a notice" });

beforeEach(() => vi.mocked(listNotices).mockReset().mockResolvedValue(ok([])));

describe("the company-wide board", () => {
  it("reads the company-wide notices only", async () => {
    await mount("member");
    expect(listNotices).toHaveBeenCalledWith("u-1", "co-a", { scope: "company" }, { state: "current", cursor: null });
    expect(screen.getByRole("heading", { level: 1, name: "Company notices" })).toBeInTheDocument();
  });
  it("lists them, saying Whole company, with the author, and links the past ones", async () => {
    vi.mocked(listNotices).mockResolvedValue(ok([row("a", { pinned: true }), row("b")]));
    await mount("member");
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText("Pinned")).toBeInTheDocument();
    expect(items[0]).toHaveTextContent("Whole company · by Clement Hansel");
    expect(screen.getByRole("link", { name: "Past notices" })).toHaveAttribute("href", "/notices?state=past");
  });
  it("says 'No current notices' after a successful empty read, and never after a failed or refused one", async () => {
    const a = await mount("member");
    expect(screen.getByText("No current notices.")).toBeInTheDocument();
    a.unmount();
    vi.mocked(listNotices).mockResolvedValue({ kind: "unavailable", reason: "platform 503" });
    const b = await mount("member");
    expect(screen.queryByText(/No current notices/)).not.toBeInTheDocument();
    expect(screen.getByText(/platform 503/)).toBeInTheDocument();
    b.unmount();
    vi.mocked(listNotices).mockResolvedValue({ kind: "forbidden" });
    await mount("member");
    expect(screen.queryByText(/No current notices/)).not.toBeInTheDocument();
  });
  it("offers Edit and Withdraw on the rows the server says may be changed (the company admin's)", async () => {
    vi.mocked(listNotices).mockResolvedValue(ok([row("a", { canEdit: true })]));
    await mount("admin");
    expect(screen.getByRole("button", { name: "Edit Title a" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Withdraw Title a" })).toBeInTheDocument();
  });
});

describe("the form shows only to a company admin", () => {
  it("is offered to a company admin", async () => {
    await mount("admin");
    expect(postButton()).toBeInTheDocument();
  });
  it("is not offered to a member, nor to a department head (a head posting company-wide is a 403)", async () => {
    const m = await mount("member");
    expect(postButton()).not.toBeInTheDocument();
    m.unmount();
    await mount("head");
    expect(postButton()).not.toBeInTheDocument();
  });
  it("is not offered in the past view or after a refused read", async () => {
    const a = await mount("admin", { state: "past" });
    expect(postButton()).not.toBeInTheDocument();
    a.unmount();
    vi.mocked(listNotices).mockResolvedValue({ kind: "forbidden" });
    await mount("admin");
    expect(postButton()).not.toBeInTheDocument();
  });
});
