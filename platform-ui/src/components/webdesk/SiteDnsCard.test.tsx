import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { SiteDnsCard } from "./SiteDnsCard";
import {
  parseSiteDns, parseSiteDnsTask, REASON_COPY, CHECKLIST_COPY, TASK_STATE_COPY, ASSIGNEE_COPY, CLOSED_BY_COPY, PROPERTY_COPY,
  type DnsRead, type SiteDns, type SiteDnsTask,
} from "@/lib/siteDnsModel";
import type { RecheckResult } from "@/lib/siteDnsActions";

const rec = { type: "A", name: "acme.example", target: "203.0.113.10" };
const dnsBody = (over: Record<string, unknown> = {}) => ({
  siteId: "s1", domain: "acme.example", environment: "staging", hostKind: "our-box", hostRef: "helios", recordsOwner: "owner",
  checklist: { state: "ready", records: [rec], instruction: null },
  observed: { a: ["198.51.100.7"], aaaa: [], cname: [] },
  check: { state: "pending", reason: "points_elsewhere" },
  checkedAt: "2026-10-30T08:00:00.000Z",
  property: { id: null, state: "none" },
  ...over,
});
const taskBody = (over: Record<string, unknown> = {}) => ({
  id: "l1", siteId: "s1", state: "open", domain: "acme.example", taskId: "task-9", records: [rec], assigneeSource: "project_owner", assigneeUserId: "u1",
  closedBy: null, closedAt: null, lastCheckedAt: "2026-10-30T08:00:00.000Z", lastCheckReason: "points_elsewhere", erpSawPointing: false, ...over,
});
const okDns = (over: Record<string, unknown> = {}): DnsRead<SiteDns> => ({ state: "ok", data: parseSiteDns(dnsBody(over)) });
const okTask = (over: Record<string, unknown> = {}): DnsRead<SiteDnsTask> => ({ state: "ok", data: parseSiteDnsTask(taskBody(over)) });
const fail = (message: string, kind: "forbidden" | "unavailable" = "unavailable"): DnsRead<never> => ({ state: "unavailable", kind, message });
const noop = vi.fn(async (): Promise<RecheckResult> => ({ ok: false, message: "unused" }));

function show(props: Partial<React.ComponentProps<typeof SiteDnsCard>> = {}) {
  return render(<SiteDnsCard dns={okDns()} task={okTask()} canRecheck onRecheck={noop} {...props} />);
}

describe("SiteDnsCard: the checklist", () => {
  it("draws the domain, environment, who changes the records, the table and what DNS answers", () => {
    show();
    expect(screen.getAllByText("acme.example").length).toBeGreaterThan(0);
    expect(screen.getByText("Staging")).toBeInTheDocument();
    expect(screen.getByText(/We change the records/)).toBeInTheDocument();
    expect(screen.getByText("203.0.113.10")).toBeInTheDocument();
    expect(screen.getByText(/A: 198\.51\.100\.7/)).toBeInTheDocument();
    expect(screen.getByText(/AAAA: no answer/)).toBeInTheDocument();
    expect(screen.getByText(/CNAME: no answer/)).toBeInTheDocument();
    expect(screen.getByText(CHECKLIST_COPY.ready)).toBeInTheDocument();
    expect(screen.getByText(REASON_COPY.points_elsewhere)).toBeInTheDocument();
    expect(screen.getByText(PROPERTY_COPY.none)).toBeInTheDocument();
  });

  it("says a client's domain is the client's to change", () => {
    show({ dns: okDns({ recordsOwner: "client" }) });
    expect(screen.getByText(/The client changes the records/)).toBeInTheDocument();
  });

  it.each(["not_claimed", "needs_binding", "target_unknown"] as const)("%s says it is not ready, in words, with no empty records table", (state) => {
    show({ dns: okDns({ checklist: { state, records: [], instruction: "Ask the operator." }, observed: null, check: { state: "pending", reason: state === "not_claimed" ? "domain_not_claimed" : state } }) });
    expect(screen.getByText(CHECKLIST_COPY[state])).toBeInTheDocument();
    expect(screen.getByText("Not ready.")).toBeInTheDocument();
    expect(screen.getByText("Ask the operator.")).toBeInTheDocument();
    expect(screen.getByText(/DNS was not asked/)).toBeInTheDocument();
    expect(screen.queryByText("Target")).toBeNull();
  });

  it("pointing is the done word, and the observed error is shown", () => {
    show({ dns: okDns({ check: { state: "pointing", reason: null }, observed: { a: ["203.0.113.10"], aaaa: [], cname: [], error: "AAAA lookup timed out" } }) });
    expect(screen.getByText(/The records are in place/)).toBeInTheDocument();
    expect(screen.getByText(/AAAA lookup timed out/)).toBeInTheDocument();
  });

  it.each(Object.keys(REASON_COPY) as (keyof typeof REASON_COPY)[])("pending %s shows its own sentence", (reason) => {
    show({ dns: okDns({ check: { state: "pending", reason } }) });
    expect(screen.getAllByText(REASON_COPY[reason]).length).toBeGreaterThan(0);
  });

  it("states the search property's consent state", () => {
    show({ dns: okDns({ property: { id: "p1", state: "verified" } }) });
    expect(screen.getByText(PROPERTY_COPY.verified)).toBeInTheDocument();
  });
});

describe("SiteDnsCard: the task", () => {
  it("open: state, assignee, link to the PM task and the last check", () => {
    show();
    expect(screen.getByText(TASK_STATE_COPY.open)).toBeInTheDocument();
    expect(screen.getByText(ASSIGNEE_COPY.project_owner)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the task" })).toHaveAttribute("href", "/tasks/task-9");
    expect(screen.getByText(/Last checked/)).toBeInTheDocument();
    expect(screen.getByText(/The ERP has not seen the records point/)).toBeInTheDocument();
  });

  it.each(["project_owner", "web_dev_head", "unassigned"] as const)("assignee %s in words", (source) => {
    show({ task: okTask({ assigneeSource: source }) });
    expect(screen.getByText(ASSIGNEE_COPY[source])).toBeInTheDocument();
  });

  it.each(["erp_check", "manual", "domain_changed", "site_archived"] as const)("closed by %s says so, with the time", (closedBy) => {
    show({ task: okTask({ state: "closed", closedBy, closedAt: "2026-10-30T09:00:00.000Z", erpSawPointing: closedBy === "erp_check", lastCheckReason: null }) });
    expect(screen.getByText(new RegExp(CLOSED_BY_COPY[closedBy].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeInTheDocument();
    expect(screen.getByText(/Closed \d/)).toBeInTheDocument();
    expect(screen.getByText(closedBy === "erp_check" ? /The ERP saw the records point/ : /The ERP has not seen the records point/)).toBeInTheDocument();
  });

  it("none says there is no task, and has no link", () => {
    show({ task: okTask({ id: null, state: "none", domain: null, taskId: null, records: [], assigneeSource: null, assigneeUserId: null, lastCheckedAt: null }) });
    expect(screen.getByText(TASK_STATE_COPY.none)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open the task" })).toBeNull();
  });
});

describe("SiteDnsCard: a failed read is a sentence, and the reads are independent", () => {
  it("the checklist failing leaves the task drawn, with no empty table", () => {
    show({ dns: fail("The DNS checklist could not be read just now. Try again in a moment.") });
    expect(screen.getByText(/The DNS checklist could not be read just now/)).toBeInTheDocument();
    expect(screen.getByText(TASK_STATE_COPY.open)).toBeInTheDocument();
    expect(screen.queryByText("Target")).toBeNull();
  });

  it("the task failing leaves the checklist drawn, and never says 'no task'", () => {
    show({ task: fail("The DNS task answer did not match the contract (state: unknown value). This is a defect, not an empty value.") });
    expect(screen.getByText(/did not match the contract/)).toBeInTheDocument();
    expect(screen.getByText("203.0.113.10")).toBeInTheDocument();
    expect(screen.queryByText(TASK_STATE_COPY.none)).toBeNull();
  });

  it("both failing draws two sentences and nothing else", () => {
    show({ dns: fail("dns down"), task: fail("task forbidden", "forbidden") });
    expect(screen.getByText("dns down")).toBeInTheDocument();
    expect(screen.getByText(/You don't have access to this site's DNS task/)).toBeInTheDocument();
    expect(screen.queryByText("Target")).toBeNull();
    expect(screen.queryByText(TASK_STATE_COPY.none)).toBeNull();
    expect(screen.queryByText(TASK_STATE_COPY.open)).toBeNull();
  });
});

describe("SiteDnsCard: Check DNS now", () => {
  it("is not offered to a viewer without the capability", () => {
    show({ canRecheck: false });
    expect(screen.queryByRole("button", { name: "Check DNS now" })).toBeNull();
  });

  it("shows the new task and the check from the answer (pending keeps the task open)", async () => {
    const onRecheck = vi.fn(async (): Promise<RecheckResult> => ({
      ok: true, task: parseSiteDnsTask(taskBody({ lastCheckReason: "no_records" })), check: { state: "pending", reason: "no_records" },
    }));
    show({ onRecheck });
    fireEvent.click(screen.getByRole("button", { name: "Check DNS now" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/does not point at its host yet/));
    expect(screen.getByRole("status")).toHaveTextContent(REASON_COPY.no_records);
    expect(onRecheck).toHaveBeenCalledTimes(1);
  });

  it("pointing: the task shown is the closed one from the answer", async () => {
    const onRecheck = vi.fn(async (): Promise<RecheckResult> => ({
      ok: true,
      task: parseSiteDnsTask(taskBody({ state: "closed", closedBy: "erp_check", closedAt: "2026-10-31T01:00:00.000Z", erpSawPointing: true, lastCheckReason: null })),
      check: { state: "pointing", reason: null },
    }));
    show({ onRecheck });
    fireEvent.click(screen.getByRole("button", { name: "Check DNS now" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/The check closed the task/));
    expect(screen.getByText(/The ERP saw the records point/)).toBeInTheDocument();
    expect(screen.getByText(/Closed by the ERP's own DNS check/)).toBeInTheDocument();
  });

  it("a null check says there was nothing to check", async () => {
    const onRecheck = vi.fn(async (): Promise<RecheckResult> => ({
      ok: true,
      task: parseSiteDnsTask(taskBody({ id: null, state: "none", domain: null, taskId: null, records: [], assigneeSource: null, assigneeUserId: null, lastCheckedAt: null, lastCheckReason: null })),
      check: null,
    }));
    show({ onRecheck });
    fireEvent.click(screen.getByRole("button", { name: "Check DNS now" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/Nothing was checked: this site has no open DNS task/));
  });

  it("a 403 from the server is a sentence, and the old task stays", async () => {
    const onRecheck = vi.fn(async (): Promise<RecheckResult> => ({ ok: false, message: "You are not allowed to run the DNS check for this site: it can close the task. Nothing was checked." }));
    show({ onRecheck });
    fireEvent.click(screen.getByRole("button", { name: "Check DNS now" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/not allowed to run the DNS check/));
    expect(screen.getByText(TASK_STATE_COPY.open)).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("an action that throws is a sentence, not a crash", async () => {
    const onRecheck = vi.fn(async (): Promise<RecheckResult> => { throw new Error("network"); });
    show({ onRecheck });
    fireEvent.click(screen.getByRole("button", { name: "Check DNS now" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/could not be run just now/));
  });

  it("works when the page's own task read failed: the answer's task replaces the sentence", async () => {
    const onRecheck = vi.fn(async (): Promise<RecheckResult> => ({ ok: true, task: parseSiteDnsTask(taskBody()), check: { state: "pending", reason: "lookup_failed" } }));
    show({ task: fail("The DNS task could not be read just now."), onRecheck });
    fireEvent.click(screen.getByRole("button", { name: "Check DNS now" }));
    await waitFor(() => expect(screen.getByText(TASK_STATE_COPY.open)).toBeInTheDocument());
    expect(screen.queryByText(/The DNS task could not be read just now/)).toBeNull();
  });
});
