// TR-27 — the seal-flow integration half of the AI narrative (narrative.test.ts covers the pure
// prompt-build/parse/guard contract with no database at all). This file drives the REAL
// `sealPeriod` (report-seal.ts) against live Postgres and asserts the three acceptance criteria
// that can only be proven end-to-end:
//   1. gateway outage (unconfigured, the default in this test env — GATEWAY_URL is unset) ->
//      every sealed document still gets a usable deterministic narrative; sealing never throws.
//   2. a clean AI completion (fetchImpl mocked, no real network) -> narrative.source === "ai".
//   3. THE SHARPEST BAR: a "successful" (HTTP 200) completion carrying a hallucinated numeral ->
//      still downgrades to the deterministic fallback, against the REAL seal flow, not just the
//      pure parser in narrative.test.ts.
// `gatewayOpts` (sealPeriod's 4th, test-only param) injects `fetchImpl` so no real network call
// ever happens here — same technique providers/gateway-client.ts's own tests use for `fetchImpl`.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { config } from "../../config";
import { newId, withTenants } from "../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { addMembership, createCompany, createProject, createUser } from "../../testing/fixtures";
import { syncMetricDefinitions } from "../../rollups/engine";
import { ensureCalendarPeriodRows } from "./report-periods";
import { sealPeriod } from "./report-seal";
import type { ReportDocument } from "./report-document";

const ORG_BLOB = {
  root: {
    id: "co-root",
    kind: "company",
    name: "TR-27 Co",
    children: [{ id: "d-eng", kind: "department", name: "Engineering", children: [] }],
  },
};

describe.skipIf(!TEST_URL)("TR-27 AI narrative — sealPeriod integration (live PG)", () => {
  let co: string;
  let alice: string;
  let projectId: string;

  async function pmTask(id: string, dueDate: string): Promise<void> {
    await withTenants([co], (c) =>
      c.query(`INSERT INTO pm_tasks (id, tenant_id, project_id, title, due_date, estimate_minutes, origin_site) VALUES ($1,$2,$3,'task',$4::date,60,'central')`, [id, co, projectId, dueDate]),
    );
  }
  async function ownerAssignee(taskId: string, userId: string): Promise<void> {
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO pm_task_assignees (id, tenant_id, task_id, role, assignee_kind, assignee_ref, user_id, origin_site, valid_from)
         VALUES ($1,$2,$3,'owner','person',$4,$5,'central','2026-01-01'::date)`,
        [newId(), co, taskId, userId, userId],
      ),
    );
  }
  async function completedEvent(taskId: string, dateIso: string, actorUserId: string): Promise<void> {
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO work_activity (id, tenant_id, source, source_ref, actor_user_id, verb, object_kind, object_ref, occurred_at, origin_site)
         VALUES ($1,$2,'pm',$3,$4,'completed','pm_task',$5,$6::timestamptz,'central')`,
        [newId(), co, `ev-${newId()}`, actorUserId, taskId, `${dateIso}T10:00:00Z`],
      ),
    );
  }
  async function completeTaskOn(dateIso: string): Promise<void> {
    const taskId = newId();
    await pmTask(taskId, dateIso);
    await ownerAssignee(taskId, alice);
    await completedEvent(taskId, dateIso, alice);
  }

  beforeAll(async () => {
    await initTestDb();
    await syncMetricDefinitions();

    co = await createCompany("TR-27 Co", ["reports", "pm", "hr"]);
    alice = await createUser("alice@tr27.test");
    await addMembership(co, alice);

    await withTenants([co], (c) => c.query(`INSERT INTO company_org_structure (tenant_id, structure, origin_site) VALUES ($1,$2,'central')`, [co, JSON.stringify(ORG_BLOB)]));
    projectId = await createProject(co, "Website");
    await withTenants([co], (c) =>
      c.query(`INSERT INTO org_unit_memberships (id, tenant_id, user_id, unit_node_id, is_primary, valid_from, source, origin_site) VALUES ($1,$2,$3,'d-eng',true,'2026-01-01'::date,'manual','central')`, [
        newId(),
        co,
        alice,
      ]),
    );

    // Alice completes exactly 3 tasks in January 2026 — she is the sole contributor, so the
    // project/department/company-grain documents all carry the SAME task-completed count as her
    // own person-grain document (no cross-grain aggregation surprises to account for below).
    for (const day of ["2026-01-05", "2026-01-12", "2026-01-19"]) {
      await completeTaskOn(day);
    }
  }, 60_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  async function personDoc(periodId: string, revision?: number): Promise<ReportDocument> {
    const { rows } = await withTenants(
      [co],
      (c) =>
        revision === undefined
          ? c.query<{ document: ReportDocument }>(`SELECT document FROM report_documents WHERE tenant_id=$1 AND period_id=$2 AND grain='person' AND scope_ref=$3 ORDER BY revision DESC LIMIT 1`, [co, periodId, alice])
          : c.query<{ document: ReportDocument }>(`SELECT document FROM report_documents WHERE tenant_id=$1 AND period_id=$2 AND grain='person' AND scope_ref=$3 AND revision=$4`, [co, periodId, alice, revision]),
      { modules: ["reports"] },
    );
    return rows[0].document;
  }

  it("acceptance 1: gateway unconfigured (GATEWAY_URL unset in this test env) -> seal succeeds, EVERY document narrative is a usable deterministic fallback, sealPeriod never throws", async () => {
    expect(config.services.gateway.url).toBe(""); // the precondition this test actually exercises
    const [period] = await ensureCalendarPeriodRows(co, "month", "2026-01-01", "2026-01-01");

    const result = await sealPeriod(co, period.id, null);
    expect(result.ok).toBe(true);

    const { rows } = await withTenants([co], (c) => c.query<{ document: ReportDocument }>(`SELECT document FROM report_documents WHERE tenant_id=$1 AND period_id=$2`, [co, period.id]), { modules: ["reports"] });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.document.narrative.source).toBe("deterministic");
      expect(row.document.narrative.text.length).toBeGreaterThan(0);
      expect(row.document.narrative.groundingHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.document.narrative.model).toBeUndefined(); // never labelled ai when there was no AI
    }
  });

  it("acceptance 2: a clean AI completion (mocked fetchImpl, no real network) -> the person document's narrative.source is 'ai'", async () => {
    const [period] = await ensureCalendarPeriodRows(co, "month", "2026-02-01", "2026-02-01");
    // No facts in February -> the person-grain kpis are all zero, so a completion with NO
    // numerals at all trivially clears the hallucinated-numeral guard for every scope.
    const fetchImpl = (async () =>
      ({ ok: true, status: 200, json: async () => ({ text: "A quiet period with no completed tasks recorded.", provider: "test-model" }) }) as Response) as unknown as typeof fetch;

    const result = await sealPeriod(co, period.id, null, { gatewayUrl: "http://fake-gateway.invalid", gatewayToken: "test-token", fetchImpl });
    expect(result.ok).toBe(true);

    const doc = await personDoc(period.id);
    expect(doc.narrative.source).toBe("ai");
    expect(doc.narrative.text).toBe("A quiet period with no completed tasks recorded.");
    expect(doc.narrative.model).toBe("test-model");
    expect(doc.narrative.groundingHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("acceptance 3 (THE SHARPEST BAR): an HTTP-200 completion with a HALLUCINATED numeral still downgrades to the deterministic fallback — against the real seal flow, not just the pure parser", async () => {
    const [period] = await ensureCalendarPeriodRows(co, "month", "2026-03-01", "2026-03-01");
    // March also has zero facts for Alice, so the ONLY legitimate numeral her document's grounding
    // facts contain is 0. A completion inventing "throughput rose 40%" must be rejected.
    const fetchImpl = (async () =>
      ({ ok: true, status: 200, json: async () => ({ text: "Throughput rose 40% this period, an excellent result.", provider: "test-model" }) }) as Response) as unknown as typeof fetch;

    const result = await sealPeriod(co, period.id, null, { gatewayUrl: "http://fake-gateway.invalid", gatewayToken: "test-token", fetchImpl });
    expect(result.ok).toBe(true);

    const doc = await personDoc(period.id);
    expect(doc.narrative.source).toBe("deterministic"); // downgraded, never "ai"
    expect(doc.narrative.text).not.toContain("40%");
    expect(doc.narrative.text).toBe("No activity recorded for this period."); // TR-13's exact fallback wording, byte-for-byte
    expect(doc.narrative.model).toBeUndefined();
  });

  it("narrative.source is honestly persisted to report_documents.narrative_source (never reportable as 'ai' when it isn't)", async () => {
    const { rows } = await withTenants(
      [co],
      (c) => c.query<{ narrative_source: string; grain: string }>(`SELECT narrative_source, grain FROM report_documents WHERE tenant_id=$1`, [co]),
      { modules: ["reports"] },
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(["ai", "deterministic"]).toContain(row.narrative_source);
    }
  });
});
