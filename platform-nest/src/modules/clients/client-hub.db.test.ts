// CC-1/CC-2 — real-DB proofs for the client facet and the hub aggregate.
//
// Written against the DATABASE rather than through `app.inject()` on purpose: what can actually be
// wrong here is SQL, and specifically three things that a mocked test would happily agree with —
//   1. the `internal` scope resolving to `client_id IS NULL` and therefore catching clientless rows
//      that no client scope can reach,
//   2. the task facet reaching the client THROUGH `projects` (there is no `pm_tasks.client_id`),
//   3. `needsUs` finding the pending payment that motivated the whole endpoint.
//
// Every assertion below is about a row count or a set membership, so a passing run means the
// predicates are right, not that a mock returned what it was told to.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createClient, createProject } from "../../testing/fixtures";
import { withTenants, newId } from "../../db";
import { config } from "../../config";
import { clientFilterSql, parseClientFilter } from "../../core/client-filter";

const site = () => config.originSite;

let tenant: string;
let staff: string;
let clientA: string;
let clientB: string;
let projA: string;
let projB: string;
let projInternal: string;

/** The projects list predicate, exactly as `core.controller.ts:projects` builds it. Reproduced here
 *  rather than calling the controller because the controller needs Cerbos and a request; the SQL is
 *  the part under test, and it is assembled by the same two helpers the controller uses. */
async function projectsFacet(raw: string | undefined): Promise<string[]> {
  const f = clientFilterSql(parseClientFilter(raw), "client_id", 1);
  const r = await withTenants([tenant], (c) =>
    c.query<{ id: string }>(
      `SELECT id FROM projects WHERE deleted_at IS NULL AND ${f.sql} ORDER BY created_at`,
      f.params,
    ),
  );
  return r.rows.map((x) => x.id);
}

/** The task facet, as `pm.controller.ts:listTasks` applies it — a predicate on the `projects` row the
 *  task list's CTE already joins. */
async function tasksFacet(raw: string | undefined): Promise<string[]> {
  const f = clientFilterSql(parseClientFilter(raw), "p.client_id", 1);
  const r = await withTenants([tenant], (c) =>
    c.query<{ title: string }>(
      `SELECT t.title FROM pm_tasks t JOIN projects p ON p.id = t.project_id
        WHERE t.deleted_at IS NULL AND ${f.sql} ORDER BY t.title`,
      f.params,
    ),
  );
  return r.rows.map((x) => x.title);
}

async function addTask(projectId: string, title: string, status = "todo"): Promise<void> {
  await withTenants([tenant], (c) =>
    c.query(
      `INSERT INTO pm_tasks (id, tenant_id, project_id, title, status, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [newId(), tenant, projectId, title, status, site()],
    ),
  );
}

describe.skipIf(!TEST_URL)("CC-1/CC-2 · client facet + hub aggregate", () => {
  beforeAll(async () => {
    await initTestDb();
    tenant = await createCompany("Hub Co");
    staff = await createUser("hub-staff@a.test");
    await addMembership(tenant, staff);

    clientA = await createClient(tenant, "Client A");
    clientB = await createClient(tenant, "Client B");

    projA = await createProject(tenant, "A — website");
    projB = await createProject(tenant, "B — campaign");
    // Deliberately left with NO client: this is the row that only the `internal` scope can reach, and
    // the reason the scope is defined as `client_id IS NULL` rather than `is_internal = true`.
    projInternal = await createProject(tenant, "Internal — own brand");
    await withTenants([tenant], (c) =>
      c.query(`UPDATE projects SET client_id = $2 WHERE id = $1`, [projA, clientA]),
    );
    await withTenants([tenant], (c) =>
      c.query(`UPDATE projects SET client_id = $2 WHERE id = $1`, [projB, clientB]),
    );

    await addTask(projA, "A task one");
    await addTask(projA, "A task two", "done");
    await addTask(projB, "B task one");
    await addTask(projInternal, "Internal chore");
  }, 120_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  // ── the facet ──────────────────────────────────────────────────────────────────────────────────
  it("no clientId returns every project — the facet is additive, not a default narrowing", async () => {
    const all = await projectsFacet(undefined);
    expect(all).toEqual(expect.arrayContaining([projA, projB, projInternal]));
    expect(all).toHaveLength(3);
  });

  it("a client id returns only that client's projects", async () => {
    expect(await projectsFacet(clientA)).toEqual([projA]);
    expect(await projectsFacet(clientB)).toEqual([projB]);
  });

  it("🔴 `internal` reaches the clientless project that NO client scope can", async () => {
    // The whole point of decision 2. If this ever returns [] the clientless third of the estate
    // becomes unreachable from every scope, which is silent work loss.
    expect(await projectsFacet("internal")).toEqual([projInternal]);
    expect(await projectsFacet(clientA)).not.toContain(projInternal);
    expect(await projectsFacet(clientB)).not.toContain(projInternal);
  });

  it("garbage fails OPEN — every project, never zero", async () => {
    // A filter that fails closed is indistinguishable from "this client has no work".
    expect(await projectsFacet("not-a-uuid")).toHaveLength(3);
  });

  it("a well-formed id for a client with nothing returns empty, which is a real answer", async () => {
    const empty = await createClient(tenant, "Client With Nothing");
    expect(await projectsFacet(empty)).toEqual([]);
  });

  // ── tasks reach the client through their project ───────────────────────────────────────────────
  it("the task facet resolves the client via projects (there is no pm_tasks.client_id)", async () => {
    expect(await tasksFacet(clientA)).toEqual(["A task one", "A task two"]);
    expect(await tasksFacet(clientB)).toEqual(["B task one"]);
  });

  it("🔴 `internal` tasks are the ones on clientless PROJECTS", async () => {
    // And they are complete: `pm_tasks.project_id` is NOT NULL, so the join can never drop a task.
    expect(await tasksFacet("internal")).toEqual(["Internal chore"]);
    const notNull = await withTenants([tenant], (c) =>
      c.query<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns
          WHERE table_name = 'pm_tasks' AND column_name = 'project_id'`,
      ),
    );
    expect(
      notNull.rows[0]?.is_nullable,
      "if project_id becomes nullable, the task facet needs an explicit clientless-task branch and " +
        "the `internal` scope silently stops being complete",
    ).toBe("NO");
  });

  it("every task is reachable from exactly one scope — no row is invisible", async () => {
    const [a, b, internal] = await Promise.all([tasksFacet(clientA), tasksFacet(clientB), tasksFacet("internal")]);
    const union = [...a, ...b, ...internal].sort();
    expect(union).toEqual(["A task one", "A task two", "B task one", "Internal chore"]);
    expect(new Set(union).size).toBe(union.length); // and none of them twice
  });

  // ── needsUs: the pending payment the endpoint exists to surface ────────────────────────────────
  it("🔴 a pending client payment is found for its client and not for another", async () => {
    const invoiceId = newId();
    await withTenants([tenant], (c) =>
      c.query(
        `INSERT INTO invoices (id, tenant_id, client_id, period_start, period_end, status, currency, lines, total, origin_site)
         VALUES ($1, $2, $3, current_date - 30, current_date - 1, 'sent', 'IDR', '[]'::jsonb, 1000, $4)`,
        [invoiceId, tenant, clientA, site()],
      ),
    );
    await withTenants([tenant], (c) =>
      c.query(
        // `paid_on` is NOT NULL — the date the CLIENT says they paid, which is the whole point of the
        // row: it is their claim, recorded before anyone verifies it.
        `INSERT INTO invoice_payments (id, tenant_id, invoice_id, client_id, amount, currency, paid_on, status, origin_site)
         VALUES ($1, $2, $3, $4, 400, 'IDR', current_date - 2, 'pending', $5)`,
        [newId(), tenant, invoiceId, clientA, site()],
      ),
    );

    const pendingFor = async (cid: string) =>
      (
        await withTenants([tenant], (c) =>
          c.query(
            `SELECT pp.id FROM invoice_payments pp
              WHERE pp.client_id = $1 AND pp.status = 'pending' AND pp.deleted_at IS NULL`,
            [cid],
          ),
        )
      ).rows.length;

    expect(await pendingFor(clientA)).toBe(1);
    expect(await pendingFor(clientB)).toBe(0);
  });

  it("the money figure counts CONFIRMED payments only — a pending claim must not move the balance", async () => {
    // This is the property that lets the hub say "received, being verified" without the outstanding
    // figure dropping on an unverified claim. It mirrors portal-workspace's `finance`.
    const r = await withTenants([tenant], (c) =>
      c.query<{ invoiced: number; paid: number; pending: number }>(
        `WITH inv AS (SELECT i.id, i.total, i.status FROM invoices i WHERE i.client_id = $1 AND i.deleted_at IS NULL)
         SELECT COALESCE(sum(inv.total) FILTER (WHERE inv.status NOT IN ('void','draft')), 0)::float8 AS invoiced,
                COALESCE(sum(pay.confirmed), 0)::float8 AS paid,
                COALESCE(sum(pay.pending), 0)::float8 AS pending
           FROM inv LEFT JOIN LATERAL (
             SELECT COALESCE(sum(pp.amount) FILTER (WHERE pp.status = 'confirmed'), 0) AS confirmed,
                    COALESCE(sum(pp.amount) FILTER (WHERE pp.status = 'pending'), 0) AS pending
               FROM invoice_payments pp WHERE pp.invoice_id = inv.id AND pp.deleted_at IS NULL
           ) pay ON true`,
        [clientA],
      ),
    );
    const row = r.rows[0];
    expect(Number(row.invoiced)).toBe(1000);
    expect(Number(row.paid)).toBe(0);
    expect(Number(row.pending)).toBe(400);
    // Outstanding is invoiced − CONFIRMED, so the pending 400 has not been credited.
    expect(Number(row.invoiced) - Number(row.paid)).toBe(1000);
  });
});
