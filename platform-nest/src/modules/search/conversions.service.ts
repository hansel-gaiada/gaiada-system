// M5-P2 — the DB half of ad-platform conversion uploads. Design: docs/plans/2026-10-11-m5-lead-pipeline-design.md §8.
// The pure half (gate, hashing, binding, write mode) is conversions.ts; the Google adapter is conversions-google.ts.
//
//   handleStageChanged            the `agency.lead.stage_changed` handler (searchModule.eventHandlers; main.ts lists the `agency_lead`
//                                 stream, or this is never invoked). PLANS: gate, ledger claim, ONE WS4 approval per claim.
//   executeApprovedConversionUpload  decide() calls it IN-BAND, as the decider, once the approval is `approved`. EXECUTES: claim the
//                                 approval row, take the lock, run the gate AGAIN, send (or simulate), record the outcome.
//   recordConversionUploadRejected   a refused approval closes its ledger row `rejected` (the claim stays: nobody is asked twice).
//
// ── INVARIANTS (each one has a test) ─────────────────────────────────────────────────────────────────────────────────────
//  1. At-least-once delivery is safe: a ledger row per (tenant, platform, stage event) means a redelivered event converges.
//  2. The ledger INSERT is the claim (UNIQUE tenant, platform, submission_ref, conversion_key WHERE status <> 'skipped'):
//     a lead that regresses and advances again never uploads twice.
//  3. No personal data is ever written: the ledger, the approval's `tool_args` and `reason`, the outbox event decide() emits,
//     `execution_result`, the activity metadata and every log line hold ids, stages, kinds and typed tokens only. The contact fields
//     and the click id are read from the lead at EXECUTION, normalised and hashed in memory, and dropped with the call.
//  4. The gate runs at planning AND again under the lock at execution. Consent is STRICTLY `marketing === true`.
//  5. A send is made at most ONCE per approval: `neverAutoRetry` in spirit. After an ambiguous answer the row is `failed` with a typed
//     token and a human decides; the D14 /retry cannot re-drive it (the executor refuses any origin outside automation|agent).
//  6. Simulate is the default and needs no credential; it records what WOULD be sent (kinds and field names), never a value.
import { ConflictException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { newId, withTenants } from "../../db";
import { config } from "../../config";
import { authorize, writeActivity } from "../../core/http";
import { insertAutomationApprovalRow, notifyApprovalFiled, type FileApprovalInput } from "../../core/approval-filing";
import { EXECUTION_RESULT_MAX_CHARS } from "../../core/approval-execute";
import { parseStageChangedV1, readLeadConversionFacts, type LeadConversionFacts, type StageChangedV1 } from "../../core/agency-lead-pipeline.service";
import { isContactSuppressed } from "../../core/agency-privacy.service";
import type { OutboxEvent } from "../../events/types";
import type { Principal } from "../../rbac/principal";
import {
  CONVERSION_APPROVAL_ORIGIN, CONVERSION_UPLOAD_TOOL, CONVERSION_UPLOAD_WORKFLOW, REASON, approvalReason, conversionContentHash,
  conversionModeFor, evaluateGate, parseConversionToolArgs, type ConversionBinding, type ConversionPlatform, type ConversionToolArgs,
  type UploadStatus,
} from "./conversions";
import { buildGoogleUploadRequest, type GoogleUploadPlan, type UploadResult } from "./conversions-google";
import { getLiveConversionUploader } from "./conversions-uploaders";

const SEARCH = { modules: ["search"] };

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// PLANNING — the event handler
// ═══════════════════════════════════════════════════════════════════════════════════════════════
interface TargetRow {
  id: string;
  property_id: string;
  platform: ConversionPlatform;
  conversion_key: string;
  conversion_action: string;
  send_value: boolean;
}

interface LedgerRow {
  id: string;
  tenant_id: string;
  property_id: string;
  target_id: string | null;
  platform: ConversionPlatform;
  lead_id: string;
  stage_event_id: string;
  submission_ref: string;
  stage: string;
  conversion_key: string;
  deal_value: string | null;
  deal_currency: string | null;
  status: UploadStatus;
  approval_id: string | null;
  content_hash: string | null;
  occurred_at: Date;
}

const LEDGER_COLS = `id, tenant_id, property_id, target_id, platform, lead_id, stage_event_id, submission_ref, stage, conversion_key,
  deal_value::text AS deal_value, deal_currency, status, approval_id, content_hash, occurred_at`;

function bindingOf(l: LedgerRow): ConversionBinding {
  return {
    ledgerId: l.id, tenantId: l.tenant_id, propertyId: l.property_id, leadId: l.lead_id, stageEventId: l.stage_event_id,
    submissionRef: l.submission_ref, platform: l.platform, stage: l.stage, conversionKey: l.conversion_key,
    dealValue: l.deal_value, dealCurrency: l.deal_currency,
  };
}

interface Filed { approvalId: string; input: FileApprovalInput }

/** The handler. Never throws on a malformed or irrelevant event (a throw is a redelivery, five times, then a dead letter); a database
 *  failure does throw, so the stream redelivers it. Logs ids and tokens only. */
export async function handleStageChanged(event: OutboxEvent): Promise<void> {
  const p = parseStageChangedV1(event.payload);
  if (!p) {
    // eslint-disable-next-line no-console
    console.warn(`[search] conversions: agency.lead.stage_changed (event ${event.id}) failed v1 validation; ignored`);
    return;
  }
  if (p.submissionRef === null) return; // a staff lead has no WebDesk submission: skip without a read (design §8.2)
  const filed = await withTenants([event.tenantId], (c) => planUploads(c, event.tenantId, p), SEARCH);
  for (const f of filed) {
    try {
      await notifyApprovalFiled(f.approvalId, f.input);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[search] conversions: filed approval ${f.approvalId} but notifying the deciders failed:`, (err as Error)?.name ?? "error");
    }
  }
}

/** Runs inside the caller's `withTenants([tenant], {modules:['search']})` transaction. Exported for the DB tests. */
export async function planUploads(c: PoolClient, tenantId: string, p: StageChangedV1): Promise<Filed[]> {
  const rawFacts = await readLeadConversionFacts(c, tenantId, p.leadId);
  if (!rawFacts || !rawFacts.webSiteSlug) return []; // nothing to key a target on: skip without a ledger row
  const targets = await c.query<TargetRow>(
    `SELECT id, property_id, platform, conversion_key, conversion_action, send_value
       FROM search_conversion_targets
      WHERE tenant_id = $1 AND web_site_slug = $2 AND stage_key = $3 AND enabled AND deleted_at IS NULL
      ORDER BY platform`,
    [tenantId, rawFacts.webSiteSlug, p.toStage],
  );
  if (targets.rows.length === 0) return []; // no target means skip (design §8.3)

  // The event's submissionRef must be this lead's: a mismatch is treated as "the lead is not the one the event names".
  const facts: LeadConversionFacts | null = rawFacts.submissionRef === p.submissionRef ? rawFacts : null;
  const suppressed = facts
    ? await isContactSuppressed(c, tenantId, { email: facts.contactEmail, phone: facts.contactPhone }, "ad_upload")
    : false;
  const actor = await c.query<{ actor_id: string | null }>(
    `SELECT actor_id FROM agency_lead_stage_events WHERE id = $1 AND tenant_id = $2`, [p.stageEventId, tenantId],
  );
  const requestedBy = actor.rows[0]?.actor_id ?? null;

  const filed: Filed[] = [];
  for (const t of targets.rows) {
    const verdict = evaluateGate(facts, t.platform, suppressed);
    const value = t.send_value && p.dealValue !== null && p.dealCurrency !== null ? { v: p.dealValue, cur: p.dealCurrency } : null;
    const base = [
      newId(), tenantId, t.property_id, t.id, t.platform, p.leadId, p.stageEventId, p.submissionRef, p.toStage, t.conversion_key,
      value?.v ?? null, value?.cur ?? null,
    ];
    if (!verdict.ok) {
      // Ledger a SKIPPED row (reason visible, no approval). `skipped` is outside the claim index, so it never blocks a later attempt.
      await c.query(
        `INSERT INTO search_conversion_uploads
           (id, tenant_id, property_id, target_id, platform, lead_id, stage_event_id, submission_ref, stage, conversion_key,
            deal_value, deal_currency, status, reason, occurred_at, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'skipped',$13,$14,$15)
         ON CONFLICT (tenant_id, platform, stage_event_id) DO NOTHING`,
        [...base, verdict.reason, p.occurredAt, config.originSite],
      );
      continue;
    }

    // THE CLAIM: this INSERT is the de-duplication. No conflict target, so BOTH unique indexes are handled: a redelivered event
    // (same stage_event_id) and a second claim for the same submission and conversion key both return zero rows.
    const ins = await c.query<LedgerRow>(
      `INSERT INTO search_conversion_uploads
         (id, tenant_id, property_id, target_id, platform, lead_id, stage_event_id, submission_ref, stage, conversion_key,
          deal_value, deal_currency, status, occurred_at, origin_site)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending_approval',$13,$14)
       ON CONFLICT DO NOTHING
       RETURNING ${LEDGER_COLS}`,
      [...base, p.occurredAt, config.originSite],
    );
    const row = ins.rows[0];
    if (!row) {
      const replay = await c.query(
        `SELECT 1 FROM search_conversion_uploads WHERE tenant_id = $1 AND platform = $2 AND stage_event_id = $3`,
        [tenantId, t.platform, p.stageEventId],
      );
      if (replay.rows[0]) continue; // a redelivery of an event already handled
      // A different stage event for a submission and conversion that already hold the claim: regress-and-advance. Record, send nothing.
      await c.query(
        `INSERT INTO search_conversion_uploads
           (id, tenant_id, property_id, target_id, platform, lead_id, stage_event_id, submission_ref, stage, conversion_key,
            deal_value, deal_currency, status, reason, occurred_at, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'skipped',$13,$14,$15)
         ON CONFLICT (tenant_id, platform, stage_event_id) DO NOTHING`,
        [...base, REASON.alreadyClaimed, p.occurredAt, config.originSite],
      );
      continue;
    }

    // ONE WS4 approval per claimed upload, in the SAME transaction as the claim (both commit or neither does).
    const approvalId = newId();
    const hash = conversionContentHash(bindingOf(row));
    const toolArgs: ConversionToolArgs = {
      ledgerId: row.id, propertyId: row.property_id, leadId: row.lead_id, stageEventId: row.stage_event_id, platform: row.platform,
      conversionKey: row.conversion_key, stage: row.stage, dealValue: row.deal_value, dealCurrency: row.deal_currency, contentHash: hash,
    };
    const input: FileApprovalInput = {
      tenantId,
      workflowId: CONVERSION_UPLOAD_WORKFLOW,
      toolName: CONVERSION_UPLOAD_TOOL,
      toolArgs: { ...toolArgs },
      impact: "high",
      reason: approvalReason(row.platform, row.stage, row.conversion_key, row.deal_value, row.deal_currency),
      origin: CONVERSION_APPROVAL_ORIGIN,
      // The person (or agent principal) who moved the stage; null when the history row has no actor. The column is nullable.
      requestedBy: requestedBy as unknown as string,
    };
    await insertAutomationApprovalRow(c, approvalId, input);
    await c.query(
      `UPDATE search_conversion_uploads SET approval_id = $2, content_hash = $3, updated_at = now() WHERE id = $1`,
      [row.id, approvalId, hash],
    );
    filed.push({ approvalId, input });
  }
  return filed;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// DECISION — rejection
// ═══════════════════════════════════════════════════════════════════════════════════════════════
/** A rejected approval closes its ledger row. The claim STAYS (status `rejected` is outside `skipped`): the same conversion for the
 *  same submission is not put to a human twice. */
export async function recordConversionUploadRejected(tenantId: string, approvalId: string): Promise<void> {
  await withTenants(
    [tenantId],
    (c) =>
      c.query(
        `UPDATE search_conversion_uploads SET status = 'rejected', reason = $2, updated_at = now()
          WHERE approval_id = $1 AND tenant_id = $3 AND status = 'pending_approval'`,
        [approvalId, REASON.rejected, tenantId],
      ),
    SEARCH,
  );
}

/** The property an upload approval is about, for decide()'s authority check. Null when the stored args are not ours. */
export function conversionPropertyIdOf(toolArgs: unknown): string | null {
  return parseConversionToolArgs(toolArgs)?.propertyId ?? null;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// EXECUTION — in-band at decide()
// ═══════════════════════════════════════════════════════════════════════════════════════════════
export interface ConversionUploadResult {
  ledgerId: string | null;
  platform: ConversionPlatform | null;
  mode: "simulate" | "live" | null;
  status: "simulated" | "uploaded" | "failed" | "skipped";
  /** A typed token when status is failed or skipped. */
  reason?: string;
  /** What kind of identifier the upload carried (kinds only). */
  identifierKinds?: string[];
}

export interface ExecuteDeps {
  env?: NodeJS.ProcessEnv;
  /** Test seam: replaces the registered live uploader for the platform. */
  uploader?: (input: { tenantId: string; propertyId: string; conversionAction: string; body: Record<string, unknown> }) => Promise<UploadResult>;
}

async function markApprovalFailedUnclaimed(tenantId: string, approvalId: string, error: string): Promise<void> {
  await withTenants([tenantId], (c) =>
    c.query(
      `UPDATE automation_approvals
          SET execution_status = 'failed', execution_error = $2, updated_at = now()
        WHERE id = $1 AND origin = 'search' AND workflow_id = $3 AND status = 'approved' AND execution_status = 'pending' AND deleted_at IS NULL`,
      [approvalId, error, CONVERSION_UPLOAD_WORKFLOW],
    ),
  );
}

async function finishApproval(
  tenantId: string,
  approvalId: string,
  deciderId: string,
  outcome: { ok: true; result: Record<string, unknown> } | { ok: false; error: string },
): Promise<void> {
  const text = outcome.ok ? JSON.stringify(outcome.result) : "";
  await withTenants([tenantId], (c) =>
    outcome.ok
      ? c.query(
          `UPDATE automation_approvals
              SET execution_status = 'executed', executed_at = now(), executed_by = $2,
                  execution_result = $3::jsonb, execution_error = NULL, updated_at = now()
            WHERE id = $1 AND execution_status = 'executing'`,
          [approvalId, deciderId, JSON.stringify({ text: text.slice(0, EXECUTION_RESULT_MAX_CHARS), truncated: text.length > EXECUTION_RESULT_MAX_CHARS })],
        )
      : c.query(
          `UPDATE automation_approvals
              SET execution_status = 'failed', executed_at = now(), executed_by = $2, execution_error = $3, updated_at = now()
            WHERE id = $1 AND execution_status = 'executing'`,
          [approvalId, deciderId, outcome.error],
        ),
  );
}

type Phase2 =
  | { kind: "go"; ledger: LedgerRow; plan: GoogleUploadPlan; mode: "simulate" | "live"; conversionAction: string }
  | { kind: "stop"; ledgerId: string | null; platform: ConversionPlatform | null; status: "failed" | "skipped"; reason: string };

/**
 * Executes an APPROVED upload, in-band, as the decider. Called by decide() after the decide UPDATE (status `approved`,
 * execution_status `pending`). Outcomes after the claim are returned as data and recorded on the row; the decision itself stands
 * either way. THROWS only before the claim (a denied decider, a row that is not claimable).
 */
export async function executeApprovedConversionUpload(
  tenantId: string,
  approvalId: string,
  toolArgs: unknown,
  decider: Principal,
  deps: ExecuteDeps = {},
): Promise<ConversionUploadResult> {
  const deciderId = decider.userId as string;
  // ── Phase 0: strict parse, authority. Nothing claimed, nothing sent.
  const args = parseConversionToolArgs(toolArgs);
  if (!args) {
    await markApprovalFailedUnclaimed(tenantId, approvalId, REASON.argsInvalid);
    return { ledgerId: null, platform: null, mode: null, status: "failed", reason: REASON.argsInvalid };
  }
  try {
    await authorize(decider, { kind: "resource_search_property", id: args.propertyId, tenantId, module: "search" }, "update");
  } catch (err) {
    await markApprovalFailedUnclaimed(tenantId, approvalId, "conversion_denied");
    throw err;
  }

  // ── Phase 1: CLAIM the approval row pending → executing. The WHERE clause is the single-use guarantee.
  const claim = await withTenants([tenantId], (c) =>
    c.query<{ tool_args: unknown }>(
      `UPDATE automation_approvals
          SET execution_status = 'executing', execution_attempts = execution_attempts + 1, updated_at = now()
        WHERE id = $1 AND origin = 'search' AND workflow_id = $2 AND status = 'approved' AND execution_status = 'pending'
          AND deleted_at IS NULL
        RETURNING tool_args`,
      [approvalId, CONVERSION_UPLOAD_WORKFLOW],
    ),
  );
  if (!claim.rows[0]) {
    throw new ConflictException({
      message: "conversion_not_claimable: the approval is not approved-and-pending (already executed, failed, or not an upload row)",
      reason: "conversion_not_claimable",
    });
  }
  const filedArgs = parseConversionToolArgs(claim.rows[0].tool_args);
  if (!filedArgs || filedArgs.ledgerId !== args.ledgerId || filedArgs.contentHash !== args.contentHash) {
    await finishApproval(tenantId, approvalId, deciderId, { ok: false, error: REASON.argsInvalid });
    return { ledgerId: args.ledgerId, platform: args.platform, mode: null, status: "failed", reason: REASON.argsInvalid };
  }

  // ── Phase 2: under the lock, re-verify the binding, run the gate AGAIN, build the request, claim the ledger row `executing`.
  const a0: ConversionToolArgs = args;
  let p2: Phase2;
  try {
    p2 = await phase2Gate();
  } catch (err) {
    // A database error BEFORE anything was sent. The approval is recorded `failed` (never left wedged in `executing`), and the claim is
    // released on a best-effort basis so a later stage change can plan the upload again. Logs the error class only, never its text.
    // eslint-disable-next-line no-console
    console.error(`[search] conversions: execution of approval ${approvalId} failed before any send:`, (err as Error)?.name ?? "error");
    await withTenants(
      [tenantId],
      (c) =>
        c.query(
          `UPDATE search_conversion_uploads SET status = 'skipped', reason = $2, updated_at = now() WHERE id = $1 AND status = 'pending_approval'`,
          [a0.ledgerId, REASON.internalError],
        ),
      SEARCH,
    ).catch(() => undefined);
    await finishApproval(tenantId, approvalId, deciderId, { ok: false, error: REASON.internalError }).catch(() => undefined);
    return { ledgerId: a0.ledgerId, platform: a0.platform, mode: null, status: "failed", reason: REASON.internalError };
  }

  async function phase2Gate(): Promise<Phase2> {
    return withTenants(
    [tenantId],
    async (c): Promise<Phase2> => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${CONVERSION_UPLOAD_WORKFLOW}:${a0.ledgerId}`]);
      const led = (await c.query<LedgerRow>(`SELECT ${LEDGER_COLS} FROM search_conversion_uploads WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [a0.ledgerId, tenantId])).rows[0];
      if (!led || led.approval_id !== approvalId) {
        return { kind: "stop", ledgerId: null, platform: a0.platform, status: "failed", reason: REASON.argsInvalid };
      }
      if (led.status !== "pending_approval") {
        // Already simulated / uploaded / failed / rejected / skipped: never a second send.
        return { kind: "stop", ledgerId: led.id, platform: led.platform, status: "failed", reason: REASON.ledgerNotPending };
      }
      const hash = conversionContentHash(bindingOf(led));
      if (hash !== led.content_hash || hash !== a0.contentHash || led.platform !== a0.platform || led.conversion_key !== a0.conversionKey
        || led.deal_value !== a0.dealValue || led.deal_currency !== a0.dealCurrency) {
        await c.query(`UPDATE search_conversion_uploads SET status = 'failed', reason = $2, updated_at = now() WHERE id = $1`, [led.id, REASON.contentChanged]);
        return { kind: "stop", ledgerId: led.id, platform: led.platform, status: "failed", reason: REASON.contentChanged };
      }
      const skip = async (reason: string): Promise<Phase2> => {
        // The gate failed again: nothing is sent, and the claim is RELEASED (`skipped` is outside the claim index).
        await c.query(`UPDATE search_conversion_uploads SET status = 'skipped', reason = $2, updated_at = now() WHERE id = $1`, [led.id, reason]);
        return { kind: "stop", ledgerId: led.id, platform: led.platform, status: "skipped", reason };
      };
      const target = led.target_id
        ? (await c.query<TargetRow>(
            `SELECT id, property_id, platform, conversion_key, conversion_action, send_value FROM search_conversion_targets
              WHERE id = $1 AND tenant_id = $2 AND enabled AND deleted_at IS NULL`, [led.target_id, tenantId])).rows[0]
        : undefined;
      if (!target) return skip(REASON.targetDisabled);

      const rawFacts = await readLeadConversionFacts(c, tenantId, led.lead_id);
      const facts = rawFacts && rawFacts.submissionRef === led.submission_ref ? rawFacts : null;
      const suppressed = facts ? await isContactSuppressed(c, tenantId, { email: facts.contactEmail, phone: facts.contactPhone }, "ad_upload") : false;
      const verdict = evaluateGate(facts, led.platform, suppressed);
      if (!verdict.ok || !facts) return skip(verdict.ok ? REASON.leadNotFound : verdict.reason);

      const plan = buildGoogleUploadRequest({
        facts,
        ledger: {
          submissionRef: led.submission_ref, conversionKey: led.conversion_key, occurredAt: new Date(led.occurred_at).toISOString(),
          dealValue: led.deal_value, dealCurrency: led.deal_currency,
        },
        conversionAction: target.conversion_action,
        customerId: null,
        sendValue: target.send_value,
      });
      const mode = conversionModeFor(led.platform, deps.env);
      // What WOULD be sent, minus every identifier value: the summary holds kinds and field names only.
      await c.query(
        `UPDATE search_conversion_uploads SET status = 'executing', mode = $2, outcome = $3::jsonb, updated_at = now() WHERE id = $1`,
        [led.id, mode, JSON.stringify(plan.summary)],
      );
      return { kind: "go", ledger: led, plan, mode, conversionAction: target.conversion_action };
    },
    SEARCH,
    );
  }

  if (p2.kind === "stop") {
    const error = `${p2.status === "skipped" ? "conversion_gate" : "conversion_refused"}: ${p2.reason}`;
    await finishApproval(tenantId, approvalId, deciderId, { ok: false, error });
    return { ledgerId: p2.ledgerId, platform: p2.platform, mode: null, status: p2.status, reason: p2.reason };
  }

  // ── Phase 3: exactly ONE send (or the simulation). The ATTEMPT is on the activity ledger first, so a crash leaves evidence.
  const { ledger, plan, mode } = p2;
  await writeActivity(tenantId, deciderId, "attempted", "search_conversion_upload", ledger.id, {
    viaApproval: approvalId, platform: ledger.platform, conversionKey: ledger.conversion_key, mode,
  });
  let result: UploadResult;
  if (mode === "simulate") {
    result = { ok: true };
  } else {
    const uploader = deps.uploader ?? getLiveConversionUploader(ledger.platform);
    if (!uploader) {
      result = { ok: false, error: REASON.notConfigured, ambiguous: false };
    } else {
      try {
        result = await uploader({ tenantId, propertyId: ledger.property_id, conversionAction: p2.conversionAction, body: plan.body });
      } catch {
        // An uploader that throws after the gate may or may not have sent: treat as ambiguous, never resend.
        result = { ok: false, error: REASON.ambiguous, ambiguous: true };
      }
    }
  }

  // ── Phase 4: record. The row is `executing` until here, so a crash leaves it visible and wedged for a human, never resent.
  const finalStatus: "simulated" | "uploaded" | "failed" = result.ok ? (mode === "simulate" ? "simulated" : "uploaded") : "failed";
  await withTenants(
    [tenantId],
    (c) =>
      c.query(
        `UPDATE search_conversion_uploads SET status = $2, reason = $3, updated_at = now() WHERE id = $1 AND status = 'executing'`,
        [ledger.id, finalStatus, result.ok ? null : result.error],
      ),
    SEARCH,
  );
  const identifierKinds = plan.summary.identifierKinds;
  if (result.ok) {
    await finishApproval(tenantId, approvalId, deciderId, {
      ok: true,
      result: { ledgerId: ledger.id, platform: ledger.platform, mode, status: finalStatus, identifierKinds },
    });
    await writeActivity(tenantId, deciderId, finalStatus, "search_conversion_upload", ledger.id, {
      viaApproval: approvalId, platform: ledger.platform, conversionKey: ledger.conversion_key, mode,
    });
    return { ledgerId: ledger.id, platform: ledger.platform, mode, status: finalStatus, identifierKinds };
  }
  await finishApproval(tenantId, approvalId, deciderId, { ok: false, error: result.error });
  return { ledgerId: ledger.id, platform: ledger.platform, mode, status: "failed", reason: result.error, identifierKinds };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// TARGETS and the LEDGER — the BFF's reads and the one config write
// ═══════════════════════════════════════════════════════════════════════════════════════════════
export interface ConversionTargetDto {
  id: string;
  propertyId: string;
  webSiteSlug: string;
  platform: ConversionPlatform;
  stage: string;
  conversionKey: string;
  conversionAction: string;
  sendValue: boolean;
  enabled: boolean;
  mode: "simulate" | "live";
  updatedAt: string;
}

const TARGET_COLS = `id, property_id, web_site_slug, platform, stage_key, conversion_key, conversion_action, send_value, enabled, updated_at`;
interface TargetFullRow {
  id: string; property_id: string; web_site_slug: string; platform: ConversionPlatform; stage_key: string; conversion_key: string;
  conversion_action: string; send_value: boolean; enabled: boolean; updated_at: Date;
}
function targetDto(r: TargetFullRow, env?: NodeJS.ProcessEnv): ConversionTargetDto {
  return {
    id: r.id, propertyId: r.property_id, webSiteSlug: r.web_site_slug, platform: r.platform, stage: r.stage_key,
    conversionKey: r.conversion_key, conversionAction: r.conversion_action, sendValue: r.send_value, enabled: r.enabled,
    mode: conversionModeFor(r.platform, env), updatedAt: new Date(r.updated_at).toISOString(),
  };
}

export async function listConversionTargets(tenantId: string, propertyId: string): Promise<ConversionTargetDto[] | null> {
  return withTenants(
    [tenantId],
    async (c) => {
      const prop = await c.query(`SELECT 1 FROM search_properties WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, [propertyId, tenantId]);
      if (!prop.rows[0]) return null;
      const r = await c.query<TargetFullRow>(
        `SELECT ${TARGET_COLS} FROM search_conversion_targets WHERE tenant_id = $1 AND property_id = $2 AND deleted_at IS NULL
          ORDER BY web_site_slug, platform, stage_key`, [tenantId, propertyId]);
      return r.rows.map((x) => targetDto(x));
    },
    SEARCH,
  );
}

export interface UpsertTargetInput {
  webSiteSlug: string;
  platform: ConversionPlatform;
  stage: string;
  conversionKey: string;
  conversionAction: string;
  sendValue: boolean;
  enabled: boolean;
}
export type UpsertTargetOutcome =
  | { outcome: "ok"; target: ConversionTargetDto; created: boolean }
  | { outcome: "property_not_found" }
  | { outcome: "stage_unknown" }
  | { outcome: "slug_in_use" };

/** Idempotent upsert on (tenant, site slug, platform, stage). The property is checked THROUGH RLS first: the FK is checked as the
 *  table owner, outside RLS, so another company's property id must never reach the INSERT. */
export async function upsertConversionTarget(tenantId: string, propertyId: string, input: UpsertTargetInput, userId: string | null): Promise<UpsertTargetOutcome> {
  return withTenants(
    [tenantId],
    async (c): Promise<UpsertTargetOutcome> => {
      const prop = await c.query(`SELECT 1 FROM search_properties WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, [propertyId, tenantId]);
      if (!prop.rows[0]) return { outcome: "property_not_found" };
      const stage = await c.query(`SELECT 1 FROM agency_lead_stages WHERE key = $1`, [input.stage]);
      if (!stage.rows[0]) return { outcome: "stage_unknown" };
      const existing = await c.query<TargetFullRow>(
        `SELECT ${TARGET_COLS} FROM search_conversion_targets
          WHERE tenant_id = $1 AND web_site_slug = $2 AND platform = $3 AND stage_key = $4 AND deleted_at IS NULL FOR UPDATE`,
        [tenantId, input.webSiteSlug, input.platform, input.stage],
      );
      if (existing.rows[0]) {
        // A slug maps to ONE property per (platform, stage): moving it to another property would silently re-point an account.
        if (existing.rows[0].property_id !== propertyId) return { outcome: "slug_in_use" };
        const u = await c.query<TargetFullRow>(
          `UPDATE search_conversion_targets
              SET conversion_key = $2, conversion_action = $3, send_value = $4, enabled = $5, updated_at = now()
            WHERE id = $1 RETURNING ${TARGET_COLS}`,
          [existing.rows[0].id, input.conversionKey, input.conversionAction, input.sendValue, input.enabled],
        );
        return { outcome: "ok", target: targetDto(u.rows[0]), created: false };
      }
      const ins = await c.query<TargetFullRow>(
        `INSERT INTO search_conversion_targets
           (id, tenant_id, property_id, web_site_slug, platform, stage_key, conversion_key, conversion_action, send_value, enabled, created_by, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ${TARGET_COLS}`,
        [newId(), tenantId, propertyId, input.webSiteSlug, input.platform, input.stage, input.conversionKey, input.conversionAction,
          input.sendValue, input.enabled, userId, config.originSite],
      );
      return { outcome: "ok", target: targetDto(ins.rows[0]), created: true };
    },
    SEARCH,
  );
}

export interface ConversionUploadDto {
  id: string;
  propertyId: string;
  platform: ConversionPlatform;
  leadId: string;
  stageEventId: string;
  stage: string;
  conversionKey: string;
  dealValue: string | null;
  dealCurrency: string | null;
  status: UploadStatus;
  reason: string | null;
  mode: "simulate" | "live" | null;
  approvalId: string | null;
  /** Non-personal: kinds of identifier and field names, never values. */
  outcome: unknown;
  occurredAt: string;
  createdAt: string;
}

export interface ListUploadsFilter { propertyId?: string; leadId?: string; status?: UploadStatus; limit?: number }

export async function listConversionUploads(tenantId: string, f: ListUploadsFilter): Promise<ConversionUploadDto[]> {
  const where: string[] = ["tenant_id = $1"];
  const params: unknown[] = [tenantId];
  if (f.propertyId) { params.push(f.propertyId); where.push(`property_id = $${params.length}`); }
  if (f.leadId) { params.push(f.leadId); where.push(`lead_id = $${params.length}`); }
  if (f.status) { params.push(f.status); where.push(`status = $${params.length}`); }
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 200);
  const r = await withTenants(
    [tenantId],
    (c) =>
      c.query<{
        id: string; property_id: string; platform: ConversionPlatform; lead_id: string; stage_event_id: string; stage: string; conversion_key: string;
        deal_value: string | null; deal_currency: string | null; status: UploadStatus; reason: string | null; mode: "simulate" | "live" | null;
        approval_id: string | null; outcome: unknown; occurred_at: Date; created_at: Date;
      }>(
        `SELECT id, property_id, platform, lead_id, stage_event_id, stage, conversion_key, deal_value::text AS deal_value, deal_currency,
                status, reason, mode, approval_id, outcome, occurred_at, created_at
           FROM search_conversion_uploads WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id LIMIT ${limit}`,
        params,
      ),
    SEARCH,
  );
  return r.rows.map((x) => ({
    id: x.id, propertyId: x.property_id, platform: x.platform, leadId: x.lead_id, stageEventId: x.stage_event_id, stage: x.stage,
    conversionKey: x.conversion_key, dealValue: x.deal_value, dealCurrency: x.deal_currency, status: x.status, reason: x.reason,
    mode: x.mode, approvalId: x.approval_id, outcome: x.outcome, occurredAt: new Date(x.occurred_at).toISOString(),
    createdAt: new Date(x.created_at).toISOString(),
  }));
}
