// DW-4h-1 (BFF §44.2) — the PURE half: the kinds, the bridge catalogue (a golden table pins EVERY entry), the parity between
// the kinds, the TS source list and the `work_activity.source` CHECK, kindOf() for the PM and GitHub rows, and the occurredAt
// rules. No database, no clock. "Changing the catalogue is a code change with a test": this is the test.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACTIVITY_BRIDGE,
  ACTIVITY_KINDS,
  ACTIVITY_SOURCES,
  KIND_MATCHERS,
  SOURCE_MODULES,
  bridgeEntryFor,
  bridgeTitle,
  kindOf,
  linkFor,
  noonInTz,
  outcomeLanded,
  sourceEnabled,
} from "./activity-kinds";
import { WORK_ACTIVITY_SOURCES } from "./work-activity-ingest.service";

/** entity | audit verb [| predicate] -> source | objectKind | verb | kind. One line per catalogue entry. */
const GOLDEN: string[] = [
  "webdesk_content_item|webdesk.content.create|landed -> webdesk|webdesk_content_item|created|webdesk.edits",
  "webdesk_content_item|webdesk.content.update|landed -> webdesk|webdesk_content_item|updated|webdesk.edits",
  "webdesk_content_item|webdesk.content.restoreVersion|landed -> webdesk|webdesk_content_item|restored|webdesk.edits",
  "automation_approval|webdesk.content.publish|landed -> webdesk|webdesk_publish|published|webdesk.publishes",
  "automation_approval|webdesk.content.schedule|landed -> webdesk|webdesk_publish|scheduled|webdesk.publishes",
  "automation_approval|webdesk.content.rebuild|landed -> webdesk|webdesk_publish|rebuilt|webdesk.publishes",
  "automation_approval|webdesk.site.promote|landed -> webdesk|webdesk_publish|promoted|webdesk.publishes",
  "webdev_provisioned_site|provisioned -> webdesk|webdev_provisioned_site|provisioned|webdesk.publishes",
  "social_post|created -> social|social_post|created|social.posts",
  "social_post_variant|dispatched -> social|social_post_variant|dispatched|social.posts",
  "search_audit|ingested -> seo|search_audit|ingested|seo.audits",
  "search_content_brief|drafted -> seo|search_content_brief|drafted|seo.briefs",
  "search_content_brief|polished -> seo|search_content_brief|polished|seo.briefs",
  "search_report|drafted -> seo|search_report|drafted|seo.reports",
  "search_report|delivered -> seo|search_report|delivered|seo.reports",
  "creative_asset|graded -> creatives|creative_asset|graded|creatives.versions",
  "creative_asset|review_approved -> creatives|creative_asset|review_approved|creatives.reviews",
  "creative_asset|review_changes_requested -> creatives|creative_asset|review_changes_requested|creatives.reviews",
  "finance_journal|posted -> finance|finance_journal|posted|finance.journals",
  "invoice_payment|confirmed -> finance|invoice_payment|confirmed|finance.payments",
  "hr_leave_request|decided -> hr|hr_leave_request|decided|hr.leave_decided",
  "lms_completion|completed -> learning|lms_completion|completed|learning.completed",
  "meeting_recording|ingested -> meetings|meeting_recording|ingested|meetings.recorded",
  "meeting_recording|shared_minutes -> meetings|meeting_recording|shared_minutes|meetings.recorded",
  "time_entry|logged -> time|time_entry|logged|time.logged",
  "report_checkin|submitted -> checkins|report_checkin|submitted|checkins.submitted",
];

const line = (e: (typeof ACTIVITY_BRIDGE)[number]): string =>
  `${e.entity}|${e.auditVerb}${e.when ? "|landed" : ""} -> ${e.source}|${e.objectKind}|${e.verb}|${e.kind}`;

describe("the catalogue (BFF §44.2)", () => {
  it("golden table: every entry, in order, and nothing else", () => {
    expect(ACTIVITY_BRIDGE.map(line)).toEqual(GOLDEN);
  });

  it("the kinds are exactly §44.2's twenty, with their sources", () => {
    expect(ACTIVITY_KINDS.map((k) => `${k.key}|${k.label}|${k.source}`)).toEqual([
      "pm.tasks_completed|Tasks completed|pm",
      "pm.comments|Comments|pm",
      "pm.docs|Notes and docs|pm",
      "github.commits|Commits|github",
      "github.pull_requests|Pull requests|github",
      "webdesk.edits|Site edits|webdesk",
      "webdesk.publishes|Publishes|webdesk",
      "social.posts|Posts scheduled or sent|social",
      "seo.audits|Audits|seo",
      "seo.briefs|Content briefs|seo",
      "seo.reports|Client reports|seo",
      "creatives.versions|Asset versions|creatives",
      "creatives.reviews|Review decisions|creatives",
      "finance.journals|Journals posted|finance",
      "finance.payments|Payments confirmed|finance",
      "hr.leave_decided|Leave decided|hr",
      "meetings.recorded|Meetings recorded|meetings",
      "learning.completed|Learning completed|learning",
      "time.logged|Time logged|time",
      "checkins.submitted|Check-ins|checkins",
    ]);
    expect(new Set(ACTIVITY_KINDS.map((k) => k.key)).size).toBe(ACTIVITY_KINDS.length);
  });

  it("every entry points at a real kind of the same source, and every bridged kind has an entry", () => {
    const byKey = new Map(ACTIVITY_KINDS.map((k) => [k.key, k]));
    for (const e of ACTIVITY_BRIDGE) {
      const kind = byKey.get(e.kind);
      expect(kind, `${e.entity}/${e.auditVerb} -> ${e.kind}`).toBeDefined();
      expect(kind!.source).toBe(e.source);
    }
    const bridgedKinds = new Set(ACTIVITY_BRIDGE.map((e) => e.kind));
    for (const k of ACTIVITY_KINDS.filter((x) => x.source !== "pm" && x.source !== "github")) expect(bridgedKinds.has(k.key), k.key).toBe(true);
  });

  it("no pm_* entity is ever bridged (the outbox consumer owns PM), and a pm_* pair never matches", () => {
    expect(ACTIVITY_BRIDGE.filter((e) => e.entity.startsWith("pm_"))).toEqual([]);
    for (const [entity, verb] of [["pm_task", "completed"], ["pm_task", "commented"], ["pm_doc", "created"], ["pm_doc", "updated"], ["pm_project", "created"]]) {
      expect(bridgeEntryFor(entity, verb, {})).toBeNull();
    }
  });

  it("no entry writes an object kind the deliverable_evidence view reads (doc, file, deliverable)", () => {
    for (const e of ACTIVITY_BRIDGE) expect(["doc", "file", "deliverable"]).not.toContain(e.objectKind);
  });

  it("no title can come from a free-text field (comment, message, note, body, text, content)", () => {
    for (const e of ACTIVITY_BRIDGE) {
      if (e.titleFrom) expect(e.titleFrom).not.toMatch(/comment|message|note|body|text|content|summary|blockers/i);
    }
    const social = ACTIVITY_BRIDGE.find((e) => e.entity === "social_post")!;
    expect(bridgeTitle(social, { title: "Spring launch", body: "SECRET" })).toBe("Spring launch");
    expect(bridgeTitle(social, { body: "SECRET" })).toBe("Post scheduled");
    expect(bridgeTitle(social, { title: "   " })).toBe("Post scheduled");
    const time = ACTIVITY_BRIDGE.find((e) => e.entity === "time_entry")!;
    expect(bridgeTitle(time, { notes: "SECRET", title: "SECRET" })).toBe("Time logged");
  });

  it("the (source, objectKind, verb) -> kind map has no ambiguity: no two kinds share a row shape", () => {
    const seen = new Map<string, string>();
    for (const m of KIND_MATCHERS) {
      const k = `${m.source}|${m.objectKind}|${m.verb}`;
      expect(seen.has(k), `${k} is claimed twice`).toBe(false);
      seen.set(k, m.kind);
    }
    // and every bridge entry resolves to its own kind
    for (const e of ACTIVITY_BRIDGE) expect(kindOf(e.source, e.objectKind, e.verb)).toBe(e.kind);
  });
});

describe("parity: kinds, the TS source list and the work_activity.source CHECK", () => {
  const migration = readFileSync(join(__dirname, "..", "..", "migrations", "202610151300_work_activity_module_sources.sql"), "utf8");
  const checkBlock = /CHECK \(source IN \(([\s\S]*?)\)\)/.exec(migration);
  const inCheck = (checkBlock?.[1].match(/'([a-z_]+)'/g) ?? []).map((s) => s.replace(/'/g, ""));

  it("the migration declares the full list, and WORK_ACTIVITY_SOURCES and ACTIVITY_SOURCES match it exactly", () => {
    expect(inCheck.length).toBeGreaterThan(0);
    expect([...WORK_ACTIVITY_SOURCES].sort()).toEqual([...inCheck].sort());
    expect([...ACTIVITY_SOURCES].sort()).toEqual([...inCheck].sort());
  });

  it("every kind's source, and every bridge entry's source, is in the CHECK", () => {
    for (const k of ACTIVITY_KINDS) expect(inCheck, k.key).toContain(k.source);
    for (const e of ACTIVITY_BRIDGE) expect(inCheck, `${e.entity}/${e.auditVerb}`).toContain(e.source);
  });

  it("the original seven sources survived the re-declaration", () => {
    for (const s of ["pm", "pipeline", "github", "google_drive", "claude", "manual", "system"]) expect(inCheck).toContain(s);
  });

  it("every kind's source has a module mapping (null = core)", () => {
    for (const k of ACTIVITY_KINDS) expect(k.source in SOURCE_MODULES, k.source).toBe(true);
  });
});

describe("kindOf: the existing PM and GitHub rows, from their real verbs and object kinds", () => {
  it.each([
    ["pm", "pm_task", "completed", "pm.tasks_completed"],
    ["pm", "pm_task", "commented", "pm.comments"],
    ["pm", "doc", "created", "pm.docs"],
    ["pm", "doc", "updated", "pm.docs"],
    ["pm", "doc", "restored", "pm.docs"],
    ["github", "commit", "committed", "github.commits"],
    ["github", "pull_request", "opened", "github.pull_requests"],
    ["github", "pull_request", "merged", "github.pull_requests"],
  ])("%s/%s/%s -> %s", (source, objectKind, verb, kind) => {
    expect(kindOf(source, objectKind, verb)).toBe(kind);
  });

  it.each([
    ["pm", "pm_task", "updated"],
    ["pm", "pm_task", "created"],
    ["pm", "pm_task", "reopened"],
    ["pm", "project", "created"],
    ["github", "pull_request", "closed"],
    ["github", "workflow_run", "ci_run"],
    ["system", "meeting_recording", "ingested"],
    ["pipeline", "pipeline_run", "created"],
    // a bridge verb under the wrong source is not a kind
    ["pm", "social_post", "created"],
  ])("%s/%s/%s is not counted", (source, objectKind, verb) => {
    expect(kindOf(source, objectKind, verb)).toBeNull();
  });
});

describe("bridge predicates (BFF §44.1: outcomes, not attempts)", () => {
  it("a WebDesk command row matches only a landed outcome", () => {
    const find = (m: Record<string, unknown>) => bridgeEntryFor("webdesk_content_item", "webdesk.content.update", m);
    expect(find({ outcome: "attempted" })).toBeNull();
    expect(find({ outcome: "failed" })).toBeNull();
    expect(find({ outcome: "refused" })).toBeNull();
    expect(find({ outcome: "ambiguous" })).toBeNull();
    expect(find({})).toBeNull();
    expect(find({ outcome: "succeeded" })?.kind).toBe("webdesk.edits");
    expect(find({ outcome: "reconciled" })?.kind).toBe("webdesk.edits");
    // a replay is the same work again
    expect(find({ outcome: "succeeded", replayed: true })).toBeNull();
    expect(outcomeLanded({ outcome: "succeeded" })).toBe(true);
  });

  it("an approval executed by a person is a publish only for publish, schedule, rebuild and promote", () => {
    const m = { outcome: "succeeded" };
    for (const v of ["webdesk.content.publish", "webdesk.content.schedule", "webdesk.content.rebuild", "webdesk.site.promote"]) {
      expect(bridgeEntryFor("automation_approval", v, m)?.kind, v).toBe("webdesk.publishes");
      expect(bridgeEntryFor("automation_approval", v, { outcome: "attempted" }), v).toBeNull();
    }
    // key minting, archiving and a domain change are administration, not a publish
    for (const v of ["webdesk.key.mint", "webdesk.site.archive", "webdesk.site.setDomain", "approved", "consumed", "suspended"]) {
      expect(bridgeEntryFor("automation_approval", v, m), v).toBeNull();
    }
  });

  it("an uncatalogued pair is null (the hot path: one Map lookup)", () => {
    expect(bridgeEntryFor("social_post", "updated", {})).toBeNull();
    expect(bridgeEntryFor("invoice", "issued", {})).toBeNull();
    expect(bridgeEntryFor("search_audit", "ingest_noop", {})).toBeNull();
    expect(bridgeEntryFor("report_checkin", "excused", {})).toBeNull();
  });
});

describe("occurredAt rules (BFF §44.2)", () => {
  it("noon of a date in REPORTS_TZ, as a UTC instant", () => {
    expect(noonInTz("2026-03-05", "UTC")).toBe("2026-03-05T12:00:00.000Z");
    expect(noonInTz("2026-03-05", "Asia/Makassar")).toBe("2026-03-05T04:00:00.000Z"); // UTC+8
    expect(noonInTz("2026-03-05", "Asia/Jakarta")).toBe("2026-03-05T05:00:00.000Z"); // UTC+7
    expect(noonInTz("2026-03-05", "America/Los_Angeles")).toBe("2026-03-05T20:00:00.000Z"); // PST, UTC-8
    expect(noonInTz("2026-07-05", "America/Los_Angeles")).toBe("2026-07-05T19:00:00.000Z"); // PDT, UTC-7
    expect(noonInTz("2026-03-05", "Pacific/Kiritimati")).toBe("2026-03-04T22:00:00.000Z"); // UTC+14
  });

  it("the noon instant falls on the SAME calendar day back in that zone, for every zone and the DST edges", () => {
    for (const tz of ["UTC", "Asia/Makassar", "America/Los_Angeles", "Pacific/Kiritimati", "Pacific/Pago_Pago", "Europe/London"]) {
      for (const date of ["2026-03-08", "2026-03-29", "2026-10-25", "2026-11-01", "2026-12-31"]) {
        const iso = noonInTz(date, tz)!;
        const back = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
        expect(back, `${tz} ${date}`).toBe(date);
      }
    }
  });

  it("a malformed or impossible date is null", () => {
    expect(noonInTz("not-a-date", "UTC")).toBeNull();
    expect(noonInTz("2026-02-30", "UTC")).toBeNull();
    expect(noonInTz("", "UTC")).toBeNull();
    expect(noonInTz("2026-13-01", "UTC")).toBeNull();
  });

  it("time.logged reads the entry's date; checkins.submitted reads the check-in's date and is one row per check-in", () => {
    const time = ACTIVITY_BRIDGE.find((e) => e.entity === "time_entry")!;
    const checkin = ACTIVITY_BRIDGE.find((e) => e.entity === "report_checkin")!;
    expect(time.occurredAtFrom).toBe("time_entry_date");
    expect(checkin.occurredAtFrom).toBe("metadata_date");
    expect(checkin.dedupe).toBe("entity");
    // every other entry counts on when the action happened
    for (const e of ACTIVITY_BRIDGE) if (e !== time && e !== checkin) expect(e.occurredAtFrom, e.entity).toBeUndefined();
  });
});

describe("source -> module (the series lists only the kinds of enabled modules)", () => {
  it("core sources are always on; a module source needs its module; finance is any-of finance or invoice", () => {
    const none = new Set<string>();
    for (const core of ["github", "creatives", "meetings", "time"]) expect(sourceEnabled(core, none), core).toBe(true);
    expect(sourceEnabled("pm", none)).toBe(false);
    expect(sourceEnabled("pm", new Set(["pm"]))).toBe(true);
    expect(sourceEnabled("webdesk", new Set(["webdev"]))).toBe(true);
    expect(sourceEnabled("seo", new Set(["search"]))).toBe(true);
    expect(sourceEnabled("learning", new Set(["lms"]))).toBe(true);
    expect(sourceEnabled("checkins", new Set(["reports"]))).toBe(true);
    expect(sourceEnabled("finance", new Set(["invoice"]))).toBe(true);
    expect(sourceEnabled("finance", new Set(["finance"]))).toBe(true);
    expect(sourceEnabled("finance", new Set(["pm"]))).toBe(false);
    expect(sourceEnabled("no-such-source", new Set(["pm"]))).toBe(false);
  });
});

describe("links: only to pages that exist, built from the object id alone", () => {
  const id = "0197d0f0-0000-7000-8000-000000000001";
  it("pm tasks, meetings and finance journals link; everything else has no link", () => {
    expect(linkFor("pm_task", id)).toBe(`/tasks/${id}`);
    expect(linkFor("meeting_recording", id)).toBe(`/meetings/${id}`);
    expect(linkFor("finance_journal", id)).toBe(`/finance/journals/${id}`);
    expect(linkFor("social_post", id)).toBeUndefined();
    expect(linkFor("commit", "a".repeat(40))).toBeUndefined();
    expect(linkFor("pm_task", "not-a-uuid")).toBeUndefined();
  });
});
