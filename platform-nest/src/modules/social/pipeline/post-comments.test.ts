// SCP-1l — the pure parts of a social_post thread (BFF §63.8) and the one rule the portal reads through: which comments the
// client may see. No database: the real-Postgres behaviour is in post-comments.http.test.ts.
import { describe, it, expect, vi } from "vitest";
import type { PoolClient } from "pg";
import { clientVisibleComments, parseAnchor, parseVisibility } from "./post-comments";

const FILE = "11111111-1111-4111-8111-111111111111";
const TENANT = "22222222-2222-4222-8222-222222222222";
const POST = "33333333-3333-4333-8333-333333333333";

function fakeClient(rows: Array<Record<string, unknown>>) {
  const query = vi.fn(async (sql: string) => (sql.includes("FROM social_posts") ? { rows } : { rows: [] }));
  return { client: { query } as unknown as PoolClient, query };
}

describe("parseVisibility", () => {
  it("is team when absent, and takes team or client", () => {
    expect(parseVisibility(undefined)).toBe("team");
    expect(parseVisibility("team")).toBe("team");
    expect(parseVisibility("client")).toBe("client");
  });
  it("refuses anything else with 400 and the field", () => {
    for (const bad of ["", "CLIENT", "everyone", null, 1, true, {}]) {
      expect(() => parseVisibility(bad)).toThrow();
      try { parseVisibility(bad); } catch (e) {
        expect((e as { getStatus(): number }).getStatus()).toBe(400);
        expect((e as { getResponse(): { field: string } }).getResponse().field).toBe("visibility");
      }
    }
  });
});

describe("parseAnchor", () => {
  it("is no pin when absent or null", () => {
    expect(parseAnchor(undefined)).toBeNull();
    expect(parseAnchor(null)).toBeNull();
  });
  it("keeps exactly x, y and a lower-cased fileId, ends included", () => {
    expect(parseAnchor({ x: 0, y: 1, fileId: FILE.toUpperCase(), extra: "dropped" })).toEqual({ x: 0, y: 1, fileId: FILE });
  });
  it("refuses a pin outside the shape with 400 and the field anchor", () => {
    const bad: unknown[] = [
      {}, [], "pin", 0.5, { x: 2, y: 0.5, fileId: FILE }, { x: -0.1, y: 0.5, fileId: FILE }, { x: 0.5, y: 1.5, fileId: FILE },
      { x: "0.5", y: 0.5, fileId: FILE }, { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5, fileId: 7 }, { x: 0.5, y: 0.5, fileId: "not-a-uuid" },
      { x: Number.NaN, y: 0.5, fileId: FILE }, { x: Infinity, y: 0.5, fileId: FILE }, { y: 0.5, fileId: FILE },
    ];
    for (const b of bad) {
      let err: unknown;
      try { parseAnchor(b); } catch (e) { err = e; }
      expect(err, JSON.stringify(b)).toBeDefined();
      expect((err as { getStatus(): number }).getStatus()).toBe(400);
      expect((err as { getResponse(): { field: string } }).getResponse().field).toBe("anchor");
    }
  });
});

describe("clientVisibleComments (the rule the portal reads through)", () => {
  it("answers nothing, without touching the database, for a post id that is not a uuid", async () => {
    const { client, query } = fakeClient([]);
    expect(await clientVisibleComments(client, TENANT, "nope")).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it("reads only client comments, of a live post that has reached the client, of this tenant and post", async () => {
    const { client, query } = fakeClient([]);
    await clientVisibleComments(client, TENANT, POST);
    const call = query.mock.calls.find((c) => String(c[0]).includes("FROM social_posts")) as unknown as [string, unknown[]];
    expect(call).toBeDefined();
    const [sql, params] = call;
    expect(sql).toContain("p.client_first_sent_at IS NOT NULL");
    expect(sql).toContain("co.visibility = 'client'");
    expect(sql).toContain("co.deleted_at IS NULL");
    expect(sql).toContain("p.deleted_at IS NULL");
    expect(sql).toContain("co.target_entity_type = 'social_post'");
    expect(params).toEqual([TENANT, POST]);
  });

  it("declares the social module scope first (the post is a third-walled table)", async () => {
    const { client, query } = fakeClient([]);
    await clientVisibleComments(client, TENANT, POST);
    expect(String(query.mock.calls[0]![0])).toContain("set_config('app.scopes'");
  });

  it("maps rows to the portal shape: no author id, the pin as stored, an ISO time", async () => {
    const at = new Date("2027-03-01T10:00:00.000Z");
    const { client } = fakeClient([
      { id: "c-1", author_name: "Mock Officer", body: "Please check", parent_comment_id: null, anchor: { x: 0.1, y: 0.2, fileId: FILE }, created_at: at },
      { id: "c-2", author_name: null, body: "No pin", parent_comment_id: "c-1", anchor: null, created_at: "2027-03-02T10:00:00.000Z" },
    ]);
    const out = await clientVisibleComments(client, TENANT, POST);
    expect(out).toEqual([
      { id: "c-1", authorName: "Mock Officer", body: "Please check", parentCommentId: null, anchor: { x: 0.1, y: 0.2, fileId: FILE }, createdAt: "2027-03-01T10:00:00.000Z" },
      { id: "c-2", authorName: null, body: "No pin", parentCommentId: "c-1", anchor: null, createdAt: "2027-03-02T10:00:00.000Z" },
    ]);
    expect(Object.keys(out[0]!)).not.toContain("authorId");
  });
});
