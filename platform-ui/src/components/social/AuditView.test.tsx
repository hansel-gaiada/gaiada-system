import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

// SCP-5g (BFF §63.28): one audit's form. Save sends only what changed, and the server's own rules are checked first (an override needs its note); "Use automatic" drops an override with a null score;
// "Draft with AI" is a proposal that fills the text and saves NOTHING until Save, which then says where the text came from; Finalize asks first and waits for a save; each refusal (403 who may, 409 the
// audit is final, 409 attached, 404) is said in words beside the control; a prospect is attached once.
const push = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));
vi.mock("@/lib/socialAuditActions", () => ({
  startClientAudit: vi.fn(), startProspectAudit: vi.fn(), saveAudit: vi.fn(), proposeAuditSummary: vi.fn(), finalizeAudit: vi.fn(), attachAudit: vi.fn(), deleteAudit: vi.fn(),
}));

import { attachAudit, deleteAudit, finalizeAudit, proposeAuditSummary, saveAudit } from "@/lib/socialAuditActions";
import { asAuditDetail, auditRefusalText, type AuditWriteKind } from "@/lib/socialAudit";
import { REFUSAL_WORDS } from "@/lib/socialPipeline";
import { AuditView } from "./AuditView";

const dim = (key: string, o: Record<string, unknown> = {}) => ({ key, label: key.replace(/_/g, " "), kind: "typed", weight: 1, advice: `Fix ${key}`, auto: null, typed: null, used: null, ...o });
const raw = (o: Record<string, unknown> = {}) => ({
  id: "a1", subject: "client", engagementId: "e1", name: "Northwind Traders", month: "2026-09", status: "draft", rulesRef: "default:x", summary: null, summaryVia: null, overall: 55, band: "fair", bandLabel: "Fair",
  scored: 3, total: 4, fixes: [], simulated: false, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z", canWrite: true, canFinalize: true, publicNumbers: {},
  dimensions: [
    dim("consistency", { kind: "automatic", auto: { score: 2.5, reason: null, evidence: { actual: 6, expected: 12, unit: "posts" } }, used: 2.5 }),
    dim("stories", { kind: "automatic", auto: { score: 1, reason: null, evidence: { actual: 1, expected: 5, unit: "weeks" } }, typed: { score: 4, note: "Daily in highlights." }, used: 4 }),
    dim("profile"),
  ],
  ...o,
});
const mount = (o: Record<string, unknown> = {}, clients: Array<{ engagementId: string; clientName: string }> = []) =>
  render(<AuditView deptId="d-soc" audit={asAuditDetail(raw(o))} clients={clients} />);
const wrote = (o: Record<string, unknown> = {}) => ({ ok: true as const, created: false, alreadyApplied: false, audit: asAuditDetail(raw(o)) });
const refused = (status: number, error: string, kind: AuditWriteKind, field?: string) => {
  const refusal = { status, error, ...(field ? { field } : {}) };
  return { ok: false as const, refusal, message: auditRefusalText(refusal, kind) };
};
/** Clicks a button once it is back (a write in flight disables it). */
const press = async (name: string) => {
  const b = await screen.findByRole("button", { name });
  await waitFor(() => expect(b).toBeEnabled());
  fireEvent.click(b);
};
const dimLi = (name: string) => screen.getByRole("listitem", { name });

beforeEach(() => { vi.clearAllMocks(); });

describe("saving", () => {
  it("Save is off until something changes, then sends only the changed score and says it saved", async () => {
    vi.mocked(saveAudit).mockResolvedValue(wrote());
    mount();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(within(dimLi("profile")).getByLabelText("Your score"), { target: { value: "3.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Saved.");
    expect(saveAudit).toHaveBeenCalledWith("a1", { scores: { profile: { score: 3.5, note: "" } } });
    expect(refresh).toHaveBeenCalled();
  });
  it("replacing an automatic score needs its note: it is named before any request", () => {
    mount();
    fireEvent.change(within(dimLi("consistency")).getByLabelText("Your score (replaces the automatic one)"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent("consistency: a score that replaces the automatic one needs a note saying why.");
    expect(saveAudit).not.toHaveBeenCalled();
  });
  it("Use automatic empties the override and Save sends a null for it", async () => {
    vi.mocked(saveAudit).mockResolvedValue(wrote());
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Use the automatic score for stories" }));
    expect(within(dimLi("stories")).getByLabelText("Your score (replaces the automatic one)")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveAudit).toHaveBeenCalledWith("a1", { scores: { stories: null } }));
  });
  it("a save the server refuses says who may (403) or that the audit is final (409), and stays on the form", async () => {
    mount();
    fireEvent.change(within(dimLi("profile")).getByLabelText("Your score"), { target: { value: "5" } });
    vi.mocked(saveAudit).mockResolvedValueOnce(refused(403, "not_officer_or_approver", "save"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(REFUSAL_WORDS.not_officer_or_approver);
    vi.mocked(saveAudit).mockResolvedValueOnce(refused(409, "audit_final", "save"));
    await press("Save");
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(REFUSAL_WORDS.audit_final));
    vi.mocked(saveAudit).mockResolvedValueOnce(refused(400, "invalid_field", "save", "scores.profile.score"));
    await press("Save");
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The score for profile must be from 0 to 5 in steps of a half."));
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("Draft with AI", () => {
  it("fills the summary with the proposal and saves NOTHING; Save then says it came from the AI, and typing over it says typed", async () => {
    vi.mocked(proposeAuditSummary).mockResolvedValue({ ok: true, proposal: { summary: "Northwind scores 55 out of 100.", draftedVia: "ai" } });
    vi.mocked(saveAudit).mockResolvedValue(wrote());
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Draft with AI" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Drafted with AI from the scores and the evidence");
    expect(screen.getByRole("textbox", { name: "Summary" })).toHaveValue("Northwind scores 55 out of 100.");
    expect(saveAudit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveAudit).toHaveBeenCalledWith("a1", { summary: "Northwind scores 55 out of 100.", summaryVia: "ai" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saved."));
    fireEvent.change(screen.getByRole("textbox", { name: "Summary" }), { target: { value: "Northwind scores 55 out of 100. Reels first." } });
    await press("Save");
    await waitFor(() => expect(saveAudit).toHaveBeenLastCalledWith("a1", { summary: "Northwind scores 55 out of 100. Reels first.", summaryVia: "typed" }));
  });
  it("says in words when the plain template was used, and when the proposal was refused", async () => {
    vi.mocked(proposeAuditSummary).mockResolvedValueOnce({ ok: true, proposal: { summary: "Plain.", draftedVia: "template" } });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Draft with AI" }));
    expect(await screen.findByRole("status")).toHaveTextContent("The AI could not be used just now");
    vi.mocked(proposeAuditSummary).mockResolvedValueOnce(refused(409, "audit_final", "ai_summary"));
    await press("Draft with AI");
    expect(await screen.findByRole("alert")).toHaveTextContent(REFUSAL_WORDS.audit_final);
  });
});

describe("finalize and delete", () => {
  it("Finalize asks first, says what it does, and freezes only on the second click; 'Not yet' sends nothing", async () => {
    vi.mocked(finalizeAudit).mockResolvedValue(wrote({ status: "final" }));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Finalize" }));
    const g = screen.getByRole("group", { name: "Confirm finalize" });
    expect(g).toHaveTextContent("freezes this scorecard as a dated record");
    fireEvent.click(within(g).getByRole("button", { name: "Not yet" }));
    expect(finalizeAudit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Finalize" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, finalize" }));
    await waitFor(() => expect(finalizeAudit).toHaveBeenCalledWith("a1"));
    expect(refresh).toHaveBeenCalled();
  });
  it("Finalize waits for a save, and says why beside it", () => {
    mount();
    fireEvent.change(within(dimLi("profile")).getByLabelText("Your score"), { target: { value: "5" } });
    expect(screen.getByRole("button", { name: "Finalize" })).toBeDisabled();
    expect(screen.getByText(/Save your changes first: finalizing freezes what is saved/)).toBeInTheDocument();
  });
  it("a finalize the server refuses says who may", async () => {
    vi.mocked(finalizeAudit).mockResolvedValue(refused(403, "not_officer_or_approver", "finalize"));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Finalize" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, finalize" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(REFUSAL_WORDS.not_officer_or_approver);
    expect(screen.queryByRole("group", { name: "Confirm finalize" })).toBeNull();
  });
  it("Delete draft asks first, then goes back to the list; a refusal (a final audit) is said in words", async () => {
    vi.mocked(deleteAudit).mockResolvedValueOnce(refused(409, "audit_final", "delete"));
    mount();
    await press("Delete draft");
    await press("Yes, delete it");
    expect(await screen.findByRole("alert")).toHaveTextContent(REFUSAL_WORDS.audit_final);
    expect(push).not.toHaveBeenCalled();
    vi.mocked(deleteAudit).mockResolvedValueOnce({ ok: true });
    await press("Delete draft");
    await press("Yes, delete it");
    await waitFor(() => expect(push).toHaveBeenCalledWith("/departments/d-soc/social-audit"));
  });
  it("a person who cannot write sees the buttons off with the sentence on who may (a client's audit)", () => {
    mount({ canWrite: false, canFinalize: false });
    expect(screen.getByRole("button", { name: "Finalize" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete draft" })).toBeDisabled();
    expect(screen.getAllByText(/Only this client's officer, the Social Media head, the GM, the owner or the superadmin can write a client's audit\./).length).toBeGreaterThan(0);
  });
});

describe("attaching a prospect", () => {
  const prospect = { subject: "prospect", engagementId: null, name: "Fernhill Bakery", prospectName: "Fernhill Bakery", month: null, dimensions: [dim("profile")] };
  const clients = [{ engagementId: "e1", clientName: "Northwind Traders" }, { engagementId: "e3", clientName: "Harborlight Hotel" }];
  it("attaches to the picked client once, and says so", async () => {
    vi.mocked(attachAudit).mockResolvedValue(wrote({ ...prospect, engagementId: "e3" }));
    mount(prospect, clients);
    fireEvent.change(screen.getByLabelText("Attach to the client it became"), { target: { value: "e3" } });
    fireEvent.click(screen.getByRole("button", { name: "Attach to client" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Attached.");
    expect(attachAudit).toHaveBeenCalledWith("a1", "e3");
  });
  it("says a refusal in words: not one of the four (403), already attached elsewhere (409), a client that is gone (404)", async () => {
    mount(prospect, clients);
    vi.mocked(attachAudit).mockResolvedValueOnce(refused(403, "not_a_social_approver", "attach"));
    fireEvent.click(screen.getByRole("button", { name: "Attach to client" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(REFUSAL_WORDS.not_a_social_approver);
    vi.mocked(attachAudit).mockResolvedValueOnce(refused(409, "audit_attached", "attach"));
    await press("Attach to client");
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(REFUSAL_WORDS.audit_attached));
    vi.mocked(attachAudit).mockResolvedValueOnce(refused(404, "engagement_not_found", "attach"));
    await press("Attach to client");
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(REFUSAL_WORDS.engagement_not_found));
    expect(refresh).not.toHaveBeenCalled();
  });
  it("says who may attach beside a disabled button, and a prospect's own fields are edited when it may be written", () => {
    mount({ ...prospect, canWrite: false, canFinalize: false }, clients);
    expect(screen.getByRole("button", { name: "Attach to client" })).toBeDisabled();
    expect(screen.getByText(/Only the Social Media head, the GM, the owner or the superadmin can attach/)).toBeInTheDocument();
  });
  it("a prospect's name and public numbers are saved through the same Save, with the numbers checked first", async () => {
    vi.mocked(saveAudit).mockResolvedValue(wrote(prospect));
    mount(prospect, clients);
    fireEvent.change(screen.getByLabelText("Followers"), { target: { value: "12.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Followers: a whole number, 0 or more.");
    fireEvent.change(screen.getByLabelText("Followers"), { target: { value: "3300" } });
    fireEvent.change(screen.getByLabelText("Prospect's name"), { target: { value: "Fernhill Bakehouse" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveAudit).toHaveBeenCalledWith("a1", { prospectName: "Fernhill Bakehouse", publicNumbers: { followers: 3300 } }));
  });
});
