// TR-15 — the seal/amend service (§ "Seal semantics", §0057 rule 2/3, §15's TR-07/TR-08 rulings
// on why this ticket matters more than a normal one: #20 `overdue_open` reads TODAY's task state
// over a past range, and `pm_task_assignees`' as-of window only covers what TR-34 closed — sealing
// is the ONLY mechanism that freezes a period against both gaps, and TR-14's migration must not
// slip past the first period the business intends to appraise on).
//
// ─────────────────────────────── LAYERING (mirrors document-builder.ts / leave-decision.ts) ─────
// This file is framework-agnostic: no Nest imports, no HttpException. `sealPeriod`/`amendPeriod`
// return a discriminated result (`{ok:true,...} | {ok:false, reason}`); reports.controller.ts
// maps `reason` to the right HTTP status (404/422/409). This keeps the service directly
// unit/db-testable without spinning up Nest, the same split `document-builder.ts` uses (pure
// core, I/O at the edges) and the same result-shape convention `leave-decision.ts` uses for its
// own idempotent state-transition.
//
// ─────────────────────────────── THE SEAL FLOW (§ Seal semantics, verbatim) ───────────────────────
//   recompute facts for the range -> build one ReportDocument per in-scope (grain, scope) ->
//   insert report_documents rows at the current revision -> flip status='sealed' + seal_hash ->
//   upsert the period's metrics into rollup_metrics -> emit reports.period.sealed.
// Custom ranges never reach step 2 — rejected with 422 before any of this runs (§0057 rule 2),
// so rollup_metrics is untouched for them too (rule 3), for free, by construction.
//
// ─────────────────────────────── TR-27 · AI narrative, layered on step 2 only (§9.1/§15) ────────
// `buildReportDocument` already returns a DETERMINISTIC `narrative` (document-builder.ts's
// `buildNarrative`, TR-13, unchanged by this ticket). Right here — and ONLY here, never in
// `buildReportDocument` itself — this file tries ONE `completeViaGateway` call per (grain,
// scopeRef) to upgrade that narrative to AI prose, via the pure `narrative.ts` module (prompt
// build + parse, zero I/O of its own; see its header for the fail-soft/hallucinated-numeral
// contract). This is deliberate and load-bearing: sealing is the ONLY place the reports module
// ever calls the gateway, so a live/ops document read (an open period, or any GET on a sealed one)
// never triggers AI spend or latency (§9.1: "live/ops reads default to deterministic"). Any
// failure — gateway unconfigured/down/timeout, or `narrative.ts`'s own guards rejecting the
// completion — falls straight back to the SAME deterministic narrative `buildReportDocument`
// already computed; nothing about the rest of this function's contract or atomicity changes.
//
// ─────────────────────────────── SCOPING DECISIONS RECORDED HERE (none are schema/contract calls) ─
// 1. In-scope (grain, scopeRef) enumeration reuses the EXACT rows `GET /reports/overview` already
//    derives (`computeReportRangeRows` + `rowGrainShape`) — "everyone/everything with a rollup row
//    in range" — rather than a second, independently-written membership walk that could disagree
//    with what the overview listing shows for the same period.
// 2. Department-grain sealing covers the entity's OWN view only; a servedTenant provider slice
//    (§3.2) is NOT separately sealed. Documented the same way TR-13 documented its own
//    deliberately-not-exhaustive chart subset — the provider view stays live-only for now.
// 3. The status-flip UPDATE is `WHERE status <> 'sealed'` (optimistic): the compute phase (facts
//    recompute + building every document) is NOT held under one lock, only the final write is —
//    a concurrent double-seal call loses the race there and gets `already_sealed`, never a
//    duplicate `report_documents` write (the table's own UNIQUE constraint would reject that
//    regardless, but the status guard stops it before it tries).
import { createHash } from "node:crypto";
import { withGlobal, withTenants, type WithTenantsOptions } from "../../db";
import { config } from "../../config";
import { notify, writeActivity, type NotificationPayload } from "../../core/http";
import { emitEvent } from "../../events/outbox.service";
import { recomputeFactWindow } from "./fact-job";
import { buildReportDocument, computeReportRangeRows, rowGrainShape } from "./document-builder";
import { buildGroundingFacts, buildNarrativePrompt, parseNarrative } from "./narrative";
import { completeViaGateway, type GatewayCallOptions } from "../search/providers/gateway-client";
import { upsertRows as upsertRollupRows } from "../../rollups/engine";
import { formatPeriodRange } from "./metrics";
import { getPeriodById, PERIOD_COLUMNS, type PeriodRow } from "./report-periods";
import type { ReportDocument, ReportGrain } from "./report-document";
import type { RollupRow } from "../contract";

/** §4a invariant 7's module scope for every reports-module transaction in this file. */
const SEAL_MODULES: WithTenantsOptions = { modules: ["reports", "pm", "hr"] };

/** The explicit message §0057 rule 2 quotes verbatim for both the seal endpoint and appraisal
 *  generate (TR-24) — never a silent skip. */
export const CUSTOM_SEAL_REJECT_MESSAGE = "custom ranges are ad-hoc reads; appraisal requires a sealed calendar period";

// ═══════════════════════════════ PURE — the tamper-evident hash ═══════════════════════════════

export interface SealedDocumentEntry {
  grain: ReportGrain;
  scopeRef: string;
  document: ReportDocument;
}

/** Deep-canonical `JSON.stringify`: object keys sorted at every level (array ORDER is preserved —
 *  it's significant for `kpis`/`series`/etc). Required because `report_documents.document` is a
 *  `jsonb` column: Postgres's jsonb storage does not preserve the ORIGINAL key insertion order
 *  (it deduplicates/reorders keys internally), so a document read back via `SELECT` has different
 *  key ordering than the JS object that was written — a plain `JSON.stringify` would hash the
 *  freshly-built and the round-tripped-through-Postgres copy of the IDENTICAL data differently.
 *  Sorting keys first makes the hash immune to that round-trip, which is exactly what "seal_hash
 *  verifies over the period's document set [as read back from storage]" requires.
 *
 *  Sorting keys is NOT sufficient on its own, though — the round-trip also DROPS things, and this
 *  function has to drop exactly the same ones or the hash still cannot be reproduced from storage:
 *
 *    - `undefined`-valued keys. `JSON.stringify` (which is what writes the jsonb) omits them
 *      entirely; `Object.keys()` still lists them, and `JSON.stringify(undefined)` returns the
 *      VALUE `undefined`, which template-interpolates as the literal text `undefined`. So a
 *      document carrying `header.warnings: undefined` (computeHeaderWarnings returns undefined
 *      whenever a period has no warnings — i.e. the common case) hashed as
 *      `..."warnings":undefined...` at seal time and as nothing at all from storage. That made
 *      seal_hash UNVERIFIABLE for essentially every sealed period: TR-15's own "seal_hash
 *      verifies" test failed on it, and because a tamper check that never reproduces reads
 *      identically to a tamper check that caught tampering, the failure mode was a permanent
 *      false "these rows were altered".
 *    - anything with a `toJSON()` (e.g. a `Date`). `JSON.stringify` uses it; the object branch
 *      below would otherwise see no own enumerable keys and emit `{}`. Not currently reachable
 *      (`generatedAt` is already an ISO string) but it is the identical failure mode one field
 *      away, so it is closed here rather than left as a trap.
 *
 *  Array holes/`undefined` elements become `null`, again matching `JSON.stringify`. */
function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalStringify(v))).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") return canonicalStringify((toJSON as () => unknown).call(value));
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** sha256 over the period's whole document set, order-independent (sorted by grain then
 *  scopeRef first) so the same set hashes identically regardless of fan-out ordering, AND
 *  key-order-independent (`canonicalStringify`) so hashing the freshly-BUILT documents at seal
 *  time and hashing the SAME documents re-read from `report_documents` afterward (the "seal_hash
 *  verifies" acceptance bar) always agree. This is a TAMPER-EVIDENCE check (did the stored rows
 *  change since seal), not a general-purpose canonical-JSON library. */
export function computeSealHash(entries: SealedDocumentEntry[]): string {
  const sorted = [...entries].sort((a, b) => (a.grain === b.grain ? a.scopeRef.localeCompare(b.scopeRef) : a.grain.localeCompare(b.grain)));
  const canonical = canonicalStringify(sorted.map((e) => ({ grain: e.grain, scopeRef: e.scopeRef, document: e.document })));
  return createHash("sha256").update(canonical).digest("hex");
}

// ═══════════════════════════════ I/O — in-scope (grain, scopeRef) enumeration ═══════════════════

/** Every (grain, scopeRef) with at least one rollup row in [start,end], plus the single
 *  company-grain scope (the tenant itself, which `computeReportRangeRows` never emits a row
 *  for directly). Reuses the SAME rows the `/reports/overview` listing already derives —
 *  scoping decision ①, see file header. Department-grain servedTenant provider slices are
 *  excluded (scoping decision ②). */
function enumerateInScope(tenantId: string, rows: RollupRow[]): { grain: ReportGrain; scopeRef: string }[] {
  const out = new Map<string, { grain: ReportGrain; scopeRef: string }>();
  for (const r of rows) {
    const dims = r.dimensions ?? {};
    const grain = rowGrainShape(dims);
    if (grain === "company") continue; // added once, below
    if (grain === "department" && dims.servedTenant) continue; // scoping decision ②
    const scopeRef = String(grain === "person" ? dims.userId : grain === "project" ? dims.projectId : dims.unit);
    out.set(`${grain}:${scopeRef}`, { grain, scopeRef });
  }
  out.set(`company:${tenantId}`, { grain: "company", scopeRef: tenantId });
  return [...out.values()];
}

// ═══════════════════════════════ I/O — notify exec/leads (amend) ═══════════════════════════════

/** "notifies exec/leads" (§ Seal semantics' amend line) = every `company_admin`/`group_executive`
 *  grant covering this tenant (global scope, or company scope == this tenant) — the same tier
 *  `resource_report_period.yaml` gates seal/amend/pin on, so whoever COULD have sealed/amended is
 *  who gets told. `notify()` is best-effort and silently skips a recipient with no active
 *  membership row in this tenant (its own documented behaviour) — a pure-global exec with no
 *  membership here simply does not get an in-app row, an accepted limitation of the shared
 *  helper, not something this ticket changes. */
async function notifyExecsAndLeads(tenantId: string, actorId: string | null, type: string, payload: NotificationPayload): Promise<void> {
  const { rows } = await withGlobal((c) =>
    c.query<{ user_id: string }>(
      `SELECT DISTINCT ur.user_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        WHERE r.name IN ('company_admin', 'group_executive')
          AND (ur.scope_type = 'global' OR (ur.scope_type = 'company' AND ur.scope_id = $1))`,
      [tenantId],
    ),
  );
  await Promise.all(rows.map((row) => notify(tenantId, row.user_id, actorId, type, payload)));
}

// ═══════════════════════════════ ORCHESTRATION — seal ═══════════════════════════════

export type SealResult = { ok: true; period: PeriodRow; documentCount: number } | { ok: false; reason: "not_found" | "custom_kind" | "already_sealed" };

/** The whole seal flow (file header). `actorUserId` is null for the n8n schedule/system seal
 *  (§0057's `sealed_by` column comment) — `report_periods.sealed_by` and the outbox `emitEvent`
 *  actor both tolerate that. `gatewayOpts` is TEST-ONLY (mirrors `providers/gateway-client.ts`'s
 *  own `GatewayCallOptions` escape hatch): production callers (reports.controller.ts) never pass
 *  it, so `completeViaGateway` always resolves the real configured gateway from `config`. */
export async function sealPeriod(tenantId: string, periodId: string, actorUserId: string | null, gatewayOpts?: GatewayCallOptions): Promise<SealResult> {
  const period = await getPeriodById(tenantId, periodId);
  if (!period) return { ok: false, reason: "not_found" };
  // §0057 rule 2: a required acceptance criterion, never a silent skip. Checked BEFORE any work
  // happens — a custom period must never even trigger a facts recompute under the seal path.
  if (period.periodKind === "custom") return { ok: false, reason: "custom_kind" };
  if (period.status === "sealed") return { ok: false, reason: "already_sealed" };

  const { periodStart: start, periodEnd: end } = period;
  const nextRevision = period.status === "amended" ? period.revision + 1 : period.revision;

  // Step 1: recompute facts for the range — a never-before-computed or stale historical slice
  // must not be sealed as though it were fresh (idempotent DELETE+INSERT per day, §4a invariant 5).
  await recomputeFactWindow(tenantId, start, end);

  // Step 2: one rollup-rows fetch, reused for BOTH the in-scope enumeration and the rollup_metrics
  // upsert below (never two independently-derived aggregations of the same period).
  const rangeRows = await computeReportRangeRows(tenantId, start, end);
  const scopes = enumerateInScope(tenantId, rangeRows);

  // SEQUENTIAL, not Promise.all: a real race a first run of this test suite caught. When the
  // sealed range includes TODAY (e.g. sealing "this month" mid-month), every `buildReportDocument`
  // call independently re-runs document-builder.ts's own `ensureTodayFresh` lazy-backstop (a
  // DELETE+INSERT of that one (tenant, fact_date) slice) — fine run once, but running N of them
  // concurrently across scopes races two overlapping transactions on the SAME slice and one loses
  // with `duplicate key value violates unique constraint "report_work_facts_pkey"`. Sequencing
  // costs some wall-clock time (each redundant re-derivation after the first is a cheap no-op
  // rewrite of identical rows) but is correct for any period whose range reaches today, not only
  // for wholly-historical ones.
  const documents: SealedDocumentEntry[] = [];
  for (const { grain, scopeRef } of scopes) {
    const doc = await buildReportDocument({ tenantId, grain, scopeRef, periodKind: period.periodKind, start, end });

    // TR-27: try to upgrade doc.narrative (deterministic) to AI prose. ONE completeViaGateway
    // call, caught here (never inside narrative.ts — that file makes no I/O of its own, same
    // split as search/ai-drafts.ts + search.controller.ts). Any failure -> completionText stays
    // null -> parseNarrative falls back to `doc.narrative` unchanged, never throws.
    const facts = buildGroundingFacts(doc);
    let completionText: string | null = null;
    let model: string | null = null;
    try {
      const completion = await completeViaGateway(buildNarrativePrompt(facts), gatewayOpts);
      completionText = completion.text;
      model = completion.provider ?? null;
    } catch {
      completionText = null; // gateway unconfigured/down/timeout — fall through, never throw
    }
    const narrative = parseNarrative(completionText, model, facts, doc.narrative);

    const sealedDoc: ReportDocument = {
      ...doc,
      header: {
        ...doc.header,
        sealed: true,
        periodId: period.id,
        revision: nextRevision,
        ...(period.label ? { customLabel: period.label } : {}),
      },
      narrative,
    };
    documents.push({ grain, scopeRef, document: sealedDoc });
  }

  const sealHash = computeSealHash(documents);

  // Step 3: the atomic write — status flip (optimistic WHERE status<>'sealed', closing the
  // check-then-act race per the file header) + every report_documents row + the outbox event,
  // sequenced on ONE client/transaction (never concurrent queries on a shared client).
  const sealed = await withTenants(
    [tenantId],
    async (c) => {
      const upd = await c.query<{ id: string }>(
        `UPDATE report_periods
            SET status = 'sealed', revision = $3, sealed_at = now(), sealed_by = $4, seal_hash = $5, updated_at = now()
          WHERE id = $1 AND tenant_id = $2 AND status <> 'sealed'
          RETURNING id`,
        [periodId, tenantId, nextRevision, actorUserId, sealHash],
      );
      if (!upd.rows[0]) return false; // lost the race to a concurrent seal call
      for (const d of documents) {
        await c.query(
          `INSERT INTO report_documents (id, tenant_id, period_id, revision, grain, scope_ref, document, narrative_source, origin_site)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
          [tenantId, periodId, nextRevision, d.grain, d.scopeRef, JSON.stringify(d.document), d.document.narrative.source, config.originSite],
        );
      }
      await emitEvent(c, tenantId, "report_period", periodId, "reports.period.sealed", {
        periodKind: period.periodKind,
        periodStart: start,
        periodEnd: end,
        revision: nextRevision,
        sealHash,
        documentCount: documents.length,
        grains: [...new Set(documents.map((d) => d.grain))],
      });
      return true;
    },
    SEAL_MODULES,
  );
  if (!sealed) return { ok: false, reason: "already_sealed" };

  // Step 4 (§0057 rule 3): calendar periods ONLY persist to rollup_metrics — custom already
  // rejected above, so every period reaching this line is a calendar kind by construction.
  await upsertRollupRows(tenantId, "reports", formatPeriodRange(start, end), rangeRows);

  const sealedPeriod = await getPeriodById(tenantId, periodId);
  return { ok: true, period: sealedPeriod!, documentCount: documents.length };
}

// ═══════════════════════════════ ORCHESTRATION — amend ═══════════════════════════════

export type AmendResult = { ok: true; period: PeriodRow } | { ok: false; reason: "not_found" | "not_sealed" | "reason_required" };

/** `POST .../periods/:id/amend {reason}`: flips a SEALED period to `amended` + records the
 *  reason, audits, and notifies exec/leads. The actual re-seal (revision+1, keeping the old
 *  revision's rows) happens through a SUBSEQUENT call to `sealPeriod` on the same id — this
 *  function only performs the flag + notify half. */
export async function amendPeriod(tenantId: string, periodId: string, actorUserId: string | null, reason: string | undefined): Promise<AmendResult> {
  const trimmed = reason?.trim();
  if (!trimmed) return { ok: false, reason: "reason_required" };

  const existing = await getPeriodById(tenantId, periodId);
  if (!existing) return { ok: false, reason: "not_found" };

  const { rows } = await withTenants(
    [tenantId],
    (c) =>
      c.query<PeriodRow>(
        `UPDATE report_periods SET status = 'amended', amend_reason = $3, updated_at = now()
          WHERE id = $1 AND tenant_id = $2 AND status = 'sealed'
          RETURNING ${PERIOD_COLUMNS}`,
        [periodId, tenantId, trimmed],
      ),
    SEAL_MODULES,
  );
  if (!rows[0]) return { ok: false, reason: "not_sealed" };
  const period = rows[0];

  await writeActivity(tenantId, actorUserId, "amended", "report_period", periodId, { reason: trimmed, revision: period.revision });
  await notifyExecsAndLeads(tenantId, actorUserId, "reports.period.amended", {
    title: "A sealed report period was amended",
    body: trimmed,
    href: `/reports?periodId=${periodId}`,
    entityType: "report_period",
    entityId: periodId,
    severity: "warning",
  });

  return { ok: true, period };
}

// ═══════════════════════════════ I/O — sealed-document read (reports.controller.ts) ═══════════

/** The document-read sealed branch's storage lookup: latest revision, or the EXACT `?revision=`
 *  pin when given. Returns null (never throws) — the controller decides 404 vs. graceful
 *  live-compute fallback per §6.2's own read semantics. */
export async function fetchSealedDocument(tenantId: string, periodId: string, grain: ReportGrain, scopeRef: string, revision?: number): Promise<ReportDocument | null> {
  const { rows } = await withTenants(
    [tenantId],
    (c) =>
      revision === undefined
        ? c.query<{ document: ReportDocument }>(
            `SELECT document FROM report_documents
              WHERE tenant_id = $1 AND period_id = $2 AND grain = $3 AND scope_ref = $4
              ORDER BY revision DESC LIMIT 1`,
            [tenantId, periodId, grain, scopeRef],
          )
        : c.query<{ document: ReportDocument }>(
            `SELECT document FROM report_documents
              WHERE tenant_id = $1 AND period_id = $2 AND grain = $3 AND scope_ref = $4 AND revision = $5`,
            [tenantId, periodId, grain, scopeRef, revision],
          ),
    SEAL_MODULES,
  );
  return rows[0]?.document ?? null;
}
