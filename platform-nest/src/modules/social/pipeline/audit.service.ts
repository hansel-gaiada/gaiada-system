// SCP-5g (W5-B4) — the social audit: the orchestration behind the routes (FRONTEND-BFF-CONTRACT §63.28, SCP-Q32 to SCP-Q34, SCP-Q41; PERMISSION §57: no new
// action, no new Cerbos kind). One shape for every write on an audit that exists:
//
//   1. 404 `audit_not_found`: the audit from the rows (another company's, a deleted and a malformed id are all absent).
//   2. 403: the gate CHOSEN FROM THE AUDIT'S SUBJECT, read before the body (63.28.3):
//        a client's audit   `social_post` · `manage` on the client's would-be post (its officer, the HoD and GM seats, the superadmin): 403 `not_officer_or_approver`;
//        a prospect's       `social_engagement` · `plan` (the four): 403 `not_a_social_approver`;
//        an unattended automation is refused either with 403 `automation_cannot_act`.
//   3. 400: the body, against the audit's OWN scorecard (its `rules_ref`, never today's rules).
//   4. 409: the audit's state, read under its row lock (`FOR UPDATE`): `audit_final` for an edit, delete and proposal of a final audit.
//
// A DRAFT is live: its automatic part is computed on every read from the pipeline (audit-data.ts), under the scorecard it was made under (`rules_ref`). FINALIZE
// freezes the scorecard into `frozen` once: every dimension, the overall, the band, the fixes and the scorecard itself; from then on the audit answers its
// `frozen`, whatever the pipeline or the company's rules do. A final audit is a record: never edited, never deleted.
//
// THE MODULE WALL. Every query on a `social_*` table runs inside `withTenants(..., { modules: ["social"] })`.
import { Logger } from "@nestjs/common";
import type { PoolClient } from "pg";
import { config } from "../../../config";
import { newId, withTenants } from "../../../db";
import { authorize, writeActivity } from "../../../core/http";
import { check, type Resource } from "../../../rbac/cerbos";
import type { Principal } from "../../../rbac/principal";
import { aiAttribution } from "../../ai-usage/gateway-usage";
import { completeViaGateway } from "../gateway-client";
import { declareSocialModuleScope } from "../module-scope";
import { loadSocialApproverIds, socialEngagementResource } from "../pipeline-authz";
import { todayIsoInTz } from "./cycles-data";
import { authorizeCoded } from "./boosts";
import { isAutomationPrincipal } from "./pipeline.service";
import { loadEngagement, type EngagementRow } from "./pipeline-data";
import { ScpRouteError } from "./pipeline-effects";
import {
  composeScorecard, monthsBefore, readSimulated, scoreAutomatic, type BenchmarkFacts, type Scorecard, type TypedScore,
} from "./audit-score";
import {
  applyScoresPatch, buildFrozen, buildSummaryPrompt, dimensionAnswer, engagementIdOfBody, isUuid, parseAttach, parseAuditCreate, parseAuditListQuery,
  parseAuditPatch, parseSummaryDraft, readFrozen, sortWorstFirst, subjectOfBody, summaryFactsOf,
  type AuditAnswer, type AuditCreate, type AuditListItem, type DimensionAnswer, type SummaryFacts,
} from "./audit";
import {
  attachAuditRow, clientNameOf, finalizeAuditRow, insertClientAudit, insertProspectAudit, loadAudit, loadAuditAnyState, loadClientDraft, loadClientFacts,
  personRefs, readAuditsForList, readAutoInputs, readOpenClients, softDeleteAuditDraft, updateAuditDraft, type AuditRow, type ClientFacts,
} from "./audit-data";
import { auditScorecard, rulesByRef, rulesRefFor, setAuditPreviewer, socialRules, type AuditRules, type CompanyRules } from "./rules";

const SOCIAL = { modules: ["social"] };
const log = new Logger("SocialAudit");

const notFound = (code: "audit_not_found" | "engagement_not_found"): ScpRouteError => new ScpRouteError(404, code);

// ═══ Months ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** The company's current month and the last full one, as `YYYY-MM-01`. */
function monthsNow(): { currentMonth: string; lastFullMonth: string } {
  const currentMonth = `${todayIsoInTz(config.reportsTz).slice(0, 7)}-01`;
  return { currentMonth, lastFullMonth: monthsBefore(currentMonth, 1) };
}
const monthLabel = (m: string | null): string | null => (m === null ? null : m.slice(0, 7));

// ═══ The gates ════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** The client's would-be post (63.28.3, as 63.25.2): its officer and the four's seats, from the rows. */
const wouldBePost = (tenantId: string, ownerId: string, approverIds: string[]): Resource => ({
  kind: "social_post", tenantId, module: "social", ownerId, creatorId: "", approverIds, assigneeIds: [], creativeSource: "",
});

const approverIdsOf = (tenantId: string): Promise<string[]> => withTenants([tenantId], (c) => loadSocialApproverIds(c, tenantId), SOCIAL);

/** A client's audit: `manage` on the client's would-be post. Answers the person. */
async function authorizeClientWrite(principal: Principal, tenantId: string, ownerId: string): Promise<string> {
  return authorizeCoded(principal, wouldBePost(tenantId, ownerId, await approverIdsOf(tenantId)), "manage", "not_officer_or_approver");
}

/** A prospect's audit, and an attach: `plan` (the four). Answers the person. */
async function authorizeProspectWrite(principal: Principal, tenantId: string): Promise<string> {
  return authorizeCoded(principal, socialEngagementResource(tenantId, await approverIdsOf(tenantId)), "plan", "not_a_social_approver");
}

/** The write gate of an audit that exists, from its subject. */
async function authorizeAuditWrite(principal: Principal, tenantId: string, row: Pick<AuditRow, "subject" | "engagement_id">): Promise<string> {
  if (row.subject === "prospect") return authorizeProspectWrite(principal, tenantId);
  const owner = row.engagement_id ? await ownerOf(tenantId, row.engagement_id) : "";
  return authorizeClientWrite(principal, tenantId, owner);
}

/** The gate's question without throwing: false for an automation and for any denial. */
async function mayWrite(principal: Principal, tenantId: string, row: Pick<AuditRow, "subject" | "engagement_id">): Promise<boolean> {
  if (isAutomationPrincipal(principal) || !principal.userId) return false;
  const approverIds = await approverIdsOf(tenantId);
  if (row.subject === "prospect") return (await check(principal, socialEngagementResource(tenantId, approverIds), "plan")).allow;
  const owner = row.engagement_id ? await ownerOf(tenantId, row.engagement_id) : "";
  return (await check(principal, wouldBePost(tenantId, owner, approverIds), "manage")).allow;
}

/** Whether the caller may add a prospect's audit (the UI's `canAddProspect`): the four. */
async function mayAddProspect(principal: Principal, tenantId: string): Promise<boolean> {
  return mayWrite(principal, tenantId, { subject: "prospect", engagement_id: null });
}

async function ownerOf(tenantId: string, engagementId: string): Promise<string> {
  const e = await engagementOf(tenantId, engagementId);
  return e?.owner_id ?? "";
}

async function engagementOf(tenantId: string, engagementId: string): Promise<EngagementRow | null> {
  return withTenants([tenantId], (c) => loadEngagement(c, tenantId, engagementId), SOCIAL);
}

const activity = (tenantId: string, actorId: string, verb: string, auditId: string, metadata: Record<string, unknown>): Promise<void> =>
  writeActivity(tenantId, actorId, verb, "social_audit", auditId, metadata).then(() => undefined)
    .catch((e: unknown) => log.warn(`activity ${verb} for audit ${auditId} not written: ${e instanceof Error ? e.message : String(e)}`));

// ═══ The scorecard of an audit ════════════════════════════════════════════════════════════════════════════════════════════

interface Computed {
  card: Scorecard;
  simulated: boolean;
  rules: CompanyRules;
  scorecard: AuditRules;
  client: ClientFacts | null;
  benchmark: BenchmarkFacts | null;
}

/**
 * A DRAFT's scorecard now, under the rules it was made under: a client's six automatic dimensions from the pipeline, the typed scores laid over them;
 * a prospect's twelve are typed. In the caller's transaction.
 */
async function computeCard(c: PoolClient, tenantId: string, row: AuditRow): Promise<Computed> {
  const rules = await rulesByRef(c, tenantId, row.rules_ref);
  const scorecard = auditScorecard(rules.rules);
  let client: ClientFacts | null = null;
  let auto: ReturnType<typeof scoreAutomatic> | null = null;
  let simulated = false;
  let benchmark: BenchmarkFacts | null = null;
  if (row.subject === "client" && row.engagement_id && row.month) {
    client = await loadClientFacts(c, tenantId, row.engagement_id);
    if (client) {
      const inputs = await readAutoInputs(c, tenantId, client, { month: row.month, tz: config.reportsTz, benchmark: scorecard.benchmark });
      auto = scoreAutomatic(inputs);
      simulated = readSimulated(inputs);
      benchmark = inputs.benchmark;
    }
  }
  return { card: composeScorecard({ rules: scorecard, auto, typed: row.scores }), simulated, rules, scorecard, client, benchmark };
}

interface AnswerFlags { canWrite: boolean }

/** The audit as the routes answer it: a draft computed now, a final one its `frozen`. */
async function answerOf(c: PoolClient, tenantId: string, row: AuditRow, flags: AnswerFlags): Promise<AuditAnswer> {
  const people = await personRefs(c, [row.created_by, row.finalized_by]);
  let name: string;
  if (row.subject === "prospect") name = row.prospect_name ?? "";
  else name = (row.engagement_id ? await clientNameOf(c, tenantId, row.engagement_id) : null) ?? "";

  let dimensions: DimensionAnswer[];
  let fixes: AuditAnswer["fixes"];
  let overall: number | null;
  let band: string | null;
  let bandLabel: string | null;
  let scored: number;
  let total: number;
  let simulated: boolean;
  const frozen = row.status === "final" ? readFrozen(row.frozen) : null;
  if (frozen) {
    dimensions = frozen.dimensions.map(dimensionAnswer);
    fixes = frozen.fixes;
    overall = row.overall;
    band = row.band;
    bandLabel = frozen.band?.label ?? null;
    scored = frozen.scored;
    total = frozen.total;
    simulated = row.simulated;
  } else {
    const live = await computeCard(c, tenantId, row);
    dimensions = live.card.dimensions.map(dimensionAnswer);
    fixes = live.card.fixes;
    overall = live.card.overall;
    band = live.card.band?.key ?? null;
    bandLabel = live.card.band?.label ?? null;
    scored = live.card.scored;
    total = live.card.total;
    simulated = live.simulated;
  }
  const draft = row.status === "draft";
  return {
    id: row.id, subject: row.subject, engagementId: row.engagement_id, name, prospectName: row.prospect_name, businessType: frozen?.businessType ?? row.business_type,
    month: monthLabel(row.month), publicNumbers: row.public_numbers, status: row.status, rulesRef: row.rules_ref, summary: row.summary, summaryVia: row.summary_via,
    dimensions, overall, band, bandLabel, scored, total, fixes, simulated,
    createdBy: people.get(row.created_by) ?? null, createdAt: row.created_at, updatedAt: row.updated_at,
    finalizedBy: row.finalized_by ? people.get(row.finalized_by) ?? null : null, finalizedAt: row.finalized_at,
    canWrite: flags.canWrite && draft, canFinalize: flags.canWrite && draft,
  };
}

/** The audit, read and answered in its own transaction. */
async function readAnswer(tenantId: string, auditId: string, flags: AnswerFlags): Promise<AuditAnswer> {
  const out = await withTenants([tenantId], async (c) => {
    const row = await loadAudit(c, tenantId, auditId);
    return row ? answerOf(c, tenantId, row, flags) : null;
  }, SOCIAL);
  if (!out) throw notFound("audit_not_found");
  return out;
}

/** 404 `audit_not_found`, or the row. */
async function auditOr404(tenantId: string, auditId: string): Promise<AuditRow> {
  const row = isUuid(auditId) ? await withTenants([tenantId], (c) => loadAudit(c, tenantId, auditId), SOCIAL) : null;
  if (!row) throw notFound("audit_not_found");
  return row;
}

// ═══ GET audits ═══════════════════════════════════════════════════════════════════════════════════════════════════════════

export async function listAudits(principal: Principal, tenantId: string, q: Record<string, unknown>): Promise<{ items: AuditListItem[]; canAddProspect: boolean }> {
  await authorize(principal, { kind: "social_post", tenantId, module: "social" }, "read");
  const { subject } = parseAuditListQuery(q ?? {});
  const items = await withTenants([tenantId], async (c) => {
    const out: AuditListItem[] = [];
    const rules = await socialRules(c, tenantId);
    const defaultTotal = auditScorecard(rules.rules).dimensions.length;
    if (subject !== "prospect") {
      const clients = await readOpenClients(c, tenantId);
      const { drafts, finals } = await readAuditsForList(c, tenantId, { client: true, prospect: false });
      for (const cl of clients) {
        const draft = drafts.get(cl.engagementId);
        const final = finals.get(cl.engagementId);
        const row = draft ?? final ?? null;
        out.push(row ? await itemOf(c, tenantId, row, cl.clientName) : {
          auditId: null, subject: "client", engagementId: cl.engagementId, name: cl.clientName, status: null, month: null, overall: null, band: null, bandLabel: null,
          scored: 0, total: defaultTotal, topFix: null, finalizedAt: null, simulated: false,
        });
      }
    }
    if (subject !== "client") {
      const { prospects } = await readAuditsForList(c, tenantId, { client: false, prospect: true });
      for (const p of prospects) out.push(await itemOf(c, tenantId, p, p.prospect_name ?? ""));
    }
    return out;
  }, SOCIAL);
  return { items: sortWorstFirst(items), canAddProspect: await mayAddProspect(principal, tenantId) };
}

/** One list row: a draft's live score, else a final's frozen one. */
async function itemOf(c: PoolClient, tenantId: string, row: AuditRow, name: string): Promise<AuditListItem> {
  const frozen = row.status === "final" ? readFrozen(row.frozen) : null;
  let card: { overall: number | null; band: { key: string; label: string } | null; scored: number; total: number; fixes: AuditAnswer["fixes"] };
  let simulated = row.simulated;
  if (frozen) {
    card = { overall: row.overall, band: row.band ? { key: row.band, label: frozen.band?.label ?? row.band } : null, scored: frozen.scored, total: frozen.total, fixes: frozen.fixes };
  } else {
    const live = await computeCard(c, tenantId, row);
    card = live.card;
    simulated = live.simulated;
  }
  return {
    auditId: row.id, subject: row.subject, engagementId: row.engagement_id, name, status: row.status, month: monthLabel(row.month), overall: card.overall,
    band: card.band?.key ?? null, bandLabel: card.band?.label ?? null, scored: card.scored, total: card.total, topFix: card.fixes[0] ?? null,
    finalizedAt: row.finalized_at, simulated,
  };
}

// ═══ GET audits/:auditId ══════════════════════════════════════════════════════════════════════════════════════════════════

export async function getAudit(principal: Principal, tenantId: string, auditId: string): Promise<AuditAnswer> {
  await authorize(principal, { kind: "social_post", tenantId, module: "social" }, "read");
  const row = await auditOr404(tenantId, auditId);
  return readAnswer(tenantId, row.id, { canWrite: await mayWrite(principal, tenantId, row) });
}

// ═══ POST audits ══════════════════════════════════════════════════════════════════════════════════════════════════════════

export async function createAudit(principal: Principal, tenantId: string, body: unknown): Promise<{ audit: AuditAnswer; created: boolean }> {
  const wanted = subjectOfBody(body);
  let actorId: string;
  let engagement: EngagementRow | null = null;
  if (wanted === "client") {
    // 404 for a client that is not there (a well-formed id), then the client's gate; a missing or malformed id has no client to find: the gate with no officer, then 400.
    const engagementId = engagementIdOfBody(body);
    engagement = engagementId ? await engagementOf(tenantId, engagementId) : null;
    if (engagementId && !engagement) throw notFound("engagement_not_found");
    actorId = await authorizeClientWrite(principal, tenantId, engagement?.owner_id ?? "");
  } else {
    // A prospect's, and a body with no subject (it cannot be judged as either): the four.
    actorId = await authorizeProspectWrite(principal, tenantId);
  }

  const months = monthsNow();
  const input: AuditCreate = parseAuditCreate(body, months);
  const out = await withTenants([tenantId], async (c) => {
    const rulesRef = rulesRefFor(await socialRules(c, tenantId));
    const id = input.id ?? newId();
    // A replayed `id` answers the audit as it stands; an `id` of another client or subject, or a deleted audit's, is 400 `{field: 'id'}`.
    const taken = input.id ? await loadAuditAnyState(c, tenantId, input.id) : null;
    if (taken) {
      const same = input.subject === "client" ? taken.subject === "client" && taken.engagement_id === input.engagementId : taken.subject === "prospect";
      if (!same || taken.deleted) throw new ScpRouteError(400, "invalid_field", { field: "id" });
      return { id: taken.id, created: false };
    }
    if (input.subject === "client") {
      // One live draft per client: a client with a draft answers it.
      const draft = await loadClientDraft(c, tenantId, input.engagementId);
      if (draft) return { id: draft.id, created: false };
      const inserted = await insertClientAudit(c, { tenantId, id, engagementId: input.engagementId, month: input.month, rulesRef, actorId });
      if (!inserted) {
        // A racing create won the unique index: its draft is the answer.
        const won = await loadClientDraft(c, tenantId, input.engagementId);
        if (!won) throw new ScpRouteError(400, "invalid_field", { field: "id" });
        return { id: won.id, created: false };
      }
      return { id, created: true };
    }
    const inserted = await insertProspectAudit(c, { tenantId, id, prospectName: input.prospectName, businessType: input.businessType, publicNumbers: input.publicNumbers, rulesRef, actorId });
    if (!inserted) throw new ScpRouteError(400, "invalid_field", { field: "id" });
    return { id, created: true };
  }, SOCIAL);

  if (out.created) await activity(tenantId, actorId, "created", out.id, { subject: input.subject, ...(input.subject === "client" ? { engagementId: input.engagementId } : {}) });
  return { audit: await readAnswer(tenantId, out.id, { canWrite: true }), created: out.created };
}

// ═══ PATCH audits/:auditId ════════════════════════════════════════════════════════════════════════════════════════════════

export async function editAudit(principal: Principal, tenantId: string, auditId: string, body: unknown): Promise<{ audit: AuditAnswer }> {
  const seen = await auditOr404(tenantId, auditId);
  const actorId = await authorizeAuditWrite(principal, tenantId, seen);
  const fields = await withTenants([tenantId], async (c) => {
    const rules = auditScorecard((await rulesByRef(c, tenantId, seen.rules_ref)).rules);
    const patch = parseAuditPatch(body, { subject: seen.subject, rules, existing: seen.scores, currentMonth: monthsNow().currentMonth });
    const row = await loadAudit(c, tenantId, seen.id, true);
    if (!row) throw notFound("audit_not_found");
    if (row.status === "final") throw new ScpRouteError(409, "audit_final");
    const names = Object.keys(patch);
    if (names.length === 0) return names;
    await updateAuditDraft(c, tenantId, row.id, {
      ...(patch.scores !== undefined ? { scores: applyScoresPatch(row.scores, patch.scores) } : {}),
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      ...(patch.month !== undefined ? { month: patch.month } : {}),
      ...(patch.prospectName !== undefined ? { prospectName: patch.prospectName } : {}),
      ...(patch.businessType !== undefined ? { businessType: patch.businessType } : {}),
      ...(patch.publicNumbers !== undefined ? { publicNumbers: patch.publicNumbers } : {}),
    }, actorId);
    return names;
  }, SOCIAL);
  if (fields.length > 0) await activity(tenantId, actorId, "updated", seen.id, { subject: seen.subject, fields });
  return { audit: await readAnswer(tenantId, seen.id, { canWrite: true }) };
}

// ═══ POST audits/:auditId/finalize ════════════════════════════════════════════════════════════════════════════════════════

export async function finalizeAudit(principal: Principal, tenantId: string, auditId: string): Promise<{ audit: AuditAnswer; alreadyApplied: boolean }> {
  const seen = await auditOr404(tenantId, auditId);
  const actorId = await authorizeAuditWrite(principal, tenantId, seen);
  const done = await withTenants([tenantId], async (c) => {
    const row = await loadAudit(c, tenantId, seen.id, true);
    if (!row) throw notFound("audit_not_found");
    if (row.status === "final") return false;
    // The scorecard as it stands NOW, under the audit's own rules, frozen once.
    const live = await computeCard(c, tenantId, row);
    const businessType = row.subject === "client" ? live.client?.businessType ?? null : row.business_type;
    const frozen = buildFrozen({
      card: live.card, scorecard: live.scorecard, rulesRef: row.rules_ref, fixtureVersion: live.rules.defaultsVersion, subject: row.subject, month: monthLabel(row.month),
      businessType, publicNumbers: row.public_numbers, simulated: live.simulated, benchmark: live.benchmark,
    });
    await finalizeAuditRow(c, {
      tenantId, auditId: row.id, actorId, frozen, overall: live.card.overall, band: live.card.band?.key ?? null, simulated: live.simulated, businessType,
    });
    return true;
  }, SOCIAL);
  if (done) await activity(tenantId, actorId, "finalized", seen.id, { subject: seen.subject, ...(seen.engagement_id ? { engagementId: seen.engagement_id } : {}) });
  return { audit: await readAnswer(tenantId, seen.id, { canWrite: true }), alreadyApplied: !done };
}

// ═══ DELETE audits/:auditId ═══════════════════════════════════════════════════════════════════════════════════════════════

export async function deleteAudit(principal: Principal, tenantId: string, auditId: string): Promise<{ deleted: true; id: string }> {
  const seen = await auditOr404(tenantId, auditId);
  const actorId = await authorizeAuditWrite(principal, tenantId, seen);
  await withTenants([tenantId], async (c) => {
    const row = await loadAudit(c, tenantId, seen.id, true);
    if (!row) throw notFound("audit_not_found");
    if (row.status === "final") throw new ScpRouteError(409, "audit_final");
    await softDeleteAuditDraft(c, tenantId, row.id, actorId);
  }, SOCIAL);
  await activity(tenantId, actorId, "deleted", seen.id, { subject: seen.subject });
  return { deleted: true, id: seen.id };
}

// ═══ POST audits/:auditId/attach ══════════════════════════════════════════════════════════════════════════════════════════

export async function attachAudit(principal: Principal, tenantId: string, auditId: string, body: unknown): Promise<{ audit: AuditAnswer; alreadyApplied: boolean }> {
  const seen = await auditOr404(tenantId, auditId);
  // Attaching is the four's, whatever the audit (`plan`).
  const actorId = await authorizeProspectWrite(principal, tenantId);
  const { engagementId } = parseAttach(body);
  const engagement = await engagementOf(tenantId, engagementId);
  if (!engagement) throw notFound("engagement_not_found");
  const done = await withTenants([tenantId], async (c) => {
    const row = await loadAudit(c, tenantId, seen.id, true);
    if (!row) throw notFound("audit_not_found");
    if (row.subject !== "prospect") throw new ScpRouteError(409, "not_a_prospect_audit");
    if (row.engagement_id === engagementId) return false;
    if (row.engagement_id !== null) throw new ScpRouteError(409, "audit_attached");
    await attachAuditRow(c, tenantId, row.id, engagementId, actorId);
    return true;
  }, SOCIAL);
  if (done) await activity(tenantId, actorId, "attached", seen.id, { engagementId });
  return { audit: await readAnswer(tenantId, seen.id, { canWrite: true }), alreadyApplied: !done };
}

// ═══ POST audits/:auditId/ai-summary ══════════════════════════════════════════════════════════════════════════════════════

/**
 * A PROPOSAL, never a write (63.28.4): the summary drafted from the audit's scores and evidence through the gateway, with the reports' numbers guard (a number
 * the facts do not hold rejects the draft). The gateway down, or an answer that fails any check, gives the plain template. Nothing is saved: the officer keeps
 * what they like with a PATCH. Only while the audit can still be edited (409 `audit_final`).
 */
export async function draftAuditSummary(principal: Principal, tenantId: string, auditId: string): Promise<{ summary: string; draftedVia: "ai" | "template" }> {
  const seen = await auditOr404(tenantId, auditId);
  await authorizeAuditWrite(principal, tenantId, seen);
  const facts: SummaryFacts = await withTenants([tenantId], async (c) => {
    const row = await loadAudit(c, tenantId, seen.id);
    if (!row) throw notFound("audit_not_found");
    if (row.status === "final") throw new ScpRouteError(409, "audit_final");
    const live = await computeCard(c, tenantId, row);
    const name = row.subject === "prospect" ? row.prospect_name ?? "" : (row.engagement_id ? await clientNameOf(c, tenantId, row.engagement_id) : null) ?? "";
    return summaryFactsOf({ name, subject: row.subject, month: monthLabel(row.month), card: live.card });
  }, SOCIAL);
  let raw: string | null = null;
  try {
    raw = (await completeViaGateway(buildSummaryPrompt(facts), { attribution: aiAttribution(principal, tenantId, "other", { task: "social.audit_summary" }) })).text;
  } catch {
    raw = null; // the gateway down: the template, never a failed request
  }
  return parseSummaryDraft(raw, facts);
}

// ═══ The rules preview (63.30.4: `POST rules/preview` for `audit`) ════════════════════════════════════════════════════════

export interface AuditPreview {
  engagementId: string;
  /** `YYYY-MM`: the last full month. */
  month: string;
  overall: number | null;
  band: string | null;
  bandLabel: string | null;
  scored: number;
  total: number;
  dimensions: DimensionAnswer[];
  fixes: AuditAnswer["fixes"];
  simulated: boolean;
  /** The client's live draft whose typed scores were laid over the edited scorecard, or null (then the automatic part alone). */
  draftId: string | null;
}

/**
 * A client's score under an UNSAVED scorecard: the last full month's pipeline data read through the edited dimensions, weights, bands and benchmark, the
 * client's live draft's typed scores laid over (a key the edited scorecard lacks is ignored). Saves nothing. Called outside any transaction.
 */
export async function previewAudit(a: { tenantId: string; engagementId: string; scorecard: AuditRules }): Promise<AuditPreview | null> {
  return withTenants([a.tenantId], async (c) => {
    await declareSocialModuleScope(c);
    const client = await loadClientFacts(c, a.tenantId, a.engagementId);
    if (!client) return null;
    const month = monthsNow().lastFullMonth;
    const draft = await loadClientDraft(c, a.tenantId, client.engagementId);
    const inputs = await readAutoInputs(c, a.tenantId, client, { month, tz: config.reportsTz, benchmark: a.scorecard.benchmark });
    const card = composeScorecard({ rules: a.scorecard, auto: scoreAutomatic(inputs), typed: draft?.scores ?? ({} as Record<string, TypedScore>) });
    return {
      engagementId: client.engagementId, month: month.slice(0, 7), overall: card.overall, band: card.band?.key ?? null, bandLabel: card.band?.label ?? null,
      scored: card.scored, total: card.total, dimensions: card.dimensions.map(dimensionAnswer), fixes: card.fixes, simulated: readSimulated(inputs), draftId: draft?.id ?? null,
    };
  }, SOCIAL);
}

// `POST rules/preview` for the audit section answers a real preview once this module is loaded (rules.ts's seam).
setAuditPreviewer(previewAudit);
