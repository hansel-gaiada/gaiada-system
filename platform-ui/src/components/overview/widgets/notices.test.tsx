import { render, screen, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

// DW-10a-2 (BFF §57.8): the Overview's notice blocks, the department's and the company's, in every state: unavailable (a refused or failed
// read), the notices (at most three, pinned first), "No current notices" with "Post a notice" for a person who may post, and NOTHING for a
// successful empty read when the person may not post.
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/notices-data", () => ({ listNotices: vi.fn() }));

import { listNotices } from "@/lib/notices-data";
import { Notices, CompanyNotices } from "./Notices";
import { NoticesBlock } from "./NoticesBlock";
import { OVERVIEW_WIDGETS, type OverviewWidgetProps } from "./index";
import type { NoticeList, NoticeRow } from "@/lib/notices";
import type { ReadResult } from "@/lib/readResult";
import type { Me } from "@/lib/platform";
import { me as meFixture, member } from "@/lib/workspaceFixtures";

const list = vi.mocked(listNotices);
const person = meFixture([member()]);
const head = meFixture([member(), { role: "org_unit_lead", scopeType: "org_unit", scopeId: "d-web" }]);
const admin = meFixture([{ role: "company_admin", scopeType: "company", scopeId: "co-a" }]);

const row = (id: string, over: Partial<NoticeRow> = {}): NoticeRow => ({
  id, scope: "unit", unitNodeId: "d-web", unitName: "Web Dev", title: `Title ${id}`, body: `Body ${id}`, pinned: false, endsOn: null, state: "current",
  author: { id: "u1", name: "Ketut" }, createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), editedAt: null, canEdit: false, ...over,
});
const ok = (...items: NoticeRow[]): ReadResult<NoticeList> => ({ kind: "ok", data: { items, nextCursor: null } });
const props = (key: string, who: Me = person, extra: Partial<OverviewWidgetProps> = {}): OverviewWidgetProps => ({
  me: who, tenantId: "co-a", period: "month", deptId: "d-web", unitPath: ["d-web", "root"], tools: [],
  widget: { key, band: "now", label: key }, ...extra,
});

beforeEach(() => list.mockReset());

describe("the widgets are registered", () => {
  it("hosts `notices` and `company-notices`", () => {
    expect(OVERVIEW_WIDGETS.notices).toBe(Notices);
    expect(OVERVIEW_WIDGETS["company-notices"]).toBe(CompanyNotices);
  });
});

describe("Notices (the department block)", () => {
  it("reads the department's own current notices, a few, as the signed-in person", async () => {
    list.mockResolvedValue(ok(row("a")));
    render(await Notices(props("notices")));
    expect(list).toHaveBeenCalledWith("u-1", "co-a", { unitNodeId: "d-web" }, { state: "current", limit: 3 });
  });

  it("draws at most three notices, pinned first, each with title, unit label, age and its first 140 characters, linking to the notice", async () => {
    list.mockResolvedValue(ok(
      row("a", { body: "x".repeat(300) }),
      row("b", { pinned: true }),
      row("c", { unitNodeId: "div", unitName: "Engineering" }),
      row("d"),
    ));
    render(await Notices(props("notices")));
    const block = screen.getByRole("region", { name: "Notices" });
    const items = within(block).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(within(items[0]).getByText("Pinned")).toBeInTheDocument();
    expect(within(items[0]).getByRole("link", { name: "Title b" })).toHaveAttribute("href", "/departments/d-web/notices#b");
    expect(items[1]).toHaveTextContent("Web Dev · 3 h ago");
    expect(items[1]).toHaveTextContent(`${"x".repeat(140)}…`);
    expect(items[1]).not.toHaveTextContent("x".repeat(141));
    expect(items[2]).toHaveTextContent("From Engineering");
    expect(within(block).getByRole("link", { name: "All notices" })).toHaveAttribute("href", "/departments/d-web/notices");
    // A person who may not post has no post link.
    expect(within(block).queryByRole("link", { name: "Post a notice" })).not.toBeInTheDocument();
  });

  it("draws nothing for a refused read (a visitor from another department)", async () => {
    list.mockResolvedValue({ kind: "forbidden" });
    const { container } = render(await Notices(props("notices", admin)));
    expect(screen.queryByRole("region", { name: "Notices" })).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent("Unavailable");
  });

  it("says Unavailable for a failed read, never 'No current notices'", async () => {
    for (const result of [{ kind: "unavailable", reason: "boom" }] as const) {
      list.mockResolvedValue(result);
      const { unmount } = render(await Notices(props("notices", admin)));
      const block = screen.getByRole("region", { name: "Notices" });
      expect(block).toHaveTextContent("Unavailable");
      expect(block).not.toHaveTextContent(/No current notices/);
      expect(within(block).queryByRole("link", { name: "Post a notice" })).not.toBeInTheDocument();
      unmount();
    }
  });

  it("draws nothing for a successful empty read when the person may not post", async () => {
    list.mockResolvedValue(ok());
    const { container } = render(await Notices(props("notices")));
    expect(container).toBeEmptyDOMElement();
  });

  it("says 'No current notices' with 'Post a notice' for a head on their own unit, and for a company admin", async () => {
    for (const who of [head, admin]) {
      list.mockResolvedValue(ok());
      const { unmount } = render(await Notices(props("notices", who)));
      const block = screen.getByRole("region", { name: "Notices" });
      expect(block).toHaveTextContent("No current notices");
      expect(within(block).getByRole("link", { name: "Post a notice" })).toHaveAttribute("href", "/departments/d-web/notices");
      unmount();
    }
  });

  it("does not offer a head 'Post a notice' on another department's Overview", async () => {
    list.mockResolvedValue(ok());
    const { container } = render(await Notices(props("notices", head, { deptId: "d-seo", unitPath: ["d-seo", "root"] })));
    expect(container).toBeEmptyDOMElement();
  });

  it("offers 'Post a notice' beside the notices too, for a person who may post", async () => {
    list.mockResolvedValue(ok(row("a")));
    render(await Notices(props("notices", head)));
    expect(screen.getByRole("link", { name: "Post a notice" })).toBeInTheDocument();
  });

  it("draws nothing without a department node (the frame does not place it there either)", async () => {
    expect(await Notices(props("notices", person, { deptId: null, unitPath: [] }))).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });
});

describe("CompanyNotices (the company Overview's block)", () => {
  it("reads the company-wide notices only, never narrowed to the node the frame carries", async () => {
    list.mockResolvedValue(ok(row("co", { scope: "company", unitNodeId: null, unitName: null })));
    render(await CompanyNotices(props("company-notices", person, { deptId: "d-gm", unitPath: ["d-gm", "root"] })));
    expect(list).toHaveBeenCalledWith("u-1", "co-a", { scope: "company" }, { state: "current", limit: 3 });
    const block = screen.getByRole("region", { name: "Company notices" });
    expect(within(block).getByRole("link", { name: "Title co" })).toHaveAttribute("href", "/notices#co");
    expect(block).toHaveTextContent("Whole company");
    expect(within(block).getByRole("link", { name: "All notices" })).toHaveAttribute("href", "/notices");
  });

  it("says Unavailable for a failed or refused read", async () => {
    list.mockResolvedValue({ kind: "unavailable", reason: "x" });
    render(await CompanyNotices(props("company-notices", admin, { deptId: null })));
    expect(screen.getByRole("region", { name: "Company notices" })).toHaveTextContent("Unavailable");
  });

  it("draws nothing for a successful empty read unless the person is a company admin, who is offered the post link; a head is not", async () => {
    list.mockResolvedValue(ok());
    const first = render(await CompanyNotices(props("company-notices", person, { deptId: null })));
    expect(first.container).toBeEmptyDOMElement();
    first.unmount();
    const second = render(await CompanyNotices(props("company-notices", head, { deptId: null })));
    expect(second.container).toBeEmptyDOMElement();
    second.unmount();
    render(await CompanyNotices(props("company-notices", admin, { deptId: null })));
    const block = screen.getByRole("region", { name: "Company notices" });
    expect(block).toHaveTextContent("No current notices");
    expect(within(block).getByRole("link", { name: "Post a notice" })).toHaveAttribute("href", "/notices");
  });
});

describe("NoticesBlock (a pure view)", () => {
  it("draws nothing for 'hidden'", () => {
    const { container } = render(<NoticesBlock view={{ kind: "hidden" }} title="Notices" allHref="/x" />);
    expect(container).toBeEmptyDOMElement();
  });
});
