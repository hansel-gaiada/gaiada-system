// ASST-19 — the quarantine gate, asserted at the LEVEL THAT MATTERS: the assembled context
// itself, never the UI. A UI-level assertion would pass even if the prompt still carried a
// deleted or unconfirmed fact — these two tests are the blueprint's Phase-4 gate and its negative
// counterpart, both proven directly against `assembleContext`'s output string.
//
// Ticket: docs/superpowers/plans/2026-08-05-d14-and-assistant-tickets.md ("### ASST-19").
// Design: docs/blueprints/assistant-foundation.md §4.1 ("four memories" — user memory is #2 of 4,
// its writes are proposals, and only a CONFIRMED row becomes trusted).
//
// No memory ENDPOINTS exist yet (that is the next increment) — this file drives `assistant_memory`
// directly via SQL, which is exactly what a future propose/confirm/delete endpoint will do under
// the hood, so these two assertions hold regardless of how that surface is eventually shaped.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { config } from "../../config";
import { withTenants, newId } from "../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership } from "../../testing/fixtures";
import { assembleContext } from "./context";

describe.skipIf(!TEST_URL)("Assistant memory quarantine (ASST-19, context-level)", () => {
  let A: string;
  let owner: string;

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("Assistant Memory Quarantine Tenant", ["assistant"]);
    owner = await createUser("owner@asst-memory-ctx.test");
    await addMembership(A, owner);
  });
  afterAll(async () => {
    await teardownTestDb();
  });

  async function assemble(threadId: string): Promise<string> {
    const { prompt } = await withTenants(
      [A],
      (c) => assembleContext(c, threadId, { ownerUserId: owner, compactionSummary: null, compactionSummaryUptoSeq: null }, 1),
      { modules: ["assistant"] },
    );
    return prompt;
  }

  it("the blueprint's Phase-4 gate: deleting a memory removes it from the NEXT assembled context", async () => {
    const threadId = newId();
    const memoryId = newId();
    await withTenants(
      [A],
      (c) =>
        c.query(
          `INSERT INTO assistant_memory (id, tenant_id, owner_user_id, content, confirmed_at, origin_site)
           VALUES ($1, $2, $3, 'THE_SECRET_FACT: prefers dark mode', now(), $4)`,
          [memoryId, A, owner, config.originSite],
        ),
      { modules: ["assistant"] },
    );

    const before = await assemble(threadId);
    expect(before).toContain("THE_SECRET_FACT: prefers dark mode");

    await withTenants([A], (c) => c.query(`DELETE FROM assistant_memory WHERE id = $1`, [memoryId]), { modules: ["assistant"] });

    const after = await assemble(threadId);
    expect(after).not.toContain("THE_SECRET_FACT");
  });

  it("the negative: an UNCONFIRMED row never appears in an assembled prompt, until it is confirmed", async () => {
    const threadId = newId();
    const memoryId = newId();
    await withTenants(
      [A],
      (c) =>
        c.query(
          `INSERT INTO assistant_memory (id, tenant_id, owner_user_id, content, confirmed_at, origin_site)
           VALUES ($1, $2, $3, 'UNCONFIRMED_GUESS: might be in the Jakarta office', NULL, $4)`,
          [memoryId, A, owner, config.originSite],
        ),
      { modules: ["assistant"] },
    );

    const whileUnconfirmed = await assemble(threadId);
    expect(whileUnconfirmed).not.toContain("UNCONFIRMED_GUESS");

    await withTenants(
      [A],
      (c) => c.query(`UPDATE assistant_memory SET confirmed_at = now() WHERE id = $1`, [memoryId]),
      { modules: ["assistant"] },
    );

    const afterConfirm = await assemble(threadId);
    expect(afterConfirm).toContain("UNCONFIRMED_GUESS: might be in the Jakarta office");
  });
});
