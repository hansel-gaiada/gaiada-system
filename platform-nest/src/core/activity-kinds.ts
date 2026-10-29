// DW-4h-1 (docs/FRONTEND-BFF-CONTRACT.md §44.2) — the activity series' KINDS and the audit-log BRIDGE catalogue.
//
// PURE: no I/O, no clock, no config. Everything here is a table or a function of its arguments, so the catalogue is
// pinned by a golden-table test (activity-kinds.test.ts) and a parity test against the `work_activity.source` CHECK.
//
// Two things live here, and they are deliberately one table:
//   1. ACTIVITY_BRIDGE — which audit rows (`activities`: entity + verb [+ a metadata predicate]) become a
//      `work_activity` row, and as what (source, objectKind, verb, kind). `core/activity-bridge.ts` reads it.
//   2. kindOf(source, objectKind, verb) — the inverse: which KIND a `work_activity` row counts as. The series and the
//      day read group by (source, object_kind, verb) in SQL and map through this, so the series can never disagree with
//      the catalogue about what a row is. It covers the rows the bridge writes AND the rows the PM outbox consumer and
//      the GitHub webhook already write.
//
// WHAT IS NEVER HERE: any `pm_*` entity (the outbox consumer owns PM; a bridged row would double it), and any text field
// that can hold a comment, message or note. A title is the object's own name (`titleFrom`) or a fixed phrase.

/** The sources `work_activity.source` accepts (mirror of the CHECK in migration 202610151300). */
export const ACTIVITY_SOURCES = [
  "pm", "pipeline", "github", "google_drive", "claude", "manual", "system",
  "webdesk", "social", "seo", "creatives", "finance", "hr", "learning", "time", "checkins",
] as const;

/** The sources only the audit-log bridge writes (DW-4h). Their rows are PERSON-GRAIN (who logged time, submitted a check-in,
 *  decided a leave request), so they are read only through the gated series and day reads (BFF §44.3-44.5, DW-D19, DW-D29),
 *  never through the member-level `GET /work-activity` feed. */
export const BRIDGED_SOURCES: readonly string[] = ["webdesk", "social", "seo", "creatives", "finance", "hr", "learning", "time", "checkins"];

export interface ActivityKind {
  key: string;
  label: string;
  source: string;
}

/** §44.2's kinds, in the order the series lists them. */
export const ACTIVITY_KINDS: readonly ActivityKind[] = [
  { key: "pm.tasks_completed", label: "Tasks completed", source: "pm" },
  { key: "pm.comments", label: "Comments", source: "pm" },
  { key: "pm.docs", label: "Notes and docs", source: "pm" },
  { key: "github.commits", label: "Commits", source: "github" },
  { key: "github.pull_requests", label: "Pull requests", source: "github" },
  { key: "webdesk.edits", label: "Site edits", source: "webdesk" },
  { key: "webdesk.publishes", label: "Publishes", source: "webdesk" },
  { key: "social.posts", label: "Posts scheduled or sent", source: "social" },
  { key: "seo.audits", label: "Audits", source: "seo" },
  { key: "seo.briefs", label: "Content briefs", source: "seo" },
  { key: "seo.reports", label: "Client reports", source: "seo" },
  { key: "creatives.versions", label: "Asset versions", source: "creatives" },
  { key: "creatives.reviews", label: "Review decisions", source: "creatives" },
  { key: "finance.journals", label: "Journals posted", source: "finance" },
  { key: "hr.leave_decided", label: "Leave decided", source: "hr" },
  { key: "meetings.recorded", label: "Meetings recorded", source: "system" },
  { key: "learning.completed", label: "Learning completed", source: "learning" },
  { key: "time.logged", label: "Time logged", source: "time" },
  { key: "checkins.submitted", label: "Check-ins", source: "checkins" },
];

/**
 * Which tenant-enabled module(s) a source belongs to, for the series' `kinds` list ("only the kinds of modules the tenant
 * has enabled", §44.3). The keys are `ModuleContract.key`s from `src/modules/registry.ts`. `null` = CORE: the source is
 * always on (GitHub, creatives, meetings (the `system` source: the outbox consumer's meeting_recording rows) and time entries are core controllers with no `ModuleEnabledGuard`). An array is
 * ANY-OF: finance's one bridged payment row is written by the invoice/payments code.
 */
export const SOURCE_MODULES: Readonly<Record<string, readonly string[] | null>> = {
  pm: ["pm"],
  github: null,
  webdesk: ["webdev"],
  social: ["social"],
  seo: ["search"],
  creatives: null,
  finance: ["finance", "invoice"],
  hr: ["hr"],
  system: null,
  learning: ["lms"],
  time: null,
  checkins: ["reports"],
};

/** Is `source` shown for a tenant whose effective enabled module keys are `enabled`? */
export function sourceEnabled(source: string, enabled: ReadonlySet<string>): boolean {
  const mods = SOURCE_MODULES[source];
  if (mods === undefined) return false; // a source with no mapping is never listed
  if (mods === null) return true;
  return mods.some((m) => enabled.has(m));
}

// ─────────────────────────────────────────── the bridge catalogue ───────────────────────────────────────────

type Meta = Record<string, unknown>;

/** Where a row's `occurredAt` comes from when it is NOT "when the action happened". */
export type OccurredAtFrom =
  /** The time entry's own `entry_date` (read from `time_entries`), at noon in REPORTS_TZ. */
  | "time_entry_date"
  /** `metadata.date` (a YYYY-MM-DD), at noon in REPORTS_TZ: the check-in's own day. */
  | "metadata_date";

export interface BridgeEntry {
  /** The audit row's `target_entity_type`. */
  entity: string;
  /** The audit row's `verb`. */
  auditVerb: string;
  /** Extra predicate over the audit row's metadata; omitted = always. */
  when?: (metadata: Meta) => boolean;
  /** The `work_activity` row it becomes. `objectKind` is never `doc`, `file` or `deliverable` (the deliverable_evidence view reads those). */
  source: string;
  objectKind: string;
  verb: string;
  kind: string;
  /** The metadata key holding the OBJECT'S OWN NAME (never a comment, message or note). */
  titleFrom?: string;
  /** Fixed title when the metadata carries no name. */
  title: string;
  occurredAtFrom?: OccurredAtFrom;
  /** `entity` = one work_activity row per audited ENTITY (not per audit row): a re-submitted check-in is still one check-in. */
  dedupe?: "entity";
}

/** A WebDesk command row is the one that carries the outcome; the ATTEMPT row is not work. A replay is the same work again. */
export function outcomeLanded(m: Meta): boolean {
  return (m.outcome === "succeeded" || m.outcome === "reconciled") && m.replayed !== true;
}

const edit = (auditVerb: string, verb: string): BridgeEntry => ({
  entity: "webdesk_content_item", auditVerb, when: outcomeLanded,
  source: "webdesk", objectKind: "webdesk_content_item", verb, kind: "webdesk.edits", title: "Site edit",
});
const publish = (auditVerb: string, verb: string, title: string): BridgeEntry => ({
  entity: "automation_approval", auditVerb, when: outcomeLanded,
  source: "webdesk", objectKind: "webdesk_publish", verb, kind: "webdesk.publishes", title,
});

/**
 * THE CATALOGUE. Every pair below was checked against a real `writeActivity` call (see "As built" in BFF §44.3a), except the
 * three §44.6 emitters, which 4h-2 adds (their entries are here so 4h-2 only adds the call sites).
 */
export const ACTIVITY_BRIDGE: readonly BridgeEntry[] = [
  // webdesk.edits: a person's content write that landed (the WebDesk command ledger's result row).
  edit("webdesk.content.create", "created"),
  edit("webdesk.content.update", "updated"),
  edit("webdesk.content.restoreVersion", "restored"),
  // webdesk.publishes: the approval a person decided that PUBLISHED, SCHEDULED, BUILT or PROMOTED a site (actor = the decider).
  publish("webdesk.content.publish", "published", "Publish"),
  publish("webdesk.content.schedule", "scheduled", "Scheduled publish"),
  publish("webdesk.content.rebuild", "rebuilt", "Site build"),
  publish("webdesk.site.promote", "promoted", "Promotion to production"),
  { entity: "webdev_provisioned_site", auditVerb: "provisioned", source: "webdesk", objectKind: "webdev_provisioned_site", verb: "provisioned", kind: "webdesk.publishes", titleFrom: "slug", title: "Site provisioned" },

  { entity: "social_post", auditVerb: "created", source: "social", objectKind: "social_post", verb: "created", kind: "social.posts", titleFrom: "title", title: "Post scheduled" },
  // SCP-1b (BFF §63.12, last paragraph): a pipeline post is created as a plan (its activity verb is `create`, which is not
  // bridged), so it counts when it is scheduled, by hand or through the publisher. `dispatched` stays as it is.
  { entity: "social_post", auditVerb: "schedule", source: "social", objectKind: "social_post", verb: "scheduled", kind: "social.posts", title: "Post scheduled" },
  { entity: "social_post", auditVerb: "schedule_publisher", source: "social", objectKind: "social_post", verb: "scheduled", kind: "social.posts", title: "Post scheduled" },
  { entity: "social_post_variant", auditVerb: "dispatched", source: "social", objectKind: "social_post_variant", verb: "dispatched", kind: "social.posts", title: "Post sent" },

  { entity: "search_audit", auditVerb: "ingested", source: "seo", objectKind: "search_audit", verb: "ingested", kind: "seo.audits", title: "Audit" },
  { entity: "search_content_brief", auditVerb: "drafted", source: "seo", objectKind: "search_content_brief", verb: "drafted", kind: "seo.briefs", titleFrom: "topic", title: "Content brief" },
  { entity: "search_content_brief", auditVerb: "polished", source: "seo", objectKind: "search_content_brief", verb: "polished", kind: "seo.briefs", title: "Content brief" },
  { entity: "search_report", auditVerb: "drafted", source: "seo", objectKind: "search_report", verb: "drafted", kind: "seo.reports", title: "Client report" },
  { entity: "search_report", auditVerb: "delivered", source: "seo", objectKind: "search_report", verb: "delivered", kind: "seo.reports", title: "Client report" },

  { entity: "creative_asset", auditVerb: "graded", source: "creatives", objectKind: "creative_asset", verb: "graded", kind: "creatives.versions", titleFrom: "name", title: "Asset version" },
  { entity: "creative_asset", auditVerb: "review_approved", source: "creatives", objectKind: "creative_asset", verb: "review_approved", kind: "creatives.reviews", title: "Review decision" },
  { entity: "creative_asset", auditVerb: "review_changes_requested", source: "creatives", objectKind: "creative_asset", verb: "review_changes_requested", kind: "creatives.reviews", title: "Review decision" },

  // 4h-2 adds the audit call (BFF §44.6); the entry is here so the bridge turns it into a row the day it lands.
  { entity: "finance_journal", auditVerb: "posted", source: "finance", objectKind: "finance_journal", verb: "posted", kind: "finance.journals", title: "Journal posted" },
  { entity: "hr_leave_request", auditVerb: "decided", source: "hr", objectKind: "hr_leave_request", verb: "decided", kind: "hr.leave_decided", title: "Leave decided" },
  { entity: "lms_completion", auditVerb: "completed", source: "learning", objectKind: "lms_completion", verb: "completed", kind: "learning.completed", title: "Course completed" },


  { entity: "time_entry", auditVerb: "logged", source: "time", objectKind: "time_entry", verb: "logged", kind: "time.logged", title: "Time logged", occurredAtFrom: "time_entry_date" },
  { entity: "report_checkin", auditVerb: "submitted", source: "checkins", objectKind: "report_checkin", verb: "submitted", kind: "checkins.submitted", title: "Check-in", occurredAtFrom: "metadata_date", dedupe: "entity" },
];

const bridgeKey = (entity: string, auditVerb: string): string => `${entity}|${auditVerb}`;

/** (entity|verb) -> its entries. A Map lookup on one short string: the hot-path cost of `writeActivity` when nothing matches. */
const BRIDGE_INDEX: ReadonlyMap<string, readonly BridgeEntry[]> = (() => {
  const m = new Map<string, BridgeEntry[]>();
  for (const e of ACTIVITY_BRIDGE) {
    const k = bridgeKey(e.entity, e.auditVerb);
    const list = m.get(k);
    if (list) list.push(e);
    else m.set(k, [e]);
  }
  return m;
})();

/** The catalogue entry for one audit row, or null. Never matches a `pm_*` entity (the outbox consumer owns PM). */
export function bridgeEntryFor(entity: string, auditVerb: string, metadata: Meta): BridgeEntry | null {
  if (entity.startsWith("pm_")) return null;
  const list = BRIDGE_INDEX.get(bridgeKey(entity, auditVerb));
  if (!list) return null;
  for (const e of list) {
    if (!e.when || e.when(metadata)) return e;
  }
  return null;
}

/** The title for a bridged row: the object's own name when the metadata carries a usable one, else the fixed phrase. */
export function bridgeTitle(entry: BridgeEntry, metadata: Meta): string {
  if (entry.titleFrom) {
    const v = metadata[entry.titleFrom];
    if (typeof v === "string") {
      const t = v.trim().replace(/\s+/g, " ").slice(0, 200);
      if (t) return t;
    }
  }
  return entry.title;
}

// ─────────────────────────────────────────── kindOf: row -> kind ───────────────────────────────────────────

export interface KindMatcher {
  source: string;
  objectKind: string;
  verb: string;
  kind: string;
}

/** The rows other writers already produce (the PM outbox consumer and the GitHub webhook), from their real verbs. */
const EXISTING_ROWS: readonly KindMatcher[] = [
  { source: "pm", objectKind: "pm_task", verb: "completed", kind: "pm.tasks_completed" },
  { source: "pm", objectKind: "pm_task", verb: "commented", kind: "pm.comments" },
  { source: "pm", objectKind: "doc", verb: "created", kind: "pm.docs" },
  { source: "pm", objectKind: "doc", verb: "updated", kind: "pm.docs" },
  { source: "pm", objectKind: "doc", verb: "restored", kind: "pm.docs" },
  // A person starting a recording: the consumer's `meeting.recording.created` row (it carries the actor). The recording's other
  // events (transcribed, ingested, scheduled, updated...) are the same recording and are not counted again. Not bridged from the
  // audit log: the consumer already writes this row, and a second row would double the nightly activity_events.
  { source: "system", objectKind: "meeting_recording", verb: "created", kind: "meetings.recorded" },
  { source: "github", objectKind: "commit", verb: "committed", kind: "github.commits" },
  { source: "github", objectKind: "pull_request", verb: "opened", kind: "github.pull_requests" },
  { source: "github", objectKind: "pull_request", verb: "merged", kind: "github.pull_requests" },
];

/** Every (source, objectKind, verb) -> kind the series counts. */
export const KIND_MATCHERS: readonly KindMatcher[] = (() => {
  const seen = new Set<string>();
  const out: KindMatcher[] = [];
  const add = (m: KindMatcher): void => {
    const k = `${m.source}|${m.objectKind}|${m.verb}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(m);
  };
  for (const m of EXISTING_ROWS) add(m);
  for (const e of ACTIVITY_BRIDGE) add({ source: e.source, objectKind: e.objectKind, verb: e.verb, kind: e.kind });
  return out;
})();

const KIND_INDEX: ReadonlyMap<string, string> = new Map(KIND_MATCHERS.map((m) => [`${m.source}|${m.objectKind}|${m.verb}`, m.kind]));
const KIND_BY_KEY: ReadonlyMap<string, ActivityKind> = new Map(ACTIVITY_KINDS.map((k) => [k.key, k]));

/** The kind a `work_activity` row counts as, or null when it is not counted by the series. */
export function kindOf(source: string, objectKind: string, verb: string): string | null {
  return KIND_INDEX.get(`${source}|${objectKind}|${verb}`) ?? null;
}

export function kindByKey(key: string): ActivityKind | undefined {
  return KIND_BY_KEY.get(key);
}

// ─────────────────────────────────────────── occurredAt rules ───────────────────────────────────────────

/** Offset (ms, local minus UTC) of `tz` at the instant `ts`. */
function tzOffsetMs(ts: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ts));
  const n = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - ts;
}

/**
 * The instant (ISO, UTC) of `hour:minute` local time on `date` (YYYY-MM-DD) in `tz`. Null for a bad date, hour or minute. A zone `Intl` does not
 * know throws a RangeError (the caller validates the zone first).
 * `noonInTz` and the Social sheet import (BFF §63.23, `scheduledAt`) both go through it.
 */
export function instantInTz(date: string, hour: number, minute: number, tz: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d, hour, minute));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  const guess = probe.getTime();
  const first = guess - tzOffsetMs(guess, tz);
  const second = guess - tzOffsetMs(first, tz);
  return new Date(second).toISOString();
}

/**
 * The instant (ISO, UTC) of 12:00 local time on `date` (YYYY-MM-DD) in `tz`. Noon, so the work counts on its own calendar
 * day in `REPORTS_TZ` whatever the zone's offset (and a DST shift never moves noon across midnight). Null for a bad date.
 */
export function noonInTz(date: string, tz: string): string | null {
  return instantInTz(date, 12, 0, tz);
}

// ─────────────────────────────────────────── links ───────────────────────────────────────────

/** The object's own page when the ERP has one that needs only the object's id (BFF §44.4); else absent. */
export function linkFor(objectKind: string, objectRef: string): string | undefined {
  if (!/^[0-9a-f-]{36}$/i.test(objectRef)) return undefined;
  switch (objectKind) {
    case "pm_task": return `/tasks/${objectRef}`;
    case "meeting_recording": return `/meetings/${objectRef}`;
    case "finance_journal": return `/finance/journals/${objectRef}`;
    default: return undefined;
  }
}
