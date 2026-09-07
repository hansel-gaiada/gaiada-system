// AD-4/AD-5 — agency discovery intake (AD-1), the STAFF read + triage-disposition half.
// Design: docs/superpowers/plans/2026-09-05-agency-discovery-intake-design.md
//   §3.1 (no module wall) · §4.1 (lead lifecycle) · §5.2 (Cerbos actions) · §9.2 (reviewer needs)
//
// AD-6 (convert) is a SEPARATE ticket/owner and is NOT implemented here — this file only ever
// moves a lead into 'declined', 'nurturing' or 'in_review'. Nothing here writes
// converted_client_id/converted_project_id/pipeline_run_id.
//
// ── WHY THESE TABLES CARRY NO `module` DB-WALL OPTION HERE (design §3.1) ────────────────────────
// `agency_leads`/`agency_discovery_submissions` take the PLAIN tenant wall — the same MI-02 D-2a
// reasoning `webdev-change-requests.controller.ts` documents at its own header. Consequently every
// `withTenants([tenantId], ...)` call below deliberately passes NO `{ modules: [...] }` option.
// That is a DIFFERENT thing from the `module: "agency"` attribute passed to Cerbos's `authorize()`
// in the controller — that attribute only feeds derived-role string composition
// (`module_manager`/`module_staff`, ORG-6) and has nothing to do with the DB's third wall. Adding
// `{ modules: ["agency"] }` to any call below would make every prospect submission (and every
// subsequent staff read of it) silently return zero rows — the exact failure §3.1 exists to avoid.
import { BadRequestException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { newId, withTenants } from "../db";
import { config } from "../config";
import { emitEvent } from "../events/outbox.service";
import { scrubText } from "./scrub";

// ─────────────────────────────────────────────────────────────────────── field caps
const ORG_NAME_CAP = 300;
const CONTACT_NAME_CAP = 200;
const CONTACT_EMAIL_CAP = 320; // RFC 5321 practical max
const CONTACT_PHONE_CAP = 40;
const REASON_CAP = 1000;

// ─────────────────────────────────────────────────────────────── queue ordering (design §9.2)
/** The queue sorts by WHOSE MOVE IT IS, not by recency or by lifecycle order.
 *
 *    0  submitted — they answered; we owe them a review
 *    1  new       — we created the lead and never sent the form. Ours, and the easiest to drop.
 *    2  invited   — sent; legitimately waiting on them. Nothing for us to do but chase.
 *    3  the rest  — in_review / nurturing / converted / declined: already dispositioned.
 *
 *  `new` sorting ABOVE `invited` is the point of the split (see createStaffLead). A state that
 *  needs our action must never sit below one that does not.
 *
 *  The SQL `ORDER BY` in `listLeadsQueue` encodes this same mapping as a CASE; this function exists
 *  so it is a pinned, unit-tested contract rather than a string only Postgres ever sees. If the two
 *  ever disagree, only the SQL result is real — keep them in lockstep by eye when either changes. */
export function queueRank(status: string): number {
  if (status === "submitted") return 0;
  if (status === "new") return 1;
  if (status === "invited") return 2;
  return 3;
}

// ───────────────────────────────────────────────────────────── create (staff-sourced, AD-4)
export interface NormalizedLeadInput {
  orgName: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
}

/** Validates + normalizes a staff-entered lead (source='staff' — a prospect who called in).
 *
 *  `orgName`/`contactName` go through `scrubText()`: they are free text a staff member typed.
 *  `contactEmail`/`contactPhone` deliberately do NOT — they are the structured identifiers this
 *  row exists to store, and `scrubText`'s own email rule would rewrite a real address to the
 *  literal string `[REDACTED-EMAIL]`, destroying the only way to reach the prospect. This is the
 *  same free-text-vs-structured-field split `webdev-change-requests.controller.ts`'s
 *  `createInternal()` draws between `title`/`body` (scrubbed) and `clientId`/`projectId` (not). */
export function normalizeCreateLeadInput(body: {
  orgName?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
}): NormalizedLeadInput {
  const rawOrg = body?.orgName?.trim();
  if (!rawOrg) throw new BadRequestException("orgName required");
  const rawContactName = body?.contactName?.trim();
  const rawContactEmail = body?.contactEmail?.trim();
  const rawContactPhone = body?.contactPhone?.trim();
  return {
    orgName: scrubText(rawOrg).text.slice(0, ORG_NAME_CAP),
    contactName: rawContactName ? scrubText(rawContactName).text.slice(0, CONTACT_NAME_CAP) : null,
    contactEmail: rawContactEmail ? rawContactEmail.slice(0, CONTACT_EMAIL_CAP) : null,
    contactPhone: rawContactPhone ? rawContactPhone.slice(0, CONTACT_PHONE_CAP) : null,
  };
}

/** Staff-created lead, `source='staff'` — someone who phoned in rather than answering an invite.
 *
 *  Status starts at `'new'`, NOT `'invited'`. The gap was flagged during this ticket's review and
 *  the migration was amended rather than worked around: a lead sitting in `'invited'` that nobody
 *  ever sent anything to is indistinguishable from one we genuinely chased, which hides the single
 *  most droppable thing in an agency pipeline — "we met them and never sent the form". `'new'` is
 *  an ACTIONABLE queue state meaning *mint an invite*, not a placeholder.
 *
 *  Minting the token itself is AD-2/AD-3's surface; this only creates the row it hangs off. */
export async function createStaffLead(
  tenantId: string,
  actorId: string | null,
  input: NormalizedLeadInput,
): Promise<{ id: string }> {
  const id = newId();
  await withTenants([tenantId], async (c) => {
    await c.query(
      `INSERT INTO agency_leads
         (id, tenant_id, org_name, contact_name, contact_email, contact_phone, source, status, owner_id, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6, 'staff', 'new', $7, $8)`,
      [id, tenantId, input.orgName, input.contactName, input.contactEmail, input.contactPhone, actorId, config.originSite],
    );
    await emitEvent(c, tenantId, "agency_lead", id, "agency.lead.created", {
      source: "staff", orgName: input.orgName, actorId,
    });
  });
  return { id };
}

// ─────────────────────────────────────────────────────────────────────────── reads (AD-4)
/** The triage queue. `submitted` first, then `invited`, then everything else; oldest-first WITHIN
 *  each group — same "a queue is worked front-to-back" convention
 *  `webdev-change-requests.controller.ts`'s `list()` documents for its own queue.
 *
 *  Row reach beyond the tenant wall is RLS's job (a staff reader legitimately sees the whole
 *  tenant's queue); the CALLER is responsible for having authorized `read` on `agency_lead` before
 *  this runs — this function does not itself refuse anything, so a denied caller must never reach
 *  it (criterion 5: a denial must never present as this returning `[]`). */
export async function listLeadsQueue(tenantId: string): Promise<unknown[]> {
  const { rows } = await withTenants([tenantId], (c) =>
    c.query(
      `SELECT l.id, l.org_name AS "orgName", l.contact_name AS "contactName",
              l.contact_email AS "contactEmail", l.contact_phone AS "contactPhone",
              l.source, l.status, l.owner_id AS "ownerId", ou.name AS "ownerName",
              l.created_at AS "createdAt", l.updated_at AS "updatedAt",
              EXTRACT(EPOCH FROM (now() - l.created_at))::bigint AS "ageSeconds",
              EXISTS (SELECT 1 FROM agency_discovery_submissions s WHERE s.lead_id = l.id) AS "hasSubmission"
         FROM agency_leads l
         LEFT JOIN users ou ON ou.id = l.owner_id
        WHERE l.tenant_id = $1 AND l.deleted_at IS NULL
        -- mirrors queueRank() above: submitted(0) < new(1) < invited(2) < everything else(3).
        -- Sorted by whose move it is: 'new' outranks 'invited' because it is OUR move.
        ORDER BY (CASE l.status WHEN 'submitted' THEN 0 WHEN 'new' THEN 1 WHEN 'invited' THEN 2 ELSE 3 END), l.created_at ASC
        LIMIT 200`,
      [tenantId],
    ),
  );
  return rows;
}

/** Lead detail, joined to its LATEST submission (by `created_at DESC`) via a `LATERAL` join so a
 *  lead with zero submissions still returns (the `s.*` columns come back NULL, not an absent row).
 *  `answers`/`meta` are returned EXACTLY as Postgres hands them back — never spread, defaulted, or
 *  flattened — so a key the prospect never answered stays ABSENT from the object rather than
 *  reading as an explicit `null` (CLAUDE.md's "a missing field reads exactly like NULL" trap,
 *  design §9.2's "what did they NOT tell us"). Returns `null` when the lead does not exist (or is
 *  invisible under RLS) so the controller can 404 rather than pretend it read an empty lead. */
export async function getLeadDetail(tenantId: string, leadId: string): Promise<Record<string, unknown> | null> {
  const { rows } = await withTenants([tenantId], (c) =>
    c.query(
      `SELECT l.id, l.org_name AS "orgName", l.contact_name AS "contactName",
              l.contact_email AS "contactEmail", l.contact_phone AS "contactPhone",
              l.source, l.status, l.owner_id AS "ownerId", ou.name AS "ownerName",
              l.converted_client_id AS "convertedClientId", l.converted_project_id AS "convertedProjectId",
              l.pipeline_run_id AS "pipelineRunId", l.declined_reason AS "declinedReason",
              l.triaged_by AS "triagedBy", tu.name AS "triagedByName", l.triaged_at AS "triagedAt",
              l.created_at AS "createdAt", l.updated_at AS "updatedAt",
              s.id AS "latestSubmissionId", s.schema_version AS "latestSchemaVersion",
              s.answers AS "latestAnswers", s.meta AS "latestMeta",
              s.answered_count AS "latestAnsweredCount", s.required_answered AS "latestRequiredAnswered",
              s.required_total AS "latestRequiredTotal", s.redactions AS "latestRedactions",
              s.supersedes_id AS "latestSupersedesId", s.created_at AS "latestSubmittedAt"
         FROM agency_leads l
         LEFT JOIN users ou ON ou.id = l.owner_id
         LEFT JOIN users tu ON tu.id = l.triaged_by
         LEFT JOIN LATERAL (
           SELECT * FROM agency_discovery_submissions s2
            WHERE s2.lead_id = l.id
            ORDER BY s2.created_at DESC
            LIMIT 1
         ) s ON true
        WHERE l.id = $1 AND l.tenant_id = $2 AND l.deleted_at IS NULL`,
      [leadId, tenantId],
    ),
  );
  return rows[0] ?? null;
}

/** Whether `leadId` exists (and is visible under RLS) in this tenant — used by
 *  `listLeadSubmissions` to distinguish "this lead has no submissions yet" (a genuine `[]`) from
 *  "this id is wrong or belongs to another tenant" (a 404), rather than folding both into the same
 *  empty array (criterion 5). */
async function leadExists(tenantId: string, leadId: string): Promise<boolean> {
  const { rows } = await withTenants([tenantId], (c) =>
    c.query(`SELECT 1 FROM agency_leads WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, [leadId, tenantId]),
  );
  return rows.length > 0;
}

/** Full submission history for one lead, newest first — `supersedes_id` lets the UI chain
 *  corrections. Returns `null` (not `[]`) when the lead itself does not exist, so the controller can
 *  throw a typed 404 instead of a reviewer reading an empty list as "nothing was ever submitted". */
export async function listLeadSubmissions(tenantId: string, leadId: string): Promise<unknown[] | null> {
  if (!(await leadExists(tenantId, leadId))) return null;
  const { rows } = await withTenants([tenantId], (c) =>
    c.query(
      `SELECT id, schema_version AS "schemaVersion", answers, meta,
              answered_count AS "answeredCount", required_answered AS "requiredAnswered",
              required_total AS "requiredTotal", supersedes_id AS "supersedesId",
              redactions, created_at AS "createdAt"
         FROM agency_discovery_submissions
        WHERE lead_id = $1 AND tenant_id = $2
        ORDER BY created_at DESC`,
      [leadId, tenantId],
    ),
  );
  return rows;
}

// ────────────────────────────────────────────────────────────── triage dispositions (AD-5)
export type TriageAction = "open" | "decline" | "nurture";

interface TransitionSpec {
  from: string;
  to: string;
  eventType: string;
  /** A "disposition" stamps `triaged_by`/`triaged_at` (decline, nurture — an actual decision was
   *  made about the prospect). `open` does not: it only records "someone picked this up", which is
   *  not itself a disposition and must not be indistinguishable from one in the audit trail. */
  disposition: boolean;
}

// The lead state machine, design §4.1's diagram verbatim: `open` moves submitted -> in_review;
// decline/nurture are the two non-convert dispositions out of in_review. `convert` is AD-6's, not
// modeled here at all — this map is exhaustive for what THIS file may do to a lead's status.
const TRANSITIONS: Record<TriageAction, TransitionSpec> = {
  open: { from: "submitted", to: "in_review", eventType: "agency.lead.opened", disposition: false },
  decline: { from: "in_review", to: "declined", eventType: "agency.lead.declined", disposition: true },
  nurture: { from: "in_review", to: "nurturing", eventType: "agency.lead.nurtured", disposition: true },
};

/** The typed refusal wording for an illegal transition, naming both the action and the lead's
 *  ACTUAL current status — never a silent no-op (per this ticket's explicit instruction). Pure and
 *  unit-tested directly so the wording (and the `from` it cites) cannot drift from `TRANSITIONS`
 *  without a test noticing. */
export function describeIllegalTransition(action: TriageAction, currentStatus: string): string {
  return `cannot ${action} a lead in status '${currentStatus}' — expected '${TRANSITIONS[action].from}'`;
}

/** `reason` is required for a decline (the DB's `lead_declined_has_reason` CHECK would refuse a
 *  reasonless row anyway, but a CHECK violation is a raw 500-shaped Postgres error, not a typed
 *  400 — this is what turns it into one BEFORE the statement ever runs). Scrubbed (free text) and
 *  capped, same discipline as `webdev-change-requests.controller.ts`'s own decline reason. */
export function normalizeDeclineReason(raw: unknown): string {
  const reason = scrubText(String(raw ?? "")).text.trim().slice(0, REASON_CAP);
  if (!reason) throw new BadRequestException("reason required when declining");
  return reason;
}

export type TransitionOutcome =
  | { outcome: "ok" }
  | { outcome: "not_found" }
  | { outcome: "illegal"; currentStatus: string };

/** Re-reads the lead's actual status so the caller can build a typed refusal that NAMES it, per
 *  this ticket's explicit instruction ("reject an illegal transition ... naming the current
 *  status"). Called only after the conditional `UPDATE` below affected zero rows. */
async function resolveTransitionFailure(
  c: PoolClient,
  tenantId: string,
  leadId: string,
): Promise<TransitionOutcome> {
  const cur = await c.query<{ status: string }>(
    `SELECT status FROM agency_leads WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
    [leadId, tenantId],
  );
  if (!cur.rows[0]) return { outcome: "not_found" };
  return { outcome: "illegal", currentStatus: cur.rows[0].status };
}

/** The one shared engine for all three dispositions. The `UPDATE ... WHERE status = $from` is
 *  itself the concurrency guard: Postgres takes the row lock for the statement's duration, so two
 *  concurrent callers cannot both see `status = $from` and both succeed — the loser's `UPDATE`
 *  affects zero rows and re-reads the (now different) actual status below. This is NOT the
 *  lock-then-spawn idiom `webdev-cr-lock.ts`/`pipeline-lock.ts` document at length — those exist
 *  because their transitions SPAWN new rows in other tables from a snapshot read before the lock;
 *  every transition here is a single, single-table, single-statement UPDATE, which Postgres already
 *  serializes correctly on its own. An advisory lock here would guard nothing an ordinary
 *  conditional UPDATE does not already guard. */
async function applyTransition(
  tenantId: string,
  leadId: string,
  actorId: string | null,
  action: TriageAction,
  extra: { declinedReason?: string } = {},
): Promise<TransitionOutcome> {
  const spec = TRANSITIONS[action];
  return withTenants([tenantId], async (c) => {
    const upd = await (spec.disposition
      ? c.query(
          `UPDATE agency_leads
              SET status = $4, declined_reason = $5, triaged_by = $3, triaged_at = now(), updated_at = now()
            WHERE id = $1 AND tenant_id = $2 AND status = $6 AND deleted_at IS NULL
            RETURNING id`,
          [leadId, tenantId, actorId, spec.to, extra.declinedReason ?? null, spec.from],
        )
      : c.query(
          // `open` is not a disposition: triaged_by/triaged_at stay untouched, and owner_id is set
          // ONLY if unset (COALESCE) — picking a lead up must never silently reassign an existing
          // owner to whoever happened to click it.
          `UPDATE agency_leads
              SET status = $4, owner_id = COALESCE(owner_id, $3), updated_at = now()
            WHERE id = $1 AND tenant_id = $2 AND status = $5 AND deleted_at IS NULL
            RETURNING id`,
          [leadId, tenantId, actorId, spec.to, spec.from],
        ));
    if (upd.rowCount) {
      await emitEvent(c, tenantId, "agency_lead", leadId, spec.eventType, {
        actorId, ...(action === "decline" ? { reason: extra.declinedReason } : {}),
      });
      return { outcome: "ok" as const };
    }
    return resolveTransitionFailure(c, tenantId, leadId);
  });
}

export async function openLead(tenantId: string, leadId: string, actorId: string | null): Promise<TransitionOutcome> {
  return applyTransition(tenantId, leadId, actorId, "open");
}

export async function nurtureLead(tenantId: string, leadId: string, actorId: string | null): Promise<TransitionOutcome> {
  return applyTransition(tenantId, leadId, actorId, "nurture");
}

export async function declineLead(
  tenantId: string,
  leadId: string,
  actorId: string | null,
  reason: string,
): Promise<TransitionOutcome> {
  return applyTransition(tenantId, leadId, actorId, "decline", { declinedReason: reason });
}
