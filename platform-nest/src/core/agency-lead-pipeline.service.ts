// M5-P1-b — the lead pipeline's service layer (WSK-D69, owner, 2026-10-11).
// Design: docs/plans/2026-10-11-m5-lead-pipeline-design.md §2 (stages vs status), §3 (deal value),
// §5 (the writer and the event), §7 (what P1 hands to P2-P4). Schema: migration
// 202610111425_agency_lead_pipeline.sql (P1-a).
//
// ── ONE WRITER ──────────────────────────────────────────────────────────────────────────────────
// `transitionStage()` below is the ONLY code that writes `agency_leads.stage`. Convert (won), decline
// (lost) and `moveLeadStage` (open stages) all go through it. It runs inside the CALLER's
// `withTenants([tenantId])` transaction and does, in this order:
//   1. SELECT ... FOR UPDATE on the lead. `from_stage` is THIS locked value, never an earlier,
//      unlocked read, so two concurrent moves can never both record the same `from`.
//   2. ONE UPDATE that sets `stage` together with the caller's `extraSet` (convert: status and the
//      converted_* / triaged_* columns; decline: status, declined_reason and triaged_*) and the deal
//      when one is given. The CHECKs `lead_won_iff_converted` / `lead_lost_iff_declined` see both
//      columns at once; two UPDATEs (status, then stage) would fail them (design §10 trap 4).
//   3. INSERT one `agency_lead_stage_events` row (the post-update deal, the actor, `currentVia()`).
//   4. emitEvent `agency.lead.stage_changed` v1 on the `agency_lead` stream, with EXACTLY the v1 key
//      set (pinned by a test). No names, emails, phones, org name, attribution, consent or reason:
//      consumers fetch the lead over the authenticated path (`readLeadConversionFacts`).
//
// ── LOCK ORDER (no cycles) ──────────────────────────────────────────────────────────────────────
// Convert takes its advisory lead lock (AGENCY_LEAD_LOCK_NS) first and then this row lock. Moves,
// the deal write and decline take only the row lock. The intake submit takes its token advisory
// lock, then this row lock, then touches the token row; decline takes this row lock, then the token
// rows. Every path that holds both a lead row and a token row takes the lead row FIRST.
//
// ── NO MODULE WALL ──────────────────────────────────────────────────────────────────────────────
// `agency_leads` / `agency_lead_stage_events` carry the plain tenant wall (AD-1 §3.1), so every
// `withTenants` here passes NO `{ modules }` option — same doctrine as agency-leads.service.ts.
import { BadRequestException, ConflictException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { newId, withTenants } from "../db";
import { config } from "../config";
import { emitEvent } from "../events/outbox.service";
import { currentVia } from "./request-context";

// ─────────────────────────────────────────────────────────────────────────────── vocabulary
/** The event every stage change emits (design §5). Entity type `agency_lead`, stream `events:agency_lead`.
 *  Deliberately NOT in `TOPIC_BY_EVENT` and NOT on the n8n bridge's allow-list: the value is commercially
 *  sensitive (design §5, AD-1 §9.3). */
export const STAGE_CHANGED = "agency.lead.stage_changed";

/** The terminal stage keys. The CHECKs in 202610111425 name these literally, so they are constants here
 *  too; the OPEN stages are rows in `agency_lead_stages` and are never hard-coded in this file. */
export const WON_STAGE = "won";
export const LOST_STAGE = "lost";

/** Every `status` that is still in the pipeline (design §2). `converted` and `declined` are closed. */
export const OPEN_LEAD_STATUSES: readonly string[] = ["new", "invited", "submitted", "in_review", "nurturing"];

const STAGE_KEY_RE = /^[a-z][a-z_]{1,31}$/;
/** The API's decimal grammar for a deal value (design §3): up to 16 integer digits, up to 4 decimals. */
export const DEAL_VALUE_RE = /^\d{1,16}(\.\d{1,4})?$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VIA_AGENT_CAP = 64; // agency_lead_stage_events.via_agent CHECK

/** Typed reason codes (design §6). Thrown as `{ message, reason }` so HttpErrorFilter forwards `reason`. */
export type PipelineRefusal =
  | "stage_unknown" | "stage_terminal" | "lead_closed"
  | "deal_incomplete" | "deal_value_invalid" | "deal_currency_unknown" | "deal_value_precision";

function badRequest(reason: PipelineRefusal, message: string): BadRequestException {
  return new BadRequestException({ message, reason });
}

// ─────────────────────────────────────────────────────────────────────────────── deal value
/** A validated deal: `value` is a decimal STRING in the API grammar, `currency` an upper-case ISO 4217
 *  code. Whether the code exists, and whether the value fits its minor unit, needs the DB
 *  (`assertDealAllowed`). */
export interface DealInput {
  value: string;
  currency: string;
}

/** Pure shape check of a `{value, currency}` object (design §3). Returns `null` for the explicit clear
 *  `{value:null, currency:null}`. The value may be a decimal string (preferred) or a finite JSON number;
 *  either way it must match `DEAL_VALUE_RE` once stringified, so `1e21`, `-5` and float noise such as
 *  `0.30000000000000004` are all refused as `deal_value_invalid` rather than rounded. */
export function normalizeDeal(raw: unknown): DealInput | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw badRequest("deal_incomplete", "deal must be an object {value, currency}");
  }
  const r = raw as Record<string, unknown>;
  const v = r.value;
  const cur = r.currency;
  // The clear is the EXPLICIT pair of nulls; a body that merely omits both keys is incomplete, so `{}` can
  // never wipe a value by accident.
  if (v === null && cur === null) return null;
  if (v === null || v === undefined || cur === null || cur === undefined) {
    throw badRequest("deal_incomplete", "deal value and currency are set together, or cleared together with two nulls");
  }

  let value: string;
  if (typeof v === "string") value = v.trim();
  else if (typeof v === "number" && Number.isFinite(v)) value = String(v);
  else throw badRequest("deal_value_invalid", "deal value must be a decimal string or a finite number");
  if (!DEAL_VALUE_RE.test(value)) {
    throw badRequest("deal_value_invalid", "deal value must be a non-negative decimal with at most 16 integer digits and 4 decimals");
  }

  if (typeof cur !== "string") throw badRequest("deal_currency_unknown", "deal currency must be an ISO 4217 code");
  const currency = cur.trim().toUpperCase();
  if (!CURRENCY_RE.test(currency)) throw badRequest("deal_currency_unknown", `unknown currency '${cur}'`);
  return { value, currency };
}

/** `deal` as it rides on a move or a convert: absent (or null) means "leave the value alone". */
export function normalizeOptionalDeal(raw: unknown): DealInput | null | undefined {
  if (raw === undefined || raw === null) return undefined;
  return normalizeDeal(raw);
}

/** Pure: is `value` exact at `minorUnit` decimals, i.e. is value × 10^minorUnit an integer? Trailing zeros
 *  do not count (`10.250` is fine for USD). Exported for the unit test. */
export function dealPrecisionOk(value: string, minorUnit: number): boolean {
  const dot = value.indexOf(".");
  if (dot < 0) return true;
  const decimals = value.slice(dot + 1).replace(/0+$/, "");
  return decimals.length <= minorUnit;
}

/** The currency must be an ACTIVE row of `finance_currencies` (global reference data, no RLS), and the
 *  value must be exact at its `minor_unit` (design §3: IDR refuses 1500.5; USD takes 10.25, refuses 10.255). */
export async function assertDealAllowed(c: PoolClient, deal: DealInput): Promise<void> {
  const r = await c.query<{ minor_unit: number }>(
    `SELECT minor_unit FROM finance_currencies WHERE code = $1 AND status = 'active'`,
    [deal.currency],
  );
  const row = r.rows[0];
  if (!row) throw badRequest("deal_currency_unknown", `unknown currency '${deal.currency}'`);
  if (!dealPrecisionOk(deal.value, Number(row.minor_unit))) {
    throw badRequest(
      "deal_value_precision",
      `${deal.currency} allows at most ${row.minor_unit} decimal place(s); '${deal.value}' is not exact at that unit`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────── the event (v1)
/** Payload v1 of `agency.lead.stage_changed` (design §5 / §7). Exact key set; no personal data. */
export interface StageChangedV1 {
  v: 1;
  leadId: string;
  stageEventId: string;
  submissionRef: string | null;
  fromStage: string;
  toStage: string;
  dealValue: string | null;
  dealCurrency: string | null;
  occurredAt: string;
}

/** The v1 key set, in the order the design lists it. A test pins the emitted payload's keys to EQUAL this. */
export const STAGE_CHANGED_V1_KEYS: readonly (keyof StageChangedV1)[] = [
  "v", "leadId", "stageEventId", "submissionRef", "fromStage", "toStage", "dealValue", "dealCurrency", "occurredAt",
];

/** Consumers validate the shape; they never trust it (design §7). Returns a FRESH object holding only the
 *  v1 keys (anything extra on the wire is dropped, never passed through), or null when any key is missing
 *  or malformed. */
export function parseStageChangedV1(payload: unknown): StageChangedV1 | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  if (p.v !== 1) return null;
  const isUuid = (x: unknown): x is string => typeof x === "string" && UUID_RE.test(x);
  const isStage = (x: unknown): x is string => typeof x === "string" && STAGE_KEY_RE.test(x);
  if (!isUuid(p.leadId) || !isUuid(p.stageEventId)) return null;
  if (!(p.submissionRef === null || isUuid(p.submissionRef))) return null;
  if (!isStage(p.fromStage) || !isStage(p.toStage) || p.fromStage === p.toStage) return null;
  const dv = p.dealValue;
  const dc = p.dealCurrency;
  if (dv === null || dc === null) {
    if (dv !== null || dc !== null) return null; // set together or not at all
  } else {
    if (typeof dv !== "string" || !/^\d{1,16}(\.\d{1,4})?$/.test(dv)) return null;
    if (typeof dc !== "string" || !CURRENCY_RE.test(dc)) return null;
  }
  if (typeof p.occurredAt !== "string" || Number.isNaN(Date.parse(p.occurredAt))) return null;
  return {
    v: 1,
    leadId: p.leadId,
    stageEventId: p.stageEventId,
    submissionRef: p.submissionRef as string | null,
    fromStage: p.fromStage,
    toStage: p.toStage,
    dealValue: dv as string | null,
    dealCurrency: dc as string | null,
    occurredAt: p.occurredAt,
  };
}

/** The consent gate's one reading of a lead's `visitor_consent` snapshot (design §8 step 4): "given" iff
 *  the snapshot is a plain object whose `marketing` is the boolean `true`. `false` is "not_given";
 *  anything else (absent snapshot, null, an absent key, the string "true", a number) is "unknown", which
 *  P2 treats exactly like "not_given": no upload. */
export function marketingConsentState(snapshot: unknown): "given" | "not_given" | "unknown" {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return "unknown";
  const m = (snapshot as Record<string, unknown>).marketing;
  if (m === true) return "given";
  if (m === false) return "not_given";
  return "unknown";
}

// ─────────────────────────────────────────────────────────────────────────────── the writer
/** A marker for `extraSet`: write the column as the transaction's `now()` rather than a bound value. */
export const SQL_NOW: unique symbol = Symbol("SQL_NOW");

/** The only columns a caller may set alongside `stage`. An allow-list, because the names go into SQL text. */
const EXTRA_SET_COLUMNS = new Set([
  "status", "declined_reason", "triaged_by", "triaged_at",
  "converted_client_id", "converted_project_id", "pipeline_run_id",
]);
export type StageExtraColumn =
  | "status" | "declined_reason" | "triaged_by" | "triaged_at"
  | "converted_client_id" | "converted_project_id" | "pipeline_run_id";
export type StageExtraSet = Partial<Record<StageExtraColumn, unknown>>;

export interface TransitionStageInput {
  tenantId: string;
  leadId: string;
  to: string;
  /** users.id of the deciding principal; NULL only for a principal with no user row. */
  actorId: string | null;
  /** Written in the SAME UPDATE. `undefined` leaves the value alone; `null` clears it. */
  deal?: DealInput | null;
  /** Columns written in the SAME UPDATE as `stage` (convert / decline). Values bind as parameters;
   *  `SQL_NOW` writes `now()`. */
  extraSet?: StageExtraSet;
  /** Precondition checked UNDER the row lock: the lead's status must be one of these. */
  requireStatusIn?: readonly string[];
}

export type TransitionStageResult =
  | { outcome: "not_found" }
  | { outcome: "status_mismatch"; status: string; stage: string }
  | { outcome: "unchanged"; status: string; stage: string }
  | {
      outcome: "changed";
      fromStage: string;
      toStage: string;
      status: string;
      stageEventId: string;
      eventId: string;
      dealValue: string | null;
      dealCurrency: string | null;
      occurredAt: string;
    };

/** THE writer (design §5). Must run inside the caller's `withTenants([tenantId])` transaction; it never
 *  opens one of its own, so it commits or rolls back with everything else the caller did. It validates
 *  nothing about WHICH transition is allowed beyond `requireStatusIn`; callers own that (moveLeadStage
 *  refuses terminal targets, convert and decline own won and lost). */
export async function transitionStage(c: PoolClient, input: TransitionStageInput): Promise<TransitionStageResult> {
  const { tenantId, leadId, to, actorId, deal, extraSet, requireStatusIn } = input;
  if (deal) await assertDealAllowed(c, deal);

  // 1 · the row lock, and the locked `from`.
  const locked = await c.query<{ stage: string; status: string; submission_ref: string | null }>(
    `SELECT stage, status, submission_ref FROM agency_leads
      WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
      FOR UPDATE`,
    [leadId, tenantId],
  );
  const cur = locked.rows[0];
  if (!cur) return { outcome: "not_found" };
  if (requireStatusIn && !requireStatusIn.includes(cur.status)) {
    return { outcome: "status_mismatch", status: cur.status, stage: cur.stage };
  }
  if (cur.stage === to) {
    // Writes nothing. A caller that also asked for status columns has a bug: under the iff-CHECKs a
    // status change into converted/declined always moves the stage.
    if (extraSet && Object.keys(extraSet).length) {
      throw new Error(`transitionStage: lead ${leadId} is already at '${to}' but extraSet was given`);
    }
    return { outcome: "unchanged", status: cur.status, stage: cur.stage };
  }

  // 2 · ONE UPDATE: stage + extraSet + deal.
  const params: unknown[] = [leadId, tenantId, to];
  const sets = ["stage = $3", "updated_at = now()"];
  for (const [col, val] of Object.entries(extraSet ?? {})) {
    if (!EXTRA_SET_COLUMNS.has(col)) throw new Error(`transitionStage: column '${col}' is not settable here`);
    if (val === SQL_NOW) {
      sets.push(`${col} = now()`);
    } else {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    }
  }
  if (deal !== undefined) {
    params.push(deal ? deal.value : null);
    sets.push(`deal_value = $${params.length}::numeric`);
    params.push(deal ? deal.currency : null);
    sets.push(`deal_currency = $${params.length}`);
  }
  const upd = await c.query<{ status: string; deal_value: string | null; deal_currency: string | null }>(
    `UPDATE agency_leads SET ${sets.join(", ")}
      WHERE id = $1 AND tenant_id = $2
      RETURNING status, deal_value::text AS deal_value, deal_currency`,
    params,
  );
  const after = upd.rows[0];

  // 3 · the history row (post-update value; no personal data).
  //     occurred_at is clock_timestamp(), NOT the column default now(): now() is the TRANSACTION START,
  //     and a writer that queued on the row lock started before the one holding it, so now() would order
  //     the history differently from the order the moves actually happened in. clock_timestamp() is read
  //     here, under the row lock, so it increases along the chain (from = previous to).
  const stageEventId = newId();
  const agent = currentVia()?.agent;
  const viaAgent = agent ? agent.slice(0, VIA_AGENT_CAP) : null;
  const hist = await c.query<{ occurred_at: Date }>(
    `INSERT INTO agency_lead_stage_events
       (id, tenant_id, lead_id, from_stage, to_stage, deal_value, deal_currency, actor_id, via_agent, origin_site, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9, $10, clock_timestamp())
     RETURNING occurred_at`,
    [stageEventId, tenantId, leadId, cur.stage, to, after.deal_value, after.deal_currency, actorId, viaAgent, config.originSite],
  );
  const occurredAt = new Date(hist.rows[0].occurred_at).toISOString();

  // 4 · the event, same transaction.
  const payload: StageChangedV1 = {
    v: 1,
    leadId,
    stageEventId,
    submissionRef: cur.submission_ref,
    fromStage: cur.stage,
    toStage: to,
    dealValue: after.deal_value,
    dealCurrency: after.deal_currency,
    occurredAt,
  };
  const eventId = await emitEvent(c, tenantId, "agency_lead", leadId, STAGE_CHANGED, { ...payload });

  return {
    outcome: "changed",
    fromStage: cur.stage,
    toStage: to,
    status: after.status,
    stageEventId,
    eventId,
    dealValue: after.deal_value,
    dealCurrency: after.deal_currency,
    occurredAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────── moveStage
export type MoveStageOutcome =
  | { outcome: "not_found" }
  | {
      outcome: "ok";
      id: string;
      stage: string;
      changed: boolean;
      stageEventId?: string;
      dealValue: string | null;
      dealCurrency: string | null;
    };

/** Move a lead between OPEN stages (design §2), forwards or backwards. Staff decision only: nothing a
 *  prospect does calls this. The caller has authorized `triage` (and `update` when `deal` is sent).
 *
 *  - unknown stage key → 400 `stage_unknown`; `won`/`lost` (any non-open kind) → 400 `stage_terminal`
 *    (won is Convert's, lost is Decline's);
 *  - a converted or declined lead → 409 `lead_closed`;
 *  - the stage it is already at → `changed:false`, and no history row and no event (safe retries). A
 *    `deal` sent with a same-stage move is applied as a plain value edit (no stage event), and is itself a
 *    no-op when the value is unchanged;
 *  - otherwise one history row and one `stage_changed` event, via `transitionStage`. */
export async function moveLeadStage(
  tenantId: string,
  leadId: string,
  body: { stage?: unknown; deal?: unknown },
  actorId: string | null,
): Promise<MoveStageOutcome> {
  const stage = typeof body?.stage === "string" ? body.stage.trim() : "";
  if (!STAGE_KEY_RE.test(stage)) throw badRequest("stage_unknown", `unknown stage '${String(body?.stage ?? "")}'`);
  const deal = normalizeOptionalDeal(body?.deal);

  return withTenants([tenantId], async (c) => {
    const st = await c.query<{ kind: string }>(`SELECT kind FROM agency_lead_stages WHERE key = $1`, [stage]);
    if (!st.rows[0]) throw badRequest("stage_unknown", `unknown stage '${stage}'`);
    if (st.rows[0].kind !== "open") {
      throw badRequest("stage_terminal", `'${stage}' is reached only through ${st.rows[0].kind === "won" ? "Convert" : "Decline"}`);
    }

    const r = await transitionStage(c, {
      tenantId, leadId, to: stage, actorId, deal, requireStatusIn: OPEN_LEAD_STATUSES,
    });
    if (r.outcome === "not_found") return { outcome: "not_found" as const };
    if (r.outcome === "status_mismatch") {
      throw new ConflictException({ message: `lead is ${r.status}; its stage can no longer move`, reason: "lead_closed" });
    }
    if (r.outcome === "changed") {
      return {
        outcome: "ok" as const, id: leadId, stage: r.toStage, changed: true, stageEventId: r.stageEventId,
        dealValue: r.dealValue, dealCurrency: r.dealCurrency,
      };
    }
    // unchanged — apply a carried deal as a plain value edit, under the row lock transitionStage took.
    const d = deal === undefined ? await readDeal(c, tenantId, leadId) : (await writeDeal(c, tenantId, leadId, deal)).deal;
    return { outcome: "ok" as const, id: leadId, stage: r.stage, changed: false, ...d };
  });
}

// ─────────────────────────────────────────────────────────────────────────────── deal value write
async function readDeal(c: PoolClient, tenantId: string, leadId: string): Promise<{ dealValue: string | null; dealCurrency: string | null }> {
  const r = await c.query<{ deal_value: string | null; deal_currency: string | null }>(
    `SELECT deal_value::text AS deal_value, deal_currency FROM agency_leads WHERE id = $1 AND tenant_id = $2`,
    [leadId, tenantId],
  );
  return { dealValue: r.rows[0]?.deal_value ?? null, dealCurrency: r.rows[0]?.deal_currency ?? null };
}

/** Writes the pair only when it differs (numeric comparison, so `10.25` = `10.2500`). Never touches
 *  `stage`, so it is not a stage write and emits no stage event (design §3). */
async function writeDeal(
  c: PoolClient,
  tenantId: string,
  leadId: string,
  deal: DealInput | null,
): Promise<{ found: boolean; changed: boolean; deal: { dealValue: string | null; dealCurrency: string | null } }> {
  if (deal) await assertDealAllowed(c, deal);
  const value = deal ? deal.value : null;
  const currency = deal ? deal.currency : null;
  const upd = await c.query<{ deal_value: string | null; deal_currency: string | null }>(
    `UPDATE agency_leads SET deal_value = $3::numeric, deal_currency = $4, updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
        AND (deal_value IS DISTINCT FROM $3::numeric OR deal_currency IS DISTINCT FROM $4)
      RETURNING deal_value::text AS deal_value, deal_currency`,
    [leadId, tenantId, value, currency],
  );
  if (upd.rows[0]) {
    return { found: true, changed: true, deal: { dealValue: upd.rows[0].deal_value, dealCurrency: upd.rows[0].deal_currency } };
  }
  const exists = await c.query<{ deal_value: string | null; deal_currency: string | null }>(
    `SELECT deal_value::text AS deal_value, deal_currency FROM agency_leads
      WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
    [leadId, tenantId],
  );
  if (!exists.rows[0]) return { found: false, changed: false, deal: { dealValue: null, dealCurrency: null } };
  return { found: true, changed: false, deal: { dealValue: exists.rows[0].deal_value, dealCurrency: exists.rows[0].deal_currency } };
}

export type SetDealOutcome =
  | { outcome: "not_found" }
  | { outcome: "ok"; id: string; changed: boolean; dealValue: string | null; dealCurrency: string | null };

/** Set or clear the deal value (design §3). Any status, including converted and declined. Emits no stage
 *  event; P2 does no restatement in v1. The caller has authorized `update`, and audits with writeActivity.
 *  `body` is `{value, currency}` or `{value:null, currency:null}`. */
export async function setLeadDeal(tenantId: string, leadId: string, body: unknown): Promise<SetDealOutcome> {
  const deal = normalizeDeal(body);
  return withTenants([tenantId], async (c) => {
    const r = await writeDeal(c, tenantId, leadId, deal);
    if (!r.found) return { outcome: "not_found" as const };
    return { outcome: "ok" as const, id: leadId, changed: r.changed, ...r.deal };
  });
}

// ─────────────────────────────────────────────────────────────────────────────── P2 read
/** What P2-P4 read after a `stage_changed` (design §7). Contact fields are here ONLY so an uploader can
 *  normalise and hash them in memory at execution time; they are never logged, persisted or put into an
 *  event or `tool_args`. */
export interface LeadConversionFacts {
  leadId: string;
  source: string;
  status: string;
  stage: string;
  deletedAt: string | null;
  submissionRef: string | null;
  originForm: string | null;
  webSiteSlug: string | null;
  attribution: unknown;
  visitorConsent: unknown;
  contactEmail: string | null;
  contactPhone: string | null;
  dealValue: string | null;
  dealCurrency: string | null;
}

/** Reads one lead's conversion facts on the CALLER's connection (P2 shares one `withTenants` with its
 *  module-walled ledger; agency tables ignore the scope). Returns null when the lead is not visible in
 *  this tenant. A soft-deleted lead IS returned, with `deletedAt` set, so the gate can refuse it
 *  explicitly rather than read "not found". */
export async function readLeadConversionFacts(c: PoolClient, tenantId: string, leadId: string): Promise<LeadConversionFacts | null> {
  const r = await c.query<{
    id: string; source: string; status: string; stage: string; deleted_at: Date | null;
    submission_ref: string | null; origin_form: string | null; web_site_slug: string | null;
    attribution: unknown; visitor_consent: unknown; contact_email: string | null; contact_phone: string | null;
    deal_value: string | null; deal_currency: string | null;
  }>(
    `SELECT id, source, status, stage, deleted_at, submission_ref, origin_form, web_site_slug,
            attribution, visitor_consent, contact_email, contact_phone,
            deal_value::text AS deal_value, deal_currency
       FROM agency_leads WHERE id = $1 AND tenant_id = $2`,
    [leadId, tenantId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    leadId: row.id,
    source: row.source,
    status: row.status,
    stage: row.stage,
    deletedAt: row.deleted_at ? new Date(row.deleted_at).toISOString() : null,
    submissionRef: row.submission_ref,
    originForm: row.origin_form,
    webSiteSlug: row.web_site_slug,
    attribution: row.attribution ?? null,
    visitorConsent: row.visitor_consent ?? null,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    dealValue: row.deal_value,
    dealCurrency: row.deal_currency,
  };
}
