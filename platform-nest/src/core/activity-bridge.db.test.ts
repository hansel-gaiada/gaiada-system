// DW-4h-1 (BFF §44.1, §44.7) against live Postgres + RLS: `writeActivity`'s audit-log bridge into `work_activity`, and the
// history backfill. A catalogued action creates exactly one row (source, kind in the payload, actor, occurredAt); an
// uncatalogued pair, a pm_* pair, a null actor and a WebDesk attempt row create none; a bridge failure never fails the action;
// the backfill, run twice, adds rows once.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { config } from "../config";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createProject } from "../testing/fixtures";
import { newId, withTenants } from "../db";
import { writeActivity } from "./http";
import { bridgeActivity } from "./activity-bridge";
import { runBridgeBackfill, defaultSince, parseArgs, formatReport } from "./work-activity-backfill-bridge";

interface WaRow {
  source: string;
  source_ref: string;
  actor_user_id: string | null;
  verb: string;
  object_kind: string;
  object_ref: string;
  title: string | null;
  payload: Record<string, unknown>;
  occurred_at: Date;
}

describe.skipIf(!TEST_URL)("the audit-log bridge into work_activity (DW-4h-1)", () => {
  let co: string;
  let other: string;
  let alice: string;
  let bob: string;
  let savedTz: string;

  const rowsFor = async (tenantId: string, where = "TRUE", args: unknown[] = []): Promise<WaRow[]> =>
    (await adminPool().query<WaRow>(
      `SELECT source, source_ref, actor_user_id, verb, object_kind, object_ref, title, payload, occurred_at
         FROM work_activity WHERE tenant_id = $1 AND (${where}) ORDER BY created_at, id`,
      [tenantId, ...args],
    )).rows;
  const countAll = async (tenantId: string): Promise<number> =>
    (await adminPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM work_activity WHERE tenant_id = $1`, [tenantId])).rows[0].n;
  const auditExists = async (id: string): Promise<boolean> =>
    ((await adminPool().query(`SELECT 1 FROM activities WHERE id = $1`, [id])).rowCount ?? 0) > 0;

  beforeAll(async () => {
    await initTestDb();
    savedTz = config.reportsTz;
    config.reportsTz = "Asia/Makassar"; // UTC+8: a day boundary the UTC date does not share
    co = await createCompany("Bridge Co");
    other = await createCompany("Bridge Rival Co");
    alice = await createUser("alice@activity-bridge.test");
    bob = await createUser("bob@activity-bridge.test");
    await addMembership(co, alice);
    await addMembership(co, bob);
  });
  afterAll(async () => {
    config.reportsTz = savedTz;
    await teardownTestDb();
  });

  describe("the live bridge in writeActivity", () => {
    it("a catalogued action creates exactly ONE work_activity row: source, kind in the payload, actor, object, title", async () => {
      const postId = newId();
      const before = await countAll(co);
      const id = await writeActivity(co, alice, "created", "social_post", postId, { title: "Spring launch", source: "human", body: "NEVER COPIED" });
      expect(await auditExists(id)).toBe(true);
      expect(await countAll(co)).toBe(before + 1);
      const rows = await rowsFor(co, "source_ref = $2", [`act:${id}`]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        source: "social", actor_user_id: alice, verb: "created", object_kind: "social_post", object_ref: postId, title: "Spring launch",
      });
      // the payload is the kind and nothing else: no metadata, so no free text can reach the series
      expect(rows[0].payload).toEqual({ kind: "social.posts" });
      expect(JSON.stringify(rows[0])).not.toContain("NEVER COPIED");
    });

    it("a title the metadata does not carry falls back to the fixed phrase", async () => {
      const id = await writeActivity(co, alice, "dispatched", "social_post_variant", newId(), { network: "instagram" });
      const [row] = await rowsFor(co, "source_ref = $2", [`act:${id}`]);
      expect(row.title).toBe("Post sent");
      expect(row.payload).toEqual({ kind: "social.posts" });
    });

    it("an uncatalogued pair, a pm_* pair and a null actor create none (and the audit row still lands)", async () => {
      const before = await countAll(co);
      const a = await writeActivity(co, alice, "updated", "social_post", newId(), { fields: 2 }); // not catalogued
      const b = await writeActivity(co, alice, "completed", "pm_task", newId(), {}); // the outbox consumer owns PM
      const c = await writeActivity(co, alice, "commented", "pm_task", newId(), {});
      const d = await writeActivity(co, alice, "created", "pm_doc", newId(), {});
      const e = await writeActivity(co, null, "created", "social_post", newId(), { title: "Scheduled by a job" }); // a job, not a person
      for (const id of [a, b, c, d, e]) expect(await auditExists(id)).toBe(true);
      expect(await countAll(co)).toBe(before);
    });

    it("a WebDesk command writes an attempt row and a result row: only the landed outcome is one row of work", async () => {
      const item = newId();
      const meta = { command: "content.update", idempotencyKey: "k1", tenantSlug: "t", siteId: "s", itemId: item };
      const before = await countAll(co);
      const attempt = await writeActivity(co, alice, "webdesk.content.update", "webdesk_content_item", item, { ...meta, outcome: "attempted" });
      expect(await countAll(co)).toBe(before); // the attempt is evidence, not work
      const failed = await writeActivity(co, alice, "webdesk.content.update", "webdesk_content_item", newId(), { ...meta, outcome: "failed" });
      const refused = await writeActivity(co, alice, "webdesk.content.update", "webdesk_content_item", newId(), { ...meta, outcome: "refused" });
      const replay = await writeActivity(co, alice, "webdesk.content.update", "webdesk_content_item", newId(), { ...meta, outcome: "succeeded", replayed: true });
      expect(await countAll(co)).toBe(before);
      for (const id of [attempt, failed, refused, replay]) expect(await auditExists(id)).toBe(true);

      const result = await writeActivity(co, alice, "webdesk.content.update", "webdesk_content_item", item, { ...meta, outcome: "succeeded", status: 200 });
      expect(await countAll(co)).toBe(before + 1);
      const [row] = await rowsFor(co, "source_ref = $2", [`act:${result}`]);
      expect(row).toMatchObject({ source: "webdesk", verb: "updated", object_kind: "webdesk_content_item", object_ref: item, title: "Site edit", actor_user_id: alice });
      expect(row.payload).toEqual({ kind: "webdesk.edits" });

      const reconciled = await writeActivity(co, alice, "webdesk.content.create", "webdesk_content_item", null, { ...meta, outcome: "reconciled" });
      const [rec] = await rowsFor(co, "source_ref = $2", [`act:${reconciled}`]);
      expect(rec).toMatchObject({ source: "webdesk", verb: "created" });
      expect(rec.object_ref).toBe(reconciled); // no entity id on the audit row: the audit row's own id stands in
    });

    it("an approval the decider executed is a publish (the decider is the actor); the attempt row is not", async () => {
      const approval = newId();
      const base = { viaApproval: approval, tenantSlug: "t", siteId: "s", requestedBy: bob };
      const before = await countAll(co);
      await writeActivity(co, alice, "webdesk.content.publish", "automation_approval", approval, { ...base, outcome: "attempted" });
      await writeActivity(co, alice, "webdesk.key.mint", "automation_approval", approval, { ...base, outcome: "succeeded" });
      expect(await countAll(co)).toBe(before);
      const id = await writeActivity(co, alice, "webdesk.content.publish", "automation_approval", approval, { ...base, outcome: "succeeded", selfPublish: false });
      const [row] = await rowsFor(co, "source_ref = $2", [`act:${id}`]);
      expect(row).toMatchObject({ source: "webdesk", verb: "published", object_kind: "webdesk_publish", actor_user_id: alice, title: "Publish" });
      expect(row.payload).toEqual({ kind: "webdesk.publishes" });
    });

    it("time.logged counts on the entry's own day at noon in REPORTS_TZ, not the day it was typed", async () => {
      const project = await createProject(co, "Time project");
      const entry = newId();
      await withTenants([co], (c) =>
        c.query(
          `INSERT INTO time_entries (id, tenant_id, user_id, project_id, minutes, billable, entry_date, origin_site)
           VALUES ($1, $2, $3, $4, 45, false, '2026-03-05', 'central')`,
          [entry, co, alice, project],
        ),
      );
      const id = await writeActivity(co, alice, "logged", "time_entry", entry, { minutes: 45, billable: false });
      const [row] = await rowsFor(co, "source_ref = $2", [`act:${id}`]);
      expect(row).toMatchObject({ source: "time", verb: "logged", object_kind: "time_entry", object_ref: entry, title: "Time logged" });
      expect(row.occurred_at.toISOString()).toBe("2026-03-05T04:00:00.000Z"); // 12:00 in UTC+8
      // a time entry that is not there (or is gone) is not work: nothing is written, nothing throws
      const before = await countAll(co);
      await expect(writeActivity(co, alice, "logged", "time_entry", newId(), { minutes: 5 })).resolves.toEqual(expect.any(String));
      expect(await countAll(co)).toBe(before);
    });

    it("checkins.submitted counts on its checkin_date at noon in REPORTS_TZ, and a re-submit is still ONE row", async () => {
      const checkin = newId();
      const first = await writeActivity(co, alice, "submitted", "report_checkin", checkin, { date: "2026-03-06", edited: false, source: "ui" });
      const second = await writeActivity(co, alice, "submitted", "report_checkin", checkin, { date: "2026-03-06", edited: true, source: "ui" });
      expect(first).not.toBe(second);
      const rows = await rowsFor(co, "source = 'checkins' AND object_ref = $2", [checkin]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ verb: "submitted", object_kind: "report_checkin", actor_user_id: alice, title: "Check-in" });
      expect(rows[0].occurred_at.toISOString()).toBe("2026-03-06T04:00:00.000Z");
      expect(rows[0].payload).toEqual({ kind: "checkins.submitted" });
      // an excuse is a manager's act on someone else's day, not the person's check-in
      const before = await countAll(co);
      await writeActivity(co, bob, "excused", "report_checkin", newId(), { subjectUserId: alice, reason: "sick" });
      expect(await countAll(co)).toBe(before);
    });

    it("a forced bridge failure still returns the audit id and never throws", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const ghost = newId(); // not a users row: the work_activity FK refuses it, the audit row (no FK on actor_id) does not
        const before = await countAll(co);
        const postId = newId();
        let id = "";
        await expect((async () => { id = await writeActivity(co, ghost, "created", "social_post", postId, { title: "Never lands" }); })()).resolves.toBeUndefined();
        expect(id).toMatch(/^[0-9a-f-]{36}$/);
        expect(await auditExists(id)).toBe(true);
        expect(await countAll(co)).toBe(before);
        const logged = spy.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith("[ACTIVITY-BRIDGE]"));
        expect(logged).toHaveLength(1);
        expect(logged[0]).toContain("social_post/created");
        expect(logged[0]).not.toContain("Never lands"); // the pair and the error message only
      } finally {
        spy.mockRestore();
      }
    });

    it("the bridge is idempotent per audit row: the same audit row bridged twice is one work_activity row", async () => {
      const subject = {
        tenantId: co, activityId: newId(), actorId: alice, verb: "ingested", entityType: "search_audit", entityId: newId(), metadata: {},
        occurredAt: "2026-02-01T03:00:00.000Z",
      };
      const first = await bridgeActivity(subject);
      const second = await bridgeActivity(subject);
      expect(first).toEqual({ kind: "seo.audits", deduped: false });
      expect(second).toEqual({ kind: "seo.audits", deduped: true });
      expect(await rowsFor(co, "source_ref = $2", [`act:${subject.activityId}`])).toHaveLength(1);
    });

    it("tenancy: the row lands in the tenant of the audit row and nowhere else", async () => {
      const before = await countAll(other);
      const id = await writeActivity(co, alice, "ingested", "search_audit", newId(), {});
      expect(await countAll(other)).toBe(before);
      expect(await rowsFor(co, "source_ref = $2", [`act:${id}`])).toHaveLength(1);
    });
  });

  describe("the history backfill (BFF §44.7)", () => {
    let tenant: string;
    let carol: string;
    let entry: string;

    const insertAudit = async (t: string, actor: string | null, verb: string, entity: string, entityId: string | null, metadata: Record<string, unknown>, at: string): Promise<string> => {
      const id = newId();
      await withTenants([t], (c) =>
        c.query(
          `INSERT INTO activities (id, tenant_id, actor_id, verb, target_entity_type, target_entity_id, metadata, occurred_at, origin_site)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, 'central')`,
          [id, t, actor, verb, entity, entityId, JSON.stringify(metadata), at],
        ),
      );
      return id;
    };

    beforeAll(async () => {
      tenant = await createCompany("Backfill Co");
      carol = await createUser("carol@activity-bridge.test");
      await addMembership(tenant, carol);
      const project = await createProject(tenant, "Backfill project");
      entry = newId();
      await withTenants([tenant], (c) =>
        c.query(
          `INSERT INTO time_entries (id, tenant_id, user_id, project_id, minutes, billable, entry_date, origin_site)
           VALUES ($1, $2, $3, $4, 30, false, '2026-02-10', 'central')`,
          [entry, tenant, carol, project],
        ),
      );
      const checkin = newId();
      await insertAudit(tenant, carol, "created", "social_post", newId(), { title: "Old post" }, "2026-02-10T02:00:00Z");
      await insertAudit(tenant, carol, "ingested", "search_audit", newId(), {}, "2026-02-11T02:00:00Z");
      await insertAudit(tenant, carol, "logged", "time_entry", entry, { minutes: 30 }, "2026-02-12T02:00:00Z"); // typed later than its day
      await insertAudit(tenant, carol, "submitted", "report_checkin", checkin, { date: "2026-02-13" }, "2026-02-13T09:00:00Z");
      await insertAudit(tenant, carol, "submitted", "report_checkin", checkin, { date: "2026-02-13", edited: true }, "2026-02-13T10:00:00Z"); // re-submit
      await insertAudit(tenant, carol, "webdesk.content.update", "webdesk_content_item", newId(), { outcome: "attempted" }, "2026-02-14T02:00:00Z"); // attempt
      await insertAudit(tenant, carol, "webdesk.content.update", "webdesk_content_item", newId(), { outcome: "succeeded" }, "2026-02-14T02:01:00Z");
      await insertAudit(tenant, carol, "completed", "pm_task", newId(), {}, "2026-02-15T02:00:00Z"); // PM: not bridged
      await insertAudit(tenant, null, "created", "social_post", newId(), { title: "Job post" }, "2026-02-15T03:00:00Z"); // no actor
      await insertAudit(tenant, carol, "created", "social_post", newId(), { title: "Ancient post" }, "2024-01-01T02:00:00Z"); // before --since
      // a row in ANOTHER tenant must not be replayed into this one, and a --tenant run must not touch it
      await insertAudit(other, alice, "ingested", "search_audit", newId(), {}, "2026-02-11T02:00:00Z");
    });

    it("replays the audit log through the catalogue, prints counts per kind, and a second run adds nothing", async () => {
      const otherBefore = await countAll(other);
      const first = await runBridgeBackfill({ tenantId: tenant, since: "2026-01-01" });
      expect(first.errors).toBe(0);
      expect(first.inserted).toEqual({
        "social.posts": 1,
        "seo.audits": 1,
        "time.logged": 1,
        "checkins.submitted": 1,
        "webdesk.edits": 1,
      });
      expect(await countAll(tenant)).toBe(5);
      expect(await countAll(other)).toBe(otherBefore);

      const text = formatReport(first);
      expect(text).toContain("since 2026-01-01");
      expect(text).toContain("social.posts: 1 new");

      const rows = await rowsFor(tenant);
      const by = (source: string) => rows.find((r) => r.source === source)!;
      expect(by("time").occurred_at.toISOString()).toBe("2026-02-10T04:00:00.000Z"); // the entry's day, noon UTC+8, not the day it was typed
      expect(by("checkins").occurred_at.toISOString()).toBe("2026-02-13T04:00:00.000Z");
      expect(by("social").occurred_at.toISOString()).toBe("2026-02-10T02:00:00.000Z"); // the audit row's own time
      expect(rows.every((r) => r.actor_user_id === carol)).toBe(true);
      expect(rows.every((r) => r.source_ref.startsWith("act:"))).toBe(true);

      const snapshot = JSON.stringify(rows);
      const second = await runBridgeBackfill({ tenantId: tenant, since: "2026-01-01" });
      expect(second.errors).toBe(0);
      expect(Object.values(second.inserted).reduce((n, v) => n + v, 0)).toBe(0);
      expect(await countAll(tenant)).toBe(5);
      expect(JSON.stringify(await rowsFor(tenant))).toBe(snapshot); // nothing even re-written
    });

    it("rows the live bridge already wrote are skipped, and a later window picks up the older history", async () => {
      const live = await writeActivity(tenant, carol, "ingested", "search_audit", newId(), {});
      const before = await countAll(tenant);
      const run = await runBridgeBackfill({ tenantId: tenant, since: "2026-01-01" });
      expect(run.inserted["seo.audits"] ?? 0).toBe(0);
      expect(await rowsFor(tenant, "source_ref = $2", [`act:${live}`])).toHaveLength(1);
      expect(await countAll(tenant)).toBe(before);

      const wider = await runBridgeBackfill({ tenantId: tenant, since: "2023-01-01" });
      expect(wider.inserted).toEqual({ "social.posts": 1 }); // only the ancient post is new
      expect(await countAll(tenant)).toBe(before + 1);
    });

    it("--since and --tenant parse; a typo is an error, never a full replay; the default is 400 days back", () => {
      expect(parseArgs(["--since=2026-01-01"])).toEqual({ since: "2026-01-01" });
      expect(parseArgs(["--since=2026-01-01", "--tenant=abc"])).toEqual({ since: "2026-01-01", tenantId: "abc" });
      expect(parseArgs([])).toEqual({});
      expect(() => parseArgs(["--sinse=2026-01-01"])).toThrow(/unknown argument/);
      expect(defaultSince(new Date("2026-10-15T10:00:00Z"))).toBe("2025-09-10");
    });

    it("a bad --since is refused before anything is read", async () => {
      await expect(runBridgeBackfill({ since: "yesterday" })).rejects.toThrow(/--since/);
    });
  });
});
