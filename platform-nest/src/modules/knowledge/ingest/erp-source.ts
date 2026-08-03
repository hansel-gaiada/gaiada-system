// INTERNAL-tier source builder: turns live ERP records into employee-only knowledge chunks.
//
// ── AUTHORIZATION ────────────────────────────────────────────────────────────────────────────────
// Every read goes through `withTenants([tenantId], …)`, so the platform's own FORCE-RLS predicate is
// the thing selecting rows — this job cannot read a company it was not asked to index even if a
// query forgot a WHERE. `modules` is declared for the module-owned tables (reports/pm/…): without
// it, `app_module_allowed()` is false and those tables return ZERO rows while looking perfectly
// healthy, which is the exact silent-no-op failure this codebase has been bitten by before.
//
// ── WHAT AN INGESTED RECORD LOOKS LIKE ───────────────────────────────────────────────────────────
// Records are rendered as LABELLED PROSE, not raw values. An embedding of "blocked" is meaningless;
// "Task: Migrate DNS / Status: blocked / Project: Acme Rebuild / Assignee: Sinta" is retrievable and
// answerable. Every chunk repeats its entity header for the same reason the web ingester repeats the
// page title — a chunk is retrieved alone and must stand alone.
//
// ── ACL ──────────────────────────────────────────────────────────────────────────────────────────
// All internal documents are written with an EMPTY acl, which the store reads as "every member of
// this tenant". That is precisely the requested rule ("open for employees only") and it is also the
// only rule that is currently SAFE to express: `scope` is supplied by the CALLER (the bot passes its
// chat id), so a narrower acl like ["dept:finance"] would be asserted by the party it restricts.
// Finer-grained gating needs server-resolved scopes first — see the module README.
import type { PoolClient } from "pg";
import { withTenants } from "../../../db";
import { chunkText, renderFields } from "./chunk";
import type { IngestDocument } from "./types";

/** Modules this job operates inside. Required for the module-owned tables' RLS predicate. */
const INGEST_MODULES = ["pm", "reports", "clients", "agency", "knowledge"];

/** Cap on how much of one long text field (a meeting transcript) becomes chunks. A 3-hour
 *  transcript is ~120k characters ≈ 100 embedding calls for ONE record; without a ceiling a single
 *  meeting can dominate an entire scheduled run. */
const MAX_TEXT_CHARS = 60_000;

interface Row {
  [k: string]: unknown;
}

function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

function date(v: unknown): string {
  if (!v) return "";
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

/** Build one ingest document from a rendered body, or null when there is nothing worth embedding. */
function doc(
  tenantId: string,
  sourceRef: string,
  label: string,
  header: string,
  body: string,
): IngestDocument | null {
  const chunks = chunkText(body.slice(0, MAX_TEXT_CHARS)).map((c) => `${header}\n\n${c}`);
  if (chunks.length === 0) return null;
  return { tenantId, sourceRef, audience: "internal", acl: [], kind: "doc", provenance: "human", chunks, label };
}

// ── per-family builders ──────────────────────────────────────────────────────────────────────────

async function clients(c: PoolClient, tenantId: string): Promise<IngestDocument[]> {
  const { rows } = await c.query<Row>(
    `SELECT id, name, status, contact, custom_fields, created_at FROM clients WHERE deleted_at IS NULL`,
  );
  return rows
    .map((r) =>
      doc(
        tenantId,
        `erp:client:${str(r.id)}`,
        `Client ${str(r.name)}`,
        `Client: ${str(r.name)}`,
        renderFields([
          ["Status", r.status],
          ["Contact", r.contact && Object.keys(r.contact as object).length ? JSON.stringify(r.contact) : ""],
          ["Client since", date(r.created_at)],
          ["Additional fields", r.custom_fields && Object.keys(r.custom_fields as object).length ? JSON.stringify(r.custom_fields) : ""],
        ]),
      ),
    )
    .filter((d): d is IngestDocument => d !== null);
}

async function projects(c: PoolClient, tenantId: string): Promise<IngestDocument[]> {
  const { rows } = await c.query<Row>(
    `SELECT p.id, p.name, p.status, p.start_date, p.due_date, p.is_internal, p.custom_fields,
            cl.name AS client_name, u.name AS owner_name
     FROM projects p
     LEFT JOIN clients cl ON cl.id = p.client_id
     LEFT JOIN users u ON u.id = p.owner_id
     WHERE p.deleted_at IS NULL`,
  );
  return rows
    .map((r) =>
      doc(
        tenantId,
        `erp:project:${str(r.id)}`,
        `Project ${str(r.name)}`,
        `Project: ${str(r.name)}`,
        renderFields([
          ["Status", r.status],
          ["Client", r.is_internal ? "internal project (no client)" : str(r.client_name)],
          ["Owner", r.owner_name],
          ["Start date", date(r.start_date)],
          ["Due date", date(r.due_date)],
          ["Additional fields", r.custom_fields && Object.keys(r.custom_fields as object).length ? JSON.stringify(r.custom_fields) : ""],
        ]),
      ),
    )
    .filter((d): d is IngestDocument => d !== null);
}

async function tasks(c: PoolClient, tenantId: string): Promise<IngestDocument[]> {
  const { rows } = await c.query<Row>(
    `SELECT t.id, t.title, t.status, t.priority, t.due_date, p.name AS project_name, u.name AS assignee_name
     FROM tasks t
     JOIN projects p ON p.id = t.project_id
     LEFT JOIN users u ON u.id = t.assignee_id
     WHERE t.deleted_at IS NULL`,
  );
  return rows
    .map((r) =>
      doc(
        tenantId,
        `erp:task:${str(r.id)}`,
        `Task ${str(r.title)}`,
        `Task: ${str(r.title)} (project ${str(r.project_name)})`,
        renderFields([
          ["Status", r.status],
          ["Priority", r.priority],
          ["Assignee", r.assignee_name],
          ["Due date", date(r.due_date)],
          ["Project", r.project_name],
        ]),
      ),
    )
    .filter((d): d is IngestDocument => d !== null);
}

async function deliverables(c: PoolClient, tenantId: string): Promise<IngestDocument[]> {
  const { rows } = await c.query<Row>(
    `SELECT d.id, d.name, d.status, d.due_date, p.name AS project_name, cl.name AS client_name
     FROM deliverables d
     JOIN projects p ON p.id = d.project_id
     LEFT JOIN clients cl ON cl.id = d.client_id
     WHERE d.deleted_at IS NULL`,
  );
  return rows
    .map((r) =>
      doc(
        tenantId,
        `erp:deliverable:${str(r.id)}`,
        `Deliverable ${str(r.name)}`,
        `Deliverable: ${str(r.name)} (project ${str(r.project_name)})`,
        renderFields([
          ["Status", r.status],
          ["Due date", date(r.due_date)],
          ["Project", r.project_name],
          ["Client", r.client_name],
        ]),
      ),
    )
    .filter((d): d is IngestDocument => d !== null);
}

/** Meeting transcripts — the single highest-value internal corpus, because they are long-form prose
 *  that answers "what did we agree with the client" in a way no structured row can. */
async function meetings(c: PoolClient, tenantId: string): Promise<IngestDocument[]> {
  const { rows } = await c.query<Row>(
    `SELECT m.id, m.title, m.started_at, m.transcript, p.name AS project_name, cl.name AS client_name
     FROM meeting_recordings m
     LEFT JOIN projects p ON p.id = m.project_id
     LEFT JOIN clients cl ON cl.id = m.client_id
     WHERE m.transcript IS NOT NULL AND m.transcript <> ''`,
  );
  return rows
    .map((r) => {
      const title = str(r.title) || `Meeting ${date(r.started_at)}`;
      return doc(
        tenantId,
        `erp:meeting:${str(r.id)}`,
        `Meeting ${title}`,
        `Meeting transcript: ${title}${r.client_name ? ` with ${str(r.client_name)}` : ""}${r.project_name ? ` (project ${str(r.project_name)})` : ""} on ${date(r.started_at)}`,
        str(r.transcript),
      );
    })
    .filter((d): d is IngestDocument => d !== null);
}

/** PM documents (PRDs, scopes, notes authored in the PM console). */
async function pmDocs(c: PoolClient, tenantId: string): Promise<IngestDocument[]> {
  const { rows } = await c.query<Row>(
    `SELECT d.id, d.title, d.body, p.name AS project_name, u.name AS author_name, d.updated_at
     FROM pm_docs d
     JOIN projects p ON p.id = d.project_id
     LEFT JOIN users u ON u.id = d.author_id
     WHERE d.deleted_at IS NULL AND d.body <> ''`,
  );
  return rows
    .map((r) =>
      doc(
        tenantId,
        `erp:pmdoc:${str(r.id)}`,
        `Doc ${str(r.title)}`,
        `Document: ${str(r.title)} (project ${str(r.project_name)}${r.author_name ? `, author ${str(r.author_name)}` : ""})`,
        str(r.body),
      ),
    )
    .filter((d): d is IngestDocument => d !== null);
}

/** Sealed report documents. Only the LATEST revision per (grain, scope_ref) is indexed — older
 *  revisions are superseded facts, and indexing them makes the RAG argue with itself. */
async function reportDocuments(c: PoolClient, tenantId: string): Promise<IngestDocument[]> {
  const { rows } = await c.query<Row>(
    `SELECT DISTINCT ON (grain, scope_ref) id, grain, scope_ref, revision, document, created_at
     FROM report_documents
     ORDER BY grain, scope_ref, revision DESC, created_at DESC`,
  );
  return rows
    .map((r) => {
      const body = flattenJson(r.document);
      return doc(
        tenantId,
        `erp:report:${str(r.grain)}:${str(r.scope_ref)}`,
        `Report ${str(r.grain)}/${str(r.scope_ref)}`,
        `Report (${str(r.grain)} grain, revision ${str(r.revision)}, generated ${date(r.created_at)})`,
        body,
      );
    })
    .filter((d): d is IngestDocument => d !== null);
}

/** Org structure + people. One document for the whole chart (it is small and only makes sense as a
 *  whole) plus one per active member, which is what makes "who runs SEO?" answerable. */
async function orgAndPeople(c: PoolClient, tenantId: string): Promise<IngestDocument[]> {
  const out: IngestDocument[] = [];

  const org = await c.query<Row>(`SELECT structure, updated_at FROM company_org_structure WHERE tenant_id = $1`, [tenantId]);
  if (org.rows[0]) {
    const d = doc(
      tenantId,
      `erp:org:${tenantId}`,
      "Org structure",
      "Company org structure (departments, divisions and reporting lines)",
      flattenJson(org.rows[0].structure),
    );
    if (d) out.push(d);
  }

  const units = await c.query<Row>(`SELECT node_id, kind, name, status FROM org_units WHERE tenant_id = $1 AND status = 'active'`, [tenantId]);
  if (units.rows.length > 0) {
    const d = doc(
      tenantId,
      `erp:orgunits:${tenantId}`,
      "Departments",
      "Departments and divisions",
      units.rows.map((r) => `- ${str(r.name)} (${str(r.kind)})`).join("\n"),
    );
    if (d) out.push(d);
  }

  const people = await c.query<Row>(
    `SELECT u.id, u.name, u.email, u.title, u.status, r.name AS role_name
     FROM company_memberships cm
     JOIN users u ON u.id = cm.user_id
     LEFT JOIN roles r ON r.id = cm.primary_role_id
     WHERE cm.tenant_id = $1 AND cm.deleted_at IS NULL AND cm.status = 'active' AND u.deleted_at IS NULL`,
    [tenantId],
  );
  for (const r of people.rows) {
    const d = doc(
      tenantId,
      `erp:person:${tenantId}:${str(r.id)}`,
      `Person ${str(r.name)}`,
      `Colleague: ${str(r.name)}`,
      renderFields([
        ["Job title", r.title],
        ["Primary role", r.role_name],
        ["Work email", r.email],
        ["Status", r.status],
      ]),
    );
    if (d) out.push(d);
  }
  return out;
}

/** Files. Metadata is always indexed (so "what did we send Acme?" works); readable TEXT formats are
 *  additionally indexed by content. Binary office formats (pdf/docx) are NOT parsed here — that
 *  needs binary parsers in the ERP core process and is a separate, deliberate decision; see the
 *  module README. `extractText` is the seam where they would plug in. */
async function files(c: PoolClient, tenantId: string, extractText?: FileTextExtractor): Promise<IngestDocument[]> {
  const { rows } = await c.query<Row>(
    `SELECT id, filename, content_type, byte_size, target_entity_type, target_entity_id, storage_key, created_at
     FROM files WHERE deleted_at IS NULL`,
  );
  const out: IngestDocument[] = [];
  for (const r of rows) {
    const meta = renderFields([
      ["File name", r.filename],
      ["Type", r.content_type],
      ["Size (bytes)", r.byte_size],
      ["Attached to", `${str(r.target_entity_type)} ${str(r.target_entity_id)}`],
      ["Uploaded", date(r.created_at)],
    ]);
    let body = meta;
    if (extractText && str(r.storage_key)) {
      const text = await extractText(str(r.storage_key), str(r.content_type), str(r.filename)).catch(() => "");
      if (text) body = `${meta}\n\nContents:\n${text}`;
    }
    const d = doc(tenantId, `erp:file:${str(r.id)}`, `File ${str(r.filename)}`, `File: ${str(r.filename)}`, body);
    if (d) out.push(d);
  }
  return out;
}

export type FileTextExtractor = (storageKey: string, contentType: string, filename: string) => Promise<string>;

/** Flatten arbitrary JSON into labelled lines. Report documents and the org blob are deeply nested;
 *  embedding raw JSON wastes most of the vector on punctuation and key noise. */
export function flattenJson(value: unknown, prefix = "", depth = 0): string {
  if (depth > 8 || value === null || value === undefined) return "";
  if (typeof value !== "object") {
    const s = String(value).trim();
    return s ? `${prefix ? `${prefix}: ` : ""}${s}` : "";
  }
  if (Array.isArray(value)) {
    return value
      .map((v, i) => flattenJson(v, prefix ? `${prefix}[${i}]` : `[${i}]`, depth + 1))
      .filter(Boolean)
      .join("\n");
  }
  return Object.entries(value as Record<string, unknown>)
    .map(([k, v]) => flattenJson(v, prefix ? `${prefix}.${k}` : k, depth + 1))
    .filter(Boolean)
    .join("\n");
}

/** Build every internal document for one tenant. One transaction, one tenant context. */
export async function buildErpDocuments(tenantId: string, extractText?: FileTextExtractor): Promise<IngestDocument[]> {
  return withTenants(
    [tenantId],
    async (c) => {
      // Sequential on purpose: these all share ONE PoolClient inside ONE transaction. Firing them
      // concurrently would interleave statements on a single connection (and, in files(), interleave
      // them around an await on disk I/O) — pg would serialize it anyway, so there is nothing to win
      // and a confusing failure mode to lose.
      const out: IngestDocument[] = [];
      out.push(...(await clients(c, tenantId)));
      out.push(...(await projects(c, tenantId)));
      out.push(...(await tasks(c, tenantId)));
      out.push(...(await deliverables(c, tenantId)));
      out.push(...(await meetings(c, tenantId)));
      out.push(...(await pmDocs(c, tenantId)));
      out.push(...(await reportDocuments(c, tenantId)));
      out.push(...(await orgAndPeople(c, tenantId)));
      out.push(...(await files(c, tenantId, extractText)));
      return out;
    },
    { modules: INGEST_MODULES },
  );
}
