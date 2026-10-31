import { describe, it, expect } from "vitest";
import {
  SiteDnsShapeError, parseSiteDns, parseSiteDnsTask, parseRecheck, recheckSentence, recheckRefusalSentence, dnsReadSentence, taskHref,
  REASON_COPY, CHECKLIST_COPY, TASK_STATE_COPY, ASSIGNEE_COPY, CLOSED_BY_COPY, PROPERTY_COPY, RECORDS_OWNER_COPY,
  type SiteDnsTask,
} from "./siteDnsModel";

const rec = { type: "A", name: "acme.example", target: "203.0.113.10" };
const dns = (over: Record<string, unknown> = {}) => ({
  siteId: "s1", domain: "acme.example", environment: "production", hostKind: "our-box", hostRef: "helios", recordsOwner: "owner",
  checklist: { state: "ready", records: [rec], instruction: null },
  observed: { a: ["203.0.113.10"], aaaa: [], cname: [] },
  check: { state: "pointing", reason: null },
  checkedAt: "2026-10-30T08:00:00.000Z",
  property: { id: null, state: "none" },
  ...over,
});
const task = (over: Record<string, unknown> = {}) => ({
  id: "l1", siteId: "s1", state: "open", domain: "acme.example", taskId: "t1", records: [rec], assigneeSource: "project_owner", assigneeUserId: "u1",
  closedBy: null, closedAt: null, lastCheckedAt: null, lastCheckReason: null, erpSawPointing: false, ...over,
});
const drift = (fn: () => unknown) => expect(fn).toThrow(SiteDnsShapeError);

describe("parseSiteDns", () => {
  it("reads an on-contract body", () => {
    const d = parseSiteDns(dns());
    expect(d.checklist.records).toEqual([rec]);
    expect(d.observed).toEqual({ a: ["203.0.113.10"], aaaa: [], cname: [], error: null });
    expect(d.check).toEqual({ state: "pointing", reason: null });
  });
  it("accepts observed null, an observed error and every checklist state", () => {
    expect(parseSiteDns(dns({ observed: null, checklist: { state: "not_claimed", records: [], instruction: "Claim it." } })).observed).toBeNull();
    expect(parseSiteDns(dns({ observed: { a: [], aaaa: [], cname: [], error: "SERVFAIL" } })).observed?.error).toBe("SERVFAIL");
    for (const state of ["not_claimed", "needs_binding", "target_unknown"]) {
      expect(parseSiteDns(dns({ checklist: { state, records: [], instruction: null } })).checklist.state).toBe(state);
    }
  });
  it("takes every pending reason", () => {
    for (const reason of Object.keys(REASON_COPY)) expect(parseSiteDns(dns({ check: { state: "pending", reason } })).check.reason).toBe(reason);
  });
  it("is strict: every off-contract piece is drift", () => {
    drift(() => parseSiteDns(null));
    drift(() => parseSiteDns([]));
    drift(() => parseSiteDns(dns({ recordsOwner: "us" })));
    drift(() => parseSiteDns(dns({ checklist: { state: "done", records: [], instruction: null } })));
    drift(() => parseSiteDns(dns({ checklist: { state: "ready", records: [{ ...rec, type: "MX" }], instruction: null } })));
    drift(() => parseSiteDns(dns({ checklist: { state: "ready", records: [], instruction: null } })));   // ready with nothing to list
    drift(() => parseSiteDns(dns({ check: { state: "pending", reason: "weird" } })));
    drift(() => parseSiteDns(dns({ check: { state: "pending", reason: null } })));
    drift(() => parseSiteDns(dns({ check: { state: "maybe", reason: null } })));
    drift(() => parseSiteDns(dns({ observed: { a: "1.2.3.4", aaaa: [], cname: [] } })));
    drift(() => parseSiteDns(dns({ property: { id: null, state: "yes" } })));
    drift(() => parseSiteDns(dns({ checkedAt: 5 })));
    drift(() => parseSiteDns(dns({ domain: undefined })));
  });
});

describe("parseSiteDnsTask", () => {
  it("reads open, closed and none", () => {
    expect(parseSiteDnsTask(task()).state).toBe("open");
    const closed = parseSiteDnsTask(task({ state: "closed", closedBy: "erp_check", closedAt: "2026-10-30T09:00:00.000Z", erpSawPointing: true }));
    expect(closed).toMatchObject({ state: "closed", closedBy: "erp_check", erpSawPointing: true });
    const none = parseSiteDnsTask(task({ id: null, state: "none", domain: null, taskId: null, records: [], assigneeSource: null, assigneeUserId: null }));
    expect(none.state).toBe("none");
  });
  it("is strict", () => {
    drift(() => parseSiteDnsTask(undefined));
    drift(() => parseSiteDnsTask(task({ state: "paused" })));
    drift(() => parseSiteDnsTask(task({ assigneeSource: "somebody" })));
    drift(() => parseSiteDnsTask(task({ state: "closed", closedBy: "robot", closedAt: null })));
    drift(() => parseSiteDnsTask(task({ state: "closed", closedBy: null })));
    drift(() => parseSiteDnsTask(task({ lastCheckReason: "unknown_token" })));
    drift(() => parseSiteDnsTask(task({ erpSawPointing: "no" })));
    drift(() => parseSiteDnsTask(task({ taskId: null })));                 // an open task with nowhere to link
    drift(() => parseSiteDnsTask(task({ state: "none", taskId: "t1" })));   // "no task" that carries a task
  });
});

describe("parseRecheck", () => {
  it("reads {task, check} with a check or null", () => {
    expect(parseRecheck({ task: task(), check: { state: "pending", reason: "no_records" } }).check).toEqual({ state: "pending", reason: "no_records" });
    expect(parseRecheck({ task: task(), check: null }).check).toBeNull();
  });
  it("a missing check is drift, not 'nothing to check'", () => {
    drift(() => parseRecheck({ task: task() }));
    drift(() => parseRecheck({ check: null }));
    drift(() => parseRecheck("ok"));
  });
});

describe("the words", () => {
  const t = (over: Record<string, unknown> = {}): SiteDnsTask => parseSiteDnsTask(task(over));
  it("every state and token has a sentence", () => {
    for (const k of ["not_claimed", "needs_binding", "target_unknown", "ready"]) expect(CHECKLIST_COPY[k as "ready"].length).toBeGreaterThan(20);
    for (const k of ["none", "open", "closed"]) expect(TASK_STATE_COPY[k as "none"]).toBeTruthy();
    for (const k of ["project_owner", "web_dev_head", "unassigned"]) expect(ASSIGNEE_COPY[k as "unassigned"]).toBeTruthy();
    for (const k of ["erp_check", "manual", "domain_changed", "site_archived"]) expect(CLOSED_BY_COPY[k as "manual"]).toBeTruthy();
    for (const k of ["none", "unverified", "verified"]) expect(PROPERTY_COPY[k as "none"]).toBeTruthy();
    expect(Object.keys(RECORDS_OWNER_COPY)).toEqual(["owner", "client"]);
    expect(Object.keys(REASON_COPY)).toHaveLength(7);
  });
  it("a lookup failure is never worded as 'not pointing'", () => {
    expect(REASON_COPY.lookup_failed).toMatch(/cannot say/);
    expect(REASON_COPY.lookup_failed).toMatch(/not the same as not pointing/);
  });
  it("recheck: a null check says nothing was checked, in both task states", () => {
    expect(recheckSentence({ task: t({ state: "none", taskId: null, id: null }), check: null })).toMatch(/Nothing was checked: this site has no open DNS task/);
    expect(recheckSentence({ task: t({ state: "closed", closedBy: "manual" }), check: null })).toMatch(/already closed/);
  });
  it("recheck: pointing closes, pending keeps the reason", () => {
    expect(recheckSentence({ task: t({ state: "closed", closedBy: "erp_check" }), check: { state: "pointing", reason: null } })).toMatch(/closed the task/);
    const s = recheckSentence({ task: t(), check: { state: "pending", reason: "mixed_with_other_hosts" } });
    expect(s).toMatch(/does not point/);
    expect(s).toContain(REASON_COPY.mixed_with_other_hosts);
    expect(s).toMatch(/stays open/);
  });
  it("refusals and read failures are sentences", () => {
    expect(recheckRefusalSentence(403)).toMatch(/not allowed/);
    expect(recheckRefusalSentence(404)).toMatch(/not found/);
    expect(recheckRefusalSentence(500)).toMatch(/could not be run/);
    expect(dnsReadSentence("The DNS checklist", 403)).toMatch(/do not have access to this site's dns checklist/);
    expect(dnsReadSentence("The DNS task", 404)).toMatch(/was not found/);
    expect(dnsReadSentence("The DNS task", 502)).toMatch(/could not be read just now/);
  });
  it("links to the PM task page by its id", () => {
    expect(taskHref("0194a3b2-x")).toBe("/tasks/0194a3b2-x");
  });
});
