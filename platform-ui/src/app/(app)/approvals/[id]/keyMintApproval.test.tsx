import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

// WebDesk key.mint on /approvals/[id]: labelling, and the once-only key's custody across the server action, the revalidation
// that follows, and the server render of the decided row. Real page, real client component, real server action; only the
// network egress and next's request APIs are mocked.

vi.mock("next/navigation", () => ({
  redirect: (to: string) => { throw new Error(`redirect:${to}`); },
  notFound: () => { throw new Error("notFound"); },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-approver") }));
vi.mock("@/lib/platform", async () => {
  const actual = await vi.importActual<typeof import("@/lib/platform")>("@/lib/platform");
  return { ...actual, platformFetch: vi.fn(), getMe: vi.fn() };
});
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
vi.mock("@/lib/approvals", () => ({ getApprovalDetailAcrossTenants: vi.fn() }));
vi.mock("@/lib/webdeskContent", async () => {
  const actual = await vi.importActual<typeof import("@/lib/webdeskContent")>("@/lib/webdeskContent");
  return { ...actual, findKeyTarget: vi.fn() };
});
vi.mock("@/components/mail/MailThreadPanel", () => ({ MailThreadPanel: () => null }));
vi.mock("@/components/webdesk/content/WebdeskPublishSummary", () => ({ WebdeskPublishSummary: () => <div data-testid="publish-summary" /> }));

import { revalidatePath, revalidateTag } from "next/cache";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, platformFetch, PlatformError } from "@/lib/platform";
import { getApprovalDetailAcrossTenants } from "@/lib/approvals";
import { findKeyTarget } from "@/lib/webdeskContent";
import { decideApprovalItem, decideKeyMintApproval } from "../../actions";
import ApprovalDetailPage from "./page";

const KEY = "wdk_live_SECRET_7f3a9c1e5b2d4a60";
const ENV = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const TITLE = 'Mint a production read API key for gaiada (site "gaiada.com")';

const fetchMock = vi.mocked(platformFetch);
const getMeMock = vi.mocked(getMe);
const detailMock = vi.mocked(getApprovalDetailAcrossTenants);
const targetMock = vi.mocked(findKeyTarget);

const meAs = (userId: string) => ({
  userId, name: "N", email: "n@x.com", title: null, assurance: "high",
  companies: [{ id: "co-1", name: "Gaia" }], roles: [{ role: "company_admin", scopeType: "company", scopeId: "co-1" }],
}) as never;

const row = (over: Record<string, unknown> = {}) => ({
  id: "ap-1", workflowId: "key.mint", toolName: "webdesk.key.mint",
  toolArgs: { command: "key.mint", tenantSlug: "gaiada", siteId: "site-1", envId: ENV, scope: "read", summary: { title: TITLE }, commandHash: "h" },
  impact: "high", reason: TITLE, status: "pending", origin: "webdesk", agentName: null,
  requestedBy: "u-requester", requestedByName: "Dewi", decidedBy: null, decidedByName: null, decidedAt: null,
  createdAt: "2026-10-11T08:00:00.000Z", executionStatus: "not_applicable", executedAt: null, executedBy: null, executionError: null, executionResult: null, executionAttempts: null,
  ...over,
});
const asDetail = (data: Record<string, unknown>) => ({ tenantId: "co-1", detail: { kind: "automation_approval", origin: "webdesk", data } }) as never;
/** The markup the page produces from a fresh mount (what a refresh or a revalidated render shows): no client state exists yet. */
const htmlOf = (el: React.ReactElement) => { const v = render(el); const h = v.container.innerHTML; v.unmount(); return h; };
const page = async () => ApprovalDetailPage({ params: Promise.resolve({ id: "ap-1" }) });

const decideBody = (over: Record<string, unknown> = {}) => ({
  ok: true, webdesk: { command: "key.mint", executionStatus: "executed", apiKeyId: "key-1", envId: ENV, scope: "read", plaintextOnce: KEY, ...over },
});

beforeEach(() => {
  vi.mocked(revalidatePath).mockReset(); vi.mocked(revalidateTag).mockReset();
  fetchMock.mockReset(); getMeMock.mockReset(); detailMock.mockReset(); targetMock.mockReset();
  getMeMock.mockResolvedValue(meAs("u-approver"));
  vi.mocked(getSessionUserId).mockResolvedValue("u-approver");
  targetMock.mockResolvedValue({ siteName: "gaiada.com", environmentName: "production" });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// ── the page: a key.mint row is an API-key request, not a publish ─────────────────────────────────
describe("/approvals/[id] for a key.mint row", () => {
  it("is labelled an API key request, titled from the row's summary, with environment and scope shown — never a publish summary", async () => {
    detailMock.mockResolvedValue(asDetail(row()));
    render(await page());
    expect(screen.getAllByText("API key request").length).toBeGreaterThanOrEqual(2); // the eyebrow and the summary card
    expect(screen.queryByText("Website publish")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(TITLE);
    expect(screen.queryByTestId("publish-summary")).toBeNull();
    expect(screen.getByTestId("key-summary-env").textContent).toBe("production");
    expect(screen.getByTestId("key-summary-scope").textContent).toBe("read");
    expect(screen.getByTestId("key-summary-site").textContent).toContain("gaiada.com");
    expect(targetMock).toHaveBeenCalledWith("u-approver", "co-1", "gaiada", "site-1", ENV);
  });

  it("shows the environment id when the names could not be resolved (cosmetic read failed)", async () => {
    targetMock.mockResolvedValue(null);
    detailMock.mockResolvedValue(asDetail(row()));
    render(await page());
    expect(screen.getByTestId("key-summary-env").textContent).toBe(ENV);
  });

  it("a write key says what write means", async () => {
    detailMock.mockResolvedValue(asDetail(row({ toolArgs: { ...row().toolArgs, scope: "write" } })));
    render(await page());
    expect(screen.getByTestId("key-summary-scope").textContent).toBe("write");
    expect(screen.getByText("Write keys can change content through the API. Most sites only need read.")).toBeTruthy();
  });

  it("arguments in the wrong format are flagged, not summarised", async () => {
    detailMock.mockResolvedValue(asDetail(row({ toolArgs: { unexpected: true } })));
    render(await page());
    expect(screen.getByTestId("key-summary-unrecognised").textContent).toMatch(/Unrecognised request/);
    expect(screen.queryByTestId("key-summary")).toBeNull();
  });

  it("uses the key.mint decide control, not the generic form (which would throw the key away)", async () => {
    detailMock.mockResolvedValue(asDetail(row()));
    const { container } = render(await page());
    expect(container.querySelector("form")).toBeNull();
    expect(screen.getByRole("button", { name: "Approve" }).getAttribute("type")).toBe("button");
  });

  it("the requester sees no Approve (maker is never checker)", async () => {
    vi.mocked(getSessionUserId).mockResolvedValue("u-requester");
    getMeMock.mockResolvedValue(meAs("u-requester"));
    detailMock.mockResolvedValue(asDetail(row()));
    render(await page());
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.getByTestId("key-own-request")).toBeTruthy();
  });

  it("a publish row is untouched: 'Website publish', the publish summary and the generic form", async () => {
    detailMock.mockResolvedValue(asDetail(row({
      workflowId: "content.publish", toolName: "webdesk.content.requestPublish", reason: "Publish 1 item",
      toolArgs: { tenantSlug: "gaiada", siteId: "site-1", items: [{ itemId: "i1", version: 3 }], rebuild: "staging" },
    })));
    const { container } = render(await page());
    expect(screen.getByText("Website publish")).toBeTruthy();
    expect(screen.queryAllByText("API key request")).toHaveLength(0);
    expect(screen.getByTestId("publish-summary")).toBeTruthy();
    expect(container.querySelector("form")).not.toBeNull();
    expect(screen.queryByTestId("key-summary")).toBeNull();
    expect(targetMock).not.toHaveBeenCalled();
  });
});

// ── the server action: what it returns, and what it does NOT do with it ───────────────────────────
describe("decideKeyMintApproval: the key is returned to the caller and goes nowhere else", () => {
  const CONSOLE = ["log", "info", "warn", "error", "debug", "trace"] as const;
  const mentions = (calls: unknown[][]) => calls.some((a) => a.some((x) => { try { return (typeof x === "string" ? x : JSON.stringify(x)).includes(KEY); } catch { return false; } }));

  it("approve: posts to the façade as origin webdesk and RETURNS the parsed outcome with the key", async () => {
    fetchMock.mockResolvedValue(decideBody());
    const r = await decideKeyMintApproval("co-1", "ap-1", "approved", "fine");
    expect(r).toEqual({ ok: true, decision: "approved", mint: { status: "executed", envId: ENV, scope: "read", apiKeyId: "key-1", plaintextOnce: KEY } });
    const [path, userId, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/co-1/approvals/ap-1/decide");
    expect(userId).toBe("u-approver");
    expect(JSON.parse(String(init?.body))).toEqual({ origin: "webdesk", decision: "approved", note: "fine" });
  });

  it("passes NOTHING derived from the result to revalidatePath/revalidateTag, logs nothing, and stores nothing", async () => {
    const consoleSpies = CONSOLE.map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    fetchMock.mockResolvedValue(decideBody());
    await decideKeyMintApproval("co-1", "ap-1", "approved");

    // exactly the four constant paths (the approval id the caller already sent): the same ones decideApprovalItem revalidates
    expect(vi.mocked(revalidatePath).mock.calls).toEqual([["/approvals"], ["/approvals/ap-1"], ["/"], ["/departments"]]);
    expect(mentions(vi.mocked(revalidatePath).mock.calls)).toBe(false);
    expect(revalidateTag).not.toHaveBeenCalled();
    for (const spy of consoleSpies) expect(mentions(spy.mock.calls)).toBe(false);
    expect(setItem).not.toHaveBeenCalled();
    // the only call that ever carried the key onward is the platform egress's RESPONSE; nothing we send mentions it
    expect(mentions(fetchMock.mock.calls as unknown[][])).toBe(false);
  });

  it("deny: no outcome is read, no key", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    expect(await decideKeyMintApproval("co-1", "ap-1", "rejected")).toEqual({ ok: true, decision: "rejected" });
  });

  it("failed execution: the typed error, no key", async () => {
    fetchMock.mockResolvedValue({ ok: true, webdesk: { command: "key.mint", executionStatus: "failed", error: "webdesk_unreachable" } });
    expect(await decideKeyMintApproval("co-1", "ap-1", "approved")).toEqual({ ok: true, decision: "approved", mint: { status: "failed", envId: null, scope: null, error: "webdesk_unreachable" } });
  });

  it("an answer that is not the expected shape is `unreadable` — the malformed value is not echoed anywhere", async () => {
    const consoleSpies = CONSOLE.map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    fetchMock.mockResolvedValue(decideBody({ scope: KEY }));
    const r = await decideKeyMintApproval("co-1", "ap-1", "approved");
    expect(r).toEqual({ ok: true, decision: "approved", mint: { status: "unreadable" } });
    expect(JSON.stringify(r)).not.toContain(KEY);
    for (const spy of consoleSpies) expect(mentions(spy.mock.calls)).toBe(false);
  });

  it("approved with no in-band `webdesk` block is `unreadable`, not a success", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    expect(await decideKeyMintApproval("co-1", "ap-1", "approved")).toEqual({ ok: true, decision: "approved", mint: { status: "unreadable" } });
  });

  it("a refusal (403: you filed it yourself) is `{ ok:false, error }` and revalidates nothing", async () => {
    fetchMock.mockRejectedValue(new PlatformError(403, "not authorized: a key mint may not be approved by the principal who requested it"));
    const r = await decideKeyMintApproval("co-1", "ap-1", "approved");
    expect(r).toEqual({ ok: false, error: "not authorized: a key mint may not be approved by the principal who requested it" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("decideApprovalItem is byte-identical for every other caller: same body, same result, the response body ignored even when it holds a key", async () => {
    fetchMock.mockResolvedValue(decideBody());
    const r = await decideApprovalItem("co-1", "webdesk", "ap-1", "approved", "n");
    expect(r).toEqual({ ok: true });
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(JSON.parse(String(fetchMock.mock.calls[0][2]?.body))).toEqual({ origin: "webdesk", decision: "approved", note: "n" });
    expect(vi.mocked(revalidatePath).mock.calls).toEqual([["/approvals"], ["/approvals/ap-1"], ["/"], ["/departments"]]);
  });
});

// ── end to end across the revalidation: the key is in the action's answer and in ONE component's state ──
describe("the key across the action, the revalidation and the next server render", () => {
  it("approve shows the key; the page re-rendered from the DECIDED row (mayDecide false) keeps the panel; that server render holds no key", async () => {
    const responses: unknown[] = [];
    fetchMock.mockImplementation(async () => { const b = decideBody(); responses.push(b); return b; });

    detailMock.mockResolvedValue(asDetail(row()));
    const view = render(await page());
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Approve" })); });
    expect((screen.getByTestId("key-once-value") as HTMLInputElement).value).toBe(KEY);

    // The revalidation re-renders the page on the server from the decided row — which never holds the key.
    detailMock.mockResolvedValue(asDetail(row({ status: "approved", decidedBy: "u-approver", decidedByName: "Hansel", decidedAt: "2026-10-11T08:05:00.000Z", executionStatus: "executed", executedAt: "2026-10-11T08:05:00.000Z" })));
    const decidedPage = await page();
    expect(htmlOf(decidedPage)).not.toContain(KEY);
    expect(htmlOf(decidedPage)).not.toContain(">Approve<");

    // ...and the client component, still mounted in the same slot, keeps showing what only it holds.
    view.rerender(decidedPage);
    expect((screen.getByTestId("key-once-value") as HTMLInputElement).value).toBe(KEY);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();

    // Only the decide response ever carried the key: every platform read the page makes is of the row, and the row never has it.
    expect(responses).toHaveLength(1);
    const reads = detailMock.mock.results.map((r) => JSON.stringify(r.value));
    for (const rd of reads) expect(rd).not.toContain(KEY);
  });

  it("a fresh render of the decided page (a refresh, or navigating back) shows no key and no panel", async () => {
    detailMock.mockResolvedValue(asDetail(row({ status: "approved", decidedBy: "u-approver", executionStatus: "executed" })));
    const html = htmlOf(await page());
    expect(html).not.toContain(KEY);
    expect(html).not.toContain('data-testid="key-once"');
    expect(html).not.toContain("wdk_");
  });
});
