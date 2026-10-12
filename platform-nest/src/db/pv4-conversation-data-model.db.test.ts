// PV4-01 — migration 202610122330_pv4_conversation_data_model.sql, proven against a REAL Postgres.
// Plan: docs/plans/2026-10-12-pv4-conversation-tickets.md (PV4-01).
//
// Everything runs as the NOSUPERUSER NOBYPASSRLS app role (the harness repoints the app pool at it),
// except `adminPool()`, used ONLY to read ground truth past RLS and to re-home a seeded project.
// Needs DATABASE_URL_TEST (a superuser URL to a disposable Postgres): the Linux gate. Skips without it,
// and a skipped run proves nothing.
import type { PoolClient } from "pg";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withGlobal, withTenants, newId } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, createClient, createProject } from "../testing/fixtures";

describe.skipIf(!TEST_URL)("PV4-01 — conversation / amendment / minutes data model", () => {
  let A: string; // tenant A
  let B: string; // tenant B
  let user: string;
  let agent: string;
  let clientA1: string;
  let clientA2: string;
  let clientB1: string;
  let projA1: string; // belongs to clientA1
  let projA2: string; // belongs to clientA2
  let projInternal: string; // client_id NULL
  let seq = 0;

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("PV4 Tenant A");
    B = await createCompany("PV4 Tenant B");
    user = await createUser("pv4-user@schema.test");
    agent = await createUser("pv4-agent@schema.test");
    clientA1 = await createClient(A, "PV4 Client A1");
    clientA2 = await createClient(A, "PV4 Client A2");
    clientB1 = await createClient(B, "PV4 Client B1");
    projA1 = await createProject(A, "PV4 Project A1");
    projA2 = await createProject(A, "PV4 Project A2");
    projInternal = await createProject(A, "PV4 Internal Project");
    await adminPool().query(`UPDATE projects SET client_id = $1 WHERE id = $2`, [clientA1, projA1]);
    await adminPool().query(`UPDATE projects SET client_id = $1 WHERE id = $2`, [clientA2, projA2]);
  }, 120_000);
  afterAll(teardownTestDb);

  // ── helpers ─────────────────────────────────────────────────────────────────────────────────────
  const insert = async (c: PoolClient, table: string, row: Record<string, unknown>) => {
    const names = Object.keys(row);
    await c.query(
      `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
      names.map((n) => row[n]),
    );
  };
  async function thread(tenant: string, client: string, cols: Record<string, unknown> = {}): Promise<string> {
    const id = newId();
    await withTenants([tenant], (c) =>
      insert(c, "conversation_threads", {
        id, tenant_id: tenant, client_id: client, project_id: null, created_by: user, created_side: "staff",
        origin_site: "test", ...cols,
      }),
    );
    return id;
  }
  async function message(tenant: string, threadId: string, cols: Record<string, unknown> = {}): Promise<string> {
    const id = newId();
    await withTenants([tenant], (c) =>
      insert(c, "conversation_messages", {
        id, tenant_id: tenant, thread_id: threadId, author_id: user, author_side: "staff", body: `hello ${++seq}`,
        origin_site: "test", ...cols,
      }),
    );
    return id;
  }
  async function draft(tenant: string, threadId: string, cols: Record<string, unknown> = {}): Promise<string> {
    const id = newId();
    await withTenants([tenant], (c) =>
      insert(c, "conversation_drafts", {
        id, tenant_id: tenant, thread_id: threadId, body: "draft", drafted_by: agent, idempotency_key: `k-${id}`, ...cols,
      }),
    );
    return id;
  }
  const insertContract = (c: PoolClient, tenant: string, client: string, cols: Record<string, unknown> = {}) =>
    insert(c, "contracts", { id: newId(), tenant_id: tenant, client_id: client, title: `C ${++seq}`, origin_site: "test", ...cols });
  const insertCr = (c: PoolClient, tenant: string, client: string | null, cols: Record<string, unknown> = {}) =>
    insert(c, "webdev_change_requests", {
      id: newId(), tenant_id: tenant, client_id: client, source: "internal", kind: "feature", title: `CR ${++seq}`,
      origin_site: "test", ...cols,
    });

  // ── RLS ─────────────────────────────────────────────────────────────────────────────────────────
  describe("RLS", () => {
    const TABLES = ["conversation_threads", "conversation_messages", "conversation_drafts", "conversation_reads", "meeting_minutes"];

    it("every new table has RLS enabled AND forced, with the tenant_isolation policy", async () => {
      for (const t of TABLES) {
        const rls = await adminPool().query<{ on: boolean; forced: boolean }>(
          `SELECT relrowsecurity AS on, relforcerowsecurity AS forced FROM pg_class WHERE oid = $1::regclass`, [t],
        );
        expect(rls.rows[0], t).toEqual({ on: true, forced: true });
        const pol = await adminPool().query(`SELECT 1 FROM pg_policies WHERE tablename = $1 AND policyname = 'tenant_isolation'`, [t]);
        expect(pol.rowCount, t).toBe(1);
      }
    });

    it("an UNSET tenant GUC reads ZERO rows from every new table (the RLS zero-row trap, on purpose), while rows exist", async () => {
      const rlsClient = await createClient(A, "PV4 RLS Client");
      const th = await thread(A, rlsClient);
      const msg = await message(A, th);
      await draft(A, th);
      await withTenants([A], async (c) => {
        await insert(c, "conversation_reads", { tenant_id: A, thread_id: th, user_id: user });
        const rec = newId();
        await insert(c, "meeting_recordings", { id: rec, tenant_id: A, meeting_id: `m-${rec}`, origin_site: "test" });
        await insert(c, "meeting_minutes", { id: newId(), tenant_id: A, meeting_recording_id: rec });
      });
      expect(msg).toBeTruthy();
      for (const t of TABLES) {
        const truth = await adminPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`);
        expect(truth.rows[0].n, `${t}: ground truth has rows`).toBeGreaterThan(0);
        const unset = await withGlobal((c) => c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`));
        expect(unset.rows[0].n, `${t}: unset GUC`).toBe(0);
        const other = await withTenants([B], (c) => c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`));
        expect(other.rows[0].n, `${t}: other tenant`).toBe(0);
      }
    });

    it("a write for another tenant is refused by the policy's WITH CHECK", async () => {
      await expect(
        withTenants([B], (c) =>
          insert(c, "conversation_threads", {
            id: newId(), tenant_id: A, client_id: clientA1, created_by: user, created_side: "staff", origin_site: "test",
          }),
        ),
      ).rejects.toThrow(/row-level security/);
    });
  });

  // ── threads ─────────────────────────────────────────────────────────────────────────────────────
  describe("conversation_threads", () => {
    it("a second live client-wide thread for the same client fails (partial unique, PV-D22)", async () => {
      const first = await thread(A, clientA2);
      expect(first).toBeTruthy();
      await expect(thread(A, clientA2)).rejects.toThrow(/ux_conv_threads_client_wide/);
    });

    it("the partial unique does not block a different client, a project thread, or a replacement after soft delete", async () => {
      // Another client: its own client-wide thread is fine.
      const c3 = await createClient(A, "PV4 Client A3");
      await thread(A, c3);
      // Several project threads for one client (and alongside the client-wide thread) are fine.
      await thread(A, clientA1, { project_id: projA1 });
      await thread(A, clientA1, { project_id: projA1, subject: "second on same project" });
      // Soft-deleting the client-wide thread frees the slot.
      const first = await thread(A, clientA1);
      await expect(thread(A, clientA1)).rejects.toThrow(/ux_conv_threads_client_wide/);
      await withTenants([A], (c) => c.query(`UPDATE conversation_threads SET deleted_at = now() WHERE id = $1`, [first]));
      await expect(thread(A, clientA1)).resolves.toBeTruthy();
    });

    it("a project thread whose project belongs to ANOTHER client fails (composite FK)", async () => {
      await expect(thread(A, clientA1, { project_id: projA2 })).rejects.toThrow(/fk_conv_threads_project_client_tenant/);
    });

    it("an internal project (client_id NULL) cannot carry a thread", async () => {
      await expect(thread(A, clientA1, { project_id: projInternal })).rejects.toThrow(/fk_conv_threads_project_client_tenant/);
    });

    it("a thread cannot reach another tenant's client", async () => {
      await expect(thread(B, clientA1)).rejects.toThrow(/fk_conv_threads_client_tenant/);
      await expect(thread(A, clientB1)).rejects.toThrow(/fk_conv_threads_client_tenant/);
    });

    it("re-homing a project to another client is REFUSED while a thread references it", async () => {
      const proj = await createProject(A, "PV4 Rehome Project");
      await adminPool().query(`UPDATE projects SET client_id = $1 WHERE id = $2`, [clientA1, proj]);
      await thread(A, clientA1, { project_id: proj });
      await expect(
        adminPool().query(`UPDATE projects SET client_id = $1 WHERE id = $2`, [clientA2, proj]),
      ).rejects.toThrow(/fk_conv_threads_project_client_tenant/);
    });

    it("status and created_side are constrained", async () => {
      await expect(thread(A, clientA1, { project_id: projA1, status: "archived" })).rejects.toThrow(/check constraint/);
      await expect(thread(A, clientA1, { project_id: projA1, created_side: "bot" })).rejects.toThrow(/check constraint/);
    });
  });

  // ── messages ────────────────────────────────────────────────────────────────────────────────────
  describe("conversation_messages", () => {
    it("body is 1 to 10,000 characters", async () => {
      const th = await thread(A, clientA1, { project_id: projA1 });
      await expect(message(A, th, { body: "" })).rejects.toThrow(/conv_messages_body_length/);
      await expect(message(A, th, { body: "x".repeat(10001) })).rejects.toThrow(/conv_messages_body_length/);
      await expect(message(A, th, { body: "x".repeat(10000) })).resolves.toBeTruthy();
      await expect(message(A, th, { body: "x" })).resolves.toBeTruthy();
    });

    it("author_side is client or staff; a message cannot sit in another tenant's thread", async () => {
      const th = await thread(A, clientA1, { project_id: projA1 });
      await expect(message(A, th, { author_side: "agent" })).rejects.toThrow(/check constraint/);
      await expect(message(B, th)).rejects.toThrow(/fk_conv_messages_thread_tenant/);
    });

    it("there is no visibility column: every message is client-visible by definition", async () => {
      const cols = await adminPool().query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'conversation_messages'`,
      );
      const names = cols.rows.map((r) => r.column_name);
      expect(names).not.toContain("visibility");
      expect(names).not.toContain("client_visible");
      expect(names).not.toContain("status");
    });
  });

  // ── drafts ──────────────────────────────────────────────────────────────────────────────────────
  describe("conversation_drafts", () => {
    it("(tenant, idempotency_key) is unique", async () => {
      const th = await thread(A, clientA1, { project_id: projA1 });
      await draft(A, th, { idempotency_key: "same-key" });
      await expect(draft(A, th, { idempotency_key: "same-key" })).rejects.toThrow(/ux_conv_drafts_idempotency/);
    });

    it("a sent draft needs its message; a pending one must not have one; a decided draft names who and when", async () => {
      const th = await thread(A, clientA1, { project_id: projA1 });
      const msg = await message(A, th);
      await expect(draft(A, th, { status: "sent", decided_by: user, decided_at: new Date() })).rejects.toThrow(/conv_drafts_sent_has_message/);
      await expect(draft(A, th, { status: "pending", sent_message_id: msg })).rejects.toThrow(/conv_drafts_sent_has_message/);
      await expect(draft(A, th, { status: "discarded" })).rejects.toThrow(/conv_drafts_decided_has_actor/);
      await expect(draft(A, th, { status: "sent", sent_message_id: msg, decided_by: user, decided_at: new Date() })).resolves.toBeTruthy();
      // The same message cannot be the product of a second draft.
      await expect(
        draft(A, th, { status: "sent", sent_message_id: msg, decided_by: user, decided_at: new Date() }),
      ).rejects.toThrow(/ux_conv_drafts_sent_message/);
    });

    it("body length is constrained like a message", async () => {
      const th = await thread(A, clientA1, { project_id: projA1 });
      await expect(draft(A, th, { body: "" })).rejects.toThrow(/conv_drafts_body_length/);
    });
  });

  // ── reads ───────────────────────────────────────────────────────────────────────────────────────
  describe("conversation_reads", () => {
    it("primary key is (thread_id, user_id)", async () => {
      const th = await thread(A, clientA1, { project_id: projA1 });
      const put = () =>
        withTenants([A], (c) => insert(c, "conversation_reads", { tenant_id: A, thread_id: th, user_id: user }));
      await put();
      await expect(put()).rejects.toThrow(/conversation_reads_pkey/);
    });
  });

  // ── contracts: amendments ───────────────────────────────────────────────────────────────────────
  describe("contracts.kind / amends_id", () => {
    it("existing-shape rows default to kind = agreement", async () => {
      const id = newId();
      await withTenants([A], (c) => insertContract(c, A, clientA1, { id }));
      const r = await adminPool().query<{ kind: string; amends_id: string | null }>(`SELECT kind, amends_id FROM contracts WHERE id = $1`, [id]);
      expect(r.rows[0]).toEqual({ kind: "agreement", amends_id: null });
    });

    it("an amendment without amends_id fails", async () => {
      await expect(withTenants([A], (c) => insertContract(c, A, clientA1, { kind: "amendment" }))).rejects.toThrow(/contracts_amendment_amends/);
    });

    it("an amendment that names its agreement succeeds; one that names itself, or an unknown kind, fails", async () => {
      const base = newId();
      await withTenants([A], (c) => insertContract(c, A, clientA1, { id: base }));
      await expect(
        withTenants([A], (c) => insertContract(c, A, clientA1, { kind: "amendment", amends_id: base })),
      ).resolves.toBeUndefined();
      const selfId = newId();
      await expect(
        withTenants([A], (c) => insertContract(c, A, clientA1, { id: selfId, kind: "amendment", amends_id: selfId })),
      ).rejects.toThrow(/contracts_not_self_amending|fk_contracts_amends_tenant/);
      await expect(withTenants([A], (c) => insertContract(c, A, clientA1, { kind: "rider" }))).rejects.toThrow(/contracts_kind_check/);
    });

    it("amends_id cannot cross tenants", async () => {
      const baseB = newId();
      await withTenants([B], (c) => insertContract(c, B, clientB1, { id: baseB }));
      await expect(
        withTenants([A], (c) => insertContract(c, A, clientA1, { kind: "amendment", amends_id: baseB })),
      ).rejects.toThrow(/fk_contracts_amends_tenant/);
    });
  });

  // ── change requests ─────────────────────────────────────────────────────────────────────────────
  describe("webdev_change_requests price_impact / amendment link / source message", () => {
    it("price_impact defaults to unassessed and is constrained", async () => {
      const id = newId();
      await withTenants([A], (c) => insertCr(c, A, clientA1, { id }));
      const r = await adminPool().query<{ price_impact: string }>(`SELECT price_impact FROM webdev_change_requests WHERE id = $1`, [id]);
      expect(r.rows[0].price_impact).toBe("unassessed");
      await expect(withTenants([A], (c) => insertCr(c, A, clientA1, { price_impact: "maybe" }))).rejects.toThrow(/wcr_price_impact_check/);
      await expect(withTenants([A], (c) => insertCr(c, A, clientA1, { price_impact: "changes_price" }))).resolves.toBeUndefined();
    });

    it("source_message_id must be a message in the same tenant", async () => {
      const th = await thread(A, clientA1, { project_id: projA1 });
      const msg = await message(A, th);
      await expect(withTenants([A], (c) => insertCr(c, A, clientA1, { source_message_id: msg }))).resolves.toBeUndefined();
      await expect(withTenants([B], (c) => insertCr(c, B, clientB1, { source_message_id: msg }))).rejects.toThrow(/fk_wcr_source_message_tenant/);
    });
  });

  // ── the circular reference ──────────────────────────────────────────────────────────────────────
  describe("contracts <-> webdev_change_requests cycle (both FKs DEFERRABLE)", () => {
    it("one transaction can insert the amendment first, naming a change request that does not exist yet", async () => {
      const crId = newId();
      const amendId = newId();
      const baseId = newId();
      await withTenants([A], async (c) => {
        await insertContract(c, A, clientA1, { id: baseId });
        await insertContract(c, A, clientA1, { id: amendId, kind: "amendment", amends_id: baseId, change_request_id: crId });
        await insertCr(c, A, clientA1, { id: crId, price_impact: "changes_price", amendment_contract_id: amendId });
      });
      const r = await adminPool().query(
        `SELECT (SELECT change_request_id FROM contracts WHERE id = $1) AS cr, (SELECT amendment_contract_id FROM webdev_change_requests WHERE id = $2) AS am`,
        [amendId, crId],
      );
      expect(r.rows[0]).toEqual({ cr: crId, am: amendId });
    });

    it("and the other way round: change request first, pointing at an amendment inserted afterwards", async () => {
      const crId = newId();
      const amendId = newId();
      const baseId = newId();
      await withTenants([A], async (c) => {
        await insertContract(c, A, clientA1, { id: baseId });
        await insertCr(c, A, clientA1, { id: crId, amendment_contract_id: amendId });
        await insertContract(c, A, clientA1, { id: amendId, kind: "amendment", amends_id: baseId, change_request_id: crId });
      });
    });

    it("deferral does not weaken integrity: a dangling half fails at COMMIT, in both directions", async () => {
      await expect(
        withTenants([A], (c) => insertCr(c, A, clientA1, { amendment_contract_id: newId() })),
      ).rejects.toThrow(/fk_wcr_amendment_contract_tenant/);
      await expect(
        withTenants([A], (c) => insertContract(c, A, clientA1, { change_request_id: newId() })),
      ).rejects.toThrow(/fk_contracts_change_request_tenant/);
    });

    it("cross-tenant links are refused", async () => {
      const crB = newId();
      await withTenants([B], (c) => insertCr(c, B, clientB1, { id: crB }));
      await expect(
        withTenants([A], (c) => insertContract(c, A, clientA1, { change_request_id: crB })),
      ).rejects.toThrow(/fk_contracts_change_request_tenant/);
    });
  });

  // ── meeting_minutes ─────────────────────────────────────────────────────────────────────────────
  describe("meeting_minutes", () => {
    async function recording(tenant: string): Promise<string> {
      const id = newId();
      await withTenants([tenant], (c) => insert(c, "meeting_recordings", { id, tenant_id: tenant, meeting_id: `m-${id}`, origin_site: "test" }));
      return id;
    }
    const minutes = (tenant: string, rec: string, cols: Record<string, unknown> = {}) =>
      withTenants([tenant], (c) => insert(c, "meeting_minutes", { id: newId(), tenant_id: tenant, meeting_recording_id: rec, ...cols }));

    it("one minutes row per meeting recording", async () => {
      const rec = await recording(A);
      await minutes(A, rec);
      await expect(minutes(A, rec)).rejects.toThrow(/ux_meeting_minutes_recording/);
    });

    it("a recording from another tenant is refused", async () => {
      const recB = await recording(B);
      await expect(minutes(A, recB)).rejects.toThrow(/fk_meeting_minutes_recording_tenant/);
    });

    it("shared needs shared_at and shared_by; a draft carries neither", async () => {
      const r1 = await recording(A);
      await expect(minutes(A, r1, { status: "shared" })).rejects.toThrow(/meeting_minutes_share_stamp/);
      await expect(minutes(A, r1, { status: "draft", shared_at: new Date(), shared_by: user })).rejects.toThrow(/meeting_minutes_share_stamp/);
      await expect(minutes(A, r1, { status: "shared", shared_at: new Date(), shared_by: user })).resolves.toBeUndefined();
    });

    it("has no client_id / project_id copy (decision 8)", async () => {
      const cols = await adminPool().query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'meeting_minutes'`,
      );
      const names = cols.rows.map((r) => r.column_name);
      expect(names).not.toContain("client_id");
      expect(names).not.toContain("project_id");
    });
  });
});
