import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(async () => ({ userId: "u-1", companies: [], roles: [] })) }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
vi.mock("@/lib/admin", () => ({
  getSystemStatus: vi.fn(async () => ({ ok: true })),
  getKnowledgeSources: vi.fn(async () => []),
  searchKnowledge: vi.fn(),
  KNOWLEDGE_QUERY_INVALID: "query_invalid",
}));
vi.mock("@/components/PageHeader", () => ({ PageHeader: ({ title }: { title: string }) => <h1>{title}</h1> }));
vi.mock("@/components/systems/StatusCard", () => ({ StatusCard: () => null }));
vi.mock("@/components/systems/ReviewButtons", () => ({ ReviewButtons: () => null }));
vi.mock("@/components/OutcomeScope", () => ({ OutcomeScope: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("./actions", () => ({ reviewSource: vi.fn() }));

import { searchKnowledge } from "@/lib/admin";
import KnowledgePage from "./page";

const mount = async (q?: string) => render(await KnowledgePage({ searchParams: Promise.resolve(q === undefined ? {} : { q }) }));
const hit = (family: string, title: string) => ({ sourceRef: `${family}:1`, family, title, snippet: `snippet of ${title}`, href: `/x/${family}`, score: 1 });
const IDX = "PDF and Word files are found by name, not by their contents.";

beforeEach(() => { vi.mocked(searchKnowledge).mockReset(); });

describe("Knowledge page search (DW-8i)", () => {
  it("lists results with a title link, a plain family label and the snippet", async () => {
    vi.mocked(searchKnowledge).mockResolvedValue({ kind: "ok", data: { query: "acme", results: [hit("pmtask", "Fix it"), hit("pmdoc", "Brief")] as never, indexedAt: null } });
    await mount("acme");
    expect(searchKnowledge).toHaveBeenCalledWith("u-1", "co-1", "acme");
    expect(screen.getByRole("link", { name: "Fix it" }).getAttribute("href")).toBe("/x/pmtask");
    expect(screen.getByText("Task")).toBeTruthy();
    expect(screen.getByText("Document")).toBeTruthy();
    expect(screen.getByText("snippet of Brief")).toBeTruthy();
  });
  it("nothing: says so and that results include only records you can open", async () => {
    vi.mocked(searchKnowledge).mockResolvedValue({ kind: "ok", data: { query: "zz", results: [], indexedAt: null } });
    await mount("zzz");
    expect(screen.getByText("Nothing you can open matches.")).toBeTruthy();
    expect(screen.getByText("Results include only records you can open.")).toBeTruthy();
  });
  it("unavailable is not 'no results'", async () => {
    vi.mocked(searchKnowledge).mockResolvedValue({ kind: "unavailable", reason: "knowledge_unavailable" });
    await mount("acme");
    expect(screen.getByText("Search isn't available right now.")).toBeTruthy();
    expect(screen.queryByText("Nothing you can open matches.")).toBeNull();
  });
  it("forbidden is not 'no results'", async () => {
    vi.mocked(searchKnowledge).mockResolvedValue({ kind: "forbidden" });
    await mount("acme");
    expect(screen.getByText("You can't search company knowledge.")).toBeTruthy();
    expect(screen.queryByText("Nothing you can open matches.")).toBeNull();
  });
  it("a one-character query is refused on the page without calling the reader", async () => {
    await mount("a");
    expect(screen.getByText("Type at least 2 characters.")).toBeTruthy();
    expect(searchKnowledge).not.toHaveBeenCalled();
  });
  it("a 400 from the reader reads the same way", async () => {
    vi.mocked(searchKnowledge).mockResolvedValue({ kind: "unavailable", reason: "query_invalid" });
    await mount("ab");
    expect(screen.getByText("Type at least 2 characters.")).toBeTruthy();
  });
  it("indexed line: with indexedAt shows (last: ...), without it does not", async () => {
    vi.mocked(searchKnowledge).mockResolvedValue({ kind: "ok", data: { query: "acme", results: [], indexedAt: "2026-10-14T06:00:00.000Z" } });
    const { unmount } = await mount("acme");
    expect(document.body.textContent).toMatch(/Indexed every 6 hours \(last: .*2026.*\)\. /);
    expect(document.body.textContent).toContain(IDX);
    unmount();
    vi.mocked(searchKnowledge).mockResolvedValue({ kind: "ok", data: { query: "acme", results: [], indexedAt: null } });
    await mount("acme");
    expect(document.body.textContent).toContain(`Indexed every 6 hours. ${IDX}`);
    expect(document.body.textContent).not.toContain("last:");
  });
  it("with no query: the form and the indexed line show, no search is made", async () => {
    await mount();
    expect(searchKnowledge).not.toHaveBeenCalled();
    expect(document.querySelector("form[method=get] input[name=q]")).toBeTruthy();
    expect(document.body.textContent).toContain(IDX);
  });
});
