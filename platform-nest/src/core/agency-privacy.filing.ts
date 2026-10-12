// M5-G5b — how an `agency_privacy.*` approval is FILED without ever holding the data subject's identifier.
//
// WHY THIS FILE EXISTS. The privacy tools take a person's email and/or phone as arguments. When an UNATTENDED
// caller (an agent, an n8n workflow) calls one, the mcp-hub suspends it (HIGH impact) and the caller files the
// suspension through `approvals.request` -> `POST /api/:t/automation-approvals`, which used to store the call's
// args verbatim in `automation_approvals.tool_args`; the approval's decided-event then carried them into
// `outbox_events` too. G5's route flow (core/agency-privacy.service.ts) never had that problem (it files its own
// approval with kinds only); the hub path did. This file is the per-tool args policy that closes it, applied by
// core/approval-filing.ts BEFORE anything is persisted or emitted (registry: core/approval-arg-minimisers.ts).
//
// It is a LEAF module on purpose (imports only the db helpers, config and the pure subject helpers), so the
// filing core can import it statically: a policy that had to be "registered at boot" could be forgotten by one
// process, and a forgotten policy fails OPEN (raw identifiers stored). Imported statically, it cannot be.
//
// ── WHAT IS STORED INSTEAD ──────────────────────────────────────────────────────────────────────────
// tool_args = {
//   minimised: "agency-privacy.v1",
//   kind: "find" | "export" | "erase",           // from the tool name, never from the caller
//   identifiers: ["email", "phone",              // WHICH keys were given
//                 "visitor_id", "consent_id"],   //   (M5-V3-h: the consented website visitor's own ids)
//   subject: { emailHash?, phoneHash?,           // subjectHash() of the NORMALISED value: the SAME hash the G5
//              emailHint?, phoneHint?,           //   DSR ledger and suppression list use (not a second one)
//              visitorIdHash?, consentIdHash? }, // M5-V3-h: pseudonymHash() = V3-d's tombstone hash, hex. No hint:
//                                                //   a uuid has no harmless part worth showing an approver
//   tenantId?, approvalId?, requestId?           // ids only
// }
// Anything else the caller sent is DROPPED (an allow-list, not a deny-list: an unexpected key such as `query`
// or `Email` can never carry an identifier through).
//
// ── THE HINT (decision recorded) ────────────────────────────────────────────────────────────────────
// `emailHint` is `***@<domain>`: the local part is the person; the domain is not, and it lets the approver
// tell two simultaneous requests apart and spot a nonsense one (a gmail address asked of a corporate lead).
// `phoneHint` is `***` + the last two digits, for the same reason. Both live ONLY in the approval row (the
// approver's detail view). They are dropped from the decided-event (`eventArgs`) and are NOT in the inbox
// reason, the activity row or the notification, which carry ids and the generated sentence only.
// Residual, stated plainly: the hash is unsalted SHA-256 with WebDesk's domain prefix (deliberately, so the two
// ledgers correlate). Someone who can read the DB and guess an email can confirm the guess; a phone number has
// few enough digits to brute-force. The leads table itself holds these values in plaintext, so the hash adds no
// exposure beyond what DB read already gives, and the hint adds 100x on a phone (last two digits).
//
// ── HOW THE APPROVAL STILL EXECUTES ─────────────────────────────────────────────────────────────────
// `onFiled` writes the G5 ledger's `filed` row IN THE SAME TRANSACTION as the approval INSERT, binding
// (approval, kind, hashes, requester) exactly as the route's own call 1 does: the binding is the ledger row, never
// tool_args (which any member can forge). After a DIFFERENT admin approves, the requester calls the route with
// just the `approvalId`; `executeAgencyPrivacyRequest` re-resolves the subject from the ledger's hashes
// (agency-privacy.service.ts `resolveSubjectByHashes`). No vault, no ciphertext, no schema change.
//
// ── AUTHORITY AT FILING ─────────────────────────────────────────────────────────────────────────────
// `authorizeFiling` asks Cerbos `convert` on `agency_lead` (the route's own gate) when a privacy approval is
// filed through `POST /automation-approvals`, so the generic `create` right (which an agent's OBO human or any
// automation account holds) cannot be used to plant a privacy approval the route would never have filed.
import { BadRequestException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { newId } from "../db";
import { config } from "../config";
import type { Principal } from "../rbac/principal";
import { authorize } from "./http";
import { NO_SUBJECT_MESSAGE, parseSubject } from "./agency-privacy.subject";
import type { PrivacyCounts } from "./agency-privacy.service";

export const MINIMISED_MARKER = "agency-privacy.v1";

export type PrivacyKindName = "find" | "export" | "erase";

/** The MCP tool names (kept in step with agency-privacy.service.ts `PRIVACY_TOOL` by a unit test). */
export const AGENCY_PRIVACY_TOOL_NAMES = ["agency_privacy.find", "agency_privacy.export", "agency_privacy.erase"] as const;

const KIND_OF_TOOL: Readonly<Record<string, PrivacyKindName>> = Object.freeze({
  "agency_privacy.find": "find",
  "agency_privacy.export": "export",
  "agency_privacy.erase": "erase",
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const EMAIL_HINT_RE = /^\*\*\*@[^\s@*]{1,253}$/;
const PHONE_HINT_RE = /^\*\*\*\d{2}$/;

export interface MinimisedSubject {
  emailHash?: string;
  phoneHash?: string;
  emailHint?: string;
  phoneHint?: string;
  /** M5-V3-h: pseudonymHash() of the visitor id / consent id (hex sha256 of the lower-case uuid). */
  visitorIdHash?: string;
  consentIdHash?: string;
}

/** The kinds of key a request can name a person by. Stored in `identifiers`; never the values. */
export type IdentifierKind = "email" | "phone" | "visitor_id" | "consent_id";

const KIND_WORDS: Readonly<Record<IdentifierKind, string>> = Object.freeze({
  email: "email", phone: "phone", visitor_id: "website visitor id", consent_id: "website consent id",
});

/** `***@domain` for an ALREADY-NORMALISED email. */
export function emailHint(email: string): string {
  const at = email.lastIndexOf("@");
  return `***@${email.slice(at + 1)}`;
}

/** `***` + the last two digits of an ALREADY-NORMALISED phone (digits only). */
export function phoneHint(digits: string): string {
  return `***${digits.slice(-2)}`;
}

/** Which keys were given. Never the values. */
export function identifierKinds(subject: {
  email: string | null; phone: string | null; visitorId?: string | null; consentId?: string | null;
}): IdentifierKind[] {
  return [
    ...(subject.email ? (["email"] as const) : []), ...(subject.phone ? (["phone"] as const) : []),
    ...(subject.visitorId ? (["visitor_id"] as const) : []), ...(subject.consentId ? (["consent_id"] as const) : []),
  ];
}

function kindsOfMinimised(s: MinimisedSubject): IdentifierKind[] {
  return [
    ...(s.emailHash ? (["email"] as const) : []), ...(s.phoneHash ? (["phone"] as const) : []),
    ...(s.visitorIdHash ? (["visitor_id"] as const) : []), ...(s.consentIdHash ? (["consent_id"] as const) : []),
  ];
}

/** True when a minimised subject names somebody (any of the four hashes). */
export function minimisedNamesSomeone(s: MinimisedSubject): boolean {
  return kindsOfMinimised(s).length > 0;
}

/** The approval's inbox / notification text. No identifier: the command and which keys identify the person. */
export function approvalReasonFor(kind: PrivacyKindName, kinds: readonly IdentifierKind[]): string {
  const verb = kind === "erase" ? "ERASE the personal data of" : kind === "export" ? "export the personal data of" : "find the records of";
  const by = kinds.length > 0 ? `identified by ${kinds.map((k) => KIND_WORDS[k] ?? k).join(" and ")}` : "identified by the approval it is bound to";
  const reach = "the agency intake (leads, AD-1 submissions, intake tokens) and the consented website-visitor profiles" +
    (kind === "erase" ? " (with a forget at the visitor-event collector)" : "");
  return (
    `Privacy request: ${verb} one data subject in ${reach}, ` +
    `${by}. Approving lets the requester run it exactly once; ` +
    "nothing runs on approval itself, and the requester cannot approve their own request."
  );
}

function present(v: unknown): boolean {
  return v !== undefined && v !== null;
}

function refuse(message: string): never {
  throw new BadRequestException({ message, reason: "subject_invalid" });
}

/** Re-validate an already-minimised `subject` object: keep only well-formed hashes and hints. */
function keepMinimisedSubject(v: unknown): MinimisedSubject {
  const s = v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const out: MinimisedSubject = {};
  if (typeof s.emailHash === "string" && HASH_RE.test(s.emailHash)) {
    out.emailHash = s.emailHash;
    if (typeof s.emailHint === "string" && EMAIL_HINT_RE.test(s.emailHint)) out.emailHint = s.emailHint;
  }
  if (typeof s.phoneHash === "string" && HASH_RE.test(s.phoneHash)) {
    out.phoneHash = s.phoneHash;
    if (typeof s.phoneHint === "string" && PHONE_HINT_RE.test(s.phoneHint)) out.phoneHint = s.phoneHint;
  }
  if (typeof s.visitorIdHash === "string" && HASH_RE.test(s.visitorIdHash)) out.visitorIdHash = s.visitorIdHash;
  if (typeof s.consentIdHash === "string" && HASH_RE.test(s.consentIdHash)) out.consentIdHash = s.consentIdHash;
  return out;
}

/** The minimised subject of a parsed (in-memory) Subject: hashes and hints only, never a value. */
function minimisedOf(s: {
  email: string | null; phone: string | null; emailHash: string | null; phoneHash: string | null;
  visitorIdHash?: string | null; consentIdHash?: string | null;
}): MinimisedSubject {
  const sub: MinimisedSubject = {};
  if (s.email && s.emailHash) { sub.emailHash = s.emailHash; sub.emailHint = emailHint(s.email); }
  if (s.phone && s.phoneHash) { sub.phoneHash = s.phoneHash; sub.phoneHint = phoneHint(s.phone); }
  if (s.visitorIdHash) sub.visitorIdHash = s.visitorIdHash;
  if (s.consentIdHash) sub.consentIdHash = s.consentIdHash;
  return sub;
}

export interface MinimisedFiling {
  toolArgs: Record<string, unknown>;
  reason: string;
}

/**
 * The minimiser for one `agency_privacy.*` call's args. PURE (no I/O) and IDEMPOTENT: minimising its own output
 * returns the same value, which is what lets the filing core apply it on every path (the controller's create(),
 * `insertAutomationApprovalRow`, `notifyApprovalFiled`, resolve-and-execute's digest) without double work.
 *
 * Raw `email` / `phone` are parsed with the route's own `parseSubject` (same normalisation, same limits), so a
 * value the route would refuse is refused HERE with the same 400 `subject_invalid` instead of being stored
 * un-hashed. Nothing in the error carries the value.
 */
export function minimiseAgencyPrivacyArgs(toolName: string, args: Record<string, unknown>): MinimisedFiling {
  const kind = KIND_OF_TOOL[toolName];
  if (!kind) throw new Error(`no agency-privacy minimiser for tool '${toolName}'`);
  const a = args !== null && typeof args === "object" && !Array.isArray(args) ? args : {};
  const alreadyMinimised = a.minimised === MINIMISED_MARKER;

  let subject: MinimisedSubject = {};
  if (present(a.email) || present(a.phone) || present(a.visitorId) || present(a.consentId)) {
    // M5-V3-h: the visitor id / consent id go through the route's own parser too (a uuid or a 400), and only
    // their hashes survive.
    const parsed = parseSubject({ email: a.email, phone: a.phone, visitorId: a.visitorId, consentId: a.consentId });
    if (!parsed.ok) refuse(parsed.message);
    subject = minimisedOf(parsed.subject);
  } else if (alreadyMinimised) {
    subject = keepMinimisedSubject(a.subject);
  }

  const approvalId = typeof a.approvalId === "string" && UUID_RE.test(a.approvalId) ? a.approvalId : undefined;
  const hasSubject = minimisedNamesSomeone(subject);
  // A call that names nobody and runs no approval is a call the route would refuse: refuse it here too rather
  // than file an approval that can never be bound to a person.
  if (!hasSubject && !approvalId) refuse(NO_SUBJECT_MESSAGE);

  const kinds = kindsOfMinimised(subject);
  const toolArgs: Record<string, unknown> = { minimised: MINIMISED_MARKER, kind, identifiers: kinds };
  if (hasSubject) toolArgs.subject = subject;
  if (typeof a.tenantId === "string" && SAFE_ID_RE.test(a.tenantId)) toolArgs.tenantId = a.tenantId;
  if (approvalId) toolArgs.approvalId = approvalId;
  // `requestId` is only honoured from an already-minimised shape (the route's own call 1 sets it); in a raw
  // caller's args it is dropped and the ledger row gets a fresh one.
  if (alreadyMinimised && typeof a.requestId === "string" && UUID_RE.test(a.requestId)) toolArgs.requestId = a.requestId;
  return { toolArgs, reason: approvalReasonFor(kind, kinds) };
}

/** What may ride the outbox: the hashes, never the hints. */
export function agencyPrivacyEventArgs(stored: Record<string, unknown>): Record<string, unknown> {
  const out = { ...stored };
  if (out.subject !== null && typeof out.subject === "object" && !Array.isArray(out.subject)) {
    const { emailHash, phoneHash, visitorIdHash, consentIdHash } = out.subject as MinimisedSubject;
    out.subject = {
      ...(emailHash ? { emailHash } : {}), ...(phoneHash ? { phoneHash } : {}),
      ...(visitorIdHash ? { visitorIdHash } : {}), ...(consentIdHash ? { consentIdHash } : {}),
    };
  }
  return out;
}

export async function authorizeAgencyPrivacyFiling(principal: Principal, tenantId: string): Promise<void> {
  await authorize(principal, { kind: "agency_lead", tenantId, module: "agency" }, "convert");
}

// ═══════════════════════════════════════════════════════════════════════════════════════ the ledger
/** All-zero counts (a filed row; a find or export that matched nothing). */
export function emptyPrivacyCounts(): PrivacyCounts {
  return {
    leadCount: 0, submissionCount: 0, tokenCount: 0, outOfScopeCount: 0, suppressionCount: 0,
    profileCount: 0, profileEventCount: 0, tombstoneCount: 0, collectorForget: null, collectorForgetCalls: 0, collectorDeletedEvents: 0,
  };
}

/**
 * One `agency_dsr_requests` row (append-only). Hashes and counts only. M5-V3-h: the visitor hashes, the profile
 * counts and, on an EXECUTED ERASE ONLY, the collector outcome (migration 202610131900's
 * dsr_collector_forget_on_erase requires it there and refuses it everywhere else).
 */
export async function insertLedgerRow(
  c: PoolClient,
  row: {
    tenantId: string; requestId: string; kind: PrivacyKindName; phase: "filed" | "executed";
    emailHash: string | null; phoneHash: string | null; visitorIdHash?: string | null; consentIdHash?: string | null;
    approvalId: string; actorId: string; counts?: PrivacyCounts;
  },
): Promise<string> {
  const id = newId();
  const k: PrivacyCounts = row.counts ?? emptyPrivacyCounts();
  const forget = row.phase === "executed" && row.kind === "erase" ? (k.collectorForget ?? "not_needed") : null;
  await c.query(
    `INSERT INTO agency_dsr_requests
       (id, tenant_id, request_id, kind, phase, email_hash, phone_hash, visitor_id_hash, consent_id_hash, approval_id, actor_id,
        lead_count, submission_count, token_count, out_of_scope_count, suppression_count,
        profile_count, profile_event_count, tombstone_count, collector_forget, collector_forget_calls, collector_deleted_events,
        origin_site)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
    [
      id, row.tenantId, row.requestId, row.kind, row.phase, row.emailHash, row.phoneHash, row.visitorIdHash ?? null,
      row.consentIdHash ?? null, row.approvalId, row.actorId,
      k.leadCount, k.submissionCount, k.tokenCount, k.outOfScopeCount, k.suppressionCount,
      k.profileCount, k.profileEventCount, k.tombstoneCount, forget, k.collectorForgetCalls, k.collectorDeletedEvents,
      config.originSite,
    ],
  );
  return id;
}

/**
 * Same transaction as the approval INSERT: the ledger's `filed` row. A call with no subject (an approvalId-only
 * call: nothing to bind) writes nothing; the dsr_has_subject CHECK would refuse it anyway.
 */
export async function onAgencyPrivacyFiled(
  c: PoolClient,
  f: { approvalId: string; tenantId: string; toolName: string; requestedBy: string; toolArgs: Record<string, unknown> },
): Promise<void> {
  const kind = KIND_OF_TOOL[f.toolName];
  if (!kind) return;
  const s = keepMinimisedSubject(f.toolArgs.subject);
  if (!minimisedNamesSomeone(s)) return;
  const requestId = typeof f.toolArgs.requestId === "string" && UUID_RE.test(f.toolArgs.requestId) ? f.toolArgs.requestId : newId();
  await insertLedgerRow(c, {
    tenantId: f.tenantId, requestId, kind, phase: "filed",
    emailHash: s.emailHash ?? null, phoneHash: s.phoneHash ?? null,
    visitorIdHash: s.visitorIdHash ?? null, consentIdHash: s.consentIdHash ?? null,
    approvalId: f.approvalId, actorId: f.requestedBy,
  });
}

/** Build the minimised-shape args for a Subject already held in memory (the route's own call 1). */
export function minimisedArgsForSubject(
  kind: PrivacyKindName,
  requestId: string,
  subject: {
    email: string | null; phone: string | null; emailHash: string | null; phoneHash: string | null;
    visitorId?: string | null; consentId?: string | null; visitorIdHash?: string | null; consentIdHash?: string | null;
  },
): Record<string, unknown> {
  return {
    minimised: MINIMISED_MARKER, kind, requestId, identifiers: identifierKinds(subject), subject: minimisedOf(subject),
  };
}
