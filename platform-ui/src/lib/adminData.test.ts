import { describe, it, expect, vi, beforeEach } from "vitest";
import { GATE_TEMPLATE, listUsers, listRoles, applyAuditFilters, type AuditEntry } from "./adminData";
import { PlatformError } from "./platform";

beforeEach(() => {
  process.env.PLATFORM_URL = "http://p.test";
  process.env.PLATFORM_SERVICE_TOKEN = "t";
});

describe("GATE_TEMPLATE", () => {
  it("has 6 gates keyed G.1..G.6, all open", () => {
    expect(GATE_TEMPLATE).toHaveLength(6);
    expect(GATE_TEMPLATE.map((g) => g.key)).toEqual(["G.1", "G.2", "G.3", "G.4", "G.5", "G.6"]);
    expect(GATE_TEMPLATE.every((g) => g.status === "open")).toBe(true);
    expect(GATE_TEMPLATE.every((g) => g.evidence_url === null)).toBe(true);
  });
});

describe("listUsers", () => {
  it("falls back to members mapped to users with empty roles when /users is 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/users")) {
          return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
        }
        if (String(url).includes("/members")) {
          return new Response(
            JSON.stringify([{ user_id: "u1", name: "Ada", email: "ada@example.com", title: "Eng" }]),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
      }),
    );
    const users = await listUsers("u1", "t1");
    expect(users).toEqual([
      { id: "u1", name: "Ada", email: "ada@example.com", title: "Eng", status: "active", roles: [] },
    ]);
  });

  it("re-throws a 403 (not authorized) instead of falling back to members", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })),
    );
    await expect(listUsers("u1", "t1")).rejects.toBeInstanceOf(PlatformError);
    await expect(listUsers("u1", "t1")).rejects.toMatchObject({ status: 403 });
  });
});

describe("listRoles", () => {
  it("falls back to [] when /roles is 404", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "not found" }), { status: 404 })));
    expect(await listRoles("u1")).toEqual([]);
  });

  it("re-throws a 403 (not authorized) instead of swallowing to []", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })),
    );
    await expect(listRoles("u1")).rejects.toBeInstanceOf(PlatformError);
    await expect(listRoles("u1")).rejects.toMatchObject({ status: 403 });
  });
});

describe("applyAuditFilters", () => {
  const rows: AuditEntry[] = [
    {
      id: "1",
      actor_id: "u1",
      actor_name: "Ada",
      verb: "create",
      target_entity_type: "project",
      target_entity_id: "p1",
      occurred_at: "2026-07-01T00:00:00Z",
    },
    {
      id: "2",
      actor_id: "u2",
      actor_name: "Bob",
      verb: "update",
      target_entity_type: "task",
      target_entity_id: "t1",
      occurred_at: "2026-07-04T00:00:00Z",
    },
  ];

  it("filters by verb", () => {
    expect(applyAuditFilters(rows, { verb: "update" }).map((r) => r.id)).toEqual(["2"]);
  });

  it("filters by since (inclusive lower bound)", () => {
    expect(applyAuditFilters(rows, { since: "2026-07-02T00:00:00Z" }).map((r) => r.id)).toEqual(["2"]);
  });

  it("returns all rows when no filters given", () => {
    expect(applyAuditFilters(rows, {})).toHaveLength(2);
  });
});
