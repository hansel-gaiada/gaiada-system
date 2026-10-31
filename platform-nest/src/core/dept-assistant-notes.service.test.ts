// AIP-23b (FRONTEND-BFF-CONTRACT §67; PERMISSION-CONTRACT §59) — the pure half of department notes: the three body validators, the person
// shown on a note (current name, or the stored one marked former: AIP-D23), the answer's shape and the Cerbos resource. No database and no Nest
// (the routes, with the real table and Cerbos, are dept-assistant-notes.test.ts on the Linux gate).
import { describe, it, expect } from "vitest";
import {
  LINKABLE_KINDS, NOTE_BODY_MAX_CHARS, NoteRuleError, REJECT_REASON_MAX_CHARS, noteResource, parseDecideBody, parsePinBody, parseProposeBody,
  personRef, snapshotName, toNoteView, type NoteDbRow,
} from "./dept-assistant-notes.service";

const refused = (fn: () => unknown): NoteRuleError => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(NoteRuleError);
    return e as NoteRuleError;
  }
  throw new Error("expected a refusal");
};
const UUID = "0b7c4c1e-3f7a-4a59-9f1e-6a0b2c3d4e5f";

describe("parseProposeBody", () => {
  it("trims the text; no record is null", () => {
    expect(parseProposeBody({ body: "  Cosmedic's report goes out by the 3rd.  \n" })).toEqual({ text: "Cosmedic's report goes out by the 3rd.", record: null });
    expect(parseProposeBody({ body: "x", record: null }).record).toBeNull();
  });

  it("1 and exactly 500 characters are accepted; 501 is a 400 naming `body`; the length is counted after the trim", () => {
    expect(parseProposeBody({ body: "a" }).text).toBe("a");
    expect(parseProposeBody({ body: "a".repeat(NOTE_BODY_MAX_CHARS) }).text).toHaveLength(NOTE_BODY_MAX_CHARS);
    expect(parseProposeBody({ body: `  ${"a".repeat(NOTE_BODY_MAX_CHARS)}  ` }).text).toHaveLength(NOTE_BODY_MAX_CHARS);
    const e = refused(() => parseProposeBody({ body: "a".repeat(NOTE_BODY_MAX_CHARS + 1) }));
    expect(e.httpStatus).toBe(400);
    expect(e.field).toBe("body");
  });

  it("the length is in CODE POINTS: 500 astral characters pass, 501 do not", () => {
    expect(Array.from(parseProposeBody({ body: "\u{1F600}".repeat(NOTE_BODY_MAX_CHARS) }).text)).toHaveLength(NOTE_BODY_MAX_CHARS);
    expect(refused(() => parseProposeBody({ body: "\u{1F600}".repeat(NOTE_BODY_MAX_CHARS + 1) })).field).toBe("body");
  });

  it("an empty or whitespace-only text is a 400 (a note is never empty)", () => {
    for (const body of ["", "   ", "\n\t"]) expect(refused(() => parseProposeBody({ body })).field).toBe("body");
  });

  it("an e-mail address is scrubbed before the length is measured and stored; CRLF becomes LF and a NUL is dropped", () => {
    expect(parseProposeBody({ body: "Send drafts to ann@example.com" }).text).toBe("Send drafts to [REDACTED-EMAIL]");
    expect(parseProposeBody({ body: "a\r\nb\u0000c" }).text).toBe("a\nbc");
  });

  it("a record link: a linkable kind and a uuid (lower-cased)", () => {
    expect(parseProposeBody({ body: "x", record: { kind: "client", id: UUID.toUpperCase() } }).record).toEqual({ kind: "client", id: UUID });
    for (const kind of LINKABLE_KINDS) expect(parseProposeBody({ body: "x", record: { kind, id: UUID } }).record?.kind).toBe(kind);
  });

  it("reports, people and org are NOT linkable; a bad id, an unknown key or a non-object record is a 400 naming `record`", () => {
    for (const record of [
      { kind: "report", id: UUID }, { kind: "person", id: UUID }, { kind: "org", id: UUID }, { kind: "orgunits", id: UUID },
      { kind: "client", id: "not-a-uuid" }, { kind: "client" }, { id: UUID }, { kind: "client", id: UUID, extra: 1 }, "client", [UUID], 5,
    ]) {
      expect(refused(() => parseProposeBody({ body: "x", record })).field, JSON.stringify(record)).toBe("record");
    }
  });

  it("a missing, mistyped or padded body is a 400", () => {
    for (const bad of [{}, { body: null }, { body: 7 }, { body: ["a"] }, { text: "a" }, { body: "a", extra: true }, [], null, "a"]) {
      expect(refused(() => parseProposeBody(bad)).httpStatus, JSON.stringify(bad)).toBe(400);
    }
  });
});

describe("parseDecideBody", () => {
  it("approve true or false; the reason is optional, trimmed, and at most 300 characters", () => {
    expect(parseDecideBody({ approve: true })).toEqual({ approve: true, reason: null });
    expect(parseDecideBody({ approve: false, reason: "  Not a work fact.  " })).toEqual({ approve: false, reason: "Not a work fact." });
    expect(parseDecideBody({ approve: false, reason: "   " })).toEqual({ approve: false, reason: null });
    expect(parseDecideBody({ approve: false, reason: null })).toEqual({ approve: false, reason: null });
    expect(parseDecideBody({ approve: false, reason: "r".repeat(REJECT_REASON_MAX_CHARS) }).reason).toHaveLength(REJECT_REASON_MAX_CHARS);
    expect(refused(() => parseDecideBody({ approve: false, reason: "r".repeat(REJECT_REASON_MAX_CHARS + 1) })).field).toBe("reason");
  });

  it("a missing or non-boolean approve, a non-string reason, an unknown key or a non-object body is a 400", () => {
    for (const bad of [{}, { approve: "yes" }, { approve: 1 }, { approve: null }, { approve: true, reason: 5 }, { approve: true, note: "x" }, [], null]) {
      expect(refused(() => parseDecideBody(bad)).httpStatus, JSON.stringify(bad)).toBe(400);
    }
  });
});

describe("parsePinBody", () => {
  it("{ pinned: boolean } and nothing else", () => {
    expect(parsePinBody({ pinned: true })).toEqual({ pinned: true });
    expect(parsePinBody({ pinned: false })).toEqual({ pinned: false });
    for (const bad of [{}, { pinned: "true" }, { pinned: 1 }, { pinned: true, x: 1 }, null, []]) {
      expect(refused(() => parsePinBody(bad)).httpStatus, JSON.stringify(bad)).toBe(400);
    }
  });
});

describe("the person on a note (AIP-D22 both names; AIP-D23 kept after erasure, marked former)", () => {
  it("the current name while the person is an active member; the stored name marked former otherwise", () => {
    expect(personRef("u1", "Old Name", "New Name")).toEqual({ id: "u1", name: "New Name", former: false });
    expect(personRef("u1", "Old Name", null)).toEqual({ id: "u1", name: "Old Name", former: true }); // left the company
    expect(personRef(null, "Old Name", null)).toEqual({ id: null, name: "Old Name", former: true }); // user row erased
  });

  it("snapshotName: one line, at most 200 code points, never empty", () => {
    expect(snapshotName("  Ada \n Admin ")).toBe("Ada Admin");
    expect(Array.from(snapshotName("\u{1F600}".repeat(250)))).toHaveLength(200);
    expect(snapshotName("")).toBe("A colleague");
    expect(snapshotName(null)).toBe("A colleague");
  });
});

describe("toNoteView", () => {
  const base: NoteDbRow = {
    id: "n1", unit_node_id: "d-web", body: "Two hashtags at most.", status: "proposed", record_kind: null, record_id: null,
    proposed_by: "u1", proposed_by_name: "Ann Author", proposed_by_current: "Ann Author",
    decided_by: null, decided_by_name: null, decided_by_current: null,
    pinned: false, proposed_at: new Date("2026-10-31T01:00:00Z"), decided_at: null,
  };

  it("a waiting note: no decider, no decision time", () => {
    expect(toNoteView(base)).toEqual({
      id: "n1", unitNodeId: "d-web", body: "Two hashtags at most.", status: "proposed", pinned: false, record: null,
      proposedBy: { id: "u1", name: "Ann Author", former: false }, decidedBy: null,
      proposedAt: "2026-10-31T01:00:00.000Z", decidedAt: null,
    });
  });

  it("an approved, linked note whose author was erased and whose approver left the company", () => {
    const v = toNoteView({
      ...base, status: "approved", pinned: true, record_kind: "client", record_id: UUID,
      proposed_by: null, proposed_by_current: null,
      decided_by: "u2", decided_by_name: "Hal Head", decided_by_current: null, decided_at: new Date("2026-10-31T02:00:00Z"),
    });
    expect(v).toMatchObject({
      status: "approved", pinned: true, record: { kind: "client", id: UUID },
      proposedBy: { id: null, name: "Ann Author", former: true },
      decidedBy: { id: "u2", name: "Hal Head", former: true },
      decidedAt: "2026-10-31T02:00:00.000Z",
    });
  });
});

describe("noteResource", () => {
  it("carries the route's unit, both ancestries, the GM seats and the stored author; never more", () => {
    const facts = { unitAncestors: ["d-web", "d-corp"], homeAncestors: ["d-web", "d-corp"], gmIds: ["u-gm"] };
    expect(noteResource("t1", "d-web", facts)).toEqual({
      kind: "dept_assistant_note", tenantId: "t1", unitNodeId: "d-web",
      unitAncestors: ["d-web", "d-corp"], homeAncestors: ["d-web", "d-corp"], gmIds: ["u-gm"], proposedBy: "",
    });
    expect(noteResource("t1", "d-web", facts, { id: "n1", proposedBy: "u1" })).toMatchObject({ id: "n1", proposedBy: "u1" });
    // an erased author feeds "" (the withdraw rule then matches nobody)
    expect(noteResource("t1", "d-web", facts, { id: "n1", proposedBy: null }).proposedBy).toBe("");
  });
});
