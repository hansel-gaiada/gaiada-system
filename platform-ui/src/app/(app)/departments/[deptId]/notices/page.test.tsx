import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

// DW-10a-2 (BFF §57.8): a unit's notice board. The list is the server's (pinned first, with "From <unit>" for notices posted above); the
// "Post a notice" form is a mirror and shows only to a person who may post; Edit and Withdraw come from each row's own `canEdit`; and a refused
// or failed read is said as such, never "No current notices".
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: vi.fn(() => { throw new Error("notFound"); }), useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/noticeActions", () => ({ postNoticeAction: vi.fn(), editNoticeAction: vi.fn(), withdrawNoticeAction: vi.fn() }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", async (orig) => ({ ...(await orig<typeof import("@/lib/platform")>()), getMe: vi.fn() }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("@/lib/campaigns-data", () => ({ readOrgRoot: vi.fn() }));
vi.mock("@/lib/notices-data", () => ({ listNotices: vi.fn() }));

import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { readOrgRoot } from "@/lib/campaigns-data";
import { listNotices } from "@/lib/notices-data";
import { agencyTree, lead, me as meFixture, member } from "@/lib/workspaceFixtures";
import type { NoticeList, NoticeRow } from "@/lib/notices";
import type { ReadResult } from "@/lib/readResult";
import DepartmentNoticesPage from "./page";

const row = (id: string, over: Partial<NoticeRow> = {}): NoticeRow => ({
  id, scope: "unit", unitNodeId: "d-web", unitName: "Web Dev", title: `Title ${id}`, body: `Body ${id}`, pinned: false, endsOn: null, state: "current",
  author: { id: "u1", name: "Ketut Arta" }, createdAt: "2026-10-16T09:00:00.000Z", editedAt: null, canEdit: false, ...over,
});
const ok = (items: NoticeRow[], nextCursor: string | null = null): ReadResult<NoticeList> => ({ kind: "ok", data: { items, nextCursor } });
const as = {
  member: meFixture([member()]),
  head: meFixture([member(), lead("d-web")]),
  sibling: meFixture([member(), lead("d-seo")]),
  admin: meFixture([{ role: "company_admin", scopeType: "company", scopeId: "co-a" }]),
};
const mount = async (who: keyof typeof as, search: Record<string, string> = {}, deptId = "d-web") => {
  vi.mocked(getMe).mockResolvedValue(as[who]);
  return render(await DepartmentNoticesPage({ params: Promise.resolve({ deptId }), searchParams: Promise.resolve(search) }));
};
const postButton = () => screen.queryByRole("button", { name: "Post a notice" });

beforeEach(() => {
  vi.mocked(getActiveTenant).mockReset().mockResolvedValue("co-a");
  vi.mocked(readOrgRoot).mockReset().mockResolvedValue(agencyTree() as never);
  vi.mocked(listNotices).mockReset().mockResolvedValue(ok([]));
});

describe("what is asked of the platform", () => {
  it("reads this unit's current notices for the signed-in person", async () => {
    await mount("member");
    expect(listNotices).toHaveBeenCalledWith("u-1", "co-a", { unitNodeId: "d-web" }, { state: "current", cursor: null });
  });
  it("reads the past ones for ?state=past, and passes a cursor on", async () => {
    await mount("member", { state: "past", cursor: "c2" });
    expect(listNotices).toHaveBeenCalledWith("u-1", "co-a", { unitNodeId: "d-web" }, { state: "past", cursor: "c2" });
  });
  it("treats an unknown state as current", async () => {
    await mount("member", { state: "bogus" });
    expect(vi.mocked(listNotices).mock.calls[0][3]).toMatchObject({ state: "current" });
  });
});

describe("the list", () => {
  it("shows the notices in the server's order, pinned first with a Pinned marker, with 'From <unit>' and 'Whole company'", async () => {
    vi.mocked(listNotices).mockResolvedValue(ok([
      row("p", { pinned: true }),
      row("up", { unitNodeId: "div", unitName: "Engineering" }),
      row("co", { scope: "company", unitNodeId: null, unitName: null }),
    ]));
    await mount("member");
    const items = screen.getAllByRole("listitem");
    expect(items.map((li) => li.getAttribute("id"))).toEqual(["p", "up", "co"]);
    expect(within(items[0]).getByText("Pinned")).toBeInTheDocument();
    expect(items[1]).toHaveTextContent("From Engineering");
    expect(items[2]).toHaveTextContent("Whole company");
  });
  it("links to the past notices from the current view, and back from the past view", async () => {
    const { unmount } = await mount("member");
    expect(screen.getByRole("link", { name: "Past notices" })).toHaveAttribute("href", "/departments/d-web/notices?state=past");
    unmount();
    await mount("member", { state: "past" });
    expect(screen.getByRole("link", { name: "Current notices" })).toHaveAttribute("href", "/departments/d-web/notices");
  });
  it("links the next page, keeping the state", async () => {
    vi.mocked(listNotices).mockResolvedValue(ok([row("a")], "c2"));
    await mount("member", { state: "past" });
    expect(screen.getByRole("link", { name: "Next notices" })).toHaveAttribute("href", "/departments/d-web/notices?state=past&cursor=c2");
  });
  it("says 'No current notices' after a read that succeeded and was empty", async () => {
    await mount("member");
    expect(screen.getByText("No current notices.")).toBeInTheDocument();
  });
  it("words a failed read and a refused one as such, and never says 'No current notices'", async () => {
    vi.mocked(listNotices).mockResolvedValue({ kind: "unavailable", reason: "platform 500" });
    const first = await mount("admin");
    expect(screen.queryByText(/No current notices/)).not.toBeInTheDocument();
    expect(screen.getByText(/platform 500/)).toBeInTheDocument();
    first.unmount();
    vi.mocked(listNotices).mockResolvedValue({ kind: "forbidden" });
    await mount("admin");
    expect(screen.getByText(/You don't have access to this unit's notices/)).toBeInTheDocument();
    expect(screen.queryByText(/No current notices/)).not.toBeInTheDocument();
  });
});

describe("Edit and Withdraw", () => {
  it("appear on the notices whose canEdit is true and nowhere else", async () => {
    vi.mocked(listNotices).mockResolvedValue(ok([row("mine", { canEdit: true }), row("not", { canEdit: false })]));
    await mount("head");
    const [mine, not] = screen.getAllByRole("listitem");
    expect(within(mine).getByRole("button", { name: "Edit Title mine" })).toBeInTheDocument();
    expect(within(mine).getByRole("button", { name: "Withdraw Title mine" })).toBeInTheDocument();
    expect(within(not).queryByRole("button")).not.toBeInTheDocument();
  });
  it("follow the server's canEdit, not the viewer's role: a member sees none", async () => {
    vi.mocked(listNotices).mockResolvedValue(ok([row("a", { canEdit: false })]));
    await mount("member");
    expect(screen.queryByRole("button", { name: /Edit|Withdraw/ })).not.toBeInTheDocument();
  });
});

describe("the 'Post a notice' form is shown only to a person who may post", () => {
  it("is offered to the head of this unit and to a company admin", async () => {
    const head = await mount("head");
    expect(postButton()).toBeInTheDocument();
    head.unmount();
    await mount("admin");
    expect(postButton()).toBeInTheDocument();
  });
  it("is not offered to a member, to the head of a sibling unit, or in the past view", async () => {
    const m = await mount("member");
    expect(postButton()).not.toBeInTheDocument();
    m.unmount();
    const s = await mount("sibling");
    expect(postButton()).not.toBeInTheDocument();
    s.unmount();
    await mount("head", { state: "past" });
    expect(postButton()).not.toBeInTheDocument();
  });
  it("is offered to the head of an enclosing unit on a unit below it", async () => {
    // Frontend sits under Web Dev in the fixture tree.
    const tree = agencyTree();
    vi.mocked(readOrgRoot).mockResolvedValue(tree as never);
    const frontendId = tree.children.find((c) => c.id === "d-web")!.children[0].id;
    await mount("head", {}, frontendId);
    expect(postButton()).toBeInTheDocument();
  });
  it("is not offered to a head when the org tree cannot be read, nor to anyone after a refused read; a company admin still is when the tree is unreadable", async () => {
    vi.mocked(readOrgRoot).mockResolvedValue(null);
    const first = await mount("head");
    expect(postButton()).not.toBeInTheDocument();
    first.unmount();
    const second = await mount("admin");
    expect(postButton()).toBeInTheDocument();
    second.unmount();
    vi.mocked(listNotices).mockResolvedValue({ kind: "forbidden" });
    await mount("admin");
    expect(postButton()).not.toBeInTheDocument();
  });
});

it("is not found without an active company", async () => {
  vi.mocked(getActiveTenant).mockResolvedValue(null);
  vi.mocked(getMe).mockResolvedValue(as.member);
  await expect(DepartmentNoticesPage({ params: Promise.resolve({ deptId: "d-web" }), searchParams: Promise.resolve({}) })).rejects.toThrow("notFound");
});
