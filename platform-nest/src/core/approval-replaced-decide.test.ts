// SCP-3g (PERMISSION-CONTRACT §53.12) — the registry side of listing and opening the rows an entry's approverCheck lets a caller
// decide (approval-replaced-decide.ts), pure: no database, no Cerbos. The routes are proven on real Postgres and Cerbos in
// scp-3g-approvals-read.db.test.ts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PoolClient } from "pg";
import { registerModule, resetModules } from "../modules/registry";
import { socialModule } from "../modules/social";
import { listExecutableApprovals, registerAllExecutableApprovals, resetExecutableApprovals } from "./approval-executables";
import { replacedDecidableIds, replacedDecideCandidates, replacedDecideTools } from "./approval-replaced-decide";
import type { Principal } from "../rbac/principal";

/** A client that fails the test if anything queries it: the paths below must not reach the database. */
const noQueries = { query: async () => { throw new Error("no query expected"); } } as unknown as PoolClient;
const someone = { userId: "11111111-1111-4111-8111-111111111111", assurance: "linked" } as unknown as Principal;

describe("SCP-3g · the replaced-decide read helpers (pure)", () => {
  beforeAll(() => {
    resetModules();
    registerModule(socialModule);
    resetExecutableApprovals();
    registerAllExecutableApprovals();
  });
  afterAll(() => resetModules());

  it("🔴 every entry whose approverCheck replaces the generic decide right also answers the batched read question", () => {
    // Without the batched form a row would be decidable by id and invisible in /approvals: the gap SCP-3g closes.
    const replacing = listExecutableApprovals().filter((e) => e.approverCheck?.replacesDecide === true);
    expect(replacing.length).toBeGreaterThan(0);
    for (const e of replacing) expect(typeof e.approverCheck?.replacedDecideAllowedMany, e.toolName).toBe("function");
    expect(replacedDecideTools()).toEqual(replacing.map((e) => e.toolName).sort());
  });

  it("the tools are exactly the social publish tools registered as executable (today social.publishPost)", () => {
    expect(replacedDecideTools()).toContain("social.publishPost");
    for (const t of replacedDecideTools()) expect(t.startsWith("social.publishPost"), t).toBe(true);
  });

  it("rows of another origin or tool, and a principal with no user id, are answered without a query", async () => {
    const rows = [
      { id: "a", origin: "hr", tool_name: "social.publishPost", tool_args: { variantId: "x" } },
      { id: "b", origin: "webdesk", tool_name: "social.publishPost", tool_args: {} },
      { id: "c", origin: "agent", tool_name: "invoices.issue", tool_args: {} },
      { id: "d", origin: "automation", tool_name: "deploy.production", tool_args: {} },
    ];
    expect([...(await replacedDecidableIds(noQueries, someone, rows))]).toEqual([]);
    const anonymous = { assurance: "linked" } as unknown as Principal;
    const publish = [{ id: "e", origin: "agent", tool_name: "social.publishPost", tool_args: { variantId: "x" } }];
    expect([...(await replacedDecidableIds(noQueries, anonymous, publish))]).toEqual([]);
  });

  it("the candidate read skips the query when no origin qualifies or no status is asked", async () => {
    expect(await replacedDecideCandidates(noQueries, { origins: ["hr", "webdesk", "github"], statuses: ["pending"] })).toEqual([]);
    expect(await replacedDecideCandidates(noQueries, { origins: ["agent"], statuses: [] })).toEqual([]);
  });
});
