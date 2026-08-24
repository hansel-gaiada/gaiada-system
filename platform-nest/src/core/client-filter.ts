// CC-1 — the staff-side `?clientId=` list facet.
//
// One parser, one vocabulary, for every staff list that can be narrowed to a client:
//   clientId absent        -> { kind: "all" }        every row, exactly as before this existed
//   clientId=<uuid>        -> { kind: "client" }     that client's rows
//   clientId=internal      -> { kind: "internal" }   rows with NO client (own-brand, IT, HR, platform)
//
// ── ⚠ THIS IS A FILTER, NOT A BOUNDARY. DO NOT MERGE IT WITH portal-scope.ts. ─────────────────────
// `core/portal-scope.ts` is an AUTHORIZATION BOUNDARY: an external client contact must never reach
// another client's rows, so every portal query is REQUIRED to carry its predicate and its failure mode
// is deny. This file is the opposite kind of thing — a staff member who is authorized on
// `pm_task.read` may already read every task in the tenant, and narrowing the list changes only what
// is DISPLAYED. So:
//
//   - An absent or unparseable value resolves to `{ kind: "all" }` — it NEVER denies. A boundary fails
//     closed; a filter must fail OPEN, because a filter that fails closed silently hides real work and
//     looks identical to "there is nothing here".
//   - Passing another client's id is NOT an escalation and must not 403. It returns that client's rows,
//     which the same caller could already have read unfiltered.
//
// The two files look superficially alike and must stay separate. Collapsing them into one "client
// scope" abstraction is precisely how a convenience filter silently becomes load-bearing for isolation
// without anyone deciding that it should be. Staff isolation stays where it already is: RLS for the
// tenant wall, Cerbos for the action.
//
// ── WHY `internal` MEANS `client_id IS NULL`, NOT `is_internal = true` ────────────────────────────
// `projects` carries BOTH. They are meant to agree — `knowledge/ingest/erp-source.ts` renders
// `is_internal` as literally "internal project (no client)" — but on the live estate (2026-08-24) they
// do not: of 9 clientless projects, 7 are flagged `is_internal` and **2 are not**.
//
// Defining the internal scope as `is_internal = true` would leave those 2 projects reachable from NO
// scope at all: not from any client (they have none) and not from Internal (they are not flagged).
// Work that exists in no view is the exact failure this facet is meant to prevent, so the predicate is
// the structural fact (`client_id IS NULL`) rather than the editorial flag. `is_internal` remains
// useful as a data-quality signal — a clientless project that is not flagged is drift worth showing
// someone — but it is not the filter.

import { BadRequestException } from "@nestjs/common";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The reserved value selecting rows that belong to no client. Cannot collide with a uuid. */
export const INTERNAL_CLIENT = "internal";

export type ClientFilter =
  | { kind: "all" }
  | { kind: "internal" }
  | { kind: "client"; clientId: string };

/** Parse `?clientId=`. Never throws for a *shape* problem — see the fail-open note in the header.
 *
 *  `strict` exists for the one caller that genuinely needs a 400 (a route where the client is the
 *  SUBJECT, not a filter, e.g. an aggregate keyed on one client). Default is the filter behaviour. */
export function parseClientFilter(raw: unknown, strict = false): ClientFilter {
  if (typeof raw !== "string") return { kind: "all" };
  const v = raw.trim();
  if (v === "") return { kind: "all" };
  if (v.toLowerCase() === INTERNAL_CLIENT) return { kind: "internal" };
  if (!UUID_RE.test(v)) {
    if (strict) throw new BadRequestException(`clientId must be a uuid or "${INTERNAL_CLIENT}"`);
    // A hand-edited query string is a bad filter, not a bad request: show everything rather than
    // 500ing on a uuid cast or, worse, quietly returning an empty list that reads as real data.
    return { kind: "all" };
  }
  return { kind: "client", clientId: v };
}

/** SQL fragment + params for the filter, given the column to test and the next free placeholder.
 *
 *  Returns a fragment that is always safe to `AND` into a WHERE clause — `{ kind: "all" }` yields
 *  `TRUE` rather than an empty string, so a caller cannot accidentally build `WHERE  AND x`, and the
 *  fragment reads correctly whether it is the first predicate or the fifth.
 *
 *  The id is compared **as text** (`<col>::text = $n`) on purpose. Casting the PARAMETER to uuid makes
 *  a malformed id a 500 from Postgres instead of a miss; the `/pipeline/runs` clientId filter set that
 *  convention and this follows it. (`parseClientFilter` already rejects non-uuids, so this is the
 *  second layer, not the only one.) */
export function clientFilterSql(
  filter: ClientFilter,
  column: string,
  nextParamIndex: number,
): { sql: string; params: unknown[] } {
  switch (filter.kind) {
    case "all":
      return { sql: "TRUE", params: [] };
    case "internal":
      return { sql: `${column} IS NULL`, params: [] };
    case "client":
      return { sql: `${column}::text = $${nextParamIndex}`, params: [filter.clientId] };
  }
}
