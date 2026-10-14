// DW-8i (docs/FRONTEND-BFF-CONTRACT.md §46.2) — the filter that stands between the knowledge store and a staff member.
//
// WHY THIS EXISTS. An internal chunk is written with an empty ACL, which the store reads as "every member of the company"
// (README, "Known limits"). The ERP's own reads are narrower, so a search that returned chunks on the tier's rule would show a
// member a record they cannot open (D-UX-2: never widen visibility). EVERY hit is therefore re-checked against the caller's
// READ right on ITS SOURCE RECORD, with the Cerbos resource and attributes that record's own read route sends. A source ref
// whose family is not in `FAMILIES` is never returned (fail closed), and neither is a hit whose record is gone, deleted or in
// another tenant.
//
// SHAPE. The pure half (ref parsing, collapsing, topK, snippet) has no I/O and is unit-tested locally. `filterReadableHits`
// is the I/O half: existence and title under `withTenants` first, then ONE batched Cerbos read per resource, at most 50 a request.
// A refused hit is dropped SILENTLY: a count of withheld hits would confirm that hidden records match the query.
//
// SHARED ON PURPOSE (§46.6): the hub's `knowledge.search` tool and the assistant's retrieval apply only the tier's rule today.
// This function takes a principal and candidate hits, so those paths can adopt it later. Whether they do is the owner's call.
import { withTenants } from "../../db";
import { TARGET_KINDS, targetReadResource } from "../../core/files.controller";
import { assemblePrincipal, type Principal } from "../../rbac/principal";
import { checkMany, type Resource } from "../../rbac/cerbos";
import { isModuleEnabled } from "../registry";

// ── the allowlist ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The families v1 can return. `report`, `person`, `org` and `orgunits` are deliberately absent: their read rules depend on who
 *  the person is, and each can join with its own check and its own test (§46.2). */
export const FAMILIES = ["client", "project", "task", "pmtask", "deliverable", "meeting", "pmdoc", "file"] as const;
export type Family = (typeof FAMILIES)[number];
const FAMILY_SET: ReadonlySet<string> = new Set(FAMILIES);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ParsedRef {
  family: Family;
  /** Lower-cased record uuid. */
  id: string;
}

/** `erp:<family>:<uuid>` for an allowlisted family, else `null` (withheld). Anything else, including a ref that carries extra
 *  segments (`erp:person:<tenant>:<user>`, `erp:report:<grain>:<scope>`) or a non-uuid id, is withheld. */
export function parseSourceRef(ref: unknown): ParsedRef | null {
  if (typeof ref !== "string") return null;
  const parts = ref.split(":");
  if (parts.length !== 3 || parts[0] !== "erp") return null;
  const [, family, id] = parts;
  if (!FAMILY_SET.has(family) || !UUID_RE.test(id)) return null;
  return { family: family as Family, id: id.toLowerCase() };
}

// ── the pure half ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What the knowledge service's `POST /search` answers, per hit (the fields this filter reads). */
export interface StoreHit {
  tenantId: string;
  sourceRef: string;
  kind: string;
  text: string;
  provenance: string;
  confidence: number;
  score: number;
  audience: string;
}

export interface Candidate {
  hit: StoreHit;
  family: Family;
  id: string;
}

/** Keep only company-record hits for THIS tenant (the internal tier, never the public website corpus), parse the ref, drop what
 *  does not parse, and collapse to ONE candidate per record (the best-scoring chunk wins; a tie keeps the first). Score order. */
export function collapseHits(hits: readonly StoreHit[], tenantId: string): Candidate[] {
  const best = new Map<string, Candidate>();
  for (const hit of hits) {
    if (!hit || hit.audience !== "internal" || hit.tenantId !== tenantId) continue;
    const p = parseSourceRef(hit.sourceRef);
    if (!p) continue;
    const key = `${p.family}:${p.id}`;
    const cur = best.get(key);
    if (!cur || hit.score > cur.hit.score) best.set(key, { hit, family: p.family, id: p.id });
  }
  return [...best.values()].sort((a, b) => b.hit.score - a.hit.score);
}

/** How many chunks to ask the store for: room for the filter and the per-record collapse, capped (§46.1). */
export function searchTopK(limit: number): number {
  return Math.min(limit * 4, 80);
}

export const SNIPPET_MAX = 300;

/** The chunk text, whitespace collapsed, at most 300 characters (an ellipsis counts toward the 300). */
export function snippetOf(text: string): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length <= SNIPPET_MAX ? flat : `${flat.slice(0, SNIPPET_MAX - 1).trimEnd()}…`;
}

// ── the per-family table ─────────────────────────────────────────────────────────────────────────────────────────────────

/** One existence-and-title row. Every family's SQL returns these five columns (NULL where a family has no such thing). */
interface RecordRow {
  id: string;
  title: string | null;
  project_id: string | null;
  target_type: string | null;
  target_id: string | null;
}

interface FamilySpec {
  /** A module whose own `ModuleEnabledGuard` sits in front of this record's read route: when it is off, the route 404s, so the hit goes. */
  module?: "pm" | "clients";
  /** Existence and title, under the tenant, soft-deleted rows excluded. `$1` is a `uuid[]`. Each mirrors the row the read route selects. */
  sql: string;
  /** The Cerbos READ resources, ALL of which must allow, copied from the record's own read route. `[]` withholds the hit. */
  resources(row: RecordRow, tenantId: string): Resource[];
  /** Where the UI opens it. */
  href(row: RecordRow): string;
}

const COLS_NONE = `NULL::text AS project_id, NULL::text AS target_type, NULL::text AS target_id`;

export const FAMILY_SPECS: Readonly<Record<Family, FamilySpec>> = {
  // modules/clients/clients.controller.ts `getClient` (behind ModuleEnabledGuard("clients")): client · read, `{ kind, id, tenantId }`.
  client: {
    module: "clients",
    sql: `SELECT id::text, name AS title, ${COLS_NONE} FROM clients WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
    resources: (r, tenantId) => [{ kind: "client", id: r.id, tenantId }],
    href: (r) => `/clients/${r.id}`,
  },
  // core/core.controller.ts `projectDetail`: project · read, `{ kind, tenantId, id }`.
  project: {
    sql: `SELECT id::text, name AS title, ${COLS_NONE} FROM projects WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
    resources: (r, tenantId) => [{ kind: "project", tenantId, id: r.id }],
    href: (r) => `/projects/${r.id}`,
  },
  // core/core.controller.ts `taskDetail`: task · read, `{ kind, tenantId, id }`. (JOIN projects, as the route does.)
  task: {
    sql: `SELECT t.id::text, t.title, ${COLS_NONE} FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ANY($1::uuid[]) AND t.deleted_at IS NULL`,
    resources: (r, tenantId) => [{ kind: "task", tenantId, id: r.id }],
    href: (r) => `/tasks/${r.id}`,
  },
  // modules/pm/pm.controller.ts `getTask` (behind ModuleEnabledGuard("pm")): pm_task · read, `{ kind, tenantId, id }`.
  // The page is `/tasks/:id` (TaskDetailView), the href GET /api/tasks/mine builds for a PM task.
  pmtask: {
    module: "pm",
    sql: `SELECT t.id::text, t.title, ${COLS_NONE} FROM pm_tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ANY($1::uuid[]) AND t.deleted_at IS NULL`,
    resources: (r, tenantId) => [{ kind: "pm_task", tenantId, id: r.id }],
    href: (r) => `/tasks/${r.id}`,
  },
  // core/client-work.controller.ts `getDeliverable`: deliverable · read, `{ kind, id, tenantId }`.
  // There is no `/deliverables/:id` page in the UI (only the list), so a deliverable opens on its project's page.
  deliverable: {
    sql: `SELECT id::text, name AS title, project_id::text AS project_id, NULL::text AS target_type, NULL::text AS target_id FROM deliverables WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
    resources: (r, tenantId) => [{ kind: "deliverable", id: r.id, tenantId }],
    href: (r) => (r.project_id ? `/projects/${r.project_id}` : "/deliverables"),
  },
  // core/meetings.controller.ts `get` (recordings/:id): meeting_recording · read, `{ kind, tenantId }` (the route sends no id).
  meeting: {
    sql: `SELECT id::text, COALESCE(NULLIF(title, ''), 'Meeting ' || to_char(started_at, 'YYYY-MM-DD'), 'Meeting recording') AS title, ${COLS_NONE}
          FROM meeting_recordings WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
    resources: (_r, tenantId) => [{ kind: "meeting_recording", tenantId }],
    href: (r) => `/meetings/${r.id}`,
  },
  // modules/pm/pm.controller.ts `getDoc` (behind ModuleEnabledGuard("pm")): pm_project · read on the doc's PROJECT,
  // `{ kind, tenantId, id: projectId }`. There is no page per doc: they are the project's Docs tab.
  pmdoc: {
    module: "pm",
    sql: `SELECT id::text, title, project_id::text AS project_id, NULL::text AS target_type, NULL::text AS target_id FROM pm_docs WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
    resources: (r, tenantId) => (r.project_id ? [{ kind: "pm_project", tenantId, id: r.project_id }] : []),
    href: (r) => `/projects/${r.project_id}?view=docs`,
  },
  // core/files.controller.ts `metadata`: file · read `{ kind: "file", id, tenantId }`, THEN the parent's read through
  // `targetReadResource` (the DW-8h kinds' own read shape, else the inline `{ kind, id, tenantId }`). Both must allow. A parent
  // kind the upload route cannot attach to (TARGET_KINDS) is withheld rather than guessed at.
  file: {
    sql: `SELECT id::text, filename AS title, NULL::text AS project_id, target_entity_type AS target_type, target_entity_id::text AS target_id FROM files WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
    resources: (r, tenantId) =>
      r.target_type && r.target_id && TARGET_KINDS.has(r.target_type)
        ? [{ kind: "file", id: r.id, tenantId }, targetReadResource({ target_entity_type: r.target_type, target_entity_id: r.target_id }, tenantId)]
        : [],
    href: (r) => fileHref(r),
  },
};

/** A file opens on its parent's page where the UI has one, else it downloads (`GET /api/files/:fileId`). */
function fileHref(r: RecordRow): string {
  const t = r.target_type;
  const id = r.target_id;
  if (t && id) {
    if (t === "client") return `/clients/${id}`;
    if (t === "project") return `/projects/${id}`;
    if (t === "task") return `/tasks/${id}`;
    if (t === "agency_campaign") return `/agency/${id}`;
  }
  return `/api/files/${r.id}`;
}

// ── the I/O half ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface AllowedHit {
  candidate: Candidate;
  title: string;
  href: string;
}

/**
 * The candidates this caller may open, in the order given. Steps:
 *   1. existence and title, one query per family present, in ONE `withTenants([tenantId])` transaction. No row (deleted, absent,
 *      another tenant's by RLS) drops the hit. A family whose route sits behind a module guard drops when that module is off.
 *   2. the Cerbos READ checks, batched (at most 50 a request, `checkMany`), every resource of a hit must allow. When the
 *      principal acts for someone, the acting user must allow too, as `authorize()` does: the intersection can only narrow.
 * A refusal is not reported anywhere. A Cerbos error throws, so the route answers 503 and never an empty "nothing matches".
 */
export async function filterReadableHits(principal: Principal, tenantId: string, candidates: readonly Candidate[]): Promise<AllowedHit[]> {
  if (candidates.length === 0) return [];

  // 1. existence + title.
  const idsByFamily = new Map<Family, string[]>();
  for (const c of candidates) (idsByFamily.get(c.family) ?? idsByFamily.set(c.family, []).get(c.family)!).push(c.id);
  const rows = await withTenants([tenantId], async (cl) => {
    const found = new Map<string, RecordRow>();
    for (const [family, ids] of idsByFamily) {
      const res = await cl.query<RecordRow>(FAMILY_SPECS[family].sql, [ids]);
      for (const r of res.rows) found.set(`${family}:${r.id}`, r);
    }
    return found;
  });

  const moduleOn = new Map<string, boolean>();
  for (const c of candidates) {
    const m = FAMILY_SPECS[c.family].module;
    if (m && !moduleOn.has(m)) moduleOn.set(m, await isModuleEnabled(tenantId, m));
  }

  const staged: Array<{ candidate: Candidate; row: RecordRow; resources: Resource[] }> = [];
  for (const candidate of candidates) {
    const spec = FAMILY_SPECS[candidate.family];
    if (spec.module && !moduleOn.get(spec.module)) continue;
    const row = rows.get(`${candidate.family}:${candidate.id}`);
    if (!row || !row.title) continue;
    const resources = spec.resources(row, tenantId);
    if (resources.length === 0) continue;
    staged.push({ candidate, row, resources });
  }
  if (staged.length === 0) return [];

  // 2. the read checks. Flatten (a file has two), batch, then require every resource of a hit to allow.
  const flat = staged.flatMap((s) => s.resources);
  const allowed = await readAllowed(principal, flat);
  const out: AllowedHit[] = [];
  let at = 0;
  for (const s of staged) {
    const mine = allowed.slice(at, at + s.resources.length);
    at += s.resources.length;
    if (mine.every(Boolean)) {
      out.push({ candidate: s.candidate, title: s.row.title as string, href: FAMILY_SPECS[s.candidate.family].href(s.row) });
    }
  }
  return out;
}

/** `read` on each resource for the caller, and, when the caller acts for a human, for that human as well (both must allow). */
async function readAllowed(principal: Principal, resources: readonly Resource[]): Promise<boolean[]> {
  const own = await checkMany(principal, resources, "read");
  if (!principal.actFor || principal.actFor.userId === principal.userId) return own;
  const onBehalfOf = await assemblePrincipal(principal.actFor.userId, principal.assurance);
  if (!onBehalfOf) return resources.map(() => false); // an unresolvable acting user fails CLOSED, as authorize() does
  const delegated = await checkMany({ ...onBehalfOf, via: principal.via }, resources, "read");
  return own.map((a, i) => a && delegated[i]);
}
