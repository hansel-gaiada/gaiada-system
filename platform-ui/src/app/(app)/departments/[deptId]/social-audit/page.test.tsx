import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";

// SCP-5g (BFF §63.28, §63.17): the social audit list and one audit. Server pages: the readers are mocked, the element tree is rendered. The list draws the server's `GET audits` (worst first, with the score in
// words and numbers and the band as a word, the first fix, the SIMULATED mark, "Start audit" for a client with none, "New prospect audit" for the four); one audit draws the twelve dimensions with their
// automatic evidence or reason and the typed scores, the fixes and the summary; a refused read is "no access" and a failed one is "cannot tell", never an empty list; both pages belong to the Social Media workspace only.
const push = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => { throw new Error(`redirect:${to}`); }),
  notFound: vi.fn(() => { throw new Error("notFound"); }),
  useRouter: () => ({ refresh, push }),
}));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", async (orig) => ({
  ...(await orig<typeof import("@/lib/platform")>()),
  getMe: vi.fn(async () => ({ userId: "u-1", roles: [], companies: [{ id: "co-a", vertical: "agency" }] })),
}));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("@/lib/companyContext", () => ({ activeCompany: vi.fn(() => ({ id: "co-a", vertical: "agency" })) }));
vi.mock("@/lib/departments", () => ({ getDepartmentNode: vi.fn() }));
vi.mock("@/lib/socialAudit-data", () => ({ getAudits: vi.fn(), getAudit: vi.fn() }));
vi.mock("@/lib/socialAllocation-data", () => ({ getAllocation: vi.fn() }));
vi.mock("@/lib/socialAuditActions", () => ({
  startClientAudit: vi.fn(), startProspectAudit: vi.fn(), saveAudit: vi.fn(), proposeAuditSummary: vi.fn(), finalizeAudit: vi.fn(), attachAudit: vi.fn(), deleteAudit: vi.fn(),
}));

import { getSessionUserId } from "@/lib/session-server";
import { getDepartmentNode } from "@/lib/departments";
import { getAudit, getAudits } from "@/lib/socialAudit-data";
import { getAllocation } from "@/lib/socialAllocation-data";
import { asAuditDetail, asAuditList } from "@/lib/socialAudit";
import { startClientAudit, startProspectAudit } from "@/lib/socialAuditActions";
import { REFUSAL_WORDS } from "@/lib/socialPipeline";
import { PROSPECT_WRITE_REASON, auditRefusalText } from "@/lib/socialAudit";
import SocialAuditPage from "./page";
import SocialAuditDetailPage from "./[auditId]/page";

const row = (o: Record<string, unknown> = {}) => ({ auditId: "a1", subject: "client", engagementId: "e1", name: "Northwind Traders", status: "draft", month: "2026-09", overall: 62, band: "fair", bandLabel: "Fair", scored: 7, total: 12, topFix: { key: "reels", label: "Reels", score: 1, advice: "Hook." }, finalizedAt: null, simulated: false, ...o });
const NONE = { auditId: null, subject: "client", engagementId: "e3", name: "Harborlight Hotel", status: null, month: null, overall: null, band: null, bandLabel: null, scored: 0, total: 12, topFix: null, finalizedAt: null, simulated: false };
const list = (items: unknown[], canAddProspect = false) => ({ kind: "ok" as const, data: asAuditList({ items, canAddProspect }) });
const mountList = async (search: Record<string, string> = {}, deptId = "d-soc") => render(await SocialAuditPage({ params: Promise.resolve({ deptId }), searchParams: Promise.resolve(search) }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSessionUserId).mockReset().mockResolvedValue("u-1");
  vi.mocked(getDepartmentNode).mockReset().mockResolvedValue({ id: "d-soc", name: "Social Media" } as never);
  vi.mocked(getAudits).mockReset().mockResolvedValue(list([
    row({ auditId: "a2", name: "Fernhill Bakery", subject: "prospect", engagementId: null, overall: 31, band: "needs_work", bandLabel: "Needs work", scored: 4, month: null }),
    row(),
    row({ auditId: "a3", name: "Saltmarsh Day Spa", status: "final", finalizedAt: "2026-10-05T00:00:00Z", overall: 81, band: "strong", bandLabel: "Strong", simulated: true, topFix: null }),
    NONE,
  ], true));
  vi.mocked(getAllocation).mockReset().mockResolvedValue({ kind: "ok", data: [{ engagementId: "e1", clientName: "Northwind Traders", status: "active" }, { engagementId: "e3", clientName: "Harborlight Hotel", status: "active" }] as never });
});

describe("the list: what is asked", () => {
  it("reads the audits for the signed-in person in the active company, with the subject only when it is one", async () => {
    await mountList({ subject: "prospect" });
    expect(getAudits).toHaveBeenCalledWith("u-1", "co-a", "prospect");
    await mountList({ subject: "team" });
    expect(getAudits).toHaveBeenLastCalledWith("u-1", "co-a", null);
  });
  it("sends a signed-out person to sign in, and is not found for another department, without reading anything", async () => {
    vi.mocked(getSessionUserId).mockResolvedValue(null as never);
    await expect(mountList()).rejects.toThrow("redirect:/login");
    vi.mocked(getSessionUserId).mockResolvedValue("u-1");
    vi.mocked(getDepartmentNode).mockResolvedValue({ id: "d-web", name: "Web Dev" } as never);
    await expect(mountList({}, "d-web")).rejects.toThrow("notFound");
    vi.mocked(getDepartmentNode).mockResolvedValue(null as never);
    await expect(mountList({}, "nope")).rejects.toThrow("notFound");
    expect(getAudits).not.toHaveBeenCalled();
  });
});

describe("the list: what it shows", () => {
  it("is titled Audit and draws each row in the server's order, with the score in words and numbers and the band as a word", async () => {
    await mountList();
    expect(screen.getByRole("heading", { name: "Audit" })).toBeInTheDocument();
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("cell")[0].textContent?.replace(/s*SIMULATED$/, "").trim())).toEqual(["Fernhill Bakery", "Northwind Traders", "Saltmarsh Day Spa", "Harborlight Hotel"]);
    const fern = rows[0];
    expect(fern).toHaveTextContent("Prospect");
    expect(fern).toHaveTextContent("Needs work");
    expect(fern).toHaveTextContent("31 out of 100 · 4 of 12 scored");
    const north = rows[1];
    expect(north).toHaveTextContent("Fair");
    expect(north).toHaveTextContent("62 out of 100 · 7 of 12 scored");
    expect(north).toHaveTextContent("Reels (1 out of 5)");
    expect(north).toHaveTextContent("Draft, September 2026");
    expect(within(north).getByRole("link", { name: "Northwind Traders" })).toHaveAttribute("href", "/departments/d-soc/social-audit/a1");
    expect(rows[2]).toHaveTextContent("Final, September 2026".replace("September 2026", "") );
    expect(rows[2]).toHaveTextContent("Strong");
  });
  it("marks a simulated audit, and only that one", async () => {
    await mountList();
    const marks = screen.getAllByRole("img", { name: "Simulated" });
    expect(marks).toHaveLength(1);
    expect(marks[0].closest("tr")).toHaveTextContent("Saltmarsh Day Spa");
  });
  it("a client with no audit says so and offers Start audit; the others offer none", async () => {
    await mountList();
    const hotel = screen.getByText("Harborlight Hotel").closest("tr")!;
    expect(hotel).toHaveTextContent("No audit yet");
    expect(within(hotel).getByRole("button", { name: "Start audit for Harborlight Hotel" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Start audit for/ })).toHaveLength(1);
  });
  it("filters by who through links, and says when a filter matches nothing, offering everyone", async () => {
    await mountList({ subject: "client" });
    const g = screen.getByRole("group", { name: "Who" });
    expect(within(g).getByRole("link", { name: "Clients" })).toHaveAttribute("aria-current", "true");
    expect(within(g).getByRole("link", { name: "Prospects" })).toHaveAttribute("href", "/departments/d-soc/social-audit?subject=prospect");
    expect(within(g).getByRole("link", { name: "Everyone" })).toHaveAttribute("href", "/departments/d-soc/social-audit");
    vi.mocked(getAudits).mockResolvedValue(list([]));
    await mountList({ subject: "prospect" });
    expect(screen.getByRole("status")).toHaveTextContent("There is no prospect audit yet.");
  });
  it("says an empty company is empty, in words, only when the read succeeded", async () => {
    vi.mocked(getAudits).mockResolvedValue(list([]));
    await mountList();
    expect(screen.getByRole("status")).toHaveTextContent("There is no client or prospect to audit yet.");
  });
  it("a refused read is no access and a failed one is cannot tell, never an empty list", async () => {
    vi.mocked(getAudits).mockResolvedValue({ kind: "forbidden" });
    const a = await mountList();
    expect(a.container.textContent).toMatch(/social audits/);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText(/There is no client or prospect/)).toBeNull();
    a.unmount();
    vi.mocked(getAudits).mockResolvedValue({ kind: "unavailable", reason: "the module is off" });
    await mountList();
    expect(screen.getByText(/the module is off/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("starting an audit from the list", () => {
  it("Start audit opens the client's draft for a fresh id, and a refusal is said in words with who may", async () => {
    vi.mocked(startClientAudit).mockResolvedValueOnce({ ok: false, refusal: { status: 403, error: "not_officer_or_approver" }, message: auditRefusalText({ status: 403, error: "not_officer_or_approver" }, "start") });
    await mountList();
    const btn = screen.getByRole("button", { name: "Start audit for Harborlight Hotel" });
    fireEvent.click(btn);
    expect(await screen.findByRole("alert")).toHaveTextContent(REFUSAL_WORDS.not_officer_or_approver);
    expect(push).not.toHaveBeenCalled();
    vi.mocked(startClientAudit).mockResolvedValueOnce({ ok: true, created: true, alreadyApplied: false, audit: asAuditDetail({ id: "a9", subject: "client", status: "draft", dimensions: [] }) });
    await waitFor(() => expect(btn).toBeEnabled());
    fireEvent.click(btn);
    await waitFor(() => expect(push).toHaveBeenCalledWith("/departments/d-soc/social-audit/a9"));
    const [eng, id] = vi.mocked(startClientAudit).mock.calls[1];
    expect(eng).toBe("e3");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4/);
  });
  it("New prospect audit is drawn for the four, checks the name before any request, and opens the audit it makes", async () => {
    await mountList();
    const form = screen.getByRole("form", { name: "New prospect audit" });
    fireEvent.click(within(form).getByRole("button", { name: "Create the audit" }));
    expect(within(form).getByRole("alert")).toHaveTextContent("Give the prospect a name.");
    expect(startProspectAudit).not.toHaveBeenCalled();
    vi.mocked(startProspectAudit).mockResolvedValue({ ok: true, created: true, alreadyApplied: false, audit: asAuditDetail({ id: "a8", subject: "prospect", status: "draft", dimensions: [] }) });
    fireEvent.change(within(form).getByLabelText("Prospect's name"), { target: { value: "Quay Coffee" } });
    fireEvent.change(within(form).getByLabelText("Followers"), { target: { value: "900" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create the audit" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/departments/d-soc/social-audit/a8"));
    expect(vi.mocked(startProspectAudit).mock.calls[0][0]).toMatchObject({ subject: "prospect", prospectName: "Quay Coffee", publicNumbers: { followers: 900 } });
  });
  it("says who may, and draws no form, when the server says the caller is not one of the four", async () => {
    vi.mocked(getAudits).mockResolvedValue(list([row()], false));
    await mountList();
    expect(screen.queryByRole("form", { name: "New prospect audit" })).toBeNull();
    expect(screen.getByText(new RegExp(PROSPECT_WRITE_REASON))).toBeInTheDocument();
  });
  it("a prospect refusal is said in words", async () => {
    vi.mocked(startProspectAudit).mockResolvedValue({ ok: false, refusal: { status: 403, error: "not_a_social_approver" }, message: REFUSAL_WORDS.not_a_social_approver });
    await mountList();
    const form = screen.getByRole("form", { name: "New prospect audit" });
    fireEvent.change(within(form).getByLabelText("Prospect's name"), { target: { value: "Quay Coffee" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create the audit" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent(REFUSAL_WORDS.not_a_social_approver);
  });
});

// ── one audit ─────────────────────────────────────────────────────────────────────────────────────────────────────

const dim = (key: string, o: Record<string, unknown> = {}) => ({ key, label: key.replace(/_/g, " "), kind: "typed", weight: 1, advice: `Fix ${key}`, auto: null, typed: null, used: null, ...o });
const DETAIL = (o: Record<string, unknown> = {}) => ({
  id: "a1", subject: "client", engagementId: "e1", name: "Northwind Traders", month: "2026-09", status: "draft", rulesRef: "default:x", summary: null, summaryVia: null, overall: 55, band: "fair", bandLabel: "Fair",
  scored: 3, total: 4, fixes: [{ key: "reels", label: "Reels", score: 1, advice: "Open with a hook." }, { key: "stories", label: "stories", score: 2, advice: "Post weekly." }], simulated: false,
  createdBy: { id: "u-1", name: "Komang" }, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z", canWrite: true, canFinalize: true, publicNumbers: {},
  dimensions: [
    dim("consistency", { kind: "automatic", auto: { score: 2.5, reason: null, evidence: { actual: 6, expected: 12, unit: "posts" } }, used: 2.5 }),
    dim("reels", { kind: "automatic", auto: { score: 1, reason: null, evidence: { actual: 0.01, expected: 0.04, unit: "rate" } }, used: 1 }),
    dim("boosting", { kind: "automatic", auto: { score: null, reason: "no_agreed_budget", evidence: { actual: 0, expected: 0, unit: "cycles" } } }),
    dim("stories", { kind: "automatic", auto: { score: 1, reason: null, evidence: { actual: 1, expected: 5, unit: "weeks" } }, typed: { score: 4, note: "Daily in highlights." }, used: 4 }),
    dim("profile", { typed: { score: 3.5, note: "Clear." }, used: 3.5 }),
  ],
  ...o,
});
const okAudit = (o: Record<string, unknown> = {}) => ({ kind: "ok" as const, data: asAuditDetail(DETAIL(o)) });
const mountDetail = async (auditId = "a1", deptId = "d-soc") => render(await SocialAuditDetailPage({ params: Promise.resolve({ deptId, auditId }) }));

describe("one audit: the scorecard", () => {
  beforeEach(() => { vi.mocked(getAudit).mockReset().mockResolvedValue(okAudit()); });

  it("reads the audit for the signed-in person in the active company", async () => {
    await mountDetail("a 1");
    expect(getAudit).toHaveBeenCalledWith("u-1", "co-a", "a 1");
  });
  it("is not found for an audit that does not exist, another department or a signed-out person", async () => {
    vi.mocked(getAudit).mockResolvedValue({ kind: "ok", data: null });
    await expect(mountDetail("gone")).rejects.toThrow("notFound");
    vi.mocked(getDepartmentNode).mockResolvedValue({ id: "d-web", name: "Web Dev" } as never);
    await expect(mountDetail("a1", "d-web")).rejects.toThrow("notFound");
    vi.mocked(getSessionUserId).mockResolvedValue(null as never);
    await expect(mountDetail()).rejects.toThrow("redirect:/login");
  });
  it("draws the overall in words and numbers with its band, and how many dimensions are scored", async () => {
    await mountDetail();
    const overall = screen.getByRole("region", { name: "Overall" });
    expect(overall).toHaveTextContent("55 out of 100");
    expect(overall).toHaveTextContent("Fair");
    expect(overall).toHaveTextContent("3 of 4 dimensions scored");
  });
  it("each automatic dimension shows its value with the evidence, or says why it is not scored; a typed override is named", async () => {
    await mountDetail();
    const cons = screen.getByRole("listitem", { name: "consistency" });
    expect(cons).toHaveTextContent("2.5 out of 5");
    expect(cons).toHaveTextContent("Automatic: 2.5 out of 5 (6 posts against 12 posts).");
    const boost = screen.getByRole("listitem", { name: "boosting" });
    expect(boost).toHaveTextContent("Not scored");
    expect(boost).toHaveTextContent("Automatic: not scored. No boost budget was agreed");
    const stories = screen.getByRole("listitem", { name: "stories" });
    expect(stories).toHaveTextContent("4 out of 5");
    expect(stories).toHaveTextContent("You replaced the automatic score with 4 out of 5.");
    expect(within(stories).getByLabelText("Why (needed when you replace the automatic score)")).toHaveValue("Daily in highlights.");
    expect(within(stories).getByRole("button", { name: "Use the automatic score for stories" })).toBeInTheDocument();
    expect(within(screen.getByRole("listitem", { name: "reels" })).getByText(/Rate 1% against 4%/)).toBeInTheDocument();
  });
  it("lists the fixes with their advice", async () => {
    await mountDetail();
    const fixes = screen.getByRole("region", { name: "The fixes" });
    expect(fixes).toHaveTextContent("Reels (1 out of 5): Open with a hook.");
  });
  it("marks a simulated audit once", async () => {
    vi.mocked(getAudit).mockResolvedValue(okAudit({ simulated: true }));
    await mountDetail();
    expect(screen.getAllByRole("img", { name: "Simulated" })).toHaveLength(1);
  });
  it("a refused read is no access and a failed one is cannot tell", async () => {
    vi.mocked(getAudit).mockResolvedValue({ kind: "forbidden" });
    const a = await mountDetail();
    expect(a.container.textContent).toMatch(/audit/i);
    expect(screen.queryByRole("region", { name: "Overall" })).toBeNull();
    a.unmount();
    vi.mocked(getAudit).mockResolvedValue({ kind: "unavailable", reason: "bad gateway" });
    await mountDetail();
    expect(screen.getByText(/bad gateway/)).toBeInTheDocument();
  });
  it("a final audit is read-only, says it is a dated record, and has no save, finalize, delete or Draft with AI", async () => {
    vi.mocked(getAudit).mockResolvedValue(okAudit({ status: "final", finalizedAt: "2026-10-05T00:00:00Z", finalizedBy: { id: "u-pm", name: "Dewi" }, canWrite: false, canFinalize: false, summary: "A calm account.", summaryVia: "template" }));
    await mountDetail();
    expect(screen.getByText(/a dated record/)).toHaveTextContent("Dewi");
    for (const name of ["Save", "Finalize", "Delete draft", "Draft with AI"]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Summary" })).toBeNull();
    expect(screen.getByText("A calm account.")).toBeInTheDocument();
    expect(screen.getByText("Typed: 3.5 out of 5. Note: Clear.")).toBeInTheDocument();
  });
  it("a draft the person may not write says who may, and draws the scores without inputs", async () => {
    vi.mocked(getAudit).mockResolvedValue(okAudit({ canWrite: false, canFinalize: false }));
    await mountDetail();
    expect(screen.getByText(/You can read this audit but not change it\. Only this client's officer/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Your score")).toBeNull();
    expect(screen.getByRole("button", { name: "Finalize" })).toBeDisabled();
  });
  it("a prospect's audit: no automatic part, public numbers, and Attach to client with the clients read", async () => {
    vi.mocked(getAudit).mockResolvedValue(okAudit({ subject: "prospect", engagementId: null, name: "Fernhill Bakery", prospectName: "Fernhill Bakery", businessType: "Bakery", month: null, publicNumbers: { followers: 3100 }, dimensions: [dim("profile", { typed: { score: 3, note: "" }, used: 3 })], total: 1, scored: 1 }));
    await mountDetail();
    expect(screen.queryByText(/Automatic:/)).toBeNull();
    expect(screen.getByLabelText("Followers")).toHaveValue("3100");
    expect(screen.getByRole("combobox", { name: "Attach to the client it became" })).toBeInTheDocument();
    expect(getAllocation).toHaveBeenCalledWith("u-1", "co-a");
  });
  it("an attached prospect names the client it became, linked to its page", async () => {
    vi.mocked(getAudit).mockResolvedValue(okAudit({ subject: "prospect", engagementId: "e3", name: "Fernhill Bakery", prospectName: "Fernhill Bakery", month: null, canWrite: true }));
    await mountDetail();
    expect(screen.getByRole("link", { name: "Harborlight Hotel" })).toHaveAttribute("href", expect.stringContaining("/departments/d-soc/profile/e3"));
    expect(screen.queryByRole("button", { name: "Attach to client" })).toBeNull();
  });
});
