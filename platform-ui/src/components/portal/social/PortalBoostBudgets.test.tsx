import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";

// SCP-4b (BFF §63.11 "The portal's approvals"): the "Boost budgets" section of /portal/approvals, as a signer and as a viewer meet it. The reads and the two writes are the demo twin's
// (the same boost store the staff pages use): the actions module is replaced by one that calls the twin's portal routes in the server's order (identity, the target in the contact's
// scope, the signer, the body, the replay), so a decision made here is judged by the same rules the server applies. A test replaces one answer to reach a case the twin cannot make.
// The store seeds from the day it is first touched, so the clock is pinned to mid-month (Friday 16 October 2026) before it is imported (hence vi.hoisted). Only Date is faked.
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T04:00:00Z"));
});
afterAll(() => vi.useRealTimers());

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, back: vi.fn(), push: vi.fn() }) }));
const persona = vi.hoisted(() => ({ user: "demo-client" }));
vi.mock("@/lib/portalSpendActions", async () => {
  const { demoPortalSpendRoute } = await import("@/lib/demoSocialBoosts");
  const { boostRefusalText } = await import("@/lib/socialBoosts");
  const post = async (path: string, body: Record<string, unknown>) => {
    const r = demoPortalSpendRoute("POST", `/api/co-agency/portal/social/spend/${path}`, JSON.stringify(body), persona.user)!;
    const j = r.json as Record<string, unknown>;
    if (r.status < 300) return { ok: true, ...(j.alreadyDecided ? { alreadyDecided: true } : {}) };
    return { ok: false, code: String(j.error), error: boostRefusalText({ status: r.status, error: String(j.error), detail: j.detail as Record<string, unknown> | undefined }), field: typeof j.field === "string" ? j.field : undefined };
  };
  return {
    decideBoostBudget: vi.fn(async (id: string, decision: string, note?: string) => post(`budgets/${id}/decide`, { decision, ...(note?.trim() ? { note: note.trim() } : {}) })),
    decideBoost: vi.fn(async (id: string, decision: string, note?: string) => post(`boosts/${id}/decide`, { decision, ...(note?.trim() ? { note: note.trim() } : {}) })),
  };
});

import { boostApi, demoPortalSpendRoute, seedBoostStore } from "@/lib/demoSocialBoosts";
import { PIPE_POSTS } from "@/lib/demoSocialPipeline";
import { PORTAL_VIEWER_LINE, asPortalSpend, type PortalSpend } from "@/lib/socialBoosts";
import { decideBoost, decideBoostBudget } from "@/lib/portalSpendActions";
import { PortalBoostBudgets } from "./PortalBoostBudgets";

const spendFor = (user: string): PortalSpend => asPortalSpend(demoPortalSpendRoute("GET", "/api/co-agency/portal/social/spend", undefined, user)!.json);
// A fresh seed, for the tests that run after a decision has moved the shared store.
const fresh = boostApi(seedBoostStore());
const freshSpend = (user: string): PortalSpend => asPortalSpend(fresh.portal("GET", "/api/co-agency/portal/social/spend", undefined, user)!.json);
const mount = (user = "demo-client", spend: PortalSpend = spendFor(user)) => { persona.user = user; return render(<PortalBoostBudgets spend={spend} tenant="co-agency" />); };
const reshare = () => PIPE_POSTS.find((p) => p.title === "Reader favourite reshare")!;

beforeEach(() => { vi.clearAllMocks(); persona.user = "demo-client"; });

describe("as a signer", () => {
  it("shows a month's proposal (month, amount, what is agreed and committed, the note) and a boost waiting (title, thumbnail, total, days, start, what remains)", () => {
    mount();
    expect(screen.getByRole("heading", { name: "Boost budgets" })).toBeInTheDocument();
    const budget = screen.getByRole("list", { name: "Budgets waiting for you" });
    expect(within(budget).getByText("Boost budget for November 2026")).toBeInTheDocument();
    expect(within(budget).getByText("IDR 1,200,000", { selector: "strong" })).toBeInTheDocument();
    expect(budget.textContent).toMatch(/Nothing is agreed for this month yet\. Already committed to boosts: IDR 0\./);
    expect(within(budget).getByText("Our note: Raising next month's budget for the holiday launch.")).toBeInTheDocument();

    const boosts = screen.getByRole("list", { name: "Boosts waiting for you" });
    expect(within(boosts).getByText("Reader favourite reshare")).toBeInTheDocument();
    expect(boosts.textContent).toMatch(/A boost of IDR 600,000 over 6 days, starting 27 Oct 2026\./);
    expect(boosts.textContent).toMatch(/It is over this month's agreed budget\. What is left of the month: IDR 500,000\./);
    const img = within(boosts).getByRole("img", { name: "Your post: Reader favourite reshare" });
    expect(img).toHaveAttribute("src", `/api/co-agency/portal/files/${reshare().id}-f1`);
  });

  it("offers Agree and Decline for a budget, Approve and Decline for a boost, each with an optional note, every control labelled", () => {
    mount();
    expect(screen.getByRole("button", { name: "Agree to the Boost budget for November 2026" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Decline the Boost budget for November 2026" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Approve the boost of Reader favourite reshare" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Decline the boost of Reader favourite reshare" })).toBeEnabled();
    expect(screen.getAllByLabelText("Note to the team (optional)").length).toBe(2);
    expect(screen.queryByText(PORTAL_VIEWER_LINE)).toBeNull();
  });

  it("never shows our fees, a staff status or a staff name", () => {
    const { container } = mount();
    expect(container.textContent).not.toMatch(/\bfees?\b/i);
    expect(container.textContent).not.toMatch(/Dewi|Komang|Wayan|Citra|Kadek/);
  });

  it("lists the client's own past decisions", () => {
    mount();
    const past = screen.getByRole("list", { name: "Past boost decisions" });
    expect(past.textContent).toMatch(/October 2026 budget.*Agreed: IDR 1,000,000/);
    expect(past.textContent).toMatch(/Declined: IDR 1,500,000/);
  });

  it("agreeing sends the note with the decision, shows it as done, and refreshes (the proposal for next month, with a note)", async () => {
    mount();
    const proposal = spendFor("demo-client").budgets[0].proposalId;
    fireEvent.change(screen.getAllByLabelText(/Note to the team about Boost budget for November 2026/)[0], { target: { value: "  Fine by us.  " } });
    fireEvent.click(screen.getByRole("button", { name: "Agree to the Boost budget for November 2026" }));
    await screen.findByText("Boost budget for November 2026, agreed: done.");
    expect(decideBoostBudget).toHaveBeenCalledWith(proposal, "agree", "  Fine by us.  ");
    expect(refresh).toHaveBeenCalled();
    expect(screen.queryByRole("list", { name: "Budgets waiting for you" })).toBeNull(); // it left the waiting list
    expect(spendFor("demo-client").budgets).toHaveLength(0);
  });

  it("approving a boost sends 'approve' and the boost is approved through the portal", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Approve the boost of Reader favourite reshare" }));
    await screen.findByText("Reader favourite reshare, approved: done.");
    expect(decideBoost).toHaveBeenCalledWith(spendFor("demo-client").history.find((h) => h.kind === "boost")!.id, "approve", undefined);
    expect(spendFor("demo-client").boosts).toHaveLength(0);
  });

  it("a replay of the same decision is shown as already done, not as a second decision", async () => {
    // the boost is approved above; the server answers a replay `{alreadyDecided: true}`
    const replay = spendFor("demo-client");
    const gone = replay.history.find((h) => h.kind === "boost")!;
    const spend: PortalSpend = { ...replay, boosts: [{ boostId: gone.id, clientName: "Northwind Traders", postTitle: "Reader favourite reshare", thumbFileId: null, totalBudgetMinor: 600_000, days: 6, startsOn: "2026-10-27", currency: "IDR", minorUnit: 0, remainingMinor: 0, simulated: false }], budgets: [] };
    mount("demo-client", spend);
    fireEvent.click(screen.getByRole("button", { name: "Approve the boost of Reader favourite reshare" }));
    await screen.findByText(/Reader favourite reshare, approved: this was already decided, so nothing changed\./);
    expect(screen.queryByText(/approved: done\./)).toBeNull();
  });

  it("a refusal is said in words beside the item, and the item stays", async () => {
    mount("demo-client", { budgets: [], boosts: [{ boostId: "no-such-boost", clientName: "Northwind Traders", postTitle: "A post", thumbFileId: null, totalBudgetMinor: 5, days: 1, startsOn: "2026-10-27", currency: "IDR", minorUnit: 0, remainingMinor: 0, simulated: false }], history: [], canDecide: true });
    fireEvent.click(screen.getByRole("button", { name: "Decline the boost of A post" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That boost no longer exists.");
    expect(screen.getByRole("button", { name: "Decline the boost of A post" })).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("as a viewer", () => {
  it("sees the items and the line that only a signer can decide, and has no controls", () => {
    mount("demo-client-viewer", freshSpend("demo-client-viewer"));
    expect(screen.getByRole("heading", { name: "Boost budgets" })).toBeInTheDocument();
    expect(screen.getByText("Boost budget for November 2026")).toBeInTheDocument();
    expect(screen.getByText("Reader favourite reshare")).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(PORTAL_VIEWER_LINE);
    expect(PORTAL_VIEWER_LINE).toMatch(/Only a signer on your account can agree/);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByLabelText(/Note to the team/)).toBeNull();
  });

  it("the twin refuses a viewer who decides anyway: 403 view_only, in words", () => {
    const r = fresh.portal("POST", `/api/co-agency/portal/social/spend/boosts/${freshSpend("demo-client-viewer").boosts[0].boostId}/decide`, JSON.stringify({ decision: "approve" }), "demo-client-viewer");
    expect(r).toMatchObject({ status: 403, json: { error: "view_only" } });
  });
});

describe("with nothing waiting", () => {
  it("says so in one calm line when there is only a history", () => {
    mount("demo-client", { budgets: [], boosts: [], history: [{ id: "h", kind: "budget", title: "October 2026 budget", status: "agreed", amountMinor: 1_000_000, currency: "IDR", minorUnit: 0, decidedAt: "2026-10-01T00:00:00Z" }], canDecide: true });
    expect(screen.getByText("Nothing is waiting for your decision on boost budgets.")).toBeInTheDocument();
    expect(screen.getByText("Agreed: IDR 1,000,000")).toBeInTheDocument();
    expect(screen.queryByText(PORTAL_VIEWER_LINE)).toBeNull();
  });

  it("a viewer with only a history is not told about deciding (nothing waits)", async () => {
    mount("demo-client-viewer", { budgets: [], boosts: [], history: [{ id: "h", kind: "boost", title: "A boost", status: "approved", amountMinor: 5, currency: "IDR", minorUnit: 0, decidedAt: null }], canDecide: false });
    await waitFor(() => expect(screen.getByText("Past decisions")).toBeInTheDocument());
    expect(screen.queryByRole("note")).toBeNull();
  });
});
