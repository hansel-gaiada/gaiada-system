// AIP-11: the ERP source tags each record with the org node id of the department that owns it, and does so WITHOUT touching
// the chunk text. This file runs without a database: `withTenants` is replaced by a fake client that answers each family's
// query with canned rows, so what is proved is the mapping (which column becomes `departmentId`) and the text pin. The SQL
// itself (the joins that find a project's department) is proved against real Postgres in erp-source-department.db.test.ts.
import { describe, it, expect, vi } from "vitest";

const rowsByQuery: Array<{ match: RegExp; rows: Record<string, unknown>[] }> = [];
const issued: string[] = [];

vi.mock("../../../db", () => ({
  withTenants: async (_tenants: string[], fn: (c: unknown) => Promise<unknown>) =>
    fn({
      query: async (sql: string) => {
        issued.push(sql);
        const hit = rowsByQuery.find((q) => q.match.test(sql));
        return { rows: hit ? hit.rows : [] };
      },
    }),
}));

import { buildErpDocuments, doc } from "./erp-source";

const T = "aaaaaaaa-0000-4000-8000-000000000001";
const NOW = new Date("2026-10-01T00:00:00Z");

function seed(rows: Record<string, Record<string, unknown>[]>): void {
  rowsByQuery.length = 0;
  issued.length = 0;
  const route: Record<string, RegExp> = {
    clients: /FROM clients\b/,
    projects: /FROM projects p\b/,
    tasks: /FROM tasks t\b/,
    pmTasks: /FROM pm_tasks t\b/,
    deliverables: /FROM deliverables d\b/,
    meetings: /FROM meeting_recordings m\b/,
    pmDocs: /FROM pm_docs d\b/,
    reports: /FROM report_documents/,
    org: /FROM company_org_structure/,
    units: /FROM org_units/,
    people: /FROM company_memberships/,
    files: /FROM files f\b/,
  };
  for (const [k, r] of Object.entries(rows)) rowsByQuery.push({ match: route[k], rows: r });
}

const byRef = (docs: Awaited<ReturnType<typeof buildErpDocuments>>) => new Map(docs.map((d) => [d.sourceRef, d]));

describe("ERP source: departmentId per family (AIP-11)", () => {
  it("a project carries its own department; tasks, PM tasks, deliverables and PM docs carry their project's", async () => {
    seed({
      projects: [{ id: "p1", name: "Rankings", status: "active", department_id: "d-seo" }, { id: "p2", name: "No dept", status: "active", department_id: null }],
      tasks: [{ id: "t1", title: "Core task", project_name: "Rankings", project_department_id: "d-seo" }],
      pmTasks: [{ id: "pt1", title: "PM task", project_name: "Rankings", project_department_id: "d-seo" }],
      deliverables: [{ id: "dv1", name: "Report", project_name: "Rankings", project_department_id: "d-seo" }],
      pmDocs: [{ id: "doc1", title: "Runbook", body: "Steps to follow.", project_name: "Rankings", project_department_id: "d-seo" }],
    });
    const m = byRef(await buildErpDocuments(T));
    expect(m.get("erp:project:p1")!.departmentId).toBe("d-seo");
    expect(m.get("erp:project:p2")!.departmentId).toBeNull();
    expect(m.get("erp:task:t1")!.departmentId).toBe("d-seo");
    expect(m.get("erp:pmtask:pt1")!.departmentId).toBe("d-seo");
    expect(m.get("erp:deliverable:dv1")!.departmentId).toBe("d-seo");
    expect(m.get("erp:pmdoc:doc1")!.departmentId).toBe("d-seo");
  });

  it("a task of a project with no department has none, and a blank department column is none", async () => {
    seed({
      projects: [{ id: "p3", name: "Blank", status: "active", department_id: "   " }],
      pmTasks: [{ id: "pt2", title: "Orphan", project_name: "P", project_department_id: null }],
    });
    const m = byRef(await buildErpDocuments(T));
    expect(m.get("erp:project:p3")!.departmentId).toBeNull();
    expect(m.get("erp:pmtask:pt2")!.departmentId).toBeNull();
  });

  it("a meeting carries what the query resolves (its own department, else its project's) and trims it", async () => {
    // The COALESCE is in the SQL (proved against Postgres); here: the column it returns becomes the tag.
    seed({
      meetings: [
        { id: "m1", title: "Own", started_at: NOW, transcript: "We agreed on the plan.", department_id: " d-hr " },
        { id: "m2", title: "None", started_at: NOW, transcript: "No department anywhere.", department_id: null },
      ],
    });
    const m = byRef(await buildErpDocuments(T));
    expect(m.get("erp:meeting:m1")!.departmentId).toBe("d-hr");
    expect(m.get("erp:meeting:m2")!.departmentId).toBeNull();
    const sql = issued.find((q) => /FROM meeting_recordings m\b/.test(q))!;
    expect(sql).toMatch(/COALESCE\(NULLIF\(btrim\(m\.department_id\), ''\), p\.department_id\)/); // its own first, then its project's
  });

  it("a file carries the department the query finds through its target (project, task, deliverable); any other target has none", async () => {
    seed({
      files: [
        { id: "f1", filename: "plan.txt", content_type: "text/plain", byte_size: 10, target_entity_type: "project", target_entity_id: "p1", storage_key: "", created_at: NOW, department_id: "d-seo" },
        { id: "f2", filename: "invoice.pdf", content_type: "application/pdf", byte_size: 10, target_entity_type: "client", target_entity_id: "c1", storage_key: "", created_at: NOW, department_id: null },
      ],
    });
    const m = byRef(await buildErpDocuments(T));
    expect(m.get("erp:file:f1")!.departmentId).toBe("d-seo");
    expect(m.get("erp:file:f2")!.departmentId).toBeNull();
    const sql = issued.find((q) => /FROM files f\b/.test(q))!;
    // The joins are keyed on the target TYPE, so a uuid in two tables cannot lend its project to the wrong kind of file.
    expect(sql).toMatch(/f\.target_entity_type = 'task' AND tk\.id = f\.target_entity_id/);
    expect(sql).toMatch(/f\.target_entity_type = 'task' AND pt\.id = f\.target_entity_id/);
    expect(sql).toMatch(/f\.target_entity_type = 'deliverable' AND dv\.id = f\.target_entity_id/);
    expect(sql).toMatch(/f\.target_entity_type = 'project' AND pj\.id = f\.target_entity_id/);
  });

  it("clients, reports, org and people carry no department", async () => {
    seed({
      clients: [{ id: "c1", name: "Acme", status: "active", created_at: NOW }],
      reports: [{ id: "r1", grain: "week", scope_ref: "s", revision: 1, document: { headline: "On track" }, created_at: NOW }],
      org: [{ structure: { depts: ["SEO"] }, updated_at: NOW }],
      units: [{ node_id: "d-seo", kind: "department", name: "SEO", status: "active" }],
      people: [{ id: "u1", name: "Sinta", email: "s@a.test", title: "Lead", status: "active", role_name: "member" }],
    });
    const docs = await buildErpDocuments(T);
    expect(docs.length).toBeGreaterThanOrEqual(5);
    for (const d of docs) expect(d.departmentId ?? null).toBeNull();
  });
});

describe("ERP source: the department never changes the chunk text (AIP-11)", () => {
  // The store keeps a stored chunk's vector when its text is byte-identical, so ANY change to the rendered text re-embeds the
  // whole corpus (about 2 hours on the live 2-vCPU box). The department rides beside the chunks, as a column.
  it("a record renders the same chunks with and without a department", () => {
    const body = "Status: active\nClient: Acme\nOwner: Sinta\nDue date: 2026-12-01";
    const without = doc(T, "erp:project:p1", "Project Rankings", "Project: Rankings", body);
    const withDept = doc(T, "erp:project:p1", "Project Rankings", "Project: Rankings", body, "d-seo");
    expect(without).not.toBeNull();
    expect(withDept!.chunks).toEqual(without!.chunks);
    expect(withDept!.departmentId).toBe("d-seo");
    expect(without!.departmentId).toBeNull();
    for (const c of withDept!.chunks) expect(c.toLowerCase()).not.toContain("department");
  });

  it("a long record (several chunks) is chunked identically with and without a department", () => {
    const body = Array.from({ length: 12 }, (_, i) => `Paragraph ${i}. ${"The team reviewed the ranking report and agreed the next steps. ".repeat(12)}`).join("\n\n");
    const a = doc(T, "erp:meeting:m9", "Meeting x", "Meeting transcript: x", body);
    const b = doc(T, "erp:meeting:m9", "Meeting x", "Meeting transcript: x", body, "d-seo");
    expect(a!.chunks.length).toBeGreaterThan(1);
    expect(b!.chunks).toEqual(a!.chunks);
  });

  it("end to end: the same row yields the same chunk text whatever its project's department is", async () => {
    const row = { id: "pt1", title: "PM task", description: "Do the thing", status: "open", project_name: "Rankings" };
    seed({ pmTasks: [{ ...row, project_department_id: "d-seo" }] });
    const tagged = (await buildErpDocuments(T)).find((d) => d.sourceRef === "erp:pmtask:pt1")!;
    seed({ pmTasks: [{ ...row, project_department_id: null }] });
    const plain = (await buildErpDocuments(T)).find((d) => d.sourceRef === "erp:pmtask:pt1")!;
    expect(tagged.departmentId).toBe("d-seo");
    expect(plain.departmentId).toBeNull();
    expect(tagged.chunks).toEqual(plain.chunks);
  });
});
