// AD-6 — the agency-lead CONVERT spawner. Design:
// docs/superpowers/plans/2026-09-05-agency-discovery-intake-design.md
//   §4.2 (what conversion creates) · §4.3 (delegation) · §6.2 (idempotency)
//
// This mirrors `webdev-change-requests.controller.ts`'s triage/convert spawner (MI-03, itself the
// applied form of the DEF-2 lesson in `pipeline-lock.ts`) closely enough that the differences are the
// interesting part: a lead mints a NEW client (a change request never does), and the hard build gate
// must hold by real client signatures — nothing here pre-seeds a signed gate.
//
// ── LOCK: WHY THE LEAD ID, AND WHY THE LOCK ALONE IS NOT THE FIX ─────────────────────────────────
// `POST /agency/leads/:leadId/convert` is a read-then-write decision exactly like MI-03's triage: it
// reads the lead's `status`, concludes "still open, nothing spawned yet", and then mints a client +
// project + run and links them. Two AMs converting the same lead concurrently, or an HTTP retry of a
// request that already committed, replay that. Without a lock both racers read the same "still open"
// snapshot and both spawn — two clients for one lead. Without the SERVER-SIDE RE-CHECK under the lock,
// the racers merely take turns and BOTH still spawn (DEF-2's exact shape, `pipeline-lock.ts:17-25`):
// the lock only enables the fix, it is not the fix.
//
// Lock scope is the LEAD id — the unit two deciders can disagree about — not the tenant
// (`pipeline-lock.ts:32-37`: a tenant-wide lock would serialize every triage in a one-agency
// deployment) and not narrower. No second lock is taken on the freshly-minted client/project/run ids:
// they cannot be addressed by a concurrent handler yet, the same reasoning `createRun` documents at
// `pipeline.controller.ts:208-210` for its own stage-insert loop.
import { BadRequestException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { newId, withGlobal, withTenants } from "../db";
import { config } from "../config";
import { emitEvent } from "../events/outbox.service";
import { createPmTaskInTx, normalizePmTaskInput } from "../modules/pm/pm.controller";
import {
  isPositionResolvableRole,
  loadPositionCandidates,
  pickAllPositionHolders,
  type PositionHolderResolution,
  type PositionResolvableRole,
} from "./agency-delegation-resolver";

/** Advisory-lock namespace (int4) for agency-lead convert serialization. Deliberately distinct from
 *  PIPELINE_RUN_LOCK_NS (0x50520001), WEBDEV_CR_LOCK_NS (0x57430001), APPROVAL_EXEC_LOCK_NS
 *  (0x41450001), ASSISTANT_THREAD_LOCK_NS (0x41535401) and the search module's spaces, so a lead-id
 *  hash can never collide with a run-id / CR-id / approval-key / thread-id hash in the same shared
 *  lock space. */
export const AGENCY_LEAD_LOCK_NS = 0x414c0001;

const OPEN_STATUSES = new Set(["submitted", "in_review", "nurturing"]);

/** Serialize the convert transition for ONE lead. Call as the FIRST statement inside the
 *  `withTenants` callback, before any read whose result the handler then acts on — xact-scoped
 *  (`pg_advisory_xact_lock`), so it is released by COMMIT/ROLLBACK and can never leak on a crashed
 *  handler. This REQUIRES a real transaction: `withTenants` wraps its callback in BEGIN/COMMIT, so a
 *  lock taken inside it is held for the rest of the handler. Taken on an autocommit connection it
 *  would be a silent no-op. */
export async function lockAgencyLead(c: PoolClient, leadId: string): Promise<void> {
  await c.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [AGENCY_LEAD_LOCK_NS, leadId]);
}

/** Active-staff check, the exact idiom `pipeline.controller.ts`'s `assertOwnerIsStaff` uses (read
 *  through the TENANT-SCOPED connection, so a userId from another tenant matches zero rows and is
 *  refused rather than accepted by an FK check — FK checks run as the table owner, OUTSIDE RLS, and
 *  are not a tenancy control). Design §4.2 step 3 and §4.3 both call for this exact check: the
 *  converting staff member (fatal if not staff) and every body-supplied delegation `assigneeId`
 *  (fatal 400 if not staff — "never a silent skip", design §4.3). */
export async function assertActiveStaff(c: PoolClient, userId: string, field: string): Promise<string> {
  const r = await c.query(
    `SELECT 1 FROM company_memberships WHERE user_id = $1 AND status = 'active' AND deleted_at IS NULL LIMIT 1`,
    [userId],
  );
  if (!r.rowCount) throw new BadRequestException(`${field} must be an active staff member of this tenant`);
  return userId;
}

// ── §4.2 artifact rendering — the requirement doc + scope note, from the discovery answers ─────────
//
// UNVERIFIED ASSUMPTION (flagged in the AD-6 report): the exact `answers` JSONB key names
// (objective/primary_audience/features_required/pages_required/integrations/in_scope/out_scope/dependencies) are
// inferred from the design doc's prose, not from a published questionnaire schema — AD-2/AD-3 own the
// intake form and its `schema_version` contract, and neither has landed in this checkout yet. If the
// real keys differ, only these two render functions need to change; nothing else depends on the exact
// key names, and a missing key degrades to the same "supplied no further detail" fallback the webdev
// precedent (`renderRequirementDoc`/`renderScopeNote` in webdev-change-requests.controller.ts) uses
// for an empty CR body, rather than throwing or rendering "undefined".
function fmtField(v: unknown, fallback: string): string {
  if (v === undefined || v === null) return fallback;
  if (Array.isArray(v)) {
    const items = v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).filter((s) => s.trim().length > 0);
    return items.length ? items.join(", ") : fallback;
  }
  if (typeof v === "object") return JSON.stringify(v);
  const s = String(v).trim();
  return s || fallback;
}

const NO_ANSWER = "_Not answered._";

export interface AgencyLeadForRender {
  id: string;
  orgName: string;
  contactName: string | null;
}

/** The requirement doc the mini-run's `delivery/prd_extract` stage carries (design §4.2 step 4).
 *  Rendered from the discovery answers so the run is self-describing, and carries a link back to the
 *  lead that caused it — mirrors `renderRequirementDoc` in webdev-change-requests.controller.ts. */
export function renderRequirementDoc(lead: AgencyLeadForRender, answers: Record<string, unknown>): string {
  return [
    `# ${lead.orgName}`,
    "",
    "**Origin:** agency discovery intake, converted lead",
    `**Contact:** ${lead.contactName ?? "unknown"}`,
    `**Lead:** \`${lead.id}\``,
    "",
    "## Objective",
    "",
    fmtField(answers.objective, NO_ANSWER),
    "",
    "## Audience",
    "",
    fmtField(answers.primary_audience, NO_ANSWER),
    "",
    "## Features",
    "",
    fmtField(answers.features_required, NO_ANSWER),
    "",
    "## Pages",
    "",
    fmtField(answers.pages_required, NO_ANSWER),
    "",
    "## Integrations",
    "",
    fmtField(answers.integrations, NO_ANSWER),
  ].join("\n");
}

/** The scope note the mini-run's `scope/scope_extract` stage carries (design §4.2 step 4).
 *  Deliberately describes the WORK only — no estimate/pricing embed, same restraint
 *  `renderScopeNote` in webdev-change-requests.controller.ts documents for its own case. */
export function renderScopeNote(lead: AgencyLeadForRender, answers: Record<string, unknown>): string {
  return [
    `# Scope — ${lead.orgName}`,
    "",
    `Agency discovery lead \`${lead.id}\`, converted.`,
    "",
    "## In scope",
    "",
    fmtField(answers.in_scope, NO_ANSWER),
    "",
    "## Out of scope",
    "",
    fmtField(answers.out_scope, NO_ANSWER),
    "",
    "## Dependencies",
    "",
    fmtField(answers.dependencies, NO_ANSWER),
    "",
    "_Commercials (estimate, rate, timeline) are agreed separately; this note describes the work only._",
  ].join("\n");
}

// ── §4.3 delegation — defaults seeded from the answers, overridable by the caller ──────────────────
//
// AD-6b (this pass) closes the gap AD-6 correctly refused to paper over. AD-6's finding stands as
// history: the design's table names a default ASSIGNEE for every row ("lead owner (AM)", "PM", "tech
// lead"), but `agency_leads`/`users`/`company_memberships` alone has no directory mapping a tenant to
// "its PM" or "its tech lead" — only `agency_leads.owner_id` is resolvable from THAT schema. What AD-6
// did not have was IAM Phase 2's `positions`/`position_assignments` tables (migration 0109) — the org
// chart AS SEATS, seeded for real in `src/seed/roster.ts` (Azlan's seat is literally titled "Tech Lead
// · Head of Web Dev"). `agency-delegation-resolver.ts` is that resolver; see its header for exactly
// what it can and cannot answer (title-text matching, not a first-class role-kind column — a real
// limit of the schema, not swept under the rug).
//
// So, per role:
//   - `discovery_review` / `content_owners` (design's "AM" rows) resolve to `agency_leads.owner_id`
//     directly — this IS design's own stated default, not a degraded fallback.
//   - `sitemap` (design's "PM") / `integrations` / `dns` (design's "tech lead") first try the
//     matching tenant seat's CURRENT holder (`resolution: "position"`); only when no seat holder can
//     be resolved (no matching title at all, or a matching seat that is currently vacant) do they
//     fall back to the lead's owner — and that fallback is marked as such in the convert response
//     (`source: "owner_fallback"`) so the AM sees it landed on them by default, not by decision.
//   - Rule 1 (unconditional): an explicit caller-supplied `assigneeId` for ANY role always wins and
//     is never second-guessed against a resolved candidate — see `computeDelegationPlan` below.
//   - Rule 4: a role whose condition is true but for which NO candidate resolves (no seat holder AND
//     no owner) is not silently skipped — it is reported as unplaceable by the convert response
//     (`convertAgencyLead`'s `delegations` field), the requirement this whole ticket exists for.
export type CanonicalDelegationRole = "discovery_review" | "sitemap" | "integrations" | "content_owners" | "dns";

interface CanonicalDelegation {
  title: string;
  condition: (answers: Record<string, unknown>) => boolean;
  /** "owner" = this IS design's own default (the AM); "position" = try the matching tenant seat's
   *  current holder first, falling back to the owner only when no seat holder resolves. See the
   *  block comment above. */
  resolution: "owner" | "position";
}

function hasValue(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "string") return v.trim().length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

/** `answers.asset_inventory` shape is not pinned by any schema this ticket can read (see the header
 *  note above) — treated leniently as "an array of entries, each possibly carrying a status/value
 *  string somewhere in it", and matched by substring rather than an exact key path so a reasonable
 *  range of question-authoring choices ({status:'Does not exist'} , {value:'Does not exist'}, a bare
 *  string) all trigger the same, single, defensible behaviour: chase the client for it. */
function assetInventoryHasMissing(v: unknown): boolean {
  if (!hasValue(v)) return false;
  try {
    return JSON.stringify(v).toLowerCase().includes("does not exist");
  } catch {
    return false;
  }
}

export const CANONICAL_DELEGATIONS: Record<CanonicalDelegationRole, CanonicalDelegation> = {
  discovery_review: {
    title: "Review discovery answers & flag contradictions",
    condition: () => true,
    resolution: "owner",
  },
  sitemap: {
    title: "Produce sitemap from stated pages",
    condition: (a) => hasValue(a.pages_required),
    resolution: "position",
  },
  integrations: {
    title: "Confirm integrations & API access",
    condition: (a) => hasValue(a.integrations),
    resolution: "position",
  },
  content_owners: {
    title: "Chase missing content owners",
    condition: (a) => assetInventoryHasMissing(a.asset_inventory),
    resolution: "owner",
  },
  dns: {
    title: "Confirm domain/DNS control",
    condition: (a) => hasValue(a.dns_owner),
    resolution: "position",
  },
};

export interface DelegationInput {
  role?: string;
  assigneeId: string;
  dueAt?: string;
  title?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Pure validation/normalization of the request body's `delegations` array. Throws
 *  BadRequestException. No DB — every `assigneeId` is checked for SHAPE here only; the
 *  staff-membership check (§4.3: "a body-supplied user id that is not staff... a typed 400, never a
 *  silent skip") happens against the DB inside the transaction, because it needs a DB read. */
export function normalizeDelegationsInput(raw: unknown): DelegationInput[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new BadRequestException("delegations must be an array");
  return raw.map((entry, i) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new BadRequestException(`delegations[${i}] must be an object`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.assigneeId !== "string" || !e.assigneeId.trim()) {
      throw new BadRequestException(`delegations[${i}].assigneeId is required`);
    }
    if (e.role !== undefined && typeof e.role !== "string") {
      throw new BadRequestException(`delegations[${i}].role must be a string`);
    }
    if (e.dueAt !== undefined && (typeof e.dueAt !== "string" || !DATE_RE.test(e.dueAt))) {
      throw new BadRequestException(`delegations[${i}].dueAt must be a YYYY-MM-DD date`);
    }
    if (e.title !== undefined && typeof e.title !== "string") {
      throw new BadRequestException(`delegations[${i}].title must be a string`);
    }
    return {
      role: e.role as string | undefined,
      assigneeId: e.assigneeId,
      dueAt: e.dueAt as string | undefined,
      title: e.title as string | undefined,
    };
  });
}

/** Where a candidate assignee came from — surfaced verbatim in the convert response so the AM/PM can
 *  tell "I was assigned by design" from "I was assigned because nothing else resolved" (this
 *  ticket's whole point). `"caller"` = the API caller named this person explicitly (rule 1, always
 *  wins, never second-guessed). `"position"` = the tenant seat matching this role's title pattern
 *  currently has a holder. `"owner"` = design's OWN default for this role (the AM rows). `"owner_fallback"`
 *  = this role wanted a seat holder but none resolved, so the lead's owner was used as a fallback —
 *  distinct from `"owner"` specifically so the response can flag it. */
export type DelegationSource = "caller" | "position" | "owner" | "owner_fallback";

export interface DelegationCandidate {
  source: DelegationSource;
  assigneeId: string;
  positionId?: string;
  positionTitle?: string;
}

export interface PlannedDelegation {
  role: string;
  title: string;
  dueAt?: string;
  /** Tried in order inside the transaction; the first candidate that passes the same active-staff
   *  check `assertActiveStaff` applies everywhere else wins. A `source: "caller"` candidate's
   *  failure is FATAL (never a silent skip — design §4.3); every other source's failure just moves
   *  to the next candidate, so one stale seat holder can never fail the whole convert. Empty means
   *  no candidate could even be proposed — see `convertAgencyLead`'s unresolved-report handling. */
  candidates: DelegationCandidate[];
}

/** Pure: merges the condition-gated canonical defaults with the caller's overrides and the
 *  already-resolved position holders into the final candidate list per role. No DB of its own —
 *  `ownerId` and `positionHolders` are passed in already resolved by the caller (inside the SAME
 *  transaction, per design §6.2's "stay inside the existing single transaction" rule — see
 *  `convertAgencyLead`), and the staff-membership check on every resulting `assigneeId` happens
 *  there too, one candidate at a time. Caller entries whose `role` matches a canonical key REPLACE
 *  that default entirely (title/assigneeId/dueAt all come from the caller, and NO fallback chain is
 *  attempted for that role — rule 1: an explicit human choice is never second-guessed); caller
 *  entries with an unrecognised (or absent) `role` are appended as their own task, keyed by a
 *  synthetic role so two custom entries never collide. */
export function computeDelegationPlan(
  answers: Record<string, unknown>,
  ownerId: string | null,
  callerDelegations: DelegationInput[],
  positionHolders: Record<PositionResolvableRole, PositionHolderResolution>,
): PlannedDelegation[] {
  const byRole = new Map<string, DelegationInput>();
  for (const d of callerDelegations) if (d.role) byRole.set(d.role, d);

  const plan: PlannedDelegation[] = [];
  for (const [role, spec] of Object.entries(CANONICAL_DELEGATIONS) as Array<[CanonicalDelegationRole, CanonicalDelegation]>) {
    const override = byRole.get(role);
    if (override) {
      plan.push({
        role,
        title: override.title ?? spec.title,
        dueAt: override.dueAt,
        candidates: [{ source: "caller", assigneeId: override.assigneeId }],
      });
      continue;
    }
    if (!spec.condition(answers)) continue;

    const candidates: DelegationCandidate[] = [];
    if (spec.resolution === "position" && isPositionResolvableRole(role)) {
      const resolved = positionHolders[role];
      if (resolved.holderUserId) {
        candidates.push({
          source: "position",
          assigneeId: resolved.holderUserId,
          positionId: resolved.matchedPositionId ?? undefined,
          positionTitle: resolved.matchedPositionTitle ?? undefined,
        });
      }
    }
    if (ownerId) {
      candidates.push({ source: spec.resolution === "owner" ? "owner" : "owner_fallback", assigneeId: ownerId });
    }
    // No `continue` on an empty candidate list — design §4.3's condition fired (this role IS wanted)
    // but nothing could resolve an assignee. That is reported as unplaceable by convertAgencyLead,
    // never silently dropped the way the pre-AD-6b version did.
    plan.push({ role, title: spec.title, dueAt: undefined, candidates });
  }

  // Caller entries with no role (or a role outside the canonical five) are additive custom tasks.
  let customSeq = 0;
  for (const d of callerDelegations) {
    if (d.role && CANONICAL_DELEGATIONS[d.role as CanonicalDelegationRole]) continue; // already handled above
    customSeq += 1;
    plan.push({
      role: d.role ?? `custom_${customSeq}`,
      title: d.title ?? d.role ?? "Delegated task",
      dueAt: d.dueAt,
      candidates: [{ source: "caller", assigneeId: d.assigneeId }],
    });
  }
  return plan;
}

// ── the spawner itself ──────────────────────────────────────────────────────────────────────────

export interface ConvertLeadInput {
  tenantId: string;
  leadId: string;
  actorUserId: string;
  delegations: DelegationInput[];
}

/** One line of the convert response's delegation report — "what was delegated and to whom" (this
 *  ticket's mission statement), including fallbacks and unplaceable roles. `source: "unresolved"`
 *  means NO task was created for this role: `assigneeId` is null and `reason` says why, so the
 *  caller/UI can surface it as a gap for a human to fill rather than it vanishing silently. */
export interface DelegationReportEntry {
  role: string;
  title: string;
  assigneeId: string | null;
  taskId?: string;
  source: DelegationSource | "unresolved";
  positionId?: string;
  positionTitle?: string;
  reason?: string;
}

export type ConvertLeadOutcome =
  | { outcome: "not_found" }
  | {
      outcome: "conflict";
      existing: { clientId: string | null; projectId: string | null; runId: string | null };
    }
  | {
      outcome: "converted";
      clientId: string;
      projectId: string;
      runId: string;
      ownerId: string | null;
      contactUserId: string | null;
      orgName: string;
      delegations: DelegationReportEntry[];
    };

/** Task description suffix that makes a fallback VISIBLE on the task itself, not only in the API
 *  response — "so the AM sees it landed on them by default rather than by decision" (this ticket's
 *  brief). Plain text appended to the seeded task's description; no schema change needed. */
function delegationTaskDescription(leadId: string, role: string, chosen: DelegationCandidate): string {
  const base = `Seeded at conversion of agency lead \`${leadId}\` (role: ${role}).`;
  if (chosen.source === "owner_fallback") {
    return `${base} Auto-assigned to the lead owner as a FALLBACK — no seat holder could be resolved for this role in the tenant's org chart. Reassign to the right person if one exists.`;
  }
  if (chosen.source === "position") {
    return `${base} Assigned to the current holder of the "${chosen.positionTitle}" seat.`;
  }
  return base;
}

interface LeadRow {
  id: string;
  org_name: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  owner_id: string | null;
  status: string;
  converted_client_id: string | null;
  converted_project_id: string | null;
  pipeline_run_id: string | null;
}

/** Runs the whole design-§4.2/§4.3 spawn as ONE `withTenants` transaction, after two preliminary,
 *  non-racy, read-only steps outside it:
 *
 *   1. Read the lead's identifying fields (name/contact/owner) UNLOCKED. This is safe because none of
 *      it is part of the race-sensitive precondition (only `status`/`converted_client_id`/
 *      `pipeline_run_id` are, and those are RE-READ under the lock below, per §6.2) — a contact's
 *      name changing between this read and the lock is not a correctness bug, the same way MI-03's
 *      CR title is read once and never re-validated under its lock either.
 *   2. Find-or-create the CONTACT's `users` row via `withGlobal` — the house idiom for every
 *      find-or-create against the global (no tenant_id, no RLS) `users` table
 *      (`client-contacts.controller.ts`'s `invite()`, `admin-identity.controller.ts`, the seed
 *      scripts — there is no precedent anywhere in this codebase for inserting into `users` on a
 *      tenant-scoped `withTenants` connection). `withGlobal` is autocommit, so on the rare case the
 *      MAIN transaction below rolls back, this row is NOT rolled back with it — an accepted,
 *      pre-existing tradeoff, not a new one: `client-contacts.controller.ts:135-137` accepts the
 *      identical shape ("the same person may already be staff... find-or-create rather than
 *      create") for the identical reason (this is a global identity table with unique(email), so a
 *      leftover unlinked row is inert, never a duplicate person).
 *
 *  Then the transaction: lock -> re-read the race-sensitive columns -> re-check the precondition ->
 *  (only on success) validate staff membership -> spawn client+contact+project+run+stages+gate+tasks
 *  -> update the lead -> emit events. All inside one `withTenants` callback, so BEGIN/COMMIT is what
 *  makes the advisory lock (`pg_advisory_xact_lock`) real. */
export async function convertAgencyLead(input: ConvertLeadInput): Promise<ConvertLeadOutcome> {
  const { tenantId, leadId, actorUserId, delegations } = input;

  const preRead = await withTenants([tenantId], (c) =>
    c.query<LeadRow>(
      `SELECT id, org_name, contact_name, contact_email, contact_phone, owner_id, status,
              converted_client_id, converted_project_id, pipeline_run_id
         FROM agency_leads WHERE id = $1 AND deleted_at IS NULL`,
      [leadId],
    ),
  );
  const lead = preRead.rows[0];
  if (!lead) return { outcome: "not_found" };

  // §4.2 step 2 — find-or-create the contact's `users` row (only if the lead carries an email; a
  // lead with no contact_email cannot get a portal contact, and that is the honest consequence of
  // agency_leads.contact_email being nullable — see the AD-6 report for this called out as a gap
  // rather than silently worked around).
  const contactEmail = lead.contact_email?.trim().toLowerCase() || null;
  const contactUserId = contactEmail
    ? await withGlobal(async (c) => {
        const found = await c.query<{ id: string }>(
          `SELECT id FROM users WHERE lower(email) = $1 AND deleted_at IS NULL`,
          [contactEmail],
        );
        if (found.rows[0]) return found.rows[0].id;
        const id = newId();
        await c.query(`INSERT INTO users (id, email, name, origin_site) VALUES ($1, $2, $3, $4)`, [
          id,
          contactEmail,
          lead.contact_name ?? contactEmail.split("@")[0],
          config.originSite,
        ]);
        return id;
      })
    : null;

  const answersRow = await withTenants([tenantId], (c) =>
    c.query<{ answers: Record<string, unknown> }>(
      `SELECT answers FROM agency_discovery_submissions WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [leadId],
    ),
  );
  const answers = answersRow.rows[0]?.answers ?? {};

  const result = await withTenants([tenantId], async (c) => {
    // 1 · SERIALIZE on the lead. First statement, before any read whose result this handler acts on.
    await lockAgencyLead(c, leadId);

    // 2 · RE-READ under the lock. This, not the lock, is the fix (§6.2 / DEF-2).
    const cur = await c.query<LeadRow>(
      `SELECT id, org_name, contact_name, contact_email, contact_phone, owner_id, status,
              converted_client_id, converted_project_id, pipeline_run_id
         FROM agency_leads WHERE id = $1 AND deleted_at IS NULL`,
      [leadId],
    );
    const row = cur.rows[0];
    if (!row) return { outcome: "not_found" as const };

    // 3 · RE-CHECK THE PRECONDITION. A second convert is a stale retrigger, never an intent
    //     (existingStageForRepeatedCreate's ruling, pipeline.controller.ts:89-124) — the loser
    //     resolves to whatever already exists instead of spawning a twin.
    if (!OPEN_STATUSES.has(row.status)) {
      return {
        outcome: "conflict" as const,
        existing: {
          clientId: row.converted_client_id,
          projectId: row.converted_project_id,
          runId: row.pipeline_run_id,
        },
      };
    }

    // 4 · Validate staff membership for the converting actor (design §4.2 step 3's "validated with
    //     the existing assertOwnerIsStaff idiom"). Done here, under the lock, rather than before it,
    //     because it needs this same tenant-scoped connection and the whole point of re-checking
    //     under the lock is that nothing the spawn depends on is read outside it. Every delegation
    //     candidate (caller-supplied AND server-resolved) gets the SAME check below, at task-creation
    //     time — see the §4.3 block — where a caller-supplied id's failure is still fatal (never a
    //     silent skip, design §4.3) but a server-resolved candidate's failure falls through to its
    //     next fallback instead of aborting the whole convert.
    await assertActiveStaff(c, actorUserId, "the converting user");

    const leadForRender = { id: row.id, orgName: row.org_name, contactName: row.contact_name };

    // §4.2 step 1 — clients + client_contacts.
    const clientId = newId();
    const contactBlob = {
      name: row.contact_name ?? null,
      email: row.contact_email ?? null,
      phone: row.contact_phone ?? null,
    };
    await c.query(
      `INSERT INTO clients (id, tenant_id, name, contact, origin_site) VALUES ($1, $2, $3, $4, $5)`,
      [clientId, tenantId, row.org_name, JSON.stringify(contactBlob), config.originSite],
    );
    if (contactUserId) {
      // capability='signer' — NOT the column default ('viewer') — deliberately: the hard build gate
      // can only ever be satisfied by a REAL client signature (never pre-seeded, see below), and
      // `resolveClientRecipients(kind:'signature')` only ever resolves capability='signer' contacts
      // (client-notify.ts:37-38). A client whose only contact is a 'viewer' would have its prd_sign
      // gate open onto nobody who could ever act on it — permanently stalling the run.
      await c.query(
        `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, capability, status, invited_by, origin_site)
         VALUES ($1, $2, $3, $4, 'signer', 'invited', $5, $6)`,
        [newId(), tenantId, clientId, contactUserId, actorUserId, config.originSite],
      );
      // NOTE (AD-6 report): this does NOT call createInvite()/mint a magic link — the row's mere
      // existence is what the design's step 1 asks for ("this is what later lets the new client into
      // the portal at all"), but actually SENDING the invite is a distinct staff action available
      // today via the existing `POST /:tenantId/clients/:clientId/contacts` endpoint (which
      // idempotently adopts this exact row — see client-contacts.controller.ts:151-177 — rather than
      // erroring on it). Left as a deliberate follow-up rather than invented here.
    }

    // §4.2 step 2 — projects.
    const projectId = newId();
    await c.query(
      `INSERT INTO projects (id, tenant_id, client_id, name, owner_id, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [projectId, tenantId, clientId, row.org_name, actorUserId, config.originSite],
    );

    // §4.2 step 3 — pipeline_runs. source_meeting_id NULL is the honest value (design §4.2 step 3;
    // the 0017 dedupe index is partial on non-null, so this NULL never collides with a meeting-born
    // run's dedupe key).
    const runId = newId();
    await c.query(
      `INSERT INTO pipeline_runs
         (id, tenant_id, source_meeting_id, title, mom_ref, status, client_id, project_id, owner_id, created_by, origin_site)
       VALUES ($1, $2, NULL, $3, NULL, 'delivery_active', $4, $5, $6, $7, $8)`,
      [runId, tenantId, row.org_name, clientId, projectId, actorUserId, actorUserId, config.originSite],
    );

    // §4.2 step 4 — two pre-filled extraction stages, exactly the shape `createRun` writes
    // (pipeline.controller.ts:215-219). No `report` track: there is no meeting to minute.
    for (const stage of [
      { track: "delivery", name: "prd_extract", artifact: renderRequirementDoc(leadForRender, answers) },
      { track: "scope", name: "scope_extract", artifact: renderScopeNote(leadForRender, answers) },
    ]) {
      await c.query(
        `INSERT INTO pipeline_stages (id, tenant_id, run_id, track, name, status, artifact_ref, confidence, origin_site)
         VALUES ($1, $2, $3, $4, $5, 'done', $6, NULL, $7)`,
        [newId(), tenantId, runId, stage.track, stage.name, stage.artifact, config.originSite],
      );
    }

    // §4.2 step 5 — the delivery-track client `prd_sign` gate, run-level (stage_id NULL, exactly as
    // openGate leaves it). NOTHING ELSE IS PRE-SEEDED: the client `scope_signoff` gate is opened by
    // the shipped `pipeline-fanout` workflow off the event emitted below, and the hard build gate must
    // be satisfied by REAL client signatures — never by a pre-seeded 'decided' row, which would forge
    // what a client agreed to.
    await c.query(
      `INSERT INTO pipeline_gates (id, tenant_id, run_id, stage_id, kind, actor_side, note, opened_by, origin_site)
       VALUES ($1, $2, $3, NULL, 'prd_sign', 'client', $4, $5, $6)`,
      [newId(), tenantId, runId, "Requirement doc ready for your signature", actorUserId, config.originSite],
    );

    // §4.3 — delegation tasks, through the PM module's OWN in-process service function
    // (`createPmTaskInTx`, modules/pm/pm.controller.ts:1224) on THIS connection, inside THIS
    // transaction — so tasks, run, and lead update commit or roll back together, and core never
    // carries a second copy of PM's insert (status ladder, WD-28 seq allocation, TR-02 assignee
    // dual-write, `pm.task.created`). Same route MI-02/MI-03 use for their own pm_task creation.
    //
    // AD-6b: the position/holder read happens HERE, inside the transaction, on THIS connection — it
    // does not need to happen before the lock (it is not part of the race-sensitive precondition,
    // exactly like the answers/contact reads above), and `positions`/`position_assignments` carry no
    // module wall (0109's header) so it is an ordinary read on `c`, same as `agency_leads` itself.
    const positionCandidates = await loadPositionCandidates(c, tenantId);
    const positionHolders = pickAllPositionHolders(positionCandidates);
    const plan = computeDelegationPlan(answers, row.owner_id, delegations, positionHolders);

    const taskIds: string[] = [];
    const delegationReport: DelegationReportEntry[] = [];
    for (const d of plan) {
      let chosen: DelegationCandidate | null = null;
      for (const cand of d.candidates) {
        if (cand.source === "caller") {
          // Fatal, never a silent skip (design §4.3): a body-supplied assigneeId that is not active
          // staff in this tenant is a 400, full stop — it does NOT fall through to a server-resolved
          // fallback, because that would silently override the human's explicit choice with a guess.
          await assertActiveStaff(c, cand.assigneeId, `delegations assigneeId ${cand.assigneeId}`);
          chosen = cand;
          break;
        }
        try {
          await assertActiveStaff(c, cand.assigneeId, `delegation '${d.role}' candidate (${cand.source})`);
          chosen = cand;
          break;
        } catch (e) {
          if (!(e instanceof BadRequestException)) throw e;
          // A server-resolved candidate (a stale seat holder, or an owner who has since left the
          // company) is not valid staff — fall through to the next candidate in the chain rather than
          // failing the ENTIRE convert over one unrelated delegation. This is the security backstop
          // this ticket's brief requires: "a resolver returning a non-staff or cross-tenant user is a
          // security bug, not a UX bug" — so it is never used, only ever skipped past.
          continue;
        }
      }

      if (!chosen) {
        // Rule 4: a role whose condition fired but for which NOTHING resolves (no seat holder, no
        // owner, or every candidate failed the staff check) is REPORTED, never a task created for
        // nobody and never a silently missing row — the exact failure mode this ticket exists to close.
        delegationReport.push({
          role: d.role,
          title: d.title,
          assigneeId: null,
          source: "unresolved",
          reason:
            d.candidates.length === 0
              ? "no resolvable assignee: no matching tenant-seat holder and the lead has no owner"
              : "every candidate assignee failed the active-staff check",
        });
        continue;
      }

      const task = await createPmTaskInTx(
        c,
        tenantId,
        actorUserId,
        normalizePmTaskInput({
          projectId,
          title: d.title,
          description: delegationTaskDescription(row.id, d.role, chosen),
          assignee: { kind: "person", refId: chosen.assigneeId, responsibleId: chosen.assigneeId },
          dueDate: d.dueAt,
        }),
      );
      taskIds.push(task.id);
      delegationReport.push({
        role: d.role,
        title: d.title,
        assigneeId: chosen.assigneeId,
        taskId: task.id,
        source: chosen.source,
        positionId: chosen.positionId,
        positionTitle: chosen.positionTitle,
      });
    }

    // §4.2 step 6 — UPDATE the lead.
    await c.query(
      `UPDATE agency_leads
          SET status = 'converted', converted_client_id = $2, converted_project_id = $3,
              pipeline_run_id = $4, triaged_by = $5, triaged_at = now(), updated_at = now()
        WHERE id = $1 AND status = ANY($6::text[])`,
      [leadId, clientId, projectId, runId, actorUserId, [...OPEN_STATUSES]],
    );

    // §4.2 step 7 — THE LOAD-BEARING LINE. The shipped `pipeline-fanout` n8n workflow triggers on
    // exactly this event (automation/workflows/pipeline-fanout.json's webhook path
    // `ev/pipeline.run.created`, header line 5) and opens the client `scope_signoff` gate + notifies
    // the PM itself — zero special-casing, same payload shape as `createRun`'s emit
    // (pipeline.controller.ts:234) and MI-03's mini-run emit.
    await emitEvent(c, tenantId, "pipeline_run", runId, "pipeline.run.created", {
      sourceMeetingId: null, title: row.org_name, actorId: actorUserId,
    });
    await emitEvent(c, tenantId, "agency_lead", leadId, "agency.lead.converted", {
      clientId, projectId, runId, actorId: actorUserId,
    });

    return {
      outcome: "converted" as const,
      clientId, projectId, runId,
      ownerId: row.owner_id,
      contactUserId,
      orgName: row.org_name,
      delegations: delegationReport,
    };
  });

  return result;
}
