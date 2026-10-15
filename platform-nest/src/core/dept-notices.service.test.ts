// DW-10a (docs/FRONTEND-BFF-CONTRACT.md §57) — the PURE half of the notice board: body and query validation, the scope the Cerbos check
// reads before anything else is validated, the cursor, the current/past rule and the row shape. No database, no Cerbos, no Nest: this
// suite runs anywhere. The routes over real Postgres and Cerbos are dept-notices.test.ts (the Linux gate).
import { describe, it, expect } from "vitest";
import {
  BODY_MAX, HOME, LIST_DEFAULT, LIST_MAX, NoticeRuleError, TITLE_MAX, authFactsOf, decodeCursor, encodeCursor, isIsoDate, listModeOf,
  noticeHref, parseListQuery, parsePatch, parsePost, stateOf, toNoticeRow, type NoticeDbRow,
} from "./dept-notices.service";

const TODAY = "2026-10-15";
const ID = "0198a0a0-0000-7000-8000-000000000001";

/** The refusal a parser throws, as data: status, message and field. */
function refusal(fn: () => unknown): { httpStatus: number; message: string; field?: string } {
  try {
    fn();
  } catch (e) {
    if (e instanceof NoticeRuleError) return { httpStatus: e.httpStatus, message: e.message, field: e.field };
    throw e;
  }
  throw new Error("expected a NoticeRuleError, but nothing was thrown");
}

describe("DW-10a · authFactsOf: the only two body fields read before the Cerbos check", () => {
  it("a unit notice carries its unitNodeId; nothing else of the body is read", () => {
    expect(authFactsOf({ scope: "unit", unitNodeId: "d-web", title: 42, body: null, pinned: "yes", endsOn: "garbage" })).toEqual({ scope: "unit", unitNodeId: "d-web" });
  });
  it("a unit notice with a missing or non-string unitNodeId authorizes against '' (no ancestors, so no lead grant matches)", () => {
    expect(authFactsOf({ scope: "unit" })).toEqual({ scope: "unit", unitNodeId: "" });
    expect(authFactsOf({ scope: "unit", unitNodeId: 7 })).toEqual({ scope: "unit", unitNodeId: "" });
  });
  it("anything that is not exactly `unit` is authorized as company-wide, the strictest right (a head is refused, never widened)", () => {
    for (const body of [{ scope: "company", unitNodeId: "d-web" }, { scope: "UNIT" }, { scope: 1 }, {}, null, "x", [], undefined]) {
      expect(authFactsOf(body), JSON.stringify(body)).toEqual({ scope: "company", unitNodeId: "" });
    }
  });
});

describe("DW-10a · parsePost", () => {
  const ok = { scope: "unit", unitNodeId: "d-web", title: "Office closed", body: "Closed on Friday.\nBack Monday." };

  it("a plain unit notice: trimmed text, line breaks kept, pin false and no end date by default", () => {
    expect(parsePost({ ...ok, title: "  Office closed  " }, TODAY)).toEqual({
      scope: "unit", unitNodeId: "d-web", title: "Office closed", body: "Closed on Friday.\nBack Monday.", pinned: false, endsOn: null,
    });
  });
  it("a company-wide notice has no unit; a pin and an end date of today or later are accepted", () => {
    expect(parsePost({ scope: "company", title: "All hands", body: "Thursday 10:00", pinned: true, endsOn: TODAY }, TODAY)).toEqual({
      scope: "company", unitNodeId: null, title: "All hands", body: "Thursday 10:00", pinned: true, endsOn: TODAY,
    });
    expect(parsePost({ scope: "company", unitNodeId: null, title: "t", body: "b", endsOn: null }, TODAY).endsOn).toBeNull();
  });
  it("CRLF becomes LF; a NUL is dropped (it cannot live in a text column)", () => {
    expect(parsePost({ ...ok, body: "a\r\nb\rc\u0000d" }, TODAY).body).toBe("a\nb\ncd");
  });
  it("text is scrubbed like other free text (PAN, e-mail) BEFORE the length is measured", () => {
    const p = parsePost({ ...ok, body: "Ask ann@example.com about 4111 1111 1111 1111" }, TODAY);
    expect(p.body).toBe("Ask [REDACTED-EMAIL] about [REDACTED-PAN]");
    // a title of 119 raw characters (12 short e-mail addresses) redacts to a longer one: the STORED length is what the limit judges
    const title = Array.from({ length: 12 }, () => "a@bcd.org").join(" ");
    expect(title.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(refusal(() => parsePost({ ...ok, title }, TODAY))).toMatchObject({ httpStatus: 400, field: "title" });
  });

  it("every refusal is a 400 naming its field: scope, unitNodeId, title, body, pinned, endsOn", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...ok, scope: undefined }, "scope"],
      [{ ...ok, scope: "team" }, "scope"],
      [{ ...ok, unitNodeId: undefined }, "unitNodeId"],
      [{ ...ok, unitNodeId: "  " }, "unitNodeId"],
      [{ ...ok, unitNodeId: 5 }, "unitNodeId"],
      [{ scope: "company", unitNodeId: "d-web", title: "t", body: "b" }, "unitNodeId"],
      [{ ...ok, title: undefined }, "title"],
      [{ ...ok, title: "   " }, "title"],
      [{ ...ok, title: 5 }, "title"],
      [{ ...ok, title: "x".repeat(TITLE_MAX + 1) }, "title"],
      [{ ...ok, body: undefined }, "body"],
      [{ ...ok, body: "" }, "body"],
      [{ ...ok, body: "x".repeat(BODY_MAX + 1) }, "body"],
      [{ ...ok, pinned: "true" }, "pinned"],
      [{ ...ok, pinned: 1 }, "pinned"],
      [{ ...ok, endsOn: "2026-13-01" }, "endsOn"],
      [{ ...ok, endsOn: "2026-02-30" }, "endsOn"],
      [{ ...ok, endsOn: "15/10/2026" }, "endsOn"],
      [{ ...ok, endsOn: 20261016 }, "endsOn"],
      [{ ...ok, endsOn: "2026-10-14" }, "endsOn"], // before today, on post
    ];
    for (const [body, field] of cases) expect(refusal(() => parsePost(body, TODAY)), JSON.stringify(body)).toMatchObject({ httpStatus: 400, field });
  });
  it("the limits are inclusive: 120 title and 4,000 body characters pass, counted as characters not UTF-16 units", () => {
    expect(parsePost({ ...ok, title: "x".repeat(TITLE_MAX), body: "y".repeat(BODY_MAX) }, TODAY).title).toHaveLength(TITLE_MAX);
    // 120 astral characters are 240 UTF-16 units but 120 characters, which is what Postgres counts
    expect(parsePost({ ...ok, title: "\u{1F600}".repeat(TITLE_MAX) }, TODAY).title).toBe("\u{1F600}".repeat(TITLE_MAX));
    expect(refusal(() => parsePost({ ...ok, title: "\u{1F600}".repeat(TITLE_MAX + 1) }, TODAY))).toMatchObject({ field: "title" });
  });
  it("unknown keys are refused, by name", () => {
    expect(refusal(() => parsePost({ ...ok, authorId: "someone" }, TODAY))).toMatchObject({ httpStatus: 400, field: "authorId" });
    expect(refusal(() => parsePost({ ...ok, withdrawnAt: null }, TODAY))).toMatchObject({ field: "withdrawnAt" });
    expect(refusal(() => parsePost("not an object", TODAY))).toMatchObject({ httpStatus: 400 });
    expect(refusal(() => parsePost(null, TODAY))).toMatchObject({ httpStatus: 400 });
  });
});

describe("DW-10a · parsePatch", () => {
  it("each field is optional and validated like a post's; endsOn null clears the date; a PAST end date is allowed (it puts a notice away)", () => {
    expect(parsePatch({ title: " New " })).toEqual({ title: "New" });
    expect(parsePatch({ body: "b", pinned: true })).toEqual({ body: "b", pinned: true });
    expect(parsePatch({ endsOn: null })).toEqual({ endsOn: null });
    expect(parsePatch({ endsOn: "2020-01-01" })).toEqual({ endsOn: "2020-01-01" });
  });
  it("refusals: a bad field, an unknown key (scope and unitNodeId cannot be edited), an empty patch", () => {
    expect(refusal(() => parsePatch({ title: "" }))).toMatchObject({ httpStatus: 400, field: "title" });
    expect(refusal(() => parsePatch({ pinned: "yes" }))).toMatchObject({ field: "pinned" });
    expect(refusal(() => parsePatch({ endsOn: "soon" }))).toMatchObject({ field: "endsOn" });
    expect(refusal(() => parsePatch({ scope: "company" }))).toMatchObject({ field: "scope" });
    expect(refusal(() => parsePatch({ unitNodeId: "d-seo" }))).toMatchObject({ field: "unitNodeId" });
    expect(refusal(() => parsePatch({}))).toMatchObject({ httpStatus: 400, message: "nothing to change" });
    expect(refusal(() => parsePatch(null))).toMatchObject({ httpStatus: 400 });
  });
});

describe("DW-10a · the dates", () => {
  it("isIsoDate accepts real calendar dates only", () => {
    for (const s of ["2026-10-15", "2028-02-29", "2026-12-31"]) expect(isIsoDate(s), s).toBe(true);
    for (const s of ["2026-02-29", "2026-13-01", "2026-00-10", "2026-1-5", "26-10-15", "2026-10-15T00:00:00Z", ""]) expect(isIsoDate(s), s).toBe(false);
  });
  it("stateOf: current while there is no end date or it is today or later; past once it is behind today", () => {
    expect(stateOf(null, TODAY)).toBe("current");
    expect(stateOf("2026-10-15", TODAY)).toBe("current");
    expect(stateOf("2026-10-16", TODAY)).toBe("current");
    expect(stateOf("2026-10-14", TODAY)).toBe("past");
  });
});

describe("DW-10a · the list query", () => {
  it("a unit list defaults to state current and limit 20", () => {
    expect(parseListQuery({ unitNodeId: "d-web" })).toEqual({ mode: "unit", unitNodeId: "d-web", state: "current", limit: LIST_DEFAULT, cursor: null });
  });
  it("scope=company is the company list; the hub's `home` default beside it is not a conflict, a real unit id is", () => {
    expect(parseListQuery({ scope: "company" })).toMatchObject({ mode: "company", unitNodeId: null });
    expect(parseListQuery({ scope: "company", unitNodeId: HOME, state: "past" })).toMatchObject({ mode: "company", unitNodeId: null, state: "past" });
    expect(parseListQuery({ scope: "company", unitNodeId: "all" })).toMatchObject({ mode: "company" });
    expect(refusal(() => parseListQuery({ scope: "company", unitNodeId: "d-web" }))).toMatchObject({ httpStatus: 400, field: "unitNodeId" });
  });
  it("neither unitNodeId nor scope=company is a 400 naming unitNodeId; `all` is the not-given sentinel", () => {
    expect(refusal(() => parseListQuery({}))).toMatchObject({ httpStatus: 400, field: "unitNodeId" });
    expect(refusal(() => parseListQuery({ unitNodeId: "" }))).toMatchObject({ field: "unitNodeId" });
    expect(refusal(() => parseListQuery({ unitNodeId: "all", scope: "all" }))).toMatchObject({ field: "unitNodeId" });
    expect(parseListQuery({ unitNodeId: HOME, scope: "all", state: "all", limit: "all", cursor: "all" })).toEqual({
      mode: "unit", unitNodeId: HOME, state: "current", limit: LIST_DEFAULT, cursor: null,
    });
  });
  it("state, limit and scope are validated: 400 with the field", () => {
    expect(refusal(() => parseListQuery({ unitNodeId: "u", state: "old" }))).toMatchObject({ field: "state" });
    for (const limit of ["0", "51", "-1", "abc", "1.5", "1000"]) expect(refusal(() => parseListQuery({ unitNodeId: "u", limit })), limit).toMatchObject({ field: "limit" });
    expect(parseListQuery({ unitNodeId: "u", limit: String(LIST_MAX) }).limit).toBe(LIST_MAX);
    expect(parseListQuery({ unitNodeId: "u", limit: "1" }).limit).toBe(1);
    expect(refusal(() => parseListQuery({ unitNodeId: "u", scope: "everything" }))).toMatchObject({ field: "scope" });
  });
  it("listModeOf reads only the scope", () => {
    expect(listModeOf({ scope: "company" })).toBe("company");
    expect(listModeOf({ scope: "unit", unitNodeId: "x" })).toBe("unit");
    expect(listModeOf({})).toBe("unit");
    expect(listModeOf({ scope: ["company"] })).toBe("unit");
  });
});

describe("DW-10a · the cursor", () => {
  const cur = { state: "current" as const, pinned: true, createdKey: "2026-10-15T01:02:03.123456Z", id: ID };
  it("round-trips, microseconds and all, and is opaque base64url", () => {
    const raw = encodeCursor(cur);
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(raw, "current")).toEqual(cur);
    expect(parseListQuery({ unitNodeId: "u", cursor: raw }).cursor).toEqual(cur);
  });
  it("a cursor belongs to the state that issued it, and a malformed one is a 400 on `cursor`", () => {
    const raw = encodeCursor(cur);
    expect(refusal(() => decodeCursor(raw, "past"))).toMatchObject({ httpStatus: 400, field: "cursor" });
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8").toString("base64url");
    for (const bad of [
      "!!!", "", enc("x"), enc([]), enc(["current", true, "2026-10-15T01:02:03Z", ID]), enc(["current", "yes", cur.createdKey, ID]),
      enc(["current", true, cur.createdKey, "not-a-uuid"]), enc(["current", true, cur.createdKey, ID, "extra"]),
    ]) {
      expect(refusal(() => decodeCursor(bad, "current")), bad).toMatchObject({ httpStatus: 400, field: "cursor" });
    }
  });
});

describe("DW-10a · the row", () => {
  const db: NoticeDbRow = {
    id: ID, scope: "unit", unit_node_id: "d-web", title: "T", body: "B", pinned: true, ends_on: "2026-10-14", author_id: "u1", author_name: "Ada",
    created_at: new Date("2026-10-01T00:00:00.000Z"), created_key: "2026-10-01T00:00:00.000000Z", edited_at: null, withdrawn_at: null,
  };
  it("the contract's NoticeRow: state is computed at read time, unitName comes from the tree, canEdit is the caller's", () => {
    expect(toNoticeRow(db, TODAY, (u) => (u === "d-web" ? "Web Dev" : null), true)).toEqual({
      id: ID, scope: "unit", unitNodeId: "d-web", unitName: "Web Dev", title: "T", body: "B", pinned: true, endsOn: "2026-10-14", state: "past",
      author: { id: "u1", name: "Ada" }, createdAt: "2026-10-01T00:00:00.000Z", editedAt: null, canEdit: true,
    });
  });
  it("a unit that left the tree reads null; a company-wide notice has no unit at all; an edit stamps editedAt", () => {
    expect(toNoticeRow(db, TODAY, () => null, false)).toMatchObject({ unitNodeId: "d-web", unitName: null, canEdit: false });
    const company = toNoticeRow({ ...db, scope: "company", unit_node_id: null, ends_on: null, edited_at: new Date("2026-10-02T00:00:00.000Z") }, TODAY, () => "never called", false);
    expect(company).toMatchObject({ scope: "company", unitNodeId: null, unitName: null, endsOn: null, state: "current", editedAt: "2026-10-02T00:00:00.000Z" });
  });
  it("the Inbox link: a unit notice to the unit's notices tab, a company-wide one to /notices", () => {
    expect(noticeHref("unit", "d-web", ID)).toBe(`/departments/d-web/notices#${ID}`);
    expect(noticeHref("unit", "d web/1", ID)).toBe(`/departments/d%20web%2F1/notices#${ID}`);
    expect(noticeHref("company", null, ID)).toBe(`/notices#${ID}`);
  });
});
