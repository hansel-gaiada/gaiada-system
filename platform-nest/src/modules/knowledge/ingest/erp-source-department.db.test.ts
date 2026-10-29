// AIP-11 against REAL Postgres: the joins in erp-source.ts that find a record's department. erp-source-department.test.ts proves
// the mapping with canned rows; this proves the SQL (a project's own column, a task's or deliverable's project, a meeting's own
// department before its project's, a file's parent through its target type) under the same FORCE-RLS context the sweep runs in.
// Needs DATABASE_URL_TEST (skips silently otherwise). Linux gate only.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants, newId } from "../../../db";
import { config } from "../../../config";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../testing/setup";
import { createCompany, createProject, createTask } from "../../../testing/fixtures";
import { buildErpDocuments } from "./erp-source";

describe.skipIf(!TEST_URL)("knowledge ERP source: department per record (AIP-11, real Postgres)", () => {
  let co: string;
  let seo: string; // a project of d-seo
  let plain: string; // a project with no department
  let coreTask: string;
  let pmTask: string;
  let deliverable: string;
  const ids = {
    pmDoc: newId(), mOwn: newId(), mViaProject: newId(), mNone: newId(), mOwnOverProject: newId(),
    fProject: newId(), fCoreTask: newId(), fPmTask: newId(), fDeliverable: newId(), fPlainProject: newId(), fOrphanTask: newId(), fClient: newId(),
  };

  beforeAll(async () => {
    await initTestDb();
    co = await createCompany("Dept Knowledge Co", ["pm", "knowledge", "clients"]);
    seo = await createProject(co, "Rankings");
    plain = await createProject(co, "No department");
    coreTask = await createTask(co, seo, "Core task");
    pmTask = newId();
    deliverable = newId();
    const clientId = newId();
    const site = config.originSite;
    await withTenants([co], async (c) => {
      await c.query(`UPDATE projects SET department_id = 'd-seo' WHERE id = $1`, [seo]);
      await c.query(`INSERT INTO clients (id, tenant_id, name, origin_site) VALUES ($1, $2, 'Acme', $3)`, [clientId, co, site]);
      await c.query(`INSERT INTO pm_tasks (id, tenant_id, project_id, title, origin_site) VALUES ($1, $2, $3, 'PM task', $4)`, [pmTask, co, seo, site]);
      await c.query(`INSERT INTO deliverables (id, tenant_id, project_id, name, status, origin_site) VALUES ($1, $2, $3, 'Deliverable', 'pending', $4)`, [deliverable, co, seo, site]);
      await c.query(`INSERT INTO pm_docs (id, tenant_id, project_id, title, body, origin_site) VALUES ($1, $2, $3, 'Runbook', 'Steps to follow.', $4)`, [ids.pmDoc, co, seo, site]);
      const meeting = (id: string, projectId: string | null, dept: string | null) =>
        c.query(
          `INSERT INTO meeting_recordings (id, tenant_id, meeting_id, project_id, department_id, title, transcript, origin_site)
           VALUES ($1, $2, $3, $4, $5, 'Sync', 'We talked.', $6)`,
          [id, co, `dept-${id}`, projectId, dept, site],
        );
      await meeting(ids.mOwn, null, "d-hr"); // its own department, no project
      await meeting(ids.mViaProject, seo, null); // no department of its own: the project's
      await meeting(ids.mNone, null, null); // neither
      await meeting(ids.mOwnOverProject, seo, "d-hr"); // its own wins over the project's
      const file = (id: string, type: string, target: string) =>
        c.query(
          `INSERT INTO files (id, tenant_id, target_entity_type, target_entity_id, filename, content_type, byte_size, storage_key, origin_site)
           VALUES ($1, $2, $3, $4, $5, 'text/plain', 1, $6, $7)`,
          [id, co, type, target, `${id}.txt`, `k/${id}`, site],
        );
      await file(ids.fProject, "project", seo);
      await file(ids.fCoreTask, "task", coreTask);
      await file(ids.fPmTask, "task", pmTask);
      await file(ids.fDeliverable, "deliverable", deliverable);
      await file(ids.fPlainProject, "project", plain);
      await file(ids.fOrphanTask, "task", newId()); // a task that does not exist
      await file(ids.fClient, "client", clientId);
    });
  }, 120_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  it("every family resolves its department the way the contract says", async () => {
    const docs = await buildErpDocuments(co);
    const dept = new Map(docs.map((d) => [d.sourceRef, d.departmentId ?? null]));
    const of = (ref: string) => {
      expect(dept.has(ref), `${ref} was ingested`).toBe(true);
      return dept.get(ref);
    };
    // projects: their own
    expect(of(`erp:project:${seo}`)).toBe("d-seo");
    expect(of(`erp:project:${plain}`)).toBeNull();
    // tasks, PM tasks, deliverables, PM docs: their project's
    expect(of(`erp:task:${coreTask}`)).toBe("d-seo");
    expect(of(`erp:pmtask:${pmTask}`)).toBe("d-seo");
    expect(of(`erp:deliverable:${deliverable}`)).toBe("d-seo");
    expect(of(`erp:pmdoc:${ids.pmDoc}`)).toBe("d-seo");
    // meetings: its own, else its project's
    expect(of(`erp:meeting:${ids.mOwn}`)).toBe("d-hr");
    expect(of(`erp:meeting:${ids.mViaProject}`)).toBe("d-seo");
    expect(of(`erp:meeting:${ids.mNone}`)).toBeNull();
    expect(of(`erp:meeting:${ids.mOwnOverProject}`)).toBe("d-hr");
    // files: the parent project's, or the parent task's / deliverable's project's; anything else none
    expect(of(`erp:file:${ids.fProject}`)).toBe("d-seo");
    expect(of(`erp:file:${ids.fCoreTask}`)).toBe("d-seo");
    expect(of(`erp:file:${ids.fPmTask}`)).toBe("d-seo");
    expect(of(`erp:file:${ids.fDeliverable}`)).toBe("d-seo");
    expect(of(`erp:file:${ids.fPlainProject}`)).toBeNull();
    expect(of(`erp:file:${ids.fOrphanTask}`)).toBeNull();
    expect(of(`erp:file:${ids.fClient}`)).toBeNull();
  });

  it("clients, org and people carry none", async () => {
    const docs = await buildErpDocuments(co);
    for (const d of docs.filter((x) => /^erp:(client|org|orgunits|person|report):/.test(x.sourceRef))) expect(d.departmentId ?? null).toBeNull();
  });

  it("a file row appears once however many joins it passes through (no duplicates from the left joins)", async () => {
    const docs = await buildErpDocuments(co);
    const refs = docs.map((d) => d.sourceRef).filter((r) => r.startsWith("erp:file:"));
    expect(new Set(refs).size).toBe(refs.length);
    expect(refs).toHaveLength(7);
  });
});
