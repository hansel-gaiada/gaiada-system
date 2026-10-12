// M5-V5-c — the experiments service, I/O half: the DB (search_experiments / search_experiment_results, migration
// 202610131800), Umami reads and the WebDesk item read. The pure half (parsing, the plan, the results view) is experiments.ts.
// Design: docs/plans/2026-10-12-m5-phase5-design.md §5.4 (the stopping rule), §5.5 (the ERP side), §8 row V5-c.
//
// LIFECYCLE  draft --sync--> running --stop--> stopped --decide--> decided        (abort: from draft, running or stopped)
//   register  records the PRE-REGISTRATION (goal, weights, baseline, relative MDE, alpha, power, n per arm, projected days) after
//             refusing a projection over 56 days (422 underpowered) and an 11th live test on the property (409 too_many_running).
//             The record is a `draft`: the ERP never writes to WebDesk here. The human drafts the item with the block and publishes
//             it through the normal content flow (review + `content.publish`, a WS4 approval).
//   sync      reads the item from WebDesk: when its LIVE version carries the registered `experiment` block, the test is `running`
//             and `started_at` is the publish. A live block that differs from the registration (weights, goal, enrolment, target)
//             is NOT started: `plan_mismatch`, with the differing members, because the statistics assume the registered plan.
//   results   exposures per arm from Umami; the CONVERSIONS are read only once the exposure-only progress says the horizon is
//             reached; before it only progress and the SRM verdict come back (see experiments.ts).
//   stop      allowed only at the horizon (or the 56-day inconclusive end): stopping on a look is exactly what the design rules out.
//             Before the horizon the way out is `abort`, which shows no outcome. After `stop` the human removes the block (or merges
//             the winner's override into `fields`) through the normal content flow.
//   decide    after the block is gone from the live version: records the decision snapshot (append-only) and closes the test.
//
// A failed Umami read is `state:"unavailable"` with a reason, never zeros. Nothing here writes to Umami or WebDesk.
import { HttpException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { newId, withTenants } from "../../db";
import {
  umamiGet, UmamiAuthError, UmamiError, UmamiNotConfiguredError, UmamiNotFoundError, UmamiUnreachableError, type UmamiGetOpts,
} from "./umami-client";
import { wholeDaysBetween } from "./experiment-stats";
import {
  ALPHA, CONVERT_EVENT, EV_PROPERTY, EXPOSURE_EVENT, MAX_RUNNING_PER_PROPERTY, POWER, TRAFFIC_WINDOW_DAYS,
  ExperimentRefusal, computePlan, countEvValues, countsForSnapshot, evaluateOnExposures, experimentBlockOf, planDifferences,
  suggestBaseline, toResultsDto, totalOfEvent, totalOfValue,
  type ArmWeight, type DraftPatch, type EvalOutcome, type ExperimentGoal, type ExperimentTarget, type RegistrationInput,
  type ResultsDto, type WebdeskRef,
} from "./experiments";

const SEARCH = { modules: ["search"] };
const ITEM_PATH = "/control/v1/tenants/:tenantSlug/sites/:siteId/content/items/:itemId";
const DAY_MS = 86_400_000;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

// ───────────────────────────────────────────────────────────────────────────────────────────────
// The seams (tests replace them; production uses the defaults)
// ───────────────────────────────────────────────────────────────────────────────────────────────

/** What the service needs to know about one WebDesk item. */
export interface WebdeskItemFacts {
  exists: boolean;
  deleted: boolean;
  collectionKey: string;
  locale: string;
  publishState: string;
  publishedVersion: number | null;
  pendingChanges: boolean;
  updatedAt: string | null;
  /** The blocks of the LIVE version, or null when nothing is published. */
  liveBlocks: unknown[] | null;
}
export interface WebdeskItemReader {
  readItem(tenantId: string, ref: WebdeskRef): Promise<WebdeskItemFacts>;
}

/** The default reader: WebDesk over the webdev module's control-channel seam (loaded lazily, as indexnow-webdesk.ts does). */
export function webdeskItemReader(): WebdeskItemReader {
  return {
    async readItem(tenantId, ref) {
      const { webdeskZoneB } = await import("../webdev/webdesk-content.service");
      await webdeskZoneB.resolveEditableSite(tenantId, ref.tenantSlug, ref.siteId); // the cross-company wall (404 site-not-found)
      let body: unknown;
      try {
        body = (await webdeskZoneB.read({
          command: "item.get", path: ITEM_PATH, params: { tenantSlug: ref.tenantSlug, siteId: ref.siteId, itemId: ref.itemId },
        })).body;
      } catch (err) {
        if ((err as { getStatus?: () => number })?.getStatus?.() === 404) {
          return { exists: false, deleted: false, collectionKey: "", locale: "", publishState: "", publishedVersion: null, pendingChanges: false, updatedAt: null, liveBlocks: null };
        }
        throw err;
      }
      const item = isObj(body) && isObj(body.item) ? body.item : null;
      if (!item) throw new HttpException({ message: "webdesk_error: item_shape" }, 502);
      const live = isObj(body) && isObj(body.live) && Array.isArray(body.live.blocks) ? (body.live.blocks as unknown[]) : null;
      return {
        exists: true,
        deleted: item.deletedAt != null,
        collectionKey: typeof item.collectionKey === "string" ? item.collectionKey : "",
        locale: typeof item.locale === "string" ? item.locale : "",
        publishState: typeof item.publishState === "string" ? item.publishState : "",
        publishedVersion: typeof item.publishedVersion === "number" ? item.publishedVersion : null,
        pendingChanges: item.pendingChanges === true,
        updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : null,
        liveBlocks: item.deletedAt == null ? live : null,
      };
    },
  };
}

export interface ExperimentIo {
  /** Umami read options; tests set `fetchImpl` and `settings`. */
  umami: UmamiGetOpts;
  webdesk: WebdeskItemReader;
  now: () => Date;
  /** Enrolment "all" waits for counsel on F9 (§10 O6): off unless the env switch is exactly "1". */
  allowAllEnrolment: () => boolean;
}
export const experimentIo: ExperimentIo = {
  umami: {},
  webdesk: webdeskItemReader(),
  now: () => new Date(),
  allowAllEnrolment: () => process.env.SEARCH_EXPERIMENTS_ENROL_ALL === "1",
};

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Rows and DTOs
// ───────────────────────────────────────────────────────────────────────────────────────────────

interface Row {
  id: string; tenant_id: string; property_id: string; key: string;
  webdesk_tenant_slug: string; webdesk_site_id: string; collection_key: string; item_id: string; locale: string;
  section_id: string; target: ExperimentTarget; enrolment: "consented" | "all"; goal: ExperimentGoal; arms: ArmWeight[];
  hypothesis: string; baseline_rate: number; baseline_source: "supplied" | "umami_28d"; relative_mde: number; alpha: number; power: number;
  n_per_arm: number; daily_units: number; projected_days: number;
  status: "draft" | "running" | "stopped" | "aborted" | "decided";
  started_at: Date | null; stopped_at: Date | null; created_by: string | null; created_at: Date; updated_at: Date;
}
const COLS = `id, tenant_id, property_id, key, webdesk_tenant_slug, webdesk_site_id, collection_key, item_id, locale, section_id, target, enrolment,
  goal, arms, hypothesis, baseline_rate, baseline_source, relative_mde, alpha, power, n_per_arm, daily_units, projected_days, status,
  started_at, stopped_at, created_by, created_at, updated_at`;

export interface ExperimentDto {
  id: string;
  propertyId: string;
  key: string;
  status: Row["status"];
  hypothesis: string;
  item: { tenantSlug: string; siteId: string; itemId: string; collectionKey: string; locale: string };
  sectionId: string;
  target: ExperimentTarget;
  enrolment: "consented" | "all";
  goal: ExperimentGoal;
  arms: ArmWeight[];
  /** Fixed before the test starts; `locked` from the moment it leaves draft. These are INPUTS, not results. */
  preRegistration: {
    baselineRate: number; baselineSource: "supplied" | "umami_28d"; relativeMde: number; alpha: number; power: number;
    nPerArm: number; dailyUnits: number; projectedDays: number; locked: boolean;
  };
  startedAt: string | null;
  stoppedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);

export function toDto(r: Row): ExperimentDto {
  return {
    id: r.id, propertyId: r.property_id, key: r.key, status: r.status, hypothesis: r.hypothesis,
    item: { tenantSlug: r.webdesk_tenant_slug, siteId: r.webdesk_site_id, itemId: r.item_id, collectionKey: r.collection_key, locale: r.locale },
    sectionId: r.section_id, target: r.target, enrolment: r.enrolment, goal: r.goal, arms: r.arms,
    preRegistration: {
      baselineRate: r.baseline_rate, baselineSource: r.baseline_source, relativeMde: r.relative_mde, alpha: r.alpha, power: r.power,
      nPerArm: r.n_per_arm, dailyUnits: r.daily_units, projectedDays: r.projected_days, locked: r.status !== "draft",
    },
    startedAt: iso(r.started_at), stoppedAt: iso(r.stopped_at), createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!,
  };
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────────────────────────

/** Exposed so the controller maps every refusal the same way. The TOKEN leads the message (the error filter keeps `message`). */
export function refusalToHttp(r: ExperimentRefusal): HttpException {
  const message = r.message.startsWith(r.token) ? r.message : `${r.token}: ${r.message}`;
  return new HttpException({ message, reason: r.token, ...(r.detail ? { existing: r.detail } : {}) }, r.status);
}

type PgError = Error & { code?: string; constraint?: string };
function constraintOf(e: unknown): string | null {
  const c = (e as PgError | undefined)?.constraint;
  return typeof c === "string" ? c : null;
}

/** An Umami failure as the refusal a WRITE answers with (a read answers `state:"unavailable"` instead). */
function umamiRefusal(e: UmamiError): ExperimentRefusal {
  const r = unavailableReason(e);
  return new ExperimentRefusal(503, `analytics_${r}`, `analytics_${r}: ${UNAVAILABLE_WORDS[r]}`);
}
type UnavailableReason = "not_configured" | "not_bound" | "unreachable" | "rejected" | "truncated";
const UNAVAILABLE_WORDS: Record<UnavailableReason, string> = {
  not_configured: "Website analytics is not set up on this server yet, so exposures cannot be counted.",
  not_bound: "This property is not linked to an Umami website yet, so exposures cannot be counted.",
  unreachable: "Umami could not be reached. Nothing is shown rather than zeros; try again in a moment.",
  rejected: "Umami refused the request: the ERP's key was rejected or the website is not known to Umami.",
  truncated: "Umami returned a full page of event values, so some may be missing. Nothing is shown rather than a partial count.",
};
function unavailableReason(e: UmamiError): UnavailableReason {
  if (e instanceof UmamiNotConfiguredError) return "not_configured";
  if (e instanceof UmamiAuthError || e instanceof UmamiNotFoundError) return "rejected";
  if (e instanceof UmamiUnreachableError) return "unreachable";
  return "unreachable"; // bad_response: upstream trouble
}

class Unavailable extends Error {
  constructor(readonly reason: UnavailableReason) { super(reason); }
}

async function loadProperty(c: PoolClient, propertyId: string): Promise<{ umamiSiteId: string | null } | null> {
  const r = await c.query<{ umami_site_id: string | null }>(`SELECT umami_site_id FROM search_properties WHERE id = $1 AND deleted_at IS NULL`, [propertyId]);
  return r.rows[0] ? { umamiSiteId: r.rows[0].umami_site_id } : null;
}

async function lockProperty(c: PoolClient, propertyId: string): Promise<void> {
  // The same key the trigger takes for the running cap, so registration, sync and the trigger serialise per property.
  await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('search_experiments:' || $1::text, 0))`, [propertyId]);
}

async function activeCount(c: PoolClient, propertyId: string): Promise<number> {
  const r = await c.query<{ n: string }>(`SELECT count(*) AS n FROM search_experiments WHERE property_id = $1 AND status IN ('draft','running')`, [propertyId]);
  return Number(r.rows[0]!.n);
}

const tooMany = (): ExperimentRefusal =>
  new ExperimentRefusal(409, "too_many_running", `too_many_running: a property keeps at most ${MAX_RUNNING_PER_PROPERTY} tests going at once (drafts and running); abort or finish one first`);

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Umami reads
// ───────────────────────────────────────────────────────────────────────────────────────────────

const evValues = (siteId: string, eventName: string, startAt: number, endAt: number) =>
  umamiGet(siteId, "event-data/values", { eventName, propertyName: EV_PROPERTY, startAt, endAt }, experimentIo.umami);

/** One count per arm of an `exp_*` event over [startAt, endAt]; throws `Unavailable("truncated")` on a full 100-row page. */
async function armCounts(siteId: string, eventName: string, key: string, armKeys: readonly string[], startAt: number, endAt: number): Promise<number[]> {
  const body = await evValues(siteId, eventName, startAt, endAt);
  const { counts, truncated } = countEvValues(body, key, armKeys);
  if (truncated) throw new Unavailable("truncated");
  return counts;
}

interface Traffic { dailyUnits: number; goalEvents: number; sectionViews: number }

/** The last 28 days of the tested section's views and of the goal event (§5.4: the baseline suggestion and the duration projection). */
async function readTraffic(siteId: string, sectionId: string, goal: ExperimentGoal): Promise<Traffic> {
  const now = experimentIo.now().getTime();
  const range = { startAt: now - TRAFFIC_WINDOW_DAYS * DAY_MS, endAt: now };
  const u = experimentIo.umami;
  try {
    const views = await umamiGet(siteId, "event-data/values", { eventName: "section_view", propertyName: "section_id", ...range }, u);
    const sectionViews = totalOfValue(views, sectionId);
    let goalEvents: number;
    const [mk, mv] = goal.match ? (Object.entries(goal.match)[0] ?? []) : [];
    if (mk && typeof mv === "string") {
      goalEvents = totalOfValue(await umamiGet(siteId, "event-data/values", { eventName: goal.event, propertyName: mk, ...range }, u), mv);
    } else {
      goalEvents = totalOfEvent(await umamiGet(siteId, "metrics", { type: "event", ...range, limit: 500 }, u), goal.event);
    }
    // Umami records the events of visitors who accepted analytics, which is the enrolled population of a `consented` test, so the
    // consented share of section views is 1 and the daily eligible units are the section views a day.
    return { dailyUnits: sectionViews / TRAFFIC_WINDOW_DAYS, goalEvents, sectionViews };
  } catch (e) {
    if (e instanceof UmamiError) throw umamiRefusal(e);
    throw e;
  }
}

/** The baseline, the traffic and the plan for a set of registration fields. Throws the typed refusals. */
async function planFor(
  siteId: string | null,
  f: { sectionId: string; goal: ExperimentGoal; arms: ArmWeight[]; baselineRate: number | null; relativeMde: number },
): Promise<{ baselineRate: number; baselineSource: "supplied" | "umami_28d"; dailyUnits: number; nPerArm: number; projectedDays: number }> {
  if (!siteId) throw new ExperimentRefusal(409, "analytics_not_bound", "analytics_not_bound: " + UNAVAILABLE_WORDS.not_bound);
  const traffic = await readTraffic(siteId, f.sectionId, f.goal);
  let baselineRate = f.baselineRate;
  let baselineSource: "supplied" | "umami_28d" = "supplied";
  if (baselineRate === null) {
    baselineRate = suggestBaseline(traffic.goalEvents, traffic.sectionViews);
    baselineSource = "umami_28d";
    if (baselineRate === null) {
      throw new ExperimentRefusal(422, "baseline_unavailable", `baseline_unavailable: the section had no views in the last ${TRAFFIC_WINDOW_DAYS} days, so there is no rate to suggest; send baselineRate`);
    }
  }
  const plan = computePlan({ baselineRate, relativeMde: f.relativeMde, weights: f.arms.map((a) => a.weight), dailyUnits: traffic.dailyUnits });
  return { baselineRate, baselineSource, dailyUnits: traffic.dailyUnits, nPerArm: plan.nPerArm, projectedDays: plan.projectedDays };
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Reads
// ───────────────────────────────────────────────────────────────────────────────────────────────

export const EXPERIMENT_STATUSES = ["draft", "running", "stopped", "aborted", "decided"] as const;
const LIST_LIMIT = 200;

export async function listExperiments(tenantId: string, propertyId: string, status?: string): Promise<ExperimentDto[] | null> {
  return withTenants([tenantId], async (c) => {
    if (!(await loadProperty(c, propertyId))) return null;
    const r = status && status !== "all"
      ? await c.query<Row>(`SELECT ${COLS} FROM search_experiments WHERE property_id = $1 AND status = $2 ORDER BY created_at DESC, id LIMIT ${LIST_LIMIT}`, [propertyId, status])
      : await c.query<Row>(`SELECT ${COLS} FROM search_experiments WHERE property_id = $1 ORDER BY created_at DESC, id LIMIT ${LIST_LIMIT}`, [propertyId]);
    return r.rows.map(toDto);
  }, SEARCH);
}

async function loadRow(tenantId: string, propertyId: string, experimentId: string): Promise<{ row: Row; umamiSiteId: string | null } | null> {
  return withTenants([tenantId], async (c) => {
    const prop = await loadProperty(c, propertyId);
    if (!prop) return null;
    const r = await c.query<Row>(`SELECT ${COLS} FROM search_experiments WHERE id = $1 AND property_id = $2`, [experimentId, propertyId]);
    return r.rows[0] ? { row: r.rows[0], umamiSiteId: prop.umamiSiteId } : null;
  }, SEARCH);
}

export async function getExperiment(tenantId: string, propertyId: string, experimentId: string): Promise<ExperimentDto | null> {
  const l = await loadRow(tenantId, propertyId, experimentId);
  return l ? toDto(l.row) : null;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Register
// ───────────────────────────────────────────────────────────────────────────────────────────────

/** Refuse a registration that the item itself rules out (it must exist, not be deleted and not already run an experiment). */
function assertItemCanTest(item: WebdeskItemFacts): void {
  if (!item.exists) throw new ExperimentRefusal(404, "item_not_found", "item_not_found: WebDesk has no such item on that site");
  if (item.deleted) throw new ExperimentRefusal(409, "item_deleted", "item_deleted: the item is deleted");
  if (experimentBlockOf(item.liveBlocks)) {
    throw new ExperimentRefusal(409, "item_already_has_experiment", "item_already_has_experiment: the item's live version already carries an experiment block; a test cannot be pre-registered after it started");
  }
}

export type RegisterOutcome = "no_property" | ExperimentDto;

export async function registerExperiment(tenantId: string, propertyId: string, input: RegistrationInput, userId: string | null): Promise<RegisterOutcome> {
  if (input.enrolment === "all" && !experimentIo.allowAllEnrolment()) {
    throw new ExperimentRefusal(422, "enrolment_all_not_enabled", 'enrolment_all_not_enabled: enrolment "all" waits for counsel on F9 (design §10 O6); use "consented"');
  }
  // 1. cheap refusals first (no network): property, the cap, the key, the item
  const pre = await withTenants([tenantId], async (c) => {
    const prop = await loadProperty(c, propertyId);
    if (!prop) return null;
    const dup = await c.query(`SELECT 1 FROM search_experiments WHERE property_id = $1 AND key = $2`, [propertyId, input.key]);
    if (dup.rows[0]) throw new ExperimentRefusal(409, "key_taken", "key_taken: this property already has a test with that key");
    if ((await activeCount(c, propertyId)) >= MAX_RUNNING_PER_PROPERTY) throw tooMany();
    return prop;
  }, SEARCH);
  if (!pre) return "no_property";

  // 2. WebDesk: the item (cross-company wall inside the reader)
  const item = await experimentIo.webdesk.readItem(tenantId, input.webdesk);
  assertItemCanTest(item);

  // 3. Umami: the baseline and the projection (a registration that cannot be projected is not a pre-registration)
  const plan = await planFor(pre.umamiSiteId, input);

  // 4. insert, serialised per property so two registrations cannot both take the 10th slot
  const id = newId();
  try {
    await withTenants([tenantId], async (c) => {
      await lockProperty(c, propertyId);
      if ((await activeCount(c, propertyId)) >= MAX_RUNNING_PER_PROPERTY) throw tooMany();
      await c.query(
        `INSERT INTO search_experiments
           (id, tenant_id, property_id, key, webdesk_tenant_slug, webdesk_site_id, collection_key, item_id, locale, section_id, target, enrolment,
            goal, arms, hypothesis, baseline_rate, baseline_source, relative_mde, alpha, power, n_per_arm, daily_units, projected_days, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
        [id, tenantId, propertyId, input.key, input.webdesk.tenantSlug, input.webdesk.siteId, item.collectionKey, input.webdesk.itemId, item.locale,
          input.sectionId, JSON.stringify(input.target), input.enrolment, JSON.stringify(input.goal), JSON.stringify(input.arms), input.hypothesis,
          plan.baselineRate, plan.baselineSource, input.relativeMde, ALPHA, POWER, plan.nPerArm, plan.dailyUnits, plan.projectedDays, userId],
      );
    }, SEARCH);
  } catch (e) {
    const k = constraintOf(e);
    if (k === "search_experiments_key") throw new ExperimentRefusal(409, "key_taken", "key_taken: this property already has a test with that key");
    if (k === "ux_search_experiments_item_live") throw new ExperimentRefusal(409, "item_already_registered", "item_already_registered: this item already has a test in draft or running; abort it first");
    throw e;
  }
  return (await getExperiment(tenantId, propertyId, id))!;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Edit a draft
// ───────────────────────────────────────────────────────────────────────────────────────────────

const lockedRefusal = (): ExperimentRefusal =>
  new ExperimentRefusal(409, "pre_registration_locked", "pre_registration_locked: the pre-registration cannot change once the test has left draft; abort it and register a new one");

export type UpdateOutcome = "no_property" | "not_found" | ExperimentDto;

export async function updateDraft(tenantId: string, propertyId: string, experimentId: string, patch: DraftPatch): Promise<UpdateOutcome> {
  const l = await loadRow(tenantId, propertyId, experimentId);
  if (!l) return (await withTenants([tenantId], (c) => loadProperty(c, propertyId), SEARCH)) ? "not_found" : "no_property";
  if (l.row.status !== "draft") throw lockedRefusal();
  if (patch.enrolment === "all" && !experimentIo.allowAllEnrolment()) {
    throw new ExperimentRefusal(422, "enrolment_all_not_enabled", 'enrolment_all_not_enabled: enrolment "all" waits for counsel on F9 (design §10 O6); use "consented"');
  }
  const r = l.row;
  const next = {
    hypothesis: patch.hypothesis ?? r.hypothesis,
    sectionId: patch.sectionId ?? r.section_id,
    target: patch.target ?? r.target,
    enrolment: patch.enrolment ?? r.enrolment,
    goal: patch.goal ?? r.goal,
    arms: patch.arms ?? r.arms,
    // an omitted baseline keeps the stored one; an explicit null asks for a fresh 28-day suggestion
    baselineRate: patch.baselineRate !== undefined ? patch.baselineRate : (r.baseline_source === "supplied" ? r.baseline_rate : null),
    relativeMde: patch.relativeMde ?? r.relative_mde,
  };
  const plan = await planFor(l.umamiSiteId, next);
  try {
    const out = await withTenants([tenantId], async (c) => {
      const u = await c.query<Row>(
        `UPDATE search_experiments SET hypothesis = $3, section_id = $4, target = $5, enrolment = $6, goal = $7, arms = $8,
                baseline_rate = $9, baseline_source = $10, relative_mde = $11, n_per_arm = $12, daily_units = $13, projected_days = $14, updated_at = now()
          WHERE id = $1 AND property_id = $2 AND status = 'draft' RETURNING ${COLS}`,
        [experimentId, propertyId, next.hypothesis, next.sectionId, JSON.stringify(next.target), next.enrolment, JSON.stringify(next.goal), JSON.stringify(next.arms),
          plan.baselineRate, plan.baselineSource, next.relativeMde, plan.nPerArm, plan.dailyUnits, plan.projectedDays],
      );
      return u.rows[0] ?? null;
    }, SEARCH);
    if (!out) throw lockedRefusal(); // it started between the read and the write
    return toDto(out);
  } catch (e) {
    if (constraintOf(e) === "search_experiments_prereg_locked") throw lockedRefusal();
    throw e;
  }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Sync: detect "running" from WebDesk
// ───────────────────────────────────────────────────────────────────────────────────────────────

export type SyncState = "started" | "already_running" | "not_live" | "plan_mismatch";
export type SyncOutcome = "no_property" | "not_found" | { state: SyncState; differences?: string[]; experiment: ExperimentDto };

/**
 * The item's LIVE version carrying the registered block IS the start. `started_at` is the publish: WebDesk's `item.get` does not
 * expose `last_published_at`, so it is the item's `updatedAt` when nothing has been saved since the publish (`pendingChanges`
 * false), else the moment this sync saw the block (never earlier than the registration). A later start only shortens the
 * elapsed days and the Umami window, which is the conservative side.
 */
export async function syncExperiment(tenantId: string, propertyId: string, experimentId: string): Promise<SyncOutcome> {
  const l = await loadRow(tenantId, propertyId, experimentId);
  if (!l) return (await withTenants([tenantId], (c) => loadProperty(c, propertyId), SEARCH)) ? "not_found" : "no_property";
  const r = l.row;
  if (r.status === "running") return { state: "already_running", experiment: toDto(r) };
  if (r.status !== "draft") throw new ExperimentRefusal(409, "experiment_closed", `experiment_closed: the test is ${r.status}`);

  const item = await experimentIo.webdesk.readItem(tenantId, { tenantSlug: r.webdesk_tenant_slug, siteId: r.webdesk_site_id, itemId: r.item_id });
  const props = item.exists && !item.deleted ? experimentBlockOf(item.liveBlocks) : null;
  if (!props || props.key !== r.key) return { state: "not_live", experiment: toDto(r) };
  const differences = planDifferences({ key: r.key, target: r.target, enrolment: r.enrolment, goal: r.goal, arms: r.arms }, props);
  if (differences.length > 0) return { state: "plan_mismatch", differences, experiment: toDto(r) };

  const now = experimentIo.now();
  let startedAt = now;
  if (!item.pendingChanges && item.updatedAt) {
    const u = new Date(item.updatedAt);
    if (!Number.isNaN(u.getTime()) && u.getTime() <= now.getTime()) startedAt = u;
  }
  if (startedAt.getTime() < new Date(r.created_at).getTime()) startedAt = new Date(r.created_at);

  try {
    const out = await withTenants([tenantId], async (c) => {
      await lockProperty(c, propertyId);
      const u = await c.query<Row>(
        `UPDATE search_experiments SET status = 'running', started_at = $3, updated_at = now()
          WHERE id = $1 AND property_id = $2 AND status = 'draft' RETURNING ${COLS}`,
        [experimentId, propertyId, startedAt],
      );
      return u.rows[0] ?? null;
    }, SEARCH);
    if (!out) {
      const again = await getExperiment(tenantId, propertyId, experimentId);
      return { state: "already_running", experiment: again! };
    }
    return { state: "started", experiment: toDto(out) };
  } catch (e) {
    if (constraintOf(e) === "search_experiments_running_cap") throw tooMany();
    throw e;
  }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Results
// ───────────────────────────────────────────────────────────────────────────────────────────────

export interface ResultsEnvelope {
  experimentId: string;
  key: string;
  status: Row["status"];
  startedAt: string | null;
  stoppedAt: string | null;
}
export type ExperimentResults =
  | (ResultsEnvelope & { state: "not_started"; message: string })
  | (ResultsEnvelope & { state: "aborted"; message: string })
  | (ResultsEnvelope & { state: "unavailable"; reason: UnavailableReason; message: string })
  | (ResultsEnvelope & ResultsDto & { window: { from: string; to: string }; decided?: { decision: Record<string, unknown> | null; decidedAt: string; note: string | null } });

const envelope = (r: Row): ResultsEnvelope => ({ experimentId: r.id, key: r.key, status: r.status, startedAt: iso(r.started_at), stoppedAt: iso(r.stopped_at) });

/** Exposures and (at the horizon) conversions for the window of a started test, evaluated by the engine. Throws `Unavailable`. */
async function liveEvaluation(row: Row, siteId: string | null): Promise<{ outcome: EvalOutcome; from: Date; to: Date }> {
  if (!siteId) throw new Unavailable("not_bound");
  const from = new Date(row.started_at!);
  const to = row.stopped_at ? new Date(row.stopped_at) : experimentIo.now();
  const endAt = Math.max(to.getTime(), from.getTime());
  const armKeys = row.arms.map((a) => a.key);
  try {
    const exposures = await armCounts(siteId, EXPOSURE_EVENT, row.key, armKeys, from.getTime(), endAt);
    const outcome = await evaluateOnExposures(
      { nPerArm: row.n_per_arm, armKeys, weights: row.arms.map((a) => a.weight) },
      exposures,
      wholeDaysBetween(from.getTime(), endAt),
      () => armCounts(siteId, CONVERT_EVENT, row.key, armKeys, from.getTime(), endAt),
    );
    return { outcome, from, to: new Date(endAt) };
  } catch (e) {
    if (e instanceof UmamiError) throw new Unavailable(unavailableReason(e));
    throw e;
  }
}

export async function readResults(tenantId: string, propertyId: string, experimentId: string): Promise<"not_found" | ExperimentResults> {
  const l = await loadRow(tenantId, propertyId, experimentId);
  if (!l) return "not_found";
  const r = l.row;
  const env = envelope(r);
  if (r.status === "draft") return { ...env, state: "not_started", message: "The test has not started: its experiment block is not live yet. Nothing is counted before then." };
  if (r.status === "aborted") return { ...env, state: "aborted", message: "The test was aborted. No outcome is computed for an aborted test." };
  if (r.status === "decided") return decidedResults(tenantId, r, env);
  try {
    const { outcome, from, to } = await liveEvaluation(r, l.umamiSiteId);
    return { ...env, ...toResultsDto(outcome.view, outcome.warnings), window: { from: from.toISOString(), to: to.toISOString() } };
  } catch (e) {
    if (e instanceof Unavailable) return { ...env, state: "unavailable", reason: e.reason, message: UNAVAILABLE_WORDS[e.reason] };
    throw e;
  }
}

interface ResultRow {
  outcome: "decided" | "aborted"; decision: Record<string, unknown> | null; counts: Array<{ key: string; units: number; conversions: number }> | null;
  window_from: Date | null; window_to: Date | null; note: string | null; created_at: Date;
}

/** A decided test: rebuilt from the stored snapshot (no Umami call), with the stored decision as the authority. */
async function decidedResults(tenantId: string, r: Row, env: ResultsEnvelope): Promise<ExperimentResults> {
  const snap = await withTenants([tenantId], async (c) => {
    const q = await c.query<ResultRow>(
      `SELECT outcome, decision, counts, window_from, window_to, note, created_at FROM search_experiment_results WHERE experiment_id = $1`, [r.id]);
    return q.rows[0] ?? null;
  }, SEARCH);
  if (!snap || snap.outcome !== "decided" || !snap.counts || !snap.window_from || !snap.window_to) {
    return { ...env, state: "unavailable", reason: "unreachable", message: "The decision snapshot of this test is missing." };
  }
  const armKeys = r.arms.map((a) => a.key);
  const exposures = armKeys.map((k) => snap.counts!.find((x) => x.key === k)?.units ?? 0);
  const conversions = armKeys.map((k) => snap.counts!.find((x) => x.key === k)?.conversions ?? 0);
  const outcome = await evaluateOnExposures(
    { nPerArm: r.n_per_arm, armKeys, weights: r.arms.map((a) => a.weight) }, exposures,
    wholeDaysBetween(new Date(snap.window_from).getTime(), new Date(snap.window_to).getTime()), async () => conversions,
  );
  return {
    ...env, ...toResultsDto(outcome.view, outcome.warnings),
    window: { from: new Date(snap.window_from).toISOString(), to: new Date(snap.window_to).toISOString() },
    decided: { decision: snap.decision, decidedAt: new Date(snap.created_at).toISOString(), note: snap.note },
  };
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Stop, decide, abort
// ───────────────────────────────────────────────────────────────────────────────────────────────

export type StopOutcome = "no_property" | "not_found" | { experiment: ExperimentDto; results: ExperimentResults; replayed: boolean };

const horizonRefusal = (): ExperimentRefusal =>
  new ExperimentRefusal(409, "horizon_not_reached", "horizon_not_reached: stopping before the pre-registered horizon is not allowed, because a look at a number is the thing the design rules out; abort the test instead (an abort shows no outcome)");

/** Stop at the horizon (or at the 56-day inconclusive end). Before it: 409 horizon_not_reached; use abort. */
export async function stopExperiment(tenantId: string, propertyId: string, experimentId: string): Promise<StopOutcome> {
  const l = await loadRow(tenantId, propertyId, experimentId);
  if (!l) return (await withTenants([tenantId], (c) => loadProperty(c, propertyId), SEARCH)) ? "not_found" : "no_property";
  const r = l.row;
  if (r.status === "stopped") {
    return { experiment: toDto(r), results: (await readResults(tenantId, propertyId, experimentId)) as ExperimentResults, replayed: true };
  }
  if (r.status !== "running") throw new ExperimentRefusal(409, "not_running", `not_running: the test is ${r.status}`);

  let ev: Awaited<ReturnType<typeof liveEvaluation>>;
  try {
    ev = await liveEvaluation(r, l.umamiSiteId);
  } catch (e) {
    if (e instanceof Unavailable) throw new ExperimentRefusal(503, `analytics_${e.reason}`, `analytics_${e.reason}: ${UNAVAILABLE_WORDS[e.reason]} The horizon cannot be checked, so the test is not stopped.`);
    throw e;
  }
  if (ev.outcome.view.phase === "collecting") throw horizonRefusal();

  const updated = await withTenants([tenantId], async (c) => {
    const u = await c.query<Row>(
      `UPDATE search_experiments SET status = 'stopped', stopped_at = GREATEST($3::timestamptz, started_at), updated_at = now()
        WHERE id = $1 AND property_id = $2 AND status = 'running' RETURNING ${COLS}`,
      [experimentId, propertyId, ev.to],
    );
    return u.rows[0] ?? null;
  }, SEARCH);
  if (!updated) throw new ExperimentRefusal(409, "not_running", "not_running: the test changed state while stopping");
  const results = (await readResults(tenantId, propertyId, experimentId)) as ExperimentResults;
  return { experiment: toDto(updated), results, replayed: false };
}

export type DecideOutcome = "no_property" | "not_found" | { experiment: ExperimentDto; results: ExperimentResults; replayed: boolean };

/** Record the decision of a stopped test once its block is no longer live. Idempotent on a decided test. */
export async function decideExperiment(tenantId: string, propertyId: string, experimentId: string, note: string | null, userId: string | null): Promise<DecideOutcome> {
  const l = await loadRow(tenantId, propertyId, experimentId);
  if (!l) return (await withTenants([tenantId], (c) => loadProperty(c, propertyId), SEARCH)) ? "not_found" : "no_property";
  const r = l.row;
  if (r.status === "decided") return { experiment: toDto(r), results: (await readResults(tenantId, propertyId, experimentId)) as ExperimentResults, replayed: true };
  if (r.status !== "stopped") throw new ExperimentRefusal(409, "not_stopped", `not_stopped: only a stopped test can be decided (it is ${r.status}); stop it at the horizon first`);

  // the human must have removed the block (or merged the winner) through the normal content flow
  const item = await experimentIo.webdesk.readItem(tenantId, { tenantSlug: r.webdesk_tenant_slug, siteId: r.webdesk_site_id, itemId: r.item_id });
  const live = item.exists && !item.deleted ? experimentBlockOf(item.liveBlocks) : null;
  if (live && live.key === r.key) {
    throw new ExperimentRefusal(409, "experiment_still_live", "experiment_still_live: the item's live version still carries the experiment block; publish its removal (or the winner merged into the fields) first");
  }

  let ev: Awaited<ReturnType<typeof liveEvaluation>>;
  try {
    ev = await liveEvaluation(r, l.umamiSiteId);
  } catch (e) {
    if (e instanceof Unavailable) throw new ExperimentRefusal(503, `analytics_${e.reason}`, `analytics_${e.reason}: ${UNAVAILABLE_WORDS[e.reason]} The decision cannot be recorded without the counts.`);
    throw e;
  }
  const view = ev.outcome.view;
  if (view.phase === "collecting") throw horizonRefusal();
  const decision = view.phase === "horizon"
    ? view.analysis.decision
    : (view.decision ?? { action: "keep_control", reason: "inconclusive_at_max_duration" });
  const analysis = view.phase === "horizon" ? view.analysis : null;

  let changed = true;
  const updated = await withTenants([tenantId], async (c) => {
    // ON CONFLICT, not a caught error: a failed statement would abort the whole transaction.
    const ins = await c.query(
      `INSERT INTO search_experiment_results (id, tenant_id, property_id, experiment_id, outcome, decision, counts, analysis, srm, window_from, window_to, note, decided_by)
       VALUES ($1,$2,$3,$4,'decided',$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (experiment_id) DO NOTHING`,
      [newId(), tenantId, propertyId, experimentId, JSON.stringify(decision), JSON.stringify(countsForSnapshot(ev.outcome.arms)),
        analysis ? JSON.stringify(analysis) : null, JSON.stringify({ evaluable: view.srm.evaluable, mismatch: view.srm.mismatch }),
        ev.from, ev.to, note, userId],
    );
    if (ins.rowCount === 0) changed = false; // a concurrent decide won
    const u = await c.query<Row>(
      `UPDATE search_experiments SET status = 'decided', updated_at = now() WHERE id = $1 AND property_id = $2 AND status = 'stopped' RETURNING ${COLS}`,
      [experimentId, propertyId],
    );
    return u.rows[0] ?? null;
  }, SEARCH);
  const dto = updated ? toDto(updated) : (await getExperiment(tenantId, propertyId, experimentId))!;
  return { experiment: dto, results: (await readResults(tenantId, propertyId, experimentId)) as ExperimentResults, replayed: !changed };
}

export type AbortOutcome = "no_property" | "not_found" | { experiment: ExperimentDto; replayed: boolean };

/** Abort at any time before the decision. Records that the test ended, and nothing about an outcome (none is computed). */
export async function abortExperiment(tenantId: string, propertyId: string, experimentId: string, userId: string | null): Promise<AbortOutcome> {
  const l = await loadRow(tenantId, propertyId, experimentId);
  if (!l) return (await withTenants([tenantId], (c) => loadProperty(c, propertyId), SEARCH)) ? "not_found" : "no_property";
  const r = l.row;
  if (r.status === "aborted") return { experiment: toDto(r), replayed: true };
  if (r.status === "decided") throw new ExperimentRefusal(409, "already_decided", "already_decided: a decided test cannot be aborted");
  const out = await withTenants([tenantId], async (c) => {
    const u = await c.query<Row>(
      `UPDATE search_experiments SET status = 'aborted', stopped_at = COALESCE(stopped_at, GREATEST(now(), COALESCE(started_at, now()))), updated_at = now()
        WHERE id = $1 AND property_id = $2 AND status IN ('draft','running','stopped') RETURNING ${COLS}`,
      [experimentId, propertyId],
    );
    if (!u.rows[0]) return null;
    await c.query(
      `INSERT INTO search_experiment_results (id, tenant_id, property_id, experiment_id, outcome, decided_by)
       VALUES ($1,$2,$3,$4,'aborted',$5) ON CONFLICT (experiment_id) DO NOTHING`,
      [newId(), tenantId, propertyId, experimentId, userId],
    );
    return u.rows[0];
  }, SEARCH);
  if (!out) {
    const again = await getExperiment(tenantId, propertyId, experimentId);
    if (again?.status === "aborted") return { experiment: again, replayed: true };
    throw new ExperimentRefusal(409, "already_decided", "already_decided: the test was decided while aborting");
  }
  return { experiment: toDto(out), replayed: false };
}
