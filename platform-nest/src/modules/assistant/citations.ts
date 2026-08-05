// ASST-18 — resolving a knowledge citation chip into something the UI can actually navigate to.
//
// Ticket: docs/superpowers/plans/2026-08-05-d14-and-assistant-tickets.md ("### ASST-18").
// Design: docs/blueprints/assistant-foundation.md §8.
//
// ── THE BAR: "A CHIP THAT 404s IS WORSE THAN NO CHIP" (the ticket's own words) ──────────────────────
// This file is deliberately NARROW. It only ever returns a target for a `sourceRef` it can map to a
// REAL, still-existing, tenant-scoped entity with a page that already exists in platform-ui. Every
// other case — a kind this file doesn't cover, a stale ref whose row was deleted since it was
// embedded, a malformed ref, a ref whose embedded tenant doesn't match the caller's own — is an
// honest `null` (the controller turns that into a 404). The frontend renders an unresolvable
// citation as plain, non-clickable text, never as a link promising a destination it cannot deliver.
//
// ── THE REF FORMAT IS NOT INVENTED HERE ─────────────────────────────────────────────────────────────
// `sourceRef` is exactly what `modules/knowledge/ingest/erp-source.ts` stamps onto every
// internal-tier chunk it ingests from live ERP records: `erp:<kind>:<id...>`, where `<id...>` is
// occasionally itself colon-separated (`erp:person:<tenantId>:<userId>`,
// `erp:report:<grain>:<scopeRef>`). Read that file before adding a new `case` below — the two files
// must agree on the shape or a whole ingested kind silently stops resolving.
//
// ── TENANT SCOPING ───────────────────────────────────────────────────────────────────────────────────
// `tenantId` is the ALREADY-AUTHORIZED route tenant, never derived from the ref. Every query below
// runs inside the caller's `withTenants([tenantId], ...)`, whose RLS predicate is what actually
// prevents resolving another tenant's row — but two ref shapes (`person`, `org`, `orgunits`) also
// carry a tenant id INSIDE the ref itself (erp-source.ts's own convention), and this file checks
// that embedded id matches the route tenant before trusting the rest of the ref. That is not a
// second RLS layer (RLS already can't leak a row); it is the difference between an honest 404 and a
// confusing "this ref clearly wasn't meant for you but resolved anyway" near-miss.
import type { PoolClient } from "pg";

export interface ResolvedCitation {
  kind: string;
  label: string;
  href: string;
}

function parseSourceRef(ref: string): { kind: string; rest: string } | null {
  const m = /^erp:([a-z]+):(.+)$/.exec(ref);
  return m ? { kind: m[1], rest: m[2] } : null;
}

async function one<T extends Record<string, unknown>>(c: PoolClient, sql: string, params: unknown[]): Promise<T | undefined> {
  const r = await c.query<T>(sql, params);
  return r.rows[0];
}

/**
 * Resolve one `sourceRef` to a navigable target, or `null` when this file has no honest
 * destination for it (see file header — that is the common, EXPECTED outcome for several real
 * ingested kinds, e.g. `report`/`file`, not a bug to "fix" by inventing a link).
 */
export async function resolveCitation(c: PoolClient, tenantId: string, sourceRef: string): Promise<ResolvedCitation | null> {
  const parsed = parseSourceRef(sourceRef);
  if (!parsed) return null;
  const { kind, rest } = parsed;

  switch (kind) {
    case "client": {
      const row = await one<{ id: string; name: string }>(c, `SELECT id, name FROM clients WHERE id = $1 AND deleted_at IS NULL`, [rest]);
      return row ? { kind, label: row.name || "Client", href: `/clients/${row.id}` } : null;
    }
    case "project": {
      const row = await one<{ id: string; name: string }>(c, `SELECT id, name FROM projects WHERE id = $1 AND deleted_at IS NULL`, [rest]);
      return row ? { kind, label: row.name || "Project", href: `/projects/${row.id}` } : null;
    }
    case "task": {
      const row = await one<{ id: string; title: string }>(c, `SELECT id, title FROM tasks WHERE id = $1 AND deleted_at IS NULL`, [rest]);
      return row ? { kind, label: row.title || "Task", href: `/tasks/${row.id}` } : null;
    }
    // `pm_tasks` is the PM console's own richer task table (distinct from core `tasks` above — see
    // erp-source.ts's own header on why both are indexed). It has no standalone detail route yet;
    // the honest destination is the project that contains it.
    case "pmtask": {
      const row = await one<{ id: string; title: string; project_id: string }>(
        c,
        `SELECT id, title, project_id FROM pm_tasks WHERE id = $1 AND deleted_at IS NULL`,
        [rest],
      );
      return row ? { kind, label: row.title || "Task", href: `/projects/${row.project_id}` } : null;
    }
    case "deliverable": {
      const row = await one<{ id: string; name: string; project_id: string }>(
        c,
        `SELECT id, name, project_id FROM deliverables WHERE id = $1 AND deleted_at IS NULL`,
        [rest],
      );
      return row ? { kind, label: row.name || "Deliverable", href: `/projects/${row.project_id}` } : null;
    }
    case "pmdoc": {
      const row = await one<{ id: string; title: string; project_id: string }>(
        c,
        `SELECT id, title, project_id FROM pm_docs WHERE id = $1 AND deleted_at IS NULL`,
        [rest],
      );
      return row ? { kind, label: row.title || "Document", href: `/projects/${row.project_id}` } : null;
    }
    case "meeting": {
      const row = await one<{ id: string; title: string }>(c, `SELECT id, title FROM meeting_recordings WHERE id = $1`, [rest]);
      return row ? { kind, label: row.title || "Meeting", href: `/meetings/${row.id}` } : null;
    }
    case "person": {
      // rest = "<tenantId>:<userId>" (erp-source.ts's own person ref shape). The embedded tenant
      // MUST match the route tenant — see file header's tenant-scoping note.
      const idx = rest.lastIndexOf(":");
      if (idx < 0) return null;
      const refTenant = rest.slice(0, idx);
      const userId = rest.slice(idx + 1);
      if (refTenant !== tenantId) return null;
      const row = await one<{ id: string; name: string }>(
        c,
        `SELECT u.id, u.name FROM company_memberships cm JOIN users u ON u.id = cm.user_id
           WHERE cm.tenant_id = $1 AND cm.user_id = $2 AND cm.deleted_at IS NULL AND u.deleted_at IS NULL`,
        [tenantId, userId],
      );
      return row ? { kind, label: row.name || "Person", href: `/people/${row.id}` } : null;
    }
    // rest = the tenantId itself (erp-source.ts) for both — same embedded-tenant guard as "person".
    case "org":
    case "orgunits": {
      if (rest !== tenantId) return null;
      return { kind, label: kind === "org" ? "Org structure" : "Departments", href: `/companies/${tenantId}/org` };
    }
    default:
      return null; // report/file/unknown kind — no honest destination yet, see file header.
  }
}
