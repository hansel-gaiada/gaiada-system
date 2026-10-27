// SCP-2 — the pure parts of the portal's approval page: the delayed notices' timers, the portal state of a status, the query
// string and its cursor, and the visibility rule. No database, no Cerbos: this runs on a laptop and in the fast gates. The routes
// themselves are proved by `portal-review.http.test.ts`.
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  DECISION_NOTICE_GRACE_MS, cancelDecisionNotices, dropDecisionNotices, flushDecisionNotices, pendingDecisionNoticeCount, scheduleDecisionNotices,
  setDecisionNoticeDelayForTests,
} from "./decision-notices";
import { parseListQuery, portalPostVisibleSql, portalStateOf, postVisibleTo } from "./portal-read";

afterEach(async () => {
  vi.useRealTimers();
  setDecisionNoticeDelayForTests(null);
  await flushDecisionNotices();
});

describe("SCP-2 · the undo window's delayed notices (decision-notices.ts)", () => {
  it("fires one second after undo_until, once, and forgets the job", async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const until = new Date(Date.now() + 10_000).toISOString();
    scheduleDecisionNotices("d1", until, async () => { sent.push("d1"); });
    expect(pendingDecisionNoticeCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000 + DECISION_NOTICE_GRACE_MS - 1);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(sent).toEqual(["d1"]);
    expect(pendingDecisionNoticeCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toEqual(["d1"]);
  });

  it("a cancel drops the job; a second schedule of the same decision replaces the first", async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    scheduleDecisionNotices("d2", new Date(Date.now() + 10_000).toISOString(), async () => { sent.push("a"); });
    scheduleDecisionNotices("d2", new Date(Date.now() + 10_000).toISOString(), async () => { sent.push("b"); });
    expect(pendingDecisionNoticeCount()).toBe(1);
    expect(cancelDecisionNotices("d2")).toBe(true);
    expect(cancelDecisionNotices("d2")).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sent).toEqual([]);
  });

  it("flush runs every waiting job now and answers how many; the test seam fixes the delay", async () => {
    const sent: string[] = [];
    scheduleDecisionNotices("d3", new Date(Date.now() + 10_000).toISOString(), async () => { sent.push("d3"); });
    scheduleDecisionNotices("d4", null, async () => { sent.push("d4"); });
    expect(await flushDecisionNotices()).toBe(2);
    expect(sent.sort()).toEqual(["d3", "d4"]);
    expect(pendingDecisionNoticeCount()).toBe(0);
    vi.useFakeTimers();
    setDecisionNoticeDelayForTests(5);
    scheduleDecisionNotices("d5", new Date(Date.now() + 10_000).toISOString(), async () => { sent.push("d5"); });
    await vi.advanceTimersByTimeAsync(6);
    expect(sent).toContain("d5");
  });

  it("a reschedule waits the real remaining window even when the test seam fixes the delay, and a drop clears without running", async () => {
    vi.useFakeTimers();
    setDecisionNoticeDelayForTests(0);
    const sent: string[] = [];
    scheduleDecisionNotices("d7", new Date(Date.now() + 10_000).toISOString(), async () => { sent.push("d7"); }, { reschedule: true });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(6_001);
    expect(sent).toEqual(["d7"]);
    scheduleDecisionNotices("d8", null, async () => { sent.push("d8"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(dropDecisionNotices()).toBe(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toEqual(["d7"]);
    expect(dropDecisionNotices()).toBe(0);
  });

  it("a job that throws is logged and never escapes (a notice never undoes a decision)", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    scheduleDecisionNotices("d6", null, async () => { throw new Error("boom"); });
    await expect(flushDecisionNotices()).resolves.toBe(1);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});

describe("SCP-2 · what the client calls a status (portalStateOf)", () => {
  it("client waits on them, approved/scheduled/live are as they are, every other status of a visible post is changes_asked", () => {
    expect(portalStateOf("client")).toBe("to_review");
    expect(portalStateOf("approved")).toBe("approved");
    expect(portalStateOf("scheduled")).toBe("scheduled");
    expect(portalStateOf("live")).toBe("live");
    for (const s of ["planned", "drafting", "proofread", "hod", "design", "final", "changes", "blocked", null]) {
      expect(portalStateOf(s), String(s)).toBe("changes_asked");
    }
  });
});

describe("SCP-2 · the list's query string (parseListQuery)", () => {
  const bad = (q: Record<string, unknown>) => {
    try { parseListQuery(q); } catch (e) { return (e as { getResponse(): { message: string; field: string } }).getResponse(); }
    return null;
  };

  it("defaults: the to_review tab, 30 an page, no cursor", () => {
    expect(parseListQuery({})).toMatchObject({ tab: "to_review", limitN: 30, cursorKey: null, clientId: undefined, month: undefined });
  });

  it("takes the three tabs, a client, a month and a limit from 1 to 100", () => {
    const id = "0b9e8a3c-6a39-4bf0-9a41-0f4a7b2d1c11";
    expect(parseListQuery({ tab: "grid", clientId: id, month: "2027-03", limit: "100" })).toMatchObject({ tab: "grid", clientId: id, month: "2027-03", limitN: 100 });
    expect(parseListQuery({ tab: "approved", limit: "1" }).limitN).toBe(1);
  });

  it("refuses a bad value with the field", () => {
    for (const [q, field] of [
      [{ tab: "all" }, "tab"], [{ limit: "0" }, "limit"], [{ limit: "101" }, "limit"], [{ limit: "2.5" }, "limit"],
      [{ month: "2027-00" }, "month"], [{ month: "27-03" }, "month"], [{ clientId: "nope" }, "clientId"], [{ cursor: "%%%" }, "cursor"],
    ] as const) {
      expect(bad(q), JSON.stringify(q)).toMatchObject({ message: "invalid_field", field });
    }
  });

  it("reads back a cursor it wrote and refuses one that carries anything a cast would choke on", () => {
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8").toString("base64url");
    const id = "0b9e8a3c-6a39-4bf0-9a41-0f4a7b2d1c11";
    expect(parseListQuery({ cursor: enc(["2027-03-10 10:00:00.5+00", id]) }).cursorKey).toEqual(["2027-03-10 10:00:00.5+00", id]);
    expect(parseListQuery({ cursor: enc(["infinity", id]) }).cursorKey).toEqual(["infinity", id]);
    for (const evil of [["'; drop table x; --", id], ["infinity", "not-a-uuid"], ["infinity"], "infinity", 7]) {
      expect(bad({ cursor: enc(evil) }), JSON.stringify(evil)).toMatchObject({ field: "cursor" });
    }
  });
});

describe("SCP-2 · who may see a post (the one visibility rule)", () => {
  const row = { deleted_at: null, archived_at: null, pipeline_status: "client", client_first_sent_at: "2027-03-01T00:00:00Z" };

  it("a pipeline post of the caller's client that has reached the client, not deleted or archived", () => {
    expect(postVisibleTo(row, "c1", ["c1", "c2"])).toBe(true);
  });

  it("not: another client's, never sent, deleted, archived, or a Composer post", () => {
    expect(postVisibleTo(row, "c3", ["c1", "c2"])).toBe(false);
    expect(postVisibleTo({ ...row, client_first_sent_at: null }, "c1", ["c1"])).toBe(false);
    expect(postVisibleTo({ ...row, deleted_at: "2027-03-02T00:00:00Z" }, "c1", ["c1"])).toBe(false);
    expect(postVisibleTo({ ...row, archived_at: new Date() }, "c1", ["c1"])).toBe(false);
    expect(postVisibleTo({ ...row, pipeline_status: null }, "c1", ["c1"])).toBe(false);
  });

  it("the SQL form says the same, in the caller's clients and nothing wider", () => {
    const sql = portalPostVisibleSql("p", "e", 4).replace(/\s+/g, " ");
    for (const part of [
      "p.deleted_at IS NULL", "p.archived_at IS NULL", "p.pipeline_status IS NOT NULL", "p.client_first_sent_at IS NOT NULL",
      "e.client_id = ANY($4::uuid[])", "e.deleted_at IS NULL",
    ]) expect(sql).toContain(part);
    expect(sql).not.toMatch(/\bOR\b/);
  });
});
