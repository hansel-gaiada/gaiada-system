import { describe, it, expect, beforeEach } from "vitest";
import { noticesDemo, resetNoticesDemo } from "./demoNotices";
import { getDemoResponse } from "./demoFixtures";
import type { NoticeRow } from "./notices";

// DW-10a-2: the notice board's demo store. It stands in for the API under DEMO_MODE and in the CI smoke build, so it must keep the server's
// gates and its order of checks: a page is only as honest as the fixture behind it.

const T = "co-agency";
const base = `/api/${T}/notices`;
const q = (o: Record<string, string>) => new URLSearchParams(o);
const get = (params: Record<string, string>, user = "demo-hansel") => noticesDemo("GET", base, q(params), undefined, user)!;
const one = (id: string, user = "demo-hansel") => noticesDemo("GET", `${base}/${id}`, q({}), undefined, user)!;
const post = (body: unknown, user = "demo-hansel") => noticesDemo("POST", base, q({}), JSON.stringify(body), user)!;
const patch = (id: string, body: unknown, user = "demo-hansel") => noticesDemo("PATCH", `${base}/${id}`, q({}), JSON.stringify(body), user)!;
const withdraw = (id: string, user = "demo-hansel") => noticesDemo("POST", `${base}/${id}/withdraw`, q({}), undefined, user)!;
const items = (r: { json: unknown }) => (r.json as { items: NoticeRow[] }).items;
const UNIT1 = { unitNodeId: "dept-1" };
const valid = { scope: "unit", unitNodeId: "dept-1", title: "T", body: "B" };

beforeEach(() => resetNoticesDemo());

describe("routing", () => {
  it("ignores paths that are not notices", () => {
    expect(noticesDemo("GET", `/api/${T}/noticesx`, q({}), undefined, "demo-hansel")).toBeNull();
    expect(noticesDemo("GET", `/api/${T}/dept-kpis`, q({}), undefined, "demo-hansel")).toBeNull();
  });
  it("is reached through getDemoResponse", () => {
    const r = getDemoResponse("GET", `${base}?unitNodeId=dept-1`, "demo-hansel");
    expect(r.status).toBe(200);
    expect(items(r).length).toBeGreaterThan(0);
  });
});

describe("the seed: one pinned and one plain notice for Web Dev, and one company-wide", () => {
  it("lists Web Dev's current notices pinned first, then the company-wide one, newest first", () => {
    const r = get({ ...UNIT1 });
    expect(r.status).toBe(200);
    expect(items(r).map((n) => [n.title, n.pinned, n.scope])).toEqual([
      ["Release freeze starts Friday 17:00", true, "unit"],
      ["Office closed for Nyepi", false, "company"],
      ["New code-review checklist", false, "unit"],
    ]);
    expect((r.json as { nextCursor: string | null }).nextCursor).toBeNull();
  });
  it("lists the company-wide notice alone for scope=company", () => {
    expect(items(get({ scope: "company" })).map((n) => n.title)).toEqual(["Office closed for Nyepi"]);
  });
  it("keeps a past notice for the Past view and out of the current one", () => {
    expect(items(get({ ...UNIT1, state: "past" })).map((n) => [n.title, n.state])).toEqual([["Quarter retro notes", "past"]]);
    expect(items(get({ ...UNIT1 })).every((n) => n.state === "current")).toBe(true);
  });
  it("gives each row the unit's name, the author and canEdit for the caller", () => {
    const rows = items(get({ ...UNIT1 }, "u-webhead"));
    expect(rows[0]).toMatchObject({ unitNodeId: "dept-1", unitName: "Web Dev", author: { id: "u-webhead", name: "Ketut Arta" }, canEdit: true });
    // A head cannot edit the company-wide notice.
    expect(rows.find((n) => n.scope === "company")).toMatchObject({ unitName: null, canEdit: false });
    // A company admin can edit everything.
    expect(items(get({ ...UNIT1 })).every((n) => n.canEdit)).toBe(true);
    // Placed staff can edit nothing.
    expect(items(get({ ...UNIT1 }, "u-dev")).every((n) => !n.canEdit)).toBe(true);
  });
});

describe("reading", () => {
  it("lets the people placed in a unit, its head and the company-wide tiers read it", () => {
    for (const who of ["u-dev", "u-webhead", "demo-hansel", "demo-owner"]) expect(get({ ...UNIT1 }, who).status, who).toBe(200);
  });
  it("refuses another department's people with 403 BEFORE saying whether the unit exists, then 404 for a company-wide caller", () => {
    expect(get({ unitNodeId: "dept-1" }, "seo-staff")).toMatchObject({ status: 403, json: { error: "outside your reporting line" } });
    expect(get({ unitNodeId: "dept-99" }, "seo-staff").status).toBe(403);
    expect(get({ unitNodeId: "dept-99" }).status).toBe(404);
    expect(get({ unitNodeId: "root" }).json).toEqual({ error: "unit_not_found", field: "unitNodeId" });
  });
  it("knows HR, Finance and IT (dept-6 to dept-8) so their Overviews read, and lets the HR tier read every unit but write none", () => {
    for (const unit of ["dept-6", "dept-7", "dept-8"]) expect(get({ unitNodeId: unit }).status, unit).toBe(200);
    expect(get({ unitNodeId: "dept-6" }, "u-hr").status).toBe(200);
    expect(get({ ...UNIT1 }, "u-hr").status).toBe(200);
    expect(post(valid, "u-hr").status).toBe(403);
    // Unplaced finance staff read the company-wide notices only.
    expect(get({ unitNodeId: "dept-7" }, "u-finance-staff").status).toBe(403);
    expect(items(get({ scope: "company" }, "u-finance-staff"))).toHaveLength(1);
  });
  it("shows another department's staff their own unit's notices and not Web Dev's", () => {
    expect(items(get({ unitNodeId: "dept-3" }, "seo-staff")).map((n) => n.scope)).toEqual(["company"]);
  });
  it("lets every staff person read the company-wide ones, and refuses a client contact everything", () => {
    expect(items(get({ scope: "company" }, "seo-staff")).length).toBe(1);
    expect(get({ scope: "company" }, "demo-client").status).toBe(403);
    expect(get({ ...UNIT1 }, "demo-client").status).toBe(403);
    expect(one(items(get({ scope: "company" }))[0].id, "demo-client").status).toBe(404);
  });
  it("answers 400 for a missing unit, a bad state, a bad limit and a foreign cursor", () => {
    expect(get({})).toMatchObject({ status: 400, json: { field: "unitNodeId" } });
    expect(get({ ...UNIT1, state: "later" })).toMatchObject({ status: 400, json: { field: "state" } });
    expect(get({ ...UNIT1, limit: "0" })).toMatchObject({ status: 400, json: { field: "limit" } });
    expect(get({ ...UNIT1, limit: "51" }).status).toBe(400);
    expect(get({ ...UNIT1, cursor: "nope" })).toMatchObject({ status: 400, json: { field: "cursor" } });
    expect(get({ scope: "company", unitNodeId: "dept-1" })).toMatchObject({ status: 400, json: { field: "unitNodeId" } });
  });
  it("pages with limit and an opaque cursor, and refuses a cursor from the other state", () => {
    const first = get({ ...UNIT1, limit: "2" });
    const cursor = (first.json as { nextCursor: string }).nextCursor;
    expect(items(first)).toHaveLength(2);
    expect(cursor).toBeTruthy();
    const second = get({ ...UNIT1, limit: "2", cursor });
    expect(items(second)).toHaveLength(1);
    expect((second.json as { nextCursor: string | null }).nextCursor).toBeNull();
    expect(get({ ...UNIT1, state: "past", cursor }).status).toBe(400);
  });
  it("reads one notice, and 404s an unreadable one, never 403", () => {
    const id = items(get({ ...UNIT1 }))[0].id;
    expect(one(id).status).toBe(200);
    expect(one(id, "seo-staff")).toMatchObject({ status: 404, json: { error: "notice_not_found" } });
    expect(one("nope").status).toBe(404);
  });
  it("has no notices for another company", () => {
    expect(noticesDemo("GET", "/api/co-holding/notices", q({ scope: "company" }), undefined, "demo-hansel")).toMatchObject({ status: 200, json: { items: [], nextCursor: null } });
  });
});

describe("posting", () => {
  it("lets the head post to their own unit and the company admin anywhere, answering 201 with the row", () => {
    const r = post(valid, "u-webhead");
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ scope: "unit", unitNodeId: "dept-1", unitName: "Web Dev", title: "T", body: "B", pinned: false, endsOn: null, state: "current", canEdit: true, author: { id: "u-webhead" } });
    expect(post({ ...valid, unitNodeId: "dept-3" }).status).toBe(201);
    expect(post({ scope: "company", title: "All", body: "Hands" }).status).toBe(201);
  });
  it("shows the new notice in the list at once", () => {
    post({ ...valid, title: "Fresh" }, "u-webhead");
    expect(items(get({ ...UNIT1 })).map((n) => n.title)).toContain("Fresh");
  });
  it("refuses a head company-wide, a head on a sibling unit, staff and the owner with 403, whatever the body", () => {
    expect(post({ scope: "company", title: "x", body: "y" }, "u-webhead").status).toBe(403);
    expect(post({ ...valid, unitNodeId: "dept-3" }, "u-webhead").status).toBe(403);
    expect(post(valid, "u-dev").status).toBe(403);
    expect(post(valid, "demo-owner").status).toBe(403);
    expect(post({ ...valid, scope: "weird" }, "u-webhead").status).toBe(403);
  });
  it("authorizes BEFORE validating: a refused caller gets 403 for an invalid body, never 400", () => {
    expect(post({ scope: "unit", unitNodeId: "dept-1", title: "", body: "" }, "u-dev").status).toBe(403);
    expect(post({ scope: "unit", unitNodeId: "dept-1", title: "", body: "" }, "u-webhead")).toMatchObject({ status: 400, json: { field: "title" } });
  });
  it("answers 400 with the field for a bad title, body, pin, date, scope and unknown key", () => {
    expect(post({ ...valid, title: "x".repeat(121) })).toMatchObject({ status: 400, json: { field: "title" } });
    expect(post({ ...valid, body: "x".repeat(4001) })).toMatchObject({ status: 400, json: { field: "body" } });
    expect(post({ ...valid, pinned: "yes" })).toMatchObject({ status: 400, json: { field: "pinned" } });
    expect(post({ ...valid, endsOn: "2020-01-01" })).toMatchObject({ status: 400, json: { field: "endsOn" } });
    expect(post({ ...valid, endsOn: "tomorrow" })).toMatchObject({ status: 400, json: { field: "endsOn" } });
    expect(post({ ...valid, extra: 1 })).toMatchObject({ status: 400, json: { field: "extra" } });
    expect(post({ scope: "company", unitNodeId: "dept-1", title: "a", body: "b" })).toMatchObject({ status: 400, json: { field: "unitNodeId" } });
    expect(post({ scope: "unit", title: "a", body: "b" })).toMatchObject({ status: 400, json: { field: "unitNodeId" } });
  });
  it("answers 404 for an unknown unit (and the root) to a company admin, 403 to a head", () => {
    expect(post({ ...valid, unitNodeId: "dept-99" })).toMatchObject({ status: 404, json: { error: "unit_not_found" } });
    expect(post({ ...valid, unitNodeId: "root" }).status).toBe(404);
    expect(post({ ...valid, unitNodeId: "dept-99" }, "u-webhead").status).toBe(403);
  });
  it("keeps line breaks and trims, and 409s a fourth current pin", () => {
    // Web Dev already has one current pin.
    expect(post({ ...valid, title: "  P2  ", body: "a\r\nb", pinned: true }, "u-webhead").json).toMatchObject({ title: "P2", body: "a\nb", pinned: true });
    expect(post({ ...valid, pinned: true }, "u-webhead").status).toBe(201);
    expect(post({ ...valid, pinned: true }, "u-webhead")).toMatchObject({ status: 409, json: { error: "pin_limit", field: "pinned" } });
    // Another unit and the company scope count their own pins.
    expect(post({ ...valid, unitNodeId: "dept-3", pinned: true }).status).toBe(201);
    expect(post({ scope: "company", title: "c", body: "c", pinned: true }).status).toBe(201);
  });
});

describe("editing", () => {
  const id = () => items(get({ ...UNIT1 }))[0].id; // the pinned notice

  it("changes the fields, sets editedAt, and clears the end date with null", () => {
    const r = patch(id(), { title: "New title", pinned: false, endsOn: null }, "u-webhead");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ title: "New title", pinned: false, endsOn: null, canEdit: true });
    expect((r.json as NoticeRow).editedAt).not.toBeNull();
    expect(one(id(), "u-webhead").json).toMatchObject({ pinned: false });
  });
  it("refuses a reader who may not edit with 403 (even for an invalid body), and a stranger with 404", () => {
    expect(patch(id(), { title: "x" }, "u-dev").status).toBe(403);
    expect(patch(id(), { title: "" }, "u-dev").status).toBe(403);
    expect(patch(id(), { title: "x" }, "dept-manager").status).toBe(404);
    expect(patch("nope", { title: "x" }).status).toBe(404);
  });
  it("lets a head not edit the company-wide notice (403), and the admin edit it", () => {
    const company = items(get({ scope: "company" }))[0].id;
    expect(patch(company, { title: "x" }, "u-webhead").status).toBe(403);
    expect(patch(company, { title: "x" }).status).toBe(200);
  });
  it("answers 400 for an empty change, an unknown key and an invalid field; scope cannot change", () => {
    expect(patch(id(), {}, "u-webhead").status).toBe(400);
    expect(patch(id(), { scope: "company" }, "u-webhead")).toMatchObject({ status: 400, json: { field: "scope" } });
    expect(patch(id(), { title: "" }, "u-webhead")).toMatchObject({ status: 400, json: { field: "title" } });
    expect(patch(id(), { endsOn: "later" }, "u-webhead")).toMatchObject({ status: 400, json: { field: "endsOn" } });
  });
  it("409s a new pin past the limit and lets an existing pin be edited without a 409", () => {
    post({ ...valid, pinned: true }, "u-webhead");
    post({ ...valid, pinned: true }, "u-webhead");
    const rows = items(get({ ...UNIT1 }, "u-webhead"));
    expect(rows.filter((n) => n.pinned).length).toBe(3);
    const plain = rows.find((n) => !n.pinned && n.scope === "unit")!;
    expect(patch(plain.id, { pinned: true }, "u-webhead")).toMatchObject({ status: 409, json: { error: "pin_limit" } });
    const pinned = rows.find((n) => n.pinned)!;
    expect(patch(pinned.id, { title: "Still pinned", pinned: true }, "u-webhead").status).toBe(200);
  });
});

describe("withdrawing", () => {
  it("takes the notice out of every list and every read, and a second withdrawal is 404", () => {
    const id = items(get({ ...UNIT1 }))[0].id;
    expect(withdraw(id, "u-webhead")).toMatchObject({ status: 200, json: { id } });
    expect(items(get({ ...UNIT1 })).map((n) => n.id)).not.toContain(id);
    expect(one(id).status).toBe(404);
    expect(withdraw(id, "u-webhead").status).toBe(404);
  });
  it("refuses staff with 403, a stranger with 404, and a head on the company-wide notice with 403", () => {
    const id = items(get({ ...UNIT1 }))[0].id;
    expect(withdraw(id, "u-dev").status).toBe(403);
    expect(withdraw(id, "seo-staff").status).toBe(404);
    expect(withdraw(items(get({ scope: "company" }))[0].id, "u-webhead").status).toBe(403);
  });
  it("frees a pin slot", () => {
    post({ ...valid, pinned: true }, "u-webhead");
    post({ ...valid, pinned: true }, "u-webhead");
    expect(post({ ...valid, pinned: true }, "u-webhead").status).toBe(409);
    const pinnedId = items(get({ ...UNIT1 }))[0].id;
    withdraw(pinnedId);
    expect(post({ ...valid, pinned: true }, "u-webhead").status).toBe(201);
  });
});
