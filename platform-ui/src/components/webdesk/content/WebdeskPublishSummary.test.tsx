import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/webdeskContent", async () => {
  const actual = await vi.importActual<typeof import("@/lib/webdeskContent")>("@/lib/webdeskContent");
  return { ...actual, getItem: vi.fn() };
});
vi.mock("@/lib/departments", () => ({ listDepartments: vi.fn() }));

import { getItem } from "@/lib/webdeskContent";
import { listDepartments } from "@/lib/departments";
import { SUMMARY_READ_CAP, WebdeskPublishSummary, WebdeskPublishSummaryView, type SummaryRow } from "./WebdeskPublishSummary";

const get = vi.mocked(getItem);
const depts = vi.mocked(listDepartments);

const args = (n: number, extra: Record<string, unknown> = {}) => ({
  tenantSlug: "gaiada", siteId: "s1", rebuild: "staging",
  items: Array.from({ length: n }, (_, i) => ({ itemId: `i${i}`, version: 3, contentHash: `hash${i}abcdefghij` })), ...extra,
});
const detailFor = (id: string) => ({
  kind: "ok" as const,
  data: {
    item: { itemId: id, collectionKey: "service", locale: "en", slug: `service.${id}`, localizationGroupId: "g", headVersion: 3, publishedVersion: 2, publishState: "published", publishAt: null, unpublishAt: null, deletedAt: null, updatedAt: "t" },
    version: {} as never, group: [], lint: { unresolvedTokens: ["{{X}}"], markers: { CONFIRM: 2, CLIENT: 1 } },
  },
});

beforeEach(() => { get.mockReset(); depts.mockReset(); depts.mockResolvedValue([{ id: "dept-1", name: "Web Dev", divisions: 0, people: 0, openTasks: 0 }]);
  get.mockImplementation(async (_u, _c, _t, _s, id) => detailFor(String(id)) as never); });

describe("WebdeskPublishSummary (approvals/[id], origin webdesk)", () => {
  it("summarises a single publish: site, item at the requested version vs live, lint counts, rebuild target, diff link", async () => {
    render(await WebdeskPublishSummary({ userId: "u", company: "c", toolArgs: args(1), workflowId: "content.publish" }));
    const s = screen.getByTestId("webdesk-summary");
    expect(s.textContent).toContain("Publish to WebDesk");
    expect(s.textContent).toContain("gaiada / s1");
    expect(s.textContent).toContain("1 item");
    expect(s.textContent).toContain("staging site, after publishing");
    const row = within(screen.getByTestId("summary-items")).getAllByRole("row")[1];
    expect(row.textContent).toContain("service · service.i0 · en");
    expect(row.textContent).toContain("v3");
    expect(row.textContent).toContain("v2"); // live now
    expect(within(row).getByRole("link", { name: "Open" }).getAttribute("href")).toBe("/departments/dept-1/website/content/gaiada/s1/service/service.i0?locale=en");
    expect(within(row).getByRole("link", { name: "Diff against live" }).getAttribute("href")).toBe("/departments/dept-1/website/content/gaiada/s1/service/service.i0/history?locale=en&compare=3");
    expect(screen.getByTestId("summary-lint").textContent).toMatch(/1 unresolved token.*2 × \[CONFIRM: …\].*1 × \[CLIENT: …\]/);
    // the requested version is READ from WebDesk, not described from the arguments
    expect(get).toHaveBeenCalledWith("u", "c", "gaiada", "s1", "i0", 3);
  });

  it("a bulk import reads at most the cap and says how many it did NOT list; lint says what it was counted over", async () => {
    render(await WebdeskPublishSummary({ userId: "u", company: "c", toolArgs: args(330, { bundleSha256: "ab".repeat(32), counts: { service: 40, post: 90 } }), workflowId: "content.publish" }));
    expect(get).toHaveBeenCalledTimes(SUMMARY_READ_CAP);
    expect(screen.getAllByRole("row")).toHaveLength(SUMMARY_READ_CAP + 1);
    expect(screen.getByTestId("summary-unread").textContent).toContain(`${330 - SUMMARY_READ_CAP} more items`);
    expect(screen.getByTestId("summary-lint").textContent).toContain(`counted over the ${SUMMARY_READ_CAP} items read, not all 330`);
    expect(screen.getByTestId("summary-counts").textContent).toContain("service 40 · post 90");
    expect(screen.getByTestId("webdesk-summary").textContent).toContain("abababababababab…");
  });

  it("an item that cannot be read is shown as unreadable, never as a clean row", async () => {
    get.mockResolvedValueOnce({ kind: "unavailable", code: "upstream_error", reason: "boom" });
    render(await WebdeskPublishSummary({ userId: "u", company: "c", toolArgs: args(2), workflowId: "content.publish" }));
    expect(screen.getByTestId("summary-items").textContent).toContain("couldn't be read (boom)");
    expect(screen.getByTestId("summary-lint").textContent).toContain("1 could not be read");
  });

  it("arguments that are not in the publish format are flagged, never summarised as an empty list", async () => {
    render(await WebdeskPublishSummary({ userId: "u", company: "c", toolArgs: { items: "x" }, workflowId: "content.publish" }));
    expect(screen.getByTestId("webdesk-summary-unrecognised").textContent).toContain("Unrecognised request");
    expect(screen.queryByTestId("summary-items")).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it("a scheduled publish names the time", async () => {
    render(await WebdeskPublishSummary({ userId: "u", company: "c", toolArgs: args(1, { publishAt: "2026-11-01T00:00:00Z" }), workflowId: "content.schedule" }));
    expect(screen.getByTestId("webdesk-summary").textContent).toContain("Scheduled publish");
    expect(screen.getByTestId("webdesk-summary").textContent).toContain("Publish at");
  });

  it("without a Web Dev department the rows still render, with no deep links and a note", async () => {
    depts.mockResolvedValue([{ id: "d2", name: "Legal", divisions: 0, people: 0, openTasks: 0 }]);
    render(await WebdeskPublishSummary({ userId: "u", company: "c", toolArgs: args(1), workflowId: "content.publish" }));
    expect(screen.queryByRole("link", { name: "Open" })).toBeNull();
    expect(screen.getByTestId("webdesk-summary").textContent).toContain("could not be found for this company");
  });
});

describe("WebdeskPublishSummary: a lint that could not run is not a zero", () => {
  const unavailableDetail = (id: string) => { const d = detailFor(id); return { ...d, data: { ...d.data, lint: { unresolvedTokens: [], markers: {}, unavailable: "the collection's stored composition is invalid" } } }; };
  it("every item unchecked: 'couldn't be checked', no '0 unresolved tokens'", async () => {
    get.mockImplementation(async (_u, _c, _t, _s, id) => unavailableDetail(String(id)) as never);
    render(await WebdeskPublishSummary({ userId: "u", company: "c", toolArgs: args(2), workflowId: "content.publish" }));
    const t = screen.getByTestId("summary-lint").textContent ?? "";
    expect(t).toContain("couldn't be checked");
    expect(t).not.toMatch(/\d+ unresolved token/);
  });
  it("some unchecked: counts what was checked and says how many were not", async () => {
    get.mockImplementation(async (_u, _c, _t, _s, id) => (String(id) === "i1" ? unavailableDetail("i1") : detailFor(String(id))) as never);
    render(await WebdeskPublishSummary({ userId: "u", company: "c", toolArgs: args(2), workflowId: "content.publish" }));
    expect(screen.getByTestId("summary-lint").textContent).toMatch(/1 unresolved token.*1 couldn't be checked, so they are not counted/);
  });
});

describe("WebdeskPublishSummaryView (pure)", () => {
  it("does not offer a diff when the requested version IS the live one", () => {
    const rows: SummaryRow[] = [{ itemId: "i", version: 2, contentHash: null, problem: null, resolved: { collectionKey: "service", slug: "s", locale: "en", publishedVersion: 2, headVersion: 2, publishState: "published", lint: { unresolvedTokens: [], markers: {} } } }];
    render(<WebdeskPublishSummaryView args={{ tenantSlug: "g", siteId: "s", items: [{ itemId: "i", version: 2, contentHash: null }], publishAt: null, rebuild: null, bundleSha256: null, counts: null }} rows={rows} unread={0} workflowId="content.publish" deptId="d" />);
    expect(screen.queryByRole("link", { name: "Diff against live" })).toBeNull();
    expect(screen.getByTestId("webdesk-summary").textContent).toContain("none requested"); // rebuild
  });
});

describe("WebdeskPublishSummary: the editorial review (M5-W2c, the approver's view)", () => {
  const withEditorial = (id: string, editorial: Record<string, unknown> | undefined) => {
    const d = detailFor(id);
    return { ...d, data: { ...d.data, ...(editorial ? { editorial } : {}) } };
  };
  const cells = () => screen.getAllByTestId("summary-review-cell").map((c) => c.textContent);

  it("the requested version IS the approved one: 'approved', and no warning", async () => {
    get.mockImplementation(async (_u, _c, _t, _s, id) => withEditorial(String(id), { reviewRequired: true, state: "approved", approvedVersion: 3 }) as never);
    render(await WebdeskPublishSummary({ userId: "u", company: "c", toolArgs: args(1), workflowId: "content.publish" }));
    expect(cells()).toEqual(["approved (v3)"]);
    expect(screen.queryByTestId("summary-review-blocked")).toBeNull();
  });

  it("a requested version that is NOT the approved one: the row says so and a banner warns that WebDesk will refuse the publish", async () => {
    get.mockImplementation(async (_u, _c, _t, _s, id) =>
      withEditorial(String(id), String(id) === "i0" ? { reviewRequired: true, state: "draft", approvedVersion: 2 } : { reviewRequired: true, state: "in_review", approvedVersion: null }) as never);
    render(await WebdeskPublishSummary({ userId: "u", company: "c", toolArgs: args(2), workflowId: "content.publish" }));
    expect(cells()).toEqual(["not approved (v2 is)", "not approved (no version is)"]);
    const banner = screen.getByTestId("summary-review-blocked").textContent ?? "";
    expect(banner).toContain("2 items are not the approved version");
    expect(banner).toContain("WebDesk will refuse this publish");
  });

  it("review off says 'not required'; no review data at all says 'unknown' (never 'not required'); neither warns", async () => {
    get.mockImplementation(async (_u, _c, _t, _s, id) =>
      withEditorial(String(id), String(id) === "i0" ? { reviewRequired: false, state: "draft", approvedVersion: null } : undefined) as never);
    render(await WebdeskPublishSummary({ userId: "u", company: "c", toolArgs: args(2), workflowId: "content.publish" }));
    expect(cells()).toEqual(["not required", "unknown"]);
    expect(screen.queryByTestId("summary-review-blocked")).toBeNull();
  });

  it("a schedule that publishes is warned about the same; a takedown-only schedule puts nothing live and is not", async () => {
    get.mockImplementation(async (_u, _c, _t, _s, id) => withEditorial(String(id), { reviewRequired: true, state: "draft", approvedVersion: 2 }) as never);
    const { unmount } = render(await WebdeskPublishSummary({ userId: "u", company: "c", toolArgs: args(1, { publishAt: "2026-11-01T00:00:00Z" }), workflowId: "content.schedule" }));
    expect(screen.getByTestId("summary-review-blocked").textContent).toContain("WebDesk will refuse this schedule");
    unmount();
    render(await WebdeskPublishSummary({ userId: "u", company: "c", toolArgs: args(1, { unpublishAt: "2026-11-01T00:00:00Z" }), workflowId: "content.schedule" }));
    expect(screen.queryByTestId("summary-review-blocked")).toBeNull();
    expect(cells()).toEqual(["not checked (takedown)"]);
  });
});
