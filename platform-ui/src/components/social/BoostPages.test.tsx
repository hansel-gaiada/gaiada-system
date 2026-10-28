import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";

// SCP-4b, SCP-4c (BFF §63.11): the staff half of boosting as a person meets it. The writes are the demo store's (the twin DEMO_MODE serves): the actions module is replaced by one that
// calls `socialDemo`, the server's order of checks, so what a form posts is judged by the same rules the server applies and the page shows what comes back. A few tests replace one
// action's answer to reach a case the twin cannot make (a replayed step, a warning, a boost that moved). The store seeds from the day it is first touched, so the clock is pinned to
// mid-month (Friday 16 October 2026) before it is imported (hence vi.hoisted). Only Date is faked. Tests that submit take posts no earlier test used, and say which.
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T04:00:00Z"));
});
afterAll(() => vi.useRealTimers());

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, back: vi.fn(), push: vi.fn() }) }));
const persona = vi.hoisted(() => ({ user: "demo-hansel" }));
vi.mock("@/lib/socialBoostsActions", async () => {
  const { socialDemo } = await import("@/lib/demoSocial");
  const { asBoostBudget, asBoostEstimate, asBoostRow, boostRefusalText } = await import("@/lib/socialBoosts");
  const { asCycleTable } = await import("@/lib/socialCycles");
  const { refusalFromBody } = await import("@/lib/socialPipeline");
  const call = (method: string, tail: string, body?: unknown, query = "") =>
    socialDemo(method, `/api/co-agency/modules/social/${tail}`, new URLSearchParams(query), body === undefined ? undefined : JSON.stringify(body), persona.user)!;
  const write = (r: { status: number; json: unknown }) => {
    const j = r.json as Record<string, unknown>;
    if (r.status < 300) {
      let boost = null;
      try { boost = asBoostRow(j.boost); } catch { /* a budget write has no boost */ }
      return { ok: true as const, boost, remainingMinor: typeof j.remainingMinor === "number" ? j.remainingMinor : null, needsClient: j.needsClient === true, warnings: (j.warnings as string[] | undefined) ?? [], alreadyApplied: false };
    }
    const refusal = refusalFromBody(r.status, String(j.error), j, typeof j.field === "string" ? j.field : undefined);
    return { ok: false as const, refusal, message: boostRefusalText(refusal) };
  };
  return {
    requestBoost: vi.fn(async (postId: string, body: unknown) => write(call("POST", `posts/${postId}/boosts`, body))),
    runBoostAction: vi.fn(async (boostId: string, body: unknown) => write(call("POST", `boosts/${boostId}/actions`, body))),
    proposeBudget: vi.fn(async (cycleId: string, body: unknown) => write(call("POST", `cycles/${cycleId}/boost-budget/proposals`, body))),
    recordBudget: vi.fn(async (cycleId: string, body: unknown) => write(call("POST", `cycles/${cycleId}/boost-budget/record`, body))),
    withdrawProposal: vi.fn(async (proposalId: string) => write(call("POST", `boost-budget/proposals/${proposalId}/withdraw`, {}))),
    loadBoostEstimate: vi.fn(async (postId: string, q: { dailyBudgetMinor: number; days: number; audience: string }) => {
      const r = call("GET", `posts/${postId}/boosts/estimate`, undefined, `dailyBudgetMinor=${q.dailyBudgetMinor}&days=${q.days}&audience=${q.audience}`);
      return r.status < 300 ? asBoostEstimate(r.json) : null;
    }),
    loadBudgetForPost: vi.fn(async (postId: string, month: string) => {
      const post = call("GET", `posts/${postId}/pipeline`).json as { engagementId: string };
      const row = asCycleTable(call("GET", "cycles", undefined, `month=${month}`).json).rows.find((r) => r.engagementId === post.engagementId);
      if (!row?.cycleId) return { ok: true as const, budget: { cycleId: null, agreedMinor: null, remainingMinor: 0, committedMinor: 0, currency: "IDR", minorUnit: 0, canRecord: false } };
      const b = asBoostBudget(call("GET", `cycles/${row.cycleId}/boost-budget`).json);
      return { ok: true as const, budget: { cycleId: row.cycleId, agreedMinor: b.agreed?.amountMinor ?? null, remainingMinor: b.remainingMinor, committedMinor: b.committedMinor, currency: b.currency, minorUnit: b.minorUnit, canRecord: b.canRecord } };
    }),
  };
});

import { PIPE_POSTS, demoPipelineRead } from "@/lib/demoSocialPipeline";
import { socialDemo } from "@/lib/demoSocial";
import { asBoostBudget, asBoostList, asBoostRow, boostRefusalText, type BoostRow } from "@/lib/socialBoosts";
import { asPipelinePost, type PipelinePost } from "@/lib/socialPipeline";
import { proposeBudget, recordBudget, requestBoost, runBoostAction, withdrawProposal } from "@/lib/socialBoostsActions";
import { BoostRequestDialog } from "./BoostRequestDialog";
import { BoostCard } from "./BoostCard";
import { BoostBoard } from "./BoostBoard";
import { BoostBudgetCard } from "./BoostBudgetCard";
import { PostBoostSection } from "./PostBoost";

const postOf = (title: string) => PIPE_POSTS.find((p) => p.title === title)!;
const read = (title: string, user = "demo-hansel"): PipelinePost => asPipelinePost(demoPipelineRead(postOf(title).id, user).json);
const staff = (method: string, tail: string, user = "demo-hansel", query = "") => socialDemo(method, `/api/co-agency/modules/social/${tail}`, new URLSearchParams(query), undefined, user)!;
const budgetOf = (cycleId: string, user = "u-pm") => asBoostBudget(staff("GET", `cycles/${cycleId}/boost-budget`, user).json);
const NORTHWIND_CYCLE = "soc-cyc-soc-eng-1-2026-10";
const HOTEL_CYCLE = "soc-cyc-soc-eng-4-2026-10";
const boost = (over: Partial<BoostRow> = {}): BoostRow => asBoostRow({
  id: "bx", postId: "p1", postTitle: "A post", clientName: "Northwind Traders", cycleId: "c1", status: "approved", goal: "website", audience: "automatic", audienceNote: null,
  dailyBudgetMinor: 100_000, days: 3, totalBudgetMinor: 300_000, currency: "IDR", minorUnit: 0, startsOn: "2026-10-28", approvedVia: "budget", approvedAt: "2026-10-16T01:00:00Z",
  startedAt: null, endedAt: null, spendMinor: null, paidReach: null, clicks: null, reachEstimate: null, simulated: false, ...over,
});
const type = (label: RegExp | string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const press = (name: RegExp | string) => fireEvent.click(screen.getByRole("button", { name }));

beforeEach(() => { vi.clearAllMocks(); persona.user = "demo-hansel"; });

// The tests share one store and run in file order, so the ones that read the invented data as seeded come first, and each that submits takes posts and cycles no earlier test used.
describe("the Boosting page's body", () => {
  const data = () => asBoostList(staff("GET", "boosts").json);
  const mount = (next: string | null = null) => render(<BoostBoard deptId="d-soc" data={data()} nextHref={next} />);

  it("has the three parts: Candidates, Running and waiting, Totals", () => {
    mount();
    for (const h of ["Candidates", "Running and waiting", "Totals"]) expect(screen.getByRole("heading", { name: h })).toBeInTheDocument();
  });

  it("a candidate has a Boost button that opens the request dialog for that post, and links to the post", () => {
    mount();
    const row = screen.getByRole("list", { name: "Boost candidates" });
    const li = within(row).getAllByRole("listitem");
    expect(li).toHaveLength(1);
    expect(within(li[0]).getByRole("link", { name: "A day in the warehouse" })).toHaveAttribute("href", `/departments/d-soc/posts/${postOf("A day in the warehouse").id}`);
    expect(li[0].textContent).toMatch(/Northwind Traders.*Engagement rate 7\.\d%.*Client's average 3\.\d%/);
    fireEvent.click(within(li[0]).getByRole("button", { name: "Boost A day in the warehouse" }));
    expect(screen.getByRole("dialog", { name: "Boost this post" })).toBeInTheDocument();
  });

  it("lists every boost with its post linked, its status in words and SIMULATED where it is; filters by status and by client", () => {
    mount();
    const list = screen.getByRole("list", { name: "Boosts" });
    expect(within(list).getAllByRole("listitem").length).toBeGreaterThanOrEqual(5);
    expect(within(list).getByRole("link", { name: "Harvest collection arrives" })).toHaveAttribute("href", `/departments/d-soc/posts/${postOf("Harvest collection arrives").id}`);
    const sim = within(list).getByRole("img", { name: "Simulated" }).closest("li")!;
    expect(sim.textContent).toContain("Weekend brunch is back");
    // status
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "completed" } });
    const done = within(screen.getByRole("list", { name: "Boosts" })).getAllByRole("listitem");
    expect(done).toHaveLength(1);
    expect(done[0].textContent).toMatch(/Sunday reset ritual.*Saltmarsh Day Spa.*Spent IDR 142,500, paid reach 6,100, clicks 230/);
    // client
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Client"), { target: { value: "Northwind Traders" } });
    const north = within(screen.getByRole("list", { name: "Boosts" })).getAllByRole("listitem");
    expect(north).toHaveLength(3);
    expect(north.every((n) => n.textContent!.includes("Northwind Traders"))).toBe(true);
    // both, with nothing left
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "completed" } });
    expect(screen.getByText("No boost matches these filters.")).toBeInTheDocument();
  });

  it("shows the totals the listed boosts commit and have spent, in the client's own money", () => {
    mount();
    const totals = screen.getByLabelText("Totals of the listed boosts");
    // committed: 300,000 approved + 200,000 running + 142,500 spent on the completed one; spend: only what is recorded
    expect(within(totals).getByText("Committed").nextSibling).toHaveTextContent("IDR 642,500");
    expect(within(totals).getByText("Spend so far").nextSibling).toHaveTextContent("IDR 142,500");
  });

  it("says plainly when there is nothing: no candidates is not a failure, and the next page is linked", () => {
    const empty = { items: [], candidates: [], totals: { committedMinor: 0, spendMinor: 0, currency: "IDR" }, nextCursor: null };
    render(<BoostBoard deptId="d-soc" data={empty} nextHref="/departments/d-soc/boosts?cursor=o50" />);
    expect(screen.getByText(/No live post is well above its client's average right now/)).toBeInTheDocument();
    expect(screen.getByText("No boosts yet. A boost is requested from a live post.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Show the next boosts" })).toHaveAttribute("href", "/departments/d-soc/boosts?cursor=o50");
  });
});
describe("the Boost block of a live post", () => {
  const mount = (title: string, access: { canRun: boolean; canRecord: boolean }, user = "demo-hansel") => {
    const post = read(title, user);
    return render(<PostBoostSection post={post} access={access} />);
  };

  it("a live post with no boost offers the Boost button; it opens the request dialog", () => {
    mount("Harvest collection arrives", { canRun: true, canRecord: false }); // it has an approved boost
    expect(screen.getByRole("heading", { name: "Boost" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Boost" })).toBeNull(); // its boost is open: a second is refused, so the button is not offered
    expect(screen.getByText("Approved, not started")).toBeInTheDocument();
  });

  it("without a boost: a button labelled Boost for a person who can run one, disabled with the reason for one who cannot", () => {
    const a = mount("A day in the warehouse", { canRun: true, canRecord: false });
    expect(screen.getByText(/This post has no boost/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Boost" }));
    expect(screen.getByRole("dialog", { name: "Boost this post" })).toBeInTheDocument();
    a.unmount();
    mount("A day in the warehouse", { canRun: false, canRecord: false });
    const b = screen.getByRole("button", { name: "Boost" });
    expect(b).toBeDisabled();
    expect(b).toHaveAccessibleDescription(/The owner agrees the money but does not run boosts/);
  });

  it("draws nothing for a post that is not live", () => {
    const { container } = mount("Autumn collection teaser", { canRun: true, canRecord: true });
    expect(container).toBeEmptyDOMElement();
  });

  it("a finished boost shows its results and the button reads Boost again (the spa's completed boost)", () => {
    mount("Sunday reset ritual", { canRun: true, canRecord: false });
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.getByText("IDR 142,500", { selector: "dd" })).toBeInTheDocument();
    expect(screen.getByText("6,100", { selector: "dd" })).toBeInTheDocument();
    expect(screen.getByText("230", { selector: "dd" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Boost again" })).toBeEnabled();
  });
});

describe("the request dialog", () => {
  const open = (title = "A day in the warehouse", onRequested?: () => void) => render(<BoostRequestDialog postId={postOf(title).id} postTitle={title} onClose={vi.fn()} onRequested={onRequested} />);

  it("is a labelled, focus-trapped dialog whose money inputs are numeric", async () => {
    open();
    const dlg = screen.getByRole("dialog", { name: "Boost this post" });
    expect(dlg).toHaveAttribute("aria-modal", "true");
    for (const l of [/^Goal$/, /^Audience$/, /^Daily budget \(IDR\)$/, /^Days$/, /^Start date$/]) expect(within(dlg).getByLabelText(l), String(l)).toBeInTheDocument();
    expect(screen.getByLabelText(/Daily budget/)).toHaveAttribute("inputmode", "numeric");
    expect(screen.getByLabelText(/^Days$/)).toHaveAttribute("inputmode", "numeric");
    expect(screen.getByLabelText(/^Start date$/)).toHaveValue("2026-10-16");
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    await screen.findByText(/Fill in the daily budget and the days/);
  });

  it("says 'within' when the total fits what remains of the cycle the start date falls in, and 'over' with the figure left when it does not", async () => {
    open(); // Northwind Traders: agreed IDR 1,000,000, committed 500,000, so IDR 500,000 remains in October
    type(/Daily budget/, "100000");
    type(/^Days$/, "3");
    expect(await screen.findByText("Within this month's agreed budget: starts without asking.")).toBeInTheDocument();
    expect(screen.getByText(/Total:/).textContent).toContain("IDR 300,000");
    type(/^Days$/, "5"); // exactly what remains: still within
    expect(await screen.findByText("Within this month's agreed budget: starts without asking.")).toBeInTheDocument();
    type(/^Days$/, "6");
    expect(await screen.findByText("Over what remains (IDR 500,000 left): the client will be asked to approve it.")).toBeInTheDocument();
    // a month with no agreed budget has nothing left: every request is over
    type(/^Start date$/, "2026-12-05");
    expect(await screen.findByText("Over what remains (IDR 0 left): the client will be asked to approve it.")).toBeInTheDocument();
  });

  it("fetches the reach estimate a moment after the person stops typing, and words its basis", async () => {
    open();
    expect(screen.queryByText(/Estimated reach/)).toBeNull();
    type(/Daily budget/, "100000");
    type(/^Days$/, "5");
    expect(await screen.findByText(/Estimated reach:/, {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText(/Estimated reach:/).parentElement?.textContent).toMatch(/Estimated reach: 20,000 to 45,000 people\. From this client's own past posts\./);
    // a custom audience narrows it
    fireEvent.change(screen.getByLabelText(/^Audience$/), { target: { value: "custom" } });
    await waitFor(() => expect(screen.getByText(/Estimated reach:/).textContent).toMatch(/Estimated reach: 10,000 to 22,500 people/), { timeout: 3000 });
  });

  it("a custom audience needs its note: the field appears, and a request without it is stopped before the round trip", () => {
    open();
    expect(screen.queryByLabelText(/Describe the custom audience/)).toBeNull();
    fireEvent.change(screen.getByLabelText(/^Audience$/), { target: { value: "custom" } });
    expect(screen.getByLabelText(/Describe the custom audience \(required\)/)).toBeInTheDocument();
    type(/^Goal$/, "website");
    type(/Daily budget/, "50000");
    type(/^Days$/, "2");
    press("Request boost");
    expect(screen.getByText("Describe the custom audience.")).toHaveAttribute("role", "alert");
    expect(screen.getByLabelText(/Describe the custom audience/)).toHaveAttribute("aria-invalid", "true");
    expect(requestBoost).not.toHaveBeenCalled();
  });

  it("names the field that is missing, locally, before anything is sent", () => {
    open();
    press("Request boost");
    expect(screen.getByText("Choose what the boost is for.")).toBeInTheDocument();
    type(/^Goal$/, "messages");
    press("Request boost");
    expect(screen.getByText("Give the daily budget as a whole amount above zero.")).toBeInTheDocument();
    expect(requestBoost).not.toHaveBeenCalled();
  });

  it("within the budget the answer says it starts without asking (Closing hours reminder: the spa, IDR 600,000 agreed)", async () => {
    const done = vi.fn();
    open("Closing hours reminder", done);
    type(/^Goal$/, "profile_visits");
    type(/Daily budget/, "50000");
    type(/^Days$/, "3");
    await screen.findByText("Within this month's agreed budget: starts without asking.");
    press("Request boost");
    expect(await screen.findByText(/Approved within this month's agreed budget/)).toBeInTheDocument();
    expect(screen.queryByText(/the client has been asked/)).toBeNull();
    expect(requestBoost).toHaveBeenCalledWith(postOf("Closing hours reminder").id, expect.objectContaining({ goal: "profile_visits", audience: "automatic", dailyBudgetMinor: 50_000, days: 3, startsOn: "2026-10-16", currency: "IDR", id: expect.any(String) }));
    expect(done).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("button", { name: "Close" }).length).toBeGreaterThan(0);
  });

  it("over the budget the answer says the client has been asked (A day in the warehouse: IDR 1,000,000 against IDR 500,000 left)", async () => {
    open();
    type(/^Goal$/, "messages");
    type(/Daily budget/, "200000");
    type(/^Days$/, "5");
    await screen.findByText(/Over what remains \(IDR 500,000 left\)/);
    press("Request boost");
    expect(await screen.findByText(/over this month's agreed budget, so the client has been asked to approve it in the portal/)).toBeInTheDocument();
    expect(staff("GET", `posts/${postOf("A day in the warehouse").id}/pipeline`).json).toMatchObject({ boost: { status: "requested" } });
  });

  it("a refusal is said in words under the form: the owner agrees money but does not run boosts", async () => {
    persona.user = "demo-owner";
    open("Reader favourite reshare");
    type(/^Goal$/, "website");
    type(/Daily budget/, "10000");
    type(/^Days$/, "1");
    press("Request boost");
    expect(await screen.findByRole("alert")).toHaveTextContent("The owner agrees the money but does not run boosts.");
  });
});

describe("the Boost budget card", () => {
  const mount = (cycleId: string, user: string) => render(<BoostBudgetCard cycleId={cycleId} monthTitle="October 2026" budget={budgetOf(cycleId, user)} />);

  it("read-only for a person who cannot record: the figures and how it was agreed, no controls, and who can", () => {
    mount(NORTHWIND_CYCLE, "u-social"); // the officer is none of the four approvers
    expect(screen.getByRole("heading", { name: "Boost budget, October 2026" })).toBeInTheDocument();
    const figures = screen.getByLabelText("The month's boost budget");
    expect(within(figures).getByText("IDR 1,000,000")).toBeInTheDocument();
    expect(within(figures).getAllByText("IDR 500,000")).toHaveLength(2); // committed and remaining
    expect(screen.getByText(/Agreed by the client in the portal, Dana Whitfield/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/Only the Social Media head, the GM, the owner and the superadmin can propose or record the budget\./)).toBeInTheDocument();
    expect(screen.getByLabelText("Proposals and agreements, newest first").textContent).toMatch(/Declined: IDR 1,500,000/);
  });

  it("the four approvers get Propose to client and Record client's agreement", () => {
    mount(NORTHWIND_CYCLE, "u-pm");
    expect(screen.getByRole("button", { name: "Propose to client" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Record client's agreement" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Withdraw proposal" })).toBeNull();
  });

  it("proposing below what is committed is refused by the server, with the figure; a proposal at or above it is sent and the page refreshes", async () => {
    persona.user = "u-pm";
    mount(NORTHWIND_CYCLE, "u-pm");
    press("Propose to client");
    const form = screen.getByRole("form", { name: "Propose a boost budget to the client" });
    expect(within(form).getByLabelText(/Monthly budget \(IDR\)/)).toHaveAttribute("inputmode", "numeric");
    fireEvent.change(within(form).getByLabelText(/Monthly budget/), { target: { value: "0" } });
    fireEvent.click(within(form).getByRole("button", { name: "Send proposal" }));
    expect(within(form).getByText("Give the monthly budget as a whole amount above zero.")).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText(/Monthly budget/), { target: { value: "400000" } });
    fireEvent.click(within(form).getByRole("button", { name: "Send proposal" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("The budget cannot go below what is already committed: IDR 500,000.");
    expect(refresh).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByLabelText(/Monthly budget/), { target: { value: "500000" } });
    fireEvent.change(within(form).getByLabelText(/Note for the client \(optional\)/), { target: { value: "Back to what is committed." } });
    fireEvent.click(within(form).getByRole("button", { name: "Send proposal" }));
    await screen.findByText("Proposed. The client's signers are asked to agree in the portal.");
    expect(proposeBudget).toHaveBeenLastCalledWith(NORTHWIND_CYCLE, { amountMinor: 500_000, note: "Back to what is committed." });
    expect(refresh).toHaveBeenCalled();
    expect(budgetOf(NORTHWIND_CYCLE).pending).toMatchObject({ amountMinor: 500_000 });
  });

  it("one proposal waits at a time: Propose is off with the reason and Withdraw is offered (the hotel's pending proposal)", async () => {
    persona.user = "u-pm";
    mount(HOTEL_CYCLE, "u-pm");
    expect(screen.getByText(/Waiting for the client: IDR 800,000/)).toBeInTheDocument();
    const propose = screen.getByRole("button", { name: "Propose to client" });
    expect(propose).toBeDisabled();
    expect(propose).toHaveAccessibleDescription("A proposal is already waiting. Withdraw it to propose another amount.");
    expect(screen.getByText("Nothing agreed")).toBeInTheDocument();
    press("Withdraw proposal");
    await waitFor(() => expect(withdrawProposal).toHaveBeenCalled());
    await screen.findByText("The proposal is withdrawn.");
    expect(refresh).toHaveBeenCalled();
    expect(budgetOf(HOTEL_CYCLE).pending).toBeNull();
  });

  it("Record client's agreement needs the amount, a channel and a note, then sets the month's budget", async () => {
    persona.user = "demo-owner";
    mount(HOTEL_CYCLE, "demo-owner");
    press("Record client's agreement");
    const form = screen.getByRole("form", { name: "Record the client's agreement" });
    fireEvent.change(within(form).getByLabelText(/Monthly budget/), { target: { value: "700,000" } });
    fireEvent.click(within(form).getByRole("button", { name: "Record agreement" }));
    expect(within(form).getByText("Say how the client told you.")).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText("How did the client tell you?"), { target: { value: "meeting" } });
    fireEvent.click(within(form).getByRole("button", { name: "Record agreement" }));
    expect(within(form).getByText("Add a note on what the client said.")).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText("Note (required)"), { target: { value: "Agreed at the lobby bar meeting." } });
    fireEvent.click(within(form).getByRole("button", { name: "Record agreement" }));
    await screen.findByText("Recorded. The agreed budget is now the client's answer.");
    expect(recordBudget).toHaveBeenCalledWith(HOTEL_CYCLE, { amountMinor: 700_000, channel: "meeting", note: "Agreed at the lobby bar meeting." });
    expect(budgetOf(HOTEL_CYCLE).agreed).toMatchObject({ amountMinor: 700_000, via: "recorded", channel: "meeting" });
  });
});

describe("the boost card", () => {
  const mount = (b: BoostRow, who: { canRun: boolean; canRecord: boolean }, extra: { onChanged?: () => void; postHref?: string } = {}) => render(<BoostCard boost={b} canRun={who.canRun} canRecord={who.canRecord} {...extra} />);
  const buttons = () => within(screen.queryByRole("group", { name: "Boost actions" }) ?? document.body).queryAllByRole("button").map((b) => b.textContent);

  it("draws the status in words, the budget, the dates and SIMULATED on a simulated boost", () => {
    mount(boost({ status: "requested", approvedVia: null, approvedAt: null, simulated: true, audience: "custom", audienceNote: "Cyclists in Ubud", reachEstimate: { low: 1200, high: 2600 } }), { canRun: true, canRecord: false });
    expect(screen.getByText("Waiting for the client")).toHaveAttribute("data-status", "requested");
    expect(screen.getByRole("img", { name: "Simulated" })).toHaveTextContent("SIMULATED");
    expect(screen.getByText("IDR 300,000 (IDR 100,000 a day, 3 days)")).toBeInTheDocument();
    expect(screen.getByText("28 Oct 2026")).toBeInTheDocument();
    expect(screen.getByText("A custom audience: Cyclists in Ubud")).toBeInTheDocument();
    expect(screen.getByText("1,200 to 2,600")).toBeInTheDocument();
    expect(screen.queryByText("Approved")).toBeNull();
  });

  it("offers per status, for the officer, the HoD and the GM: Cancel (requested, approved), Start (approved), Stop (running), Complete (running, stopped), nothing once it is over", () => {
    const run = { canRun: true, canRecord: false };
    const table: Array<[string, string[]]> = [
      ["requested", ["Cancel"]], ["approved", ["Cancel", "Start"]], ["running", ["Stop", "Complete"]], ["stopped", ["Complete"]],
      ["completed", []], ["cancelled", []], ["declined", []],
    ];
    for (const [status, names] of table) {
      const { unmount } = mount(boost({ status, spendMinor: 1, paidReach: 1 }), run);
      expect(buttons(), status).toEqual(names);
      unmount();
    }
  });

  it("offers the two record actions only to one of the four approvers, and says who can when a person holds none of a status's actions", () => {
    const a = mount(boost({ status: "requested", approvedVia: null }), { canRun: false, canRecord: true });
    expect(buttons()).toEqual(["Record client's approval", "Record client's decline"]);
    expect(screen.getByText(/Only the client's officer, the Social Media head or the GM can run a boost\./)).toBeInTheDocument();
    a.unmount();
    const b = mount(boost({ status: "requested", approvedVia: null }), { canRun: true, canRecord: true });
    expect(buttons()).toEqual(["Cancel", "Record client's approval", "Record client's decline"]);
    b.unmount();
    const c = mount(boost({ status: "requested", approvedVia: null }), { canRun: true, canRecord: false });
    expect(buttons()).toEqual(["Cancel"]);
    expect(screen.getByText(/Only one of the four approvers/)).toBeInTheDocument();
    c.unmount();
    mount(boost({ status: "running" }), { canRun: false, canRecord: false });
    expect(buttons()).toEqual([]);
  });

  it("every action sends the status the card showed: Start and Cancel straight away", async () => {
    vi.mocked(runBoostAction).mockResolvedValueOnce({ ok: true, boost: boost({ status: "running", startedAt: "2026-10-16T02:00:00Z" }), remainingMinor: 0, needsClient: false, warnings: [], alreadyApplied: false });
    const changed = vi.fn();
    mount(boost({ id: "b-start", status: "approved" }), { canRun: true, canRecord: false }, { onChanged: changed });
    press("Start");
    expect(runBoostAction).toHaveBeenCalledWith("b-start", { action: "start_boost", expectedStatus: "approved", actionId: expect.any(String) });
    expect(await screen.findByText("Running")).toBeInTheDocument(); // the answer replaces what was shown
    expect(screen.getByRole("status")).toHaveTextContent("Start.");
    expect(changed).toHaveBeenCalled();
    expect(buttons()).toEqual(["Stop", "Complete"]);
  });

  it("Stop asks for the spend (required) with paid reach and clicks optional, and sends them with the status", async () => {
    vi.mocked(runBoostAction).mockResolvedValueOnce({ ok: true, boost: boost({ status: "stopped", spendMinor: 60_000 }), remainingMinor: 0, needsClient: false, warnings: [], alreadyApplied: false });
    mount(boost({ id: "b-stop", status: "running" }), { canRun: true, canRecord: false });
    press("Stop");
    const dlg = screen.getByRole("dialog", { name: "Stop the boost" });
    expect(within(dlg).getByLabelText(/Total spend \(IDR, required\)/)).toHaveAttribute("inputmode", "numeric");
    expect(within(dlg).getByLabelText("Paid reach (optional)")).toBeInTheDocument();
    expect(within(dlg).getByLabelText("Clicks (optional)")).toBeInTheDocument();
    fireEvent.click(within(dlg).getByRole("button", { name: "Stop the boost" }));
    expect(within(dlg).getByText("Give what the boost spent in total, 0 or more.")).toHaveAttribute("role", "alert");
    expect(runBoostAction).not.toHaveBeenCalled();
    fireEvent.change(within(dlg).getByLabelText(/Total spend/), { target: { value: "60,000" } });
    fireEvent.change(within(dlg).getByLabelText("Clicks (optional)"), { target: { value: "45" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Stop the boost" }));
    expect(runBoostAction).toHaveBeenCalledWith("b-stop", { action: "stop_boost", expectedStatus: "running", spendMinor: 60_000, clicks: 45, actionId: expect.any(String) });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("Stopped")).toBeInTheDocument();
  });

  it("Complete needs the spend and the paid reach; a spend above the budget is a NOTICE (the boost is saved), never an error", async () => {
    vi.mocked(runBoostAction).mockResolvedValueOnce({
      ok: true, boost: boost({ status: "completed", spendMinor: 350_000, paidReach: 9_000, clicks: null }), remainingMinor: 0, needsClient: false, warnings: ["spend_above_budget"], alreadyApplied: false,
    });
    mount(boost({ id: "b-done", status: "running" }), { canRun: true, canRecord: false });
    press("Complete");
    const dlg = screen.getByRole("dialog", { name: "Complete the boost" });
    expect(within(dlg).getByLabelText("Paid reach (required)")).toBeInTheDocument();
    fireEvent.change(within(dlg).getByLabelText(/Total spend/), { target: { value: "350000" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Complete the boost" }));
    expect(within(dlg).getByText("Give the paid reach the network showed.")).toBeInTheDocument();
    fireEvent.change(within(dlg).getByLabelText("Paid reach (required)"), { target: { value: "9000" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Complete the boost" }));
    expect(runBoostAction).toHaveBeenCalledWith("b-done", { action: "complete_boost", expectedStatus: "running", spendMinor: 350_000, paidReach: 9_000, actionId: expect.any(String) });
    const notice = await screen.findByText(/The spend is above the boost's budget/);
    expect(notice.closest("[role=status]")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    // the results the card now shows: clicks the network did not show read "Not reported", never 0
    expect(screen.getByText("IDR 350,000", { selector: "dd" })).toBeInTheDocument();
    expect(screen.getByText("9,000", { selector: "dd" })).toBeInTheDocument();
    expect(screen.getByText("Not reported", { selector: "dd" })).toBeInTheDocument();
  });

  it("recording the client's answer needs a channel and a note, and approves or declines the waiting boost (the real twin: Reader favourite reshare)", async () => {
    persona.user = "demo-owner"; // one of the four approvers, who runs no boost
    const row = asBoostList(staff("GET", "boosts").json).items.find((b) => b.postTitle === "Reader favourite reshare")!;
    expect(row.status).toBe("requested");
    const changed = vi.fn();
    mount(row, { canRun: false, canRecord: true }, { onChanged: changed });
    press("Record client's approval");
    const dlg = screen.getByRole("dialog", { name: "Record the client's approval" });
    fireEvent.click(within(dlg).getByRole("button", { name: "Record the client's approval" }));
    expect(within(dlg).getByText("Say how the client told you.")).toBeInTheDocument();
    fireEvent.change(within(dlg).getByLabelText("How did the client tell you?"), { target: { value: "whatsapp" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Record the client's approval" }));
    expect(within(dlg).getByText("Add a note on what the client said.")).toBeInTheDocument();
    fireEvent.change(within(dlg).getByLabelText("Note (required)"), { target: { value: "Agreed in the group chat." } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Record the client's approval" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(runBoostAction).toHaveBeenCalledWith(row.id, { action: "record_boost_approval", expectedStatus: "requested", channel: "whatsapp", note: "Agreed in the group chat.", actionId: expect.any(String) });
    expect(screen.getByText("Approved, not started")).toBeInTheDocument();
    expect(screen.getByText(/recorded by our team/)).toBeInTheDocument();
    expect(changed).toHaveBeenCalled();
  });

  it("a boost that moved meanwhile is refused with where it is now, and the page is asked to refresh", async () => {
    const refusal = { status: 409, error: "boost_status_changed", detail: { status: "completed" } };
    vi.mocked(runBoostAction).mockResolvedValueOnce({ ok: false, refusal, message: boostRefusalText(refusal) });
    const changed = vi.fn();
    mount(boost({ id: "b-late", status: "approved" }), { canRun: true, canRecord: false }, { onChanged: changed });
    press("Cancel");
    expect(await screen.findByRole("alert")).toHaveTextContent("It is now completed. The page has been refreshed.");
    expect(changed).toHaveBeenCalled();
  });

  it("links the title to the post only when asked to (the Boosting list does, the post page does not)", () => {
    const a = mount(boost(), { canRun: false, canRecord: false }, { postHref: "/departments/d-soc/posts/p1" });
    expect(screen.getByRole("link", { name: "A post" })).toHaveAttribute("href", "/departments/d-soc/posts/p1");
    a.unmount();
    mount(boost(), { canRun: false, canRecord: false });
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByRole("heading", { name: "This post's boost" })).toBeInTheDocument();
  });
});

