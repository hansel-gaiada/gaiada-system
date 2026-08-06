// ASST-24 QA GATE — adversarial re-proof of ASST-19 (memory quarantine), assembled against the
// live test Postgres + Cerbos. Does NOT modify production code.
//
// Design claim under test (context.ts's header): "only confirmed_at IS NOT NULL rows reach an
// assembled prompt." Every assertion below reads `assembleContext`'s returned `prompt` STRING
// directly — never a GET/list endpoint's client-facing shape — so a leak at any other layer
// (UI rendering, a future list endpoint) cannot mask a real leak here.
//
// This file is intentionally separate from context-memory.test.ts (which already proves the
// delete-removes-it and unconfirmed-then-confirmed transitions) — it adds three specific gate
// checks the QA ticket calls out by number:
//   (a) ONE assembly call, two rows (confirmed + unconfirmed, distinct markers) — both asserted
//       in the SAME prompt string, not two separate assemblies.
//   (b) propose -> confirm through the REAL HTTP confirm endpoint (not a raw UPDATE), then a
//       fresh assembly.
//   (c) scope isolation — a CONFIRMED memory owned by a DIFFERENT user (same company, and also a
//       different company entirely) must never appear in THIS user's assembled prompt.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { withTenants, newId } from "../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership } from "../../testing/fixtures";
import { registerModule, resetModules } from "../registry";
import { assistantModule } from "./index";
import { assembleContext } from "./context";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("ASST-24 QA gate / ASST-19 adversarial: memory quarantine at the assembled-context level", () => {
  let app: NestFastifyApplication;
  let A: string;
  let B: string;
  let owner: string;
  let sameCompanyOther: string;
  let otherCompanyUser: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    registerModule(assistantModule);

    A = await createCompany("ASST19-QA Tenant A", ["assistant"]);
    B = await createCompany("ASST19-QA Tenant B", ["assistant"]);
    owner = await createUser("qa19-owner@asst19qa.test");
    sameCompanyOther = await createUser("qa19-samecompany-other@asst19qa.test");
    otherCompanyUser = await createUser("qa19-othercompany@asst19qa.test");
    await addMembership(A, owner);
    await addMembership(A, sameCompanyOther);
    await addMembership(B, otherCompanyUser);

    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  async function assemble(tenant: string, ownerUserId: string, threadId: string): Promise<string> {
    const { prompt } = await withTenants(
      [tenant],
      (c) => assembleContext(c, threadId, { ownerUserId, compactionSummary: null, compactionSummaryUptoSeq: null }, 1),
      { modules: ["assistant"] },
    );
    return prompt;
  }

  async function insertMemory(tenant: string, ownerUserId: string, content: string, confirmed: boolean): Promise<string> {
    const id = newId();
    await withTenants(
      [tenant],
      (c) =>
        c.query(
          `INSERT INTO assistant_memory (id, tenant_id, owner_user_id, content, confirmed_at, origin_site)
           VALUES ($1, $2, $3, $4, ${confirmed ? "now()" : "NULL"}, $5)`,
          [id, tenant, ownerUserId, content, config.originSite],
        ),
      { modules: ["assistant"] },
    );
    return id;
  }

  it("(a) confirmed marker IS present and unconfirmed marker is ABSENT in ONE assembled prompt (both rows, same owner/thread scope)", async () => {
    const threadId = newId();
    await insertMemory(A, owner, "MARKER_CONFIRMED_7f3a91: this fact IS trusted", true);
    await insertMemory(A, owner, "MARKER_UNCONFIRMED_9c1bd2: this fact is NOT trusted", false);

    const prompt = await assemble(A, owner, threadId);
    expect(prompt).toContain("MARKER_CONFIRMED_7f3a91: this fact IS trusted");
    expect(prompt).not.toContain("MARKER_UNCONFIRMED_9c1bd2");
    expect(prompt).not.toContain("this fact is NOT trusted");
  });

  it("(b) propose -> confirm via the REAL confirm endpoint (not a raw UPDATE): absent before, present in a FRESH assembly after", async () => {
    const created = await app.inject({
      method: "POST", url: `/api/${A}/assistant/threads`, headers: asUser(owner), payload: { title: "asst19-qa-b thread" },
    });
    expect(created.statusCode).toBe(201);
    const threadId = (created.json() as { id: string }).id;

    const propose = await app.inject({
      method: "POST", url: `/api/${A}/assistant/memory`, headers: asUser(owner),
      payload: { content: "MARKER_PROPOSED_44de17: prefers Slack over email" },
    });
    expect(propose.statusCode).toBe(201);
    const memoryId = (propose.json() as { id: string }).id;

    const before = await assemble(A, owner, threadId);
    expect(before).not.toContain("MARKER_PROPOSED_44de17");

    const confirm = await app.inject({
      method: "POST", url: `/api/${A}/assistant/memory/${memoryId}/confirm`, headers: asUser(owner), payload: {},
    });
    expect(confirm.statusCode).toBe(200);

    const after = await assemble(A, owner, threadId);
    expect(after).toContain("MARKER_PROPOSED_44de17: prefers Slack over email");
  });

  it("(c) scope isolation — a CONFIRMED memory owned by a DIFFERENT user in the SAME company never leaks into this user's assembled prompt", async () => {
    await insertMemory(A, sameCompanyOther, "MARKER_SAMECOMPANY_OTHERUSER_b19a: this belongs to a different user", true);

    const threadId = newId();
    const prompt = await assemble(A, owner, threadId);
    expect(prompt).not.toContain("MARKER_SAMECOMPANY_OTHERUSER_b19a");
  });

  it("(c) scope isolation — a CONFIRMED memory owned by a user in a DIFFERENT COMPANY never leaks into this user's assembled prompt", async () => {
    await insertMemory(B, otherCompanyUser, "MARKER_OTHERCOMPANY_SECRET_ee42: belongs to tenant B entirely", true);

    const threadId = newId();
    const prompt = await assemble(A, owner, threadId);
    expect(prompt).not.toContain("MARKER_OTHERCOMPANY_SECRET_ee42");
  });
});
