// DW-8g (docs/FRONTEND-BFF-CONTRACT.md §47.1, §47.6 "Migration") — migration 202610150400_calendar_events.sql, proven against a
// REAL Postgres as the NOSUPERUSER NOBYPASSRLS app role: the CHECKs (each time shape, the 14-day span, cancelled, the field
// sizes and the https-only link), the recording UNIQUE and its tenant-safe FK, the attendee table's keys, and RLS (zero rows
// with the tenant GUC unset, nothing across tenants, FORCE on).
//
// Each refusal asserts the SQLSTATE AND that nothing was stored. A CHECK that passes on NULL would let a half-built row in
// silently, so every "must be refused" case is one where the offending column is NULL, not just wrong.
//
// Needs DATABASE_URL_TEST (a superuser URL to a disposable Postgres): the Linux gate. Skips without it; a skip is not a pass.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withGlobal, withTenants, newId } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership } from "../testing/fixtures";

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const FK_VIOLATION = "23503";
const RLS_VIOLATION = "42501";

describe.skipIf(!TEST_URL)("DW-8g — calendar_events schema (as the NOBYPASSRLS app role)", () => {
  let A: string;
  let B: string;
  let userA: string;
  let userB: string;
  let seq = 0;

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("Calendar Tenant A");
    B = await createCompany("Calendar Tenant B");
    userA = await createUser("cal-a@schema.test", "Cal A");
    userB = await createUser("cal-b@schema.test", "Cal B");
    await addMembership(A, userA);
    await addMembership(B, userB);
  }, 120_000);
  afterAll(teardownTestDb);

  const TIMED = { starts_at: "2026-10-20T01:00:00Z", ends_at: "2026-10-20T02:00:00Z" };
  const ALL_DAY = { starts_on: "2026-10-20", ends_on: "2026-10-21" };

  /** Insert an event for `tenant`. `cols` overrides the defaults (a timed event by default); returns the id. */
  async function insertEvent(tenant: string, cols: Record<string, unknown> = {}, organizer = tenant === A ? userA : userB): Promise<string> {
    const id = newId();
    const row: Record<string, unknown> = {
      id, tenant_id: tenant, title: `Event ${++seq}`, organizer_id: organizer, origin_site: "test", ...TIMED, ...cols,
    };
    const names = Object.keys(row);
    await withTenants([tenant], (c) =>
      c.query(`INSERT INTO calendar_events (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`, names.map((n) => row[n])),
    );
    return id;
  }
  const stored = async (id: string) => Number((await adminPool().query(`SELECT count(*)::int AS n FROM calendar_events WHERE id = $1`, [id])).rows[0].n);
  const refused = async (code: string, tenant: string, cols: Record<string, unknown>, organizer?: string) => {
    const before = Number((await adminPool().query(`SELECT count(*)::int AS n FROM calendar_events`)).rows[0].n);
    await expect(insertEvent(tenant, cols, organizer)).rejects.toMatchObject({ code });
    const after = Number((await adminPool().query(`SELECT count(*)::int AS n FROM calendar_events`)).rows[0].n);
    expect(after, "a refused insert stores nothing").toBe(before);
  };
  async function insertRecording(tenant: string): Promise<string> {
    const id = newId();
    await adminPool().query(
      `INSERT INTO meeting_recordings (id, tenant_id, meeting_id, status, origin_site) VALUES ($1, $2, $3, 'scheduled', 'test')`,
      [id, tenant, `mtg-${id}`],
    );
    return id;
  }

  describe("the two time shapes", () => {
    it("a timed event and an all-day event are both stored, with the column defaults (attendees, confirmed, no description)", async () => {
      const t = await insertEvent(A);
      const d = await insertEvent(A, { starts_at: null, ends_at: null, ...ALL_DAY });
      for (const id of [t, d]) {
        const r = (await adminPool().query(`SELECT visibility, status, cancelled_at, description FROM calendar_events WHERE id = $1`, [id])).rows[0];
        expect(r).toEqual({ visibility: "attendees", status: "confirmed", cancelled_at: null, description: "" });
      }
    });

    it("BOTH shapes at once is refused", async () => {
      await refused(CHECK_VIOLATION, A, { ...TIMED, ...ALL_DAY });
    });

    it("NEITHER shape is refused (every time column NULL)", async () => {
      await refused(CHECK_VIOLATION, A, { starts_at: null, ends_at: null });
    });

    it("half a timed shape (starts_at without ends_at, or the reverse) and half an all-day shape are refused", async () => {
      await refused(CHECK_VIOLATION, A, { ends_at: null });
      await refused(CHECK_VIOLATION, A, { starts_at: null });
      await refused(CHECK_VIOLATION, A, { starts_at: null, ends_at: null, starts_on: "2026-10-20" });
      await refused(CHECK_VIOLATION, A, { starts_at: null, ends_at: null, ends_on: "2026-10-20" });
    });
  });

  describe("the span rules", () => {
    it("ends_at must be after starts_at: equal and earlier are both refused", async () => {
      await refused(CHECK_VIOLATION, A, { starts_at: "2026-10-20T02:00:00Z", ends_at: "2026-10-20T02:00:00Z" });
      await refused(CHECK_VIOLATION, A, { starts_at: "2026-10-20T02:00:00Z", ends_at: "2026-10-20T01:00:00Z" });
    });

    it("a timed event spans at most 14 days: exactly 14 is stored, one second more is refused", async () => {
      const ok = await insertEvent(A, { starts_at: "2026-10-01T00:00:00Z", ends_at: "2026-10-15T00:00:00Z" });
      expect(await stored(ok)).toBe(1);
      await refused(CHECK_VIOLATION, A, { starts_at: "2026-10-01T00:00:00Z", ends_at: "2026-10-15T00:00:01Z" });
    });

    it("an all-day event ends on or after the day it starts: the same day is stored, an earlier end is refused", async () => {
      const ok = await insertEvent(A, { starts_at: null, ends_at: null, starts_on: "2026-10-20", ends_on: "2026-10-20" });
      expect(await stored(ok)).toBe(1);
      await refused(CHECK_VIOLATION, A, { starts_at: null, ends_at: null, starts_on: "2026-10-21", ends_on: "2026-10-20" });
    });
  });

  describe("cancelled and cancelled_at move together (IS NOT DISTINCT FROM, not =)", () => {
    it("cancelled with a timestamp and confirmed without one are stored", async () => {
      const c = await insertEvent(A, { status: "cancelled", cancelled_at: "2026-10-19T00:00:00Z" });
      const k = await insertEvent(A, { status: "confirmed" });
      expect(await stored(c)).toBe(1);
      expect(await stored(k)).toBe(1);
    });

    it("cancelled WITHOUT cancelled_at (NULL) is refused, and confirmed WITH one is refused", async () => {
      await refused(CHECK_VIOLATION, A, { status: "cancelled" });
      await refused(CHECK_VIOLATION, A, { status: "confirmed", cancelled_at: "2026-10-19T00:00:00Z" });
    });

    it("an unknown status or visibility is refused", async () => {
      await refused(CHECK_VIOLATION, A, { status: "tentative" });
      await refused(CHECK_VIOLATION, A, { visibility: "public" });
      const ok = await insertEvent(A, { visibility: "company" });
      expect(await stored(ok)).toBe(1);
    });
  });

  describe("the field limits", () => {
    it("title is 1 to 200 characters", async () => {
      expect(await stored(await insertEvent(A, { title: "t".repeat(200) }))).toBe(1);
      await refused(CHECK_VIOLATION, A, { title: "" });
      await refused(CHECK_VIOLATION, A, { title: "t".repeat(201) });
    });

    it("description is at most 5,000, location at most 300 (NULL is fine)", async () => {
      expect(await stored(await insertEvent(A, { description: "d".repeat(5000), location: "l".repeat(300) }))).toBe(1);
      await refused(CHECK_VIOLATION, A, { description: "d".repeat(5001) });
      await refused(CHECK_VIOLATION, A, { location: "l".repeat(301) });
      expect(await stored(await insertEvent(A, { location: null }))).toBe(1);
    });

    it("video_url is https only and at most 2,048 characters (NULL is fine)", async () => {
      expect(await stored(await insertEvent(A, { video_url: "https://meet.example.com/abc" }))).toBe(1);
      expect(await stored(await insertEvent(A, { video_url: null }))).toBe(1);
      await refused(CHECK_VIOLATION, A, { video_url: "http://meet.example.com/abc" });
      await refused(CHECK_VIOLATION, A, { video_url: "javascript:alert(1)" });
      await refused(CHECK_VIOLATION, A, { video_url: `https://x.test/${"a".repeat(2048)}` });
    });

    it("origin_site has no default: a row that omits it is refused", async () => {
      await expect(
        withTenants([A], (c) =>
          c.query(`INSERT INTO calendar_events (id, tenant_id, title, organizer_id, starts_at, ends_at) VALUES ($1, $2, 'x', $3, $4, $5)`, [newId(), A, userA, TIMED.starts_at, TIMED.ends_at]),
        ),
      ).rejects.toMatchObject({ code: "23502" });
    });
  });

  describe("the recording link", () => {
    it("one recording serves at most one event (UNIQUE); several events without a recording are fine", async () => {
      const rec = await insertRecording(A);
      expect(await stored(await insertEvent(A, { meeting_recording_id: rec }))).toBe(1);
      await refused(UNIQUE_VIOLATION, A, { meeting_recording_id: rec });
      expect(await stored(await insertEvent(A))).toBe(1);
      expect(await stored(await insertEvent(A))).toBe(1);
    });

    it("an event cannot link another company's recording (the composite FK carries the tenant)", async () => {
      const recB = await insertRecording(B);
      await refused(FK_VIOLATION, A, { meeting_recording_id: recB });
    });

    it("an unknown recording, an unknown project and an unknown organizer are refused", async () => {
      await refused(FK_VIOLATION, A, { meeting_recording_id: newId() });
      await refused(FK_VIOLATION, A, { project_id: newId() });
      await refused(FK_VIOLATION, A, {}, newId());
    });
  });

  describe("calendar_event_attendees", () => {
    async function attend(tenant: string, eventId: string, userId: string, cols: Record<string, unknown> = {}) {
      const row: Record<string, unknown> = { event_id: eventId, user_id: userId, tenant_id: tenant, ...cols };
      const names = Object.keys(row);
      await withTenants([tenant], (c) =>
        c.query(`INSERT INTO calendar_event_attendees (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`, names.map((n) => row[n])),
      );
    }

    it("a row defaults to needs_action with no answer time; the four answers are stored; an unknown one is refused", async () => {
      const ev = await insertEvent(A);
      await attend(A, ev, userA);
      const r = (await adminPool().query(`SELECT response, responded_at FROM calendar_event_attendees WHERE event_id = $1`, [ev])).rows[0];
      expect(r).toEqual({ response: "needs_action", responded_at: null });
      for (const response of ["accepted", "declined", "tentative"]) {
        const e = await insertEvent(A);
        await attend(A, e, userA, { response });
        expect((await adminPool().query(`SELECT response FROM calendar_event_attendees WHERE event_id = $1`, [e])).rows[0].response).toBe(response);
      }
      await expect(attend(A, await insertEvent(A), userA, { response: "maybe" })).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });

    it("(event, user) is the key: a second row for the same person is refused", async () => {
      const ev = await insertEvent(A);
      await attend(A, ev, userA);
      await expect(attend(A, ev, userA)).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    });

    it("an attendee row must carry the event's own tenant (the composite FK), and the person must exist", async () => {
      const ev = await insertEvent(A);
      await expect(attend(B, ev, userB)).rejects.toMatchObject({ code: FK_VIOLATION });
      await expect(attend(A, ev, newId())).rejects.toMatchObject({ code: FK_VIOLATION });
    });
  });

  describe("RLS", () => {
    it("both tables are ENABLED and FORCED, with exactly one tenant_isolation policy each", async () => {
      const { rows } = await adminPool().query(
        `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
                (SELECT count(*)::int FROM pg_policies p WHERE p.tablename = c.relname AND p.policyname = 'tenant_isolation') AS policies
           FROM pg_class c WHERE c.relname IN ('calendar_events', 'calendar_event_attendees') ORDER BY c.relname`,
      );
      expect(rows).toEqual([
        { relname: "calendar_event_attendees", rls: true, forced: true, policies: 1 },
        { relname: "calendar_events", rls: true, forced: true, policies: 1 },
      ]);
    });

    it("with the tenant GUC UNSET the app role reads ZERO rows of either table (never an error), though rows exist", async () => {
      const ev = await insertEvent(A);
      await withTenants([A], (c) =>
        c.query(`INSERT INTO calendar_event_attendees (event_id, user_id, tenant_id) VALUES ($1, $2, $3)`, [ev, userA, A]),
      );
      expect(Number((await adminPool().query(`SELECT count(*)::int AS n FROM calendar_events`)).rows[0].n)).toBeGreaterThan(0);
      const events = await withGlobal((c) => c.query(`SELECT count(*)::int AS n FROM calendar_events`));
      const attendees = await withGlobal((c) => c.query(`SELECT count(*)::int AS n FROM calendar_event_attendees`));
      expect(events.rows[0].n).toBe(0);
      expect(attendees.rows[0].n).toBe(0);
    });

    it("another tenant's context reads none of A's rows, and cannot insert a row for A", async () => {
      const ev = await insertEvent(A);
      const seenByB = await withTenants([B], (c) => c.query(`SELECT id FROM calendar_events WHERE id = $1`, [ev]));
      expect(seenByB.rows).toEqual([]);
      const seenByA = await withTenants([A], (c) => c.query(`SELECT id FROM calendar_events WHERE id = $1`, [ev]));
      expect(seenByA.rows.length).toBe(1);
      await expect(
        withTenants([B], (c) =>
          c.query(`INSERT INTO calendar_events (id, tenant_id, title, organizer_id, starts_at, ends_at, origin_site) VALUES ($1, $2, 'x', $3, $4, $5, 'test')`, [newId(), A, userA, TIMED.starts_at, TIMED.ends_at]),
        ),
      ).rejects.toMatchObject({ code: RLS_VIOLATION });
    });
  });
});
