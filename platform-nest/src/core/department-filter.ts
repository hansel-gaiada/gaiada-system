// DW-6d / DW-6g — the staff-side `?departmentId=` list facet (docs/FRONTEND-BFF-CONTRACT.md §33).
//
// "The department's" clients, deliverables and projects are those with a LIVE project whose
// `projects.department_id` (an org-node id: free text, no FK, migration 0029) is the named node or
// any node under it in the company's org tree (`org_unit_closure`, migration 0101: self-inclusive at
// depth 0, keyed by tenant, rebuilt on every org save). There is no department column on `clients`
// or `deliverables`; a project is the one link they have.
//
//   departmentId absent or blank -> { kind: "all" }            every row, exactly as before this existed
//   departmentId=<node id>       -> { kind: "unit", nodeId }   rows whose project sits at the node or under it
//
// ── ⚠ THIS IS A FILTER, NOT A BOUNDARY (the same stance as `core/client-filter.ts`). ──────────────
// It narrows what is DISPLAYED. A caller authorized on `client` / `deliverable` / `project` `read`
// could already read every row unfiltered, so naming another department is not an escalation and an
// id that names no node is an empty list, never a 404. Do not merge it with `portal-scope.ts` or any
// authorization helper; staff isolation stays in RLS (the tenant wall) and Cerbos (the action).
//
// One deliberate difference from `parseClientFilter`: a SHAPE problem here is a 400, not fail-open.
// A malformed id cannot be a typo for "show me everything"; it can only be a broken caller, and a
// quiet fall-through to the full list would read as that department's real answer. The caller parses
// AFTER `authorize`, so a denial stays a denial whatever the query string says.
//
// ── One company only. Node ids are unique only per company, and every list runs under
// `withTenants([tenantId])`, so a node id from another company matches nothing. The closure
// sub-select carries the tenant too; the extra equality on the node itself keeps its own projects
// for a company whose closure has not been rebuilt yet.

import { BadRequestException } from "@nestjs/common";

export type DepartmentFilter = { kind: "all" } | { kind: "unit"; nodeId: string };

/** The longest accepted node id. Org node ids are short slugs or uuids; this is only a sanity bound. */
export const DEPARTMENT_ID_MAX = 200;

// C0 controls and DEL (a tab or newline in an id is never a real one). A char-code scan, not a regex: a control-character
// regex trips `no-control-regex`.
function hasControlChar(v: string): boolean {
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** Parse `?departmentId=`. Absent, empty or whitespace mean "all". Anything else is trimmed and must be
 *  1 to 200 characters with no control characters, else 400 `{ error, field: "departmentId" }`. */
export function parseDepartmentFilter(raw: unknown): DepartmentFilter {
  if (raw === undefined || raw === null) return { kind: "all" };
  // `?departmentId=a&departmentId=b` arrives as an array: ambiguous, so refused rather than guessed at.
  if (typeof raw !== "string") {
    throw new BadRequestException({ message: "departmentId must be a single org node id", field: "departmentId" });
  }
  const v = raw.trim();
  if (v === "") return { kind: "all" };
  if (v.length > DEPARTMENT_ID_MAX) {
    throw new BadRequestException({
      message: `departmentId must be at most ${DEPARTMENT_ID_MAX} characters`,
      field: "departmentId",
    });
  }
  if (hasControlChar(v)) {
    throw new BadRequestException({ message: "departmentId must not contain control characters", field: "departmentId" });
  }
  return { kind: "unit", nodeId: v };
}

/** SQL fragment + params for the filter.
 *
 *  - `column`       the project's department column to test, e.g. `p.department_id` or `dp.department_id`.
 *  - `tenantParam`  the 1-based placeholder number the CALLER has already bound to the company id.
 *  - `nextParam`    the next free 1-based placeholder number; the node id takes it, and `params` is
 *                   exactly the values to append from there (one for a unit, none for "all").
 *
 *  `{ kind: "all" }` yields `TRUE`, so the fragment is always safe to `AND` into a WHERE clause.
 *  The node id is compared as text, and the tenant is cast, inside the fragment, so the placeholders
 *  keep one type each however the caller uses them elsewhere in the query. */
export function departmentFilterSql(
  filter: DepartmentFilter,
  column: string,
  tenantParam: number,
  nextParam: number,
): { sql: string; params: unknown[] } {
  if (filter.kind === "all") return { sql: "TRUE", params: [] };
  return {
    sql:
      `(${column} = $${nextParam}::text OR ${column} IN ` +
      `(SELECT oc.descendant_id FROM org_unit_closure oc ` +
      `WHERE oc.tenant_id = $${tenantParam}::uuid AND oc.ancestor_id = $${nextParam}::text))`,
    params: [filter.nodeId],
  };
}
