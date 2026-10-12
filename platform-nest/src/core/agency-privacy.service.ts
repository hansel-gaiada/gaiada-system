// M5-G5 — data-subject requests (find / export / erase) over the agency intake data: `agency_leads`, the
// AD-1 `agency_discovery_submissions` and `agency_intake_tokens`; plus the suppression list the web intake
// and P2's ad uploads consult. Addendum: legal/website-visitor-addendum.md §9.3 items 3, 7, 9 (R-V11, R-V12).
// Mirrors WebDesk WSK-38 (webdesk/api/src/privacy/): same three commands, same ledger shape, same hash.
//
// ── THE WS4 FLOW (all three are HIGH, for every principal, humans included) ────────────────────────
// The SM-21 shape (search.controller.ts `applyChangeProposalViaApi`), one route called twice:
//   call 1, no approvalId  -> `fileAgencyPrivacyRequest`: ONE transaction inserts a pending HIGH
//                             `automation_approvals` row (WS4's existing store, origin 'automation') AND the
//                             ledger's `filed` row binding that approval to (kind, email hash, phone hash,
//                             requester). Nothing is read. 202.
//   a human decides it      -> the existing decide endpoint / approvals inbox. Deciding executes nothing.
//   call 2, approvalId      -> `executeAgencyPrivacyRequest`: under an advisory lock on the approval it
//                             re-derives everything from STORED state: the filed row (never tool_args,
//                             which any member can forge through POST /automation-approvals), the same
//                             kind, the same hashes recomputed from this body (content binding), the same
//                             requester, an `approved` decision by SOMEONE ELSE (maker != checker: a
//                             self-approved privacy request never runs), and no earlier execution. Only
//                             then does it read or write personal data, and it ends by inserting the
//                             `executed` ledger row, whose partial UNIQUE index is the single-use claim.
// The approval row never holds the identifier: tool_args carries the kind, the request id, WHICH keys were
// given ("email", "phone") and the subject hashes (+ a display hint that stays in the row), so neither the inbox,
// the decided event's outbox payload nor the notification ever carries the person's email or phone.
//
// ── M5-G5b: THE UNATTENDED (AGENT HUB) PATH ─────────────────────────────────────────────────────────
// An unattended caller is suspended by the mcp-hub before it reaches this route, and files its approval through
// `POST /automation-approvals` with the call's args. core/agency-privacy.filing.ts (applied by
// core/approval-filing.ts) reduces those args to the same hashes BEFORE anything is stored or emitted and writes
// this ledger's `filed` row in the same transaction, so a hub-filed approval is bound exactly like a route-filed
// one. The requester then runs it with just the `approvalId`: `executeAgencyPrivacyRequest` is called with
// `subject: null` and rebuilds the subject from the ledger's hashes (`resolveSubjectByHashes`): the stored contact
// values that hash to them ARE the plaintext, already in this tenant's tables, so nothing is vaulted and no
// schema changes. The call stays two-person and is still never auto-run by D14 (approval-executables.ts bar).
//
// ── WHAT ERASE DOES (scrub, keep the row) ───────────────────────────────────────────────────────────
// For every lead in scope (its own contact matches, or one of its AD-1 submissions' contact matches):
//   agency_leads    org_name '(erased)', contact_name/email/phone NULL, attribution NULL, a non-null
//                   declined_reason becomes '(erased)' (the declined => reason CHECK still holds), erased_at.
//                   status, stage, converted_client_id, deal value and visitor_consent are KEPT: the first
//                   three keep every CHECK and the client link intact; the consent snapshot names nobody
//                   and is the evidence of what the visitor agreed to when data was collected (the WSK-38
//                   precedent keeps the consent text for the same reason).
//   AD-1 answers    the person fields (agency-privacy.subject.ts AD1_PERSON_FIELDS) become "[erased]", and
//                   the subject's own email / phone / name are removed from every other string answer.
//                   Business answers are kept (the evidentiary basis of scope). erased_at.
//   intake tokens   unused, unrevoked tokens of those leads are revoked, so no new data can arrive. Tokens
//                   hold no personal data themselves (a hash and timestamps).
//   suppression     the given identifiers, and the contact fields of the leads that matched directly, are
//                   added (hashed) with scope 'all'.
// A CONVERTED lead's client record (clients, client contacts, projects, the delivery run) is OUT OF SCOPE:
// it follows client-record retention (addendum §5). The lead row itself is still scrubbed, and every
// result lists those leads under `outOfScope` so the operator handles the client record by its own process.
//
// ── PRIVACY OF THIS FILE ────────────────────────────────────────────────────────────────────────────
// No identifier is logged, put in an error, an event or an activity row. Activities carry ids and counts.
// Plain tenant wall: `withTenants([tenantId])` with NO `{ modules }` (agency tables are not module-walled).
import type { PoolClient } from "pg";
import { newId, withTenants } from "../db";
import { config } from "../config";
import { insertAutomationApprovalRow, notifyApprovalFiled, type FileApprovalInput } from "./approval-filing";
import {
  collectStrings, contactHashes, contactMatches, findNormalisedByHash, normalizeEmail, normalizePhone,
  recoverIdentifiersFromText, scrubAnswers, subjectHash, type Subject,
} from "./agency-privacy.subject";
import {
  approvalReasonFor, identifierKinds as identifierKindsOf, insertLedgerRow, minimisedArgsForSubject,
} from "./agency-privacy.filing";

export const PRIVACY_KINDS = ["find", "export", "erase"] as const;
export type PrivacyKind = (typeof PRIVACY_KINDS)[number];

/** `automation_approvals.tool_name` per command, and the MCP tool names (core-tools.ts). */
export const PRIVACY_TOOL: Readonly<Record<PrivacyKind, string>> = Object.freeze({
  find: "agency_privacy.find",
  export: "agency_privacy.export",
  erase: "agency_privacy.erase",
});

export function isPrivacyKind(v: unknown): v is PrivacyKind {
  return typeof v === "string" && (PRIVACY_KINDS as readonly string[]).includes(v);
}

const ERASED_ORG = "(erased)";
const ERASED_REASON = "(erased)";

// ═════════════════════════════════════════════════════════════════════════════════ suppression list
export type SuppressionPurpose = "intake" | "ad_upload";

/**
 * True when this contact must not be used for `purpose` in this tenant. `intake`: a lead must not be created
 * from it (scope 'all'). `ad_upload`: it must not be sent to an ad platform (scope 'all' or 'ad_upload').
 * Takes plaintext (normalised and hashed here, in memory) so a caller can never pass an un-normalised hash.
 * Runs on the caller's transaction (tenant GUC already set). A contact with neither key usable is never
 * suppressed. EXPORTED FOR P2: its gate calls this with purpose 'ad_upload' before any upload.
 */
export async function isContactSuppressed(
  c: PoolClient,
  tenantId: string,
  contact: { email?: string | null; phone?: string | null },
  purpose: SuppressionPurpose,
): Promise<boolean> {
  const hashes = contactHashes(contact);
  if (hashes.length === 0) return false;
  const scopes = purpose === "intake" ? ["all"] : ["all", "ad_upload"];
  const { rows } = await c.query<{ hit: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM agency_contact_suppressions
        WHERE tenant_id = $1 AND scope = ANY($2::text[])
          AND (contact_kind, contact_hash) IN (SELECT * FROM unnest($3::text[], $4::text[]))
     ) AS hit`,
    [tenantId, scopes, hashes.map((h) => h.kind), hashes.map((h) => h.hash)],
  );
  return rows[0]?.hit === true;
}

/** Record hashed contacts. Idempotent per (tenant, kind, hash, scope). Returns how many distinct hashes are
 *  now covered (new or already present). */
export async function addContactSuppressions(
  c: PoolClient,
  tenantId: string,
  hashes: { kind: "email" | "phone"; hash: string }[],
  opts: { scope: "all" | "ad_upload"; reason: "erasure" | "marketing_withdrawal"; dsrRequestId: string | null; createdBy: string | null },
): Promise<number> {
  const unique = [...new Map(hashes.map((h) => [`${h.kind}:${h.hash}`, h])).values()];
  for (const h of unique) {
    await c.query(
      `INSERT INTO agency_contact_suppressions
         (id, tenant_id, contact_kind, contact_hash, scope, reason, dsr_request_id, created_by, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (tenant_id, contact_kind, contact_hash, scope) DO NOTHING`,
      [newId(), tenantId, h.kind, h.hash, opts.scope, opts.reason, opts.dsrRequestId, opts.createdBy, config.originSite],
    );
  }
  return unique.length;
}

// ═════════════════════════════════════════════════════════════════════════════════════════ matching
interface LeadRow {
  id: string;
  status: string;
  stage: string;
  source: string;
  converted_client_id: string | null;
  org_name: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  origin_form: string | null;
  submission_ref: string | null;
  web_site_slug: string | null;
  attribution: Record<string, unknown> | null;
  visitor_consent: Record<string, unknown> | null;
  declined_reason: string | null;
  created_at: Date;
  status_changed_at: Date;
  erased_at: Date | null;
  deleted_at: Date | null;
  sub_contacts: { email: string | null; phone: string | null; name: string | null }[];
}

export interface MatchedLead {
  row: LeadRow;
  /** The lead's OWN contact fields belong to the subject (not only one of its AD-1 submissions). */
  direct: boolean;
}

/** The phone digit strings a stored value can carry and still normalise to `phone` (SQL pre-filter only;
 *  `contactMatches` confirms in JS with the real normaliser). */
function phoneCandidates(phone: string | null): string[] | null {
  return phone ? [phone, `00${phone}`] : null;
}

/** Every lead in this tenant connected to the subject: its own contact matches, or an AD-1 submission's
 *  contact does. Soft-deleted leads are included: they still hold data. */
export async function matchLeads(c: PoolClient, tenantId: string, subject: Pick<Subject, "email" | "phone">): Promise<MatchedLead[]> {
  const { rows } = await c.query<LeadRow>(
    `SELECT l.id, l.status, l.stage, l.source, l.converted_client_id, l.org_name, l.contact_name, l.contact_email,
            l.contact_phone, l.origin_form, l.submission_ref, l.web_site_slug, l.attribution, l.visitor_consent,
            l.declined_reason, l.created_at, l.status_changed_at, l.erased_at, l.deleted_at,
            COALESCE((SELECT json_agg(json_build_object('email', s.answers->>'contact_email',
                                                        'phone', s.answers->>'contact_phone',
                                                        'name',  s.answers->>'contact_name'))
                        FROM agency_discovery_submissions s
                       WHERE s.tenant_id = l.tenant_id AND s.lead_id = l.id), '[]'::json) AS sub_contacts
       FROM agency_leads l
      WHERE l.tenant_id = $1
        AND (
          ($2::text IS NOT NULL AND lower(btrim(l.contact_email)) = $2)
          OR ($3::text[] IS NOT NULL AND regexp_replace(COALESCE(l.contact_phone, ''), '\\D', '', 'g') = ANY($3::text[]))
          OR EXISTS (
            SELECT 1 FROM agency_discovery_submissions s
             WHERE s.tenant_id = l.tenant_id AND s.lead_id = l.id
               AND (
                 ($2::text IS NOT NULL AND lower(btrim(s.answers->>'contact_email')) = $2)
                 OR ($3::text[] IS NOT NULL
                     AND regexp_replace(COALESCE(s.answers->>'contact_phone', ''), '\\D', '', 'g') = ANY($3::text[]))
               )
          )
        )
      ORDER BY l.created_at ASC, l.id ASC`,
    [tenantId, subject.email, phoneCandidates(subject.phone)],
  );
  const out: MatchedLead[] = [];
  for (const row of rows) {
    const direct = contactMatches(subject, { email: row.contact_email, phone: row.contact_phone });
    const viaSubmission = (row.sub_contacts ?? []).some((s) => contactMatches(subject, s));
    if (direct || viaSubmission) out.push({ row, direct });
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════════════ result shapes
export interface OutOfScopeItem {
  leadId: string;
  convertedClientId: string;
  reason: "client_record_retention";
}

export interface FoundLead {
  leadId: string;
  status: string;
  stage: string;
  source: string;
  createdAt: string;
  statusChangedAt: string;
  erasedAt: string | null;
  deleted: boolean;
  /** true: the lead's own contact matched; false: only one of its AD-1 submissions did. */
  directMatch: boolean;
  submissionCount: number;
  tokenCount: number;
  convertedClientId: string | null;
}

export interface ExportedLead extends FoundLead {
  orgName: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  originForm: string | null;
  submissionRef: string | null;
  webSiteSlug: string | null;
  attribution: Record<string, unknown> | null;
  visitorConsent: Record<string, unknown> | null;
  declinedReason: string | null;
  submissions: { submissionId: string; schemaVersion: string; createdAt: string; erasedAt: string | null; answers: unknown }[];
  intakeTokens: { tokenId: string; kind: string; createdAt: string; expiresAt: string | null; usedAt: string | null; revokedAt: string | null }[];
}

export interface PrivacyCounts {
  leadCount: number;
  submissionCount: number;
  tokenCount: number;
  outOfScopeCount: number;
  suppressionCount: number;
}

export type PrivacyEffectResult =
  | { kind: "find"; leads: FoundLead[]; outOfScope: OutOfScopeItem[]; counts: PrivacyCounts }
  | { kind: "export"; leads: ExportedLead[]; outOfScope: OutOfScopeItem[]; counts: PrivacyCounts }
  | { kind: "erase"; erasedAt: string; outOfScope: OutOfScopeItem[]; counts: PrivacyCounts };

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);

function outOfScopeOf(matched: MatchedLead[]): OutOfScopeItem[] {
  return matched
    .filter((m) => m.row.converted_client_id !== null)
    .map((m) => ({ leadId: m.row.id, convertedClientId: m.row.converted_client_id as string, reason: "client_record_retention" as const }));
}

interface SubmissionRow { id: string; lead_id: string; schema_version: string; answers: unknown; created_at: Date; erased_at: Date | null }
interface TokenRow { id: string; lead_id: string; kind: string; created_at: Date; expires_at: Date | null; used_at: Date | null; revoked_at: Date | null }

async function readChildren(c: PoolClient, tenantId: string, leadIds: string[]): Promise<{ subs: SubmissionRow[]; tokens: TokenRow[] }> {
  if (leadIds.length === 0) return { subs: [], tokens: [] };
  const subs = await c.query<SubmissionRow>(
    `SELECT id, lead_id, schema_version, answers, created_at, erased_at FROM agency_discovery_submissions
      WHERE tenant_id = $1 AND lead_id = ANY($2::uuid[]) ORDER BY created_at ASC, id ASC`,
    [tenantId, leadIds],
  );
  const tokens = await c.query<TokenRow>(
    `SELECT id, lead_id, kind, created_at, expires_at, used_at, revoked_at FROM agency_intake_tokens
      WHERE tenant_id = $1 AND lead_id = ANY($2::uuid[]) ORDER BY created_at ASC, id ASC`,
    [tenantId, leadIds],
  );
  return { subs: subs.rows, tokens: tokens.rows };
}

function foundLead(m: MatchedLead, subs: SubmissionRow[], tokens: TokenRow[]): FoundLead {
  const r = m.row;
  return {
    leadId: r.id,
    status: r.status,
    stage: r.stage,
    source: r.source,
    createdAt: iso(r.created_at) as string,
    statusChangedAt: iso(r.status_changed_at) as string,
    erasedAt: iso(r.erased_at),
    deleted: r.deleted_at !== null,
    directMatch: m.direct,
    submissionCount: subs.filter((s) => s.lead_id === r.id).length,
    tokenCount: tokens.filter((t) => t.lead_id === r.id).length,
    convertedClientId: r.converted_client_id,
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════ effects
async function runFind(c: PoolClient, tenantId: string, subject: Subject): Promise<PrivacyEffectResult> {
  const matched = await matchLeads(c, tenantId, subject);
  const { subs, tokens } = await readChildren(c, tenantId, matched.map((m) => m.row.id));
  const outOfScope = outOfScopeOf(matched);
  return {
    kind: "find",
    leads: matched.map((m) => foundLead(m, subs, tokens)),
    outOfScope,
    counts: { leadCount: matched.length, submissionCount: subs.length, tokenCount: tokens.length, outOfScopeCount: outOfScope.length, suppressionCount: 0 },
  };
}

async function runExport(c: PoolClient, tenantId: string, subject: Subject): Promise<PrivacyEffectResult> {
  const matched = await matchLeads(c, tenantId, subject);
  const { subs, tokens } = await readChildren(c, tenantId, matched.map((m) => m.row.id));
  const outOfScope = outOfScopeOf(matched);
  const leads: ExportedLead[] = matched.map((m) => {
    const r = m.row;
    return {
      ...foundLead(m, subs, tokens),
      orgName: r.org_name,
      contactName: r.contact_name,
      contactEmail: r.contact_email,
      contactPhone: r.contact_phone,
      originForm: r.origin_form,
      submissionRef: r.submission_ref,
      webSiteSlug: r.web_site_slug,
      attribution: r.attribution,
      visitorConsent: r.visitor_consent,
      declinedReason: r.declined_reason,
      submissions: subs.filter((s) => s.lead_id === r.id).map((s) => ({
        submissionId: s.id, schemaVersion: s.schema_version, createdAt: iso(s.created_at) as string, erasedAt: iso(s.erased_at), answers: s.answers,
      })),
      intakeTokens: tokens.filter((t) => t.lead_id === r.id).map((t) => ({
        tokenId: t.id, kind: t.kind, createdAt: iso(t.created_at) as string, expiresAt: iso(t.expires_at), usedAt: iso(t.used_at), revokedAt: iso(t.revoked_at),
      })),
    };
  });
  return {
    kind: "export",
    leads,
    outOfScope,
    counts: { leadCount: matched.length, submissionCount: subs.length, tokenCount: tokens.length, outOfScopeCount: outOfScope.length, suppressionCount: 0 },
  };
}

async function runErase(
  c: PoolClient, tenantId: string, subject: Subject, requestId: string, actorId: string,
): Promise<PrivacyEffectResult> {
  const matched = await matchLeads(c, tenantId, subject);
  const leadIds = matched.map((m) => m.row.id);
  if (leadIds.length > 0) {
    // Lock the rows before rewriting them, in a stable order (the match is ordered).
    await c.query(`SELECT id FROM agency_leads WHERE tenant_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE`, [tenantId, leadIds]);
  }
  const { subs } = await readChildren(c, tenantId, leadIds);

  // AD-1 answers: person fields, then the subject's own identifiers wherever else they appear.
  let submissionCount = 0;
  for (const s of subs) {
    const lead = matched.find((m) => m.row.id === s.lead_id)!.row;
    const subContacts = lead.sub_contacts ?? [];
    // A subject rebuilt from hashes (M5-G5b) has plaintext only for what some contact field held. An identifier
    // that appears solely in free text of a lead matched through the OTHER key is found by hashing the email- and
    // phone-shaped tokens of this submission, so the run scrubs what a run from typed identifiers would.
    const found = (subject.emailHash && !subject.email) || (subject.phoneHash && !subject.phone)
      ? recoverIdentifiersFromText(collectStrings(s.answers), {
          emailHash: subject.email ? null : subject.emailHash, phoneHash: subject.phone ? null : subject.phoneHash,
        })
      : { emails: [], phones: [] };
    const { answers } = scrubAnswers(s.answers, {
      emails: [subject.email, lead.contact_email, ...subContacts.map((x) => x.email), ...found.emails],
      phones: [subject.phone, lead.contact_phone, ...subContacts.map((x) => x.phone), ...found.phones],
      names: [lead.contact_name, ...subContacts.map((x) => x.name)],
    });
    await c.query(
      `UPDATE agency_discovery_submissions SET answers = $3::jsonb, erased_at = now() WHERE tenant_id = $1 AND id = $2`,
      [tenantId, s.id, JSON.stringify(answers)],
    );
    submissionCount += 1;
  }

  // Intake tokens: nothing new may arrive for an erased lead.
  const revoked = leadIds.length === 0 ? { rowCount: 0 } : await c.query(
    `UPDATE agency_intake_tokens SET revoked_at = now()
      WHERE tenant_id = $1 AND lead_id = ANY($2::uuid[]) AND used_at IS NULL AND revoked_at IS NULL`,
    [tenantId, leadIds],
  );

  // The leads: person fields scrubbed, row kept. status/stage/client link untouched, so every CHECK holds
  // (and the status clock does not move: an erase is not a status change).
  if (leadIds.length > 0) {
    await c.query(
      `UPDATE agency_leads
          SET org_name = $3, contact_name = NULL, contact_email = NULL, contact_phone = NULL, attribution = NULL,
              declined_reason = CASE WHEN declined_reason IS NULL THEN NULL ELSE $4 END,
              erased_at = now(), updated_at = now()
        WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
      [tenantId, leadIds, ERASED_ORG, ERASED_REASON],
    );
  }

  // Suppression: the identifiers given, plus the contact fields of the leads that matched DIRECTLY (the same
  // person's other key). A lead matched only through an AD-1 submission may carry someone else's contact
  // (a shared office address), which is why those are not added.
  const hashes: { kind: "email" | "phone"; hash: string }[] = [];
  if (subject.emailHash) hashes.push({ kind: "email", hash: subject.emailHash });
  if (subject.phoneHash) hashes.push({ kind: "phone", hash: subject.phoneHash });
  for (const m of matched) if (m.direct) hashes.push(...contactHashes({ email: m.row.contact_email, phone: m.row.contact_phone }));
  const suppressionCount = await addContactSuppressions(c, tenantId, hashes, {
    scope: "all", reason: "erasure", dsrRequestId: requestId, createdBy: actorId,
  });

  const outOfScope = outOfScopeOf(matched);
  return {
    kind: "erase",
    erasedAt: new Date().toISOString(),
    outOfScope,
    counts: {
      leadCount: leadIds.length,
      submissionCount,
      tokenCount: revoked.rowCount ?? 0,
      outOfScopeCount: outOfScope.length,
      suppressionCount,
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════ ledger + WS4
/** Which keys were given, for the approval and the inbox. Never the values. */
export function identifierKinds(subject: Pick<Subject, "email" | "phone">): ("email" | "phone")[] {
  return identifierKindsOf(subject);
}

/** The approval's inbox text. No identifier: it names the command and which keys identify the person. */
export function approvalReason(kind: PrivacyKind, subject: Pick<Subject, "email" | "phone">): string {
  return approvalReasonFor(kind, identifierKindsOf(subject));
}

/** Call 1: file the WS4 approval and the ledger's `filed` row, atomically. Reads no personal data. */
export async function fileAgencyPrivacyRequest(input: {
  tenantId: string;
  kind: PrivacyKind;
  subject: Subject;
  requestedBy: string;
}): Promise<{ requestId: string; approvalId: string }> {
  const requestId = newId();
  const approvalId = newId();
  const approval: FileApprovalInput = {
    tenantId: input.tenantId,
    workflowId: `agency-privacy:${requestId}`,
    toolName: PRIVACY_TOOL[input.kind],
    // The minimised shape (core/agency-privacy.filing.ts): kind, request id, which keys, the subject hashes and a
    // display hint. `insertAutomationApprovalRow` re-applies the policy (idempotent) and, through its `onFiled`
    // hook, writes the ledger's `filed` row in the same transaction: the one path every privacy approval takes.
    toolArgs: minimisedArgsForSubject(input.kind, requestId, input.subject),
    impact: "high",
    reason: approvalReason(input.kind, input.subject),
    // 'automation', as SM-21: the inbox's origin taxonomy is closed, and an unlisted origin would file an
    // approval nobody can see. tool_name says which privacy command it is.
    origin: "automation",
    requestedBy: input.requestedBy,
  };
  await withTenants([input.tenantId], (c) => insertAutomationApprovalRow(c, approvalId, approval));
  // The activity row + the decider notification (best-effort inside), after the commit.
  await notifyApprovalFiled(approvalId, approval);
  return { requestId, approvalId };
}

export type ExecuteOutcome =
  | { outcome: "not_found" }
  | { outcome: "mismatch" }
  | { outcome: "not_requester" }
  | { outcome: "awaiting_approval"; requestId: string }
  | { outcome: "rejected"; requestId: string }
  | { outcome: "self_approved"; requestId: string }
  | { outcome: "already_used"; requestId: string }
  | { outcome: "replayed"; requestId: string; counts: PrivacyCounts }
  | { outcome: "executed"; requestId: string; result: PrivacyEffectResult };

/**
 * M5-G5b: rebuild the plaintext of a subject known only by its hashes. The stored contact values that hash to
 * them (this tenant's leads and AD-1 submissions, normalised with the SAME functions the hash was computed
 * with) are exactly what the effects need. An identifier no stored value hashes to has no plaintext: it matches
 * no lead (matching is by stored contact), and an erase still suppresses it BY HASH. Runs on the caller's
 * transaction (tenant GUC set); call it only after every refusal has been decided from stored state.
 */
export async function resolveSubjectByHashes(
  c: PoolClient,
  tenantId: string,
  hashes: { emailHash: string | null; phoneHash: string | null },
): Promise<Subject> {
  let email: string | null = null;
  let phone: string | null = null;
  if (hashes.emailHash) {
    const { rows } = await c.query<{ v: string }>(
      `SELECT DISTINCT v FROM (
         SELECT contact_email AS v FROM agency_leads WHERE tenant_id = $1 AND contact_email IS NOT NULL
         UNION ALL
         SELECT answers->>'contact_email' FROM agency_discovery_submissions WHERE tenant_id = $1 AND answers->>'contact_email' IS NOT NULL
       ) x`,
      [tenantId],
    );
    email = findNormalisedByHash("email", hashes.emailHash, rows.map((r) => r.v));
  }
  if (hashes.phoneHash) {
    const { rows } = await c.query<{ v: string }>(
      `SELECT DISTINCT v FROM (
         SELECT contact_phone AS v FROM agency_leads WHERE tenant_id = $1 AND contact_phone IS NOT NULL
         UNION ALL
         SELECT answers->>'contact_phone' FROM agency_discovery_submissions WHERE tenant_id = $1 AND answers->>'contact_phone' IS NOT NULL
       ) x`,
      [tenantId],
    );
    phone = findNormalisedByHash("phone", hashes.phoneHash, rows.map((r) => r.v));
  }
  return { email, phone, emailHash: hashes.emailHash, phoneHash: hashes.phoneHash };
}

/**
 * Call 2: consume an approved request exactly once. Every refusal is decided from STORED state, before any
 * personal data is read. See the header for the order and why.
 *
 * `subject: null` (M5-G5b) is the run-by-approval form: the caller gave only the `approvalId`, and the subject is
 * rebuilt from the ledger's hashes. There is then no content binding to compare (nothing was typed), and none is
 * needed: the hashes ARE the stored binding. `kind`, requester, decision and single use are checked identically.
 */
export async function executeAgencyPrivacyRequest(input: {
  tenantId: string;
  kind: PrivacyKind;
  subject: Subject | null;
  approvalId: string;
  actorId: string;
}): Promise<ExecuteOutcome> {
  const { tenantId, kind, subject, approvalId, actorId } = input;
  return withTenants([tenantId], async (c): Promise<ExecuteOutcome> => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`agency-privacy:${approvalId}`]);

    const filed = await c.query<{ request_id: string; kind: string; email_hash: string | null; phone_hash: string | null; actor_id: string | null }>(
      `SELECT request_id, kind, email_hash, phone_hash, actor_id FROM agency_dsr_requests
        WHERE tenant_id = $1 AND approval_id = $2 AND phase = 'filed'`,
      [tenantId, approvalId],
    );
    const f = filed.rows[0];
    if (!f) return { outcome: "not_found" };
    // Content binding: the same command for the same person, recomputed from THIS body. Null-equal on purpose:
    // a request filed for email-only does not execute for email+phone (that would widen what was approved).
    if (f.kind !== kind) return { outcome: "mismatch" };
    if (subject && (f.email_hash !== subject.emailHash || f.phone_hash !== subject.phoneHash)) return { outcome: "mismatch" };
    if (f.actor_id !== actorId) return { outcome: "not_requester" };
    const requestId = f.request_id;

    const done = await c.query<{ lead_count: number; submission_count: number; token_count: number; out_of_scope_count: number; suppression_count: number }>(
      `SELECT lead_count, submission_count, token_count, out_of_scope_count, suppression_count FROM agency_dsr_requests
        WHERE tenant_id = $1 AND approval_id = $2 AND phase = 'executed'`,
      [tenantId, approvalId],
    );
    if (done.rows[0]) {
      // An erase replay is answered with its stored counts (no personal data in them). A find/export replay
      // is refused: its response IS personal data, which is never stored, and reading it again needs a new
      // approval (WSK-38's "withheld").
      if (kind !== "erase") return { outcome: "already_used", requestId };
      const d = done.rows[0];
      return {
        outcome: "replayed", requestId,
        counts: {
          leadCount: d.lead_count, submissionCount: d.submission_count, tokenCount: d.token_count,
          outOfScopeCount: d.out_of_scope_count, suppressionCount: d.suppression_count,
        },
      };
    }

    const appr = await c.query<{ status: string; decided_by: string | null; tool_name: string }>(
      `SELECT status, decided_by, tool_name FROM automation_approvals WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [tenantId, approvalId],
    );
    const a = appr.rows[0];
    if (!a) return { outcome: "not_found" };
    if (a.tool_name !== PRIVACY_TOOL[kind]) return { outcome: "mismatch" };
    if (a.status === "pending") return { outcome: "awaiting_approval", requestId };
    if (a.status !== "approved") return { outcome: "rejected", requestId };
    // Maker != checker. Checked here, from the stored decision, because the generic `decide` permission says
    // nothing about who filed the row.
    if (!a.decided_by || a.decided_by === actorId) return { outcome: "self_approved", requestId };

    // Every refusal above came from stored state; only now is personal data read. A run-by-approval call rebuilds
    // the subject from the filed row's hashes (the typed one, when given, was already proven equal to them).
    const who = subject ?? await resolveSubjectByHashes(c, tenantId, { emailHash: f.email_hash, phoneHash: f.phone_hash });
    const result =
      kind === "find" ? await runFind(c, tenantId, who)
      : kind === "export" ? await runExport(c, tenantId, who)
      : await runErase(c, tenantId, who, requestId, actorId);

    // The claim. The partial UNIQUE (approval_id) WHERE phase='executed' makes a second execution impossible
    // even past the advisory lock; a violation rolls this whole transaction (and the erase) back.
    await insertLedgerRow(c, {
      tenantId, requestId, kind, phase: "executed", emailHash: f.email_hash, phoneHash: f.phone_hash, approvalId, actorId,
      counts: result.counts,
    });
    return { outcome: "executed", requestId, result };
  });
}

// Re-exported for the intake and P2, so they import one module for "is this person suppressed".
export { normalizeEmail, normalizePhone, subjectHash };
