// SMM-38 phase 38d — YouTube's quota ACCOUNTING module, tested in isolation from `direct.ts` so the
// three-bucket model (and the "never invent a used value, never fabricate an increment" discipline)
// is pinned independently of the driver wiring `direct.test.ts` covers.
//
// SMM-38 phase 38e adds Gap 3's durable-store cases below, guarded by `describe.skipIf(!TEST_URL)` —
// against the repo's own `initTestDb` harness, proving the real migration's atomic-increment idiom
// and the store SEAM's contract, without touching a single assertion above (the in-memory functions
// this file already pins are untouched, byte-for-byte — `defaultYouTubeQuotaStore()` only wraps them).
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import {
  YOUTUBE_QUOTA_CAPS, recordYouTubeQuotaUsage, getYouTubeQuotaSnapshot, resetYouTubeQuotaUsage,
  defaultYouTubeQuotaStore, createDbYouTubeQuotaStore,
} from "./youtube-quota";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../../testing/setup";

beforeEach(() => {
  resetYouTubeQuotaUsage();
});

describe("SMM-38d · getYouTubeQuotaSnapshot — a fresh day starts every bucket at used:0, a TRUE fact", () => {
  it("returns the three cited caps with zero usage before anything is recorded", () => {
    const now = new Date("2026-08-21T12:00:00Z");
    expect(getYouTubeQuotaSnapshot(now)).toEqual({
      searchListCallsToday: { used: 0, cap: YOUTUBE_QUOTA_CAPS.searchListCallsPerDay },
      videosInsertCallsToday: { used: 0, cap: YOUTUBE_QUOTA_CAPS.videosInsertCallsPerDay },
      otherUnitsToday: { used: 0, cap: YOUTUBE_QUOTA_CAPS.otherUnitsPerDay },
    });
  });

  it("caps match the dossier's own documented regime exactly — 100 / 100 / 10,000", () => {
    expect(YOUTUBE_QUOTA_CAPS).toEqual({
      searchListCallsPerDay: 100, videosInsertCallsPerDay: 100, otherUnitsPerDay: 10000,
    });
  });
});

describe("SMM-38d · recordYouTubeQuotaUsage — the three buckets are INDEPENDENT, never one pool", () => {
  it("recording videosInsertCallsToday never moves searchListCallsToday or otherUnitsToday", () => {
    const now = new Date("2026-08-21T12:00:00Z");
    recordYouTubeQuotaUsage("videosInsertCallsToday", 1, now);
    const snap = getYouTubeQuotaSnapshot(now);
    expect(snap.videosInsertCallsToday).toEqual({ used: 1, cap: 100 });
    expect(snap.searchListCallsToday).toEqual({ used: 0, cap: 100 });
    expect(snap.otherUnitsToday).toEqual({ used: 0, cap: 10000 });
  });

  it("otherUnitsToday accumulates by the actual unit cost passed, not a flat +1 — a comments.insert " +
     "(50 units) and a commentThreads.list (1 unit) must NOT read the same", () => {
    const now = new Date("2026-08-21T12:00:00Z");
    recordYouTubeQuotaUsage("otherUnitsToday", 1, now);
    recordYouTubeQuotaUsage("otherUnitsToday", 50, now);
    expect(getYouTubeQuotaSnapshot(now).otherUnitsToday).toEqual({ used: 51, cap: 10000 });
  });

  it("a NEW UTC day starts a fresh counter — yesterday's usage does not carry over", () => {
    const day1 = new Date("2026-08-21T23:59:00Z");
    const day2 = new Date("2026-08-22T00:01:00Z");
    recordYouTubeQuotaUsage("videosInsertCallsToday", 1, day1);
    expect(getYouTubeQuotaSnapshot(day1).videosInsertCallsToday!.used).toBe(1);
    expect(getYouTubeQuotaSnapshot(day2).videosInsertCallsToday!.used).toBe(0);
  });
});

describe("SMM-38d · resetYouTubeQuotaUsage — the test seam", () => {
  it("clears every day's accounted usage so one test's calls never leak into another's", () => {
    const now = new Date("2026-08-21T12:00:00Z");
    recordYouTubeQuotaUsage("videosInsertCallsToday", 1, now);
    resetYouTubeQuotaUsage();
    expect(getYouTubeQuotaSnapshot(now).videosInsertCallsToday!.used).toBe(0);
  });
});

// ══ SMM-38 phase 38e — Gap 3: the `YouTubeQuotaStore` seam ═══════════════════════════════════════

describe("SMM-38e · defaultYouTubeQuotaStore — wraps the SAME singleton, zero behaviour change", () => {
  it("record()/snapshot() read and write the identical Map the module-level functions above use", async () => {
    const now = new Date("2026-08-21T12:00:00Z");
    const store = defaultYouTubeQuotaStore();
    await store.record("videosInsertCallsToday", 1, now);
    // Read through the OTHER surface (the plain function), proving it is the SAME underlying state,
    // not a second, independent counter.
    expect(getYouTubeQuotaSnapshot(now).videosInsertCallsToday).toEqual({ used: 1, cap: 100 });
    recordYouTubeQuotaUsage("otherUnitsToday", 5, now);
    expect((await store.snapshot(now)).otherUnitsToday).toEqual({ used: 5, cap: 10000 });
  });
});

// GAP 3, THE DURABLE PART — against a REAL Postgres, skips silently without DATABASE_URL_TEST.
describe.skipIf(!TEST_URL)("SMM-38e · createDbYouTubeQuotaStore — durable, atomic, cross-instance-safe", () => {
  beforeAll(async () => {
    await initTestDb();
  });
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(async () => {
    await adminPool().query(`DELETE FROM social_youtube_quota_usage`);
  });

  it("a fresh day reads every bucket at used:0 — the same true fact the in-memory store returns for " +
     "an unseen day, never a fabricated non-zero", async () => {
    const store = createDbYouTubeQuotaStore();
    const now = new Date("2026-08-21T12:00:00Z");
    expect(await store.snapshot(now)).toEqual({
      searchListCallsToday: { used: 0, cap: 100 },
      videosInsertCallsToday: { used: 0, cap: 100 },
      otherUnitsToday: { used: 0, cap: 10000 },
    });
  });

  it("record() is a REAL, durable write — a SECOND store instance (standing in for a second Node " +
     "process) reads back the SAME count, never its own empty one", async () => {
    const now = new Date("2026-08-21T13:00:00Z");
    await createDbYouTubeQuotaStore().record("videosInsertCallsToday", 1, now);
    const secondInstance = createDbYouTubeQuotaStore();
    expect((await secondInstance.snapshot(now)).videosInsertCallsToday).toEqual({ used: 1, cap: 100 });
  });

  it("the three buckets stay independent in the durable store too — never one pool", async () => {
    const now = new Date("2026-08-21T14:00:00Z");
    const store = createDbYouTubeQuotaStore();
    await store.record("otherUnitsToday", 1, now);
    await store.record("otherUnitsToday", 50, now);
    const snap = await store.snapshot(now);
    expect(snap.otherUnitsToday).toEqual({ used: 51, cap: 10000 });
    expect(snap.videosInsertCallsToday).toEqual({ used: 0, cap: 100 });
    expect(snap.searchListCallsToday).toEqual({ used: 0, cap: 100 });
  });

  it("a NEW UTC day starts a fresh row — yesterday's usage does not carry over (the SAME property " +
     "the in-memory store has, now proven against a real row)", async () => {
    const day1 = new Date("2026-08-21T23:59:00Z");
    const day2 = new Date("2026-08-22T00:01:00Z");
    const store = createDbYouTubeQuotaStore();
    await store.record("videosInsertCallsToday", 1, day1);
    expect((await store.snapshot(day1)).videosInsertCallsToday!.used).toBe(1);
    expect((await store.snapshot(day2)).videosInsertCallsToday!.used).toBe(0);
  });

  it("CONCURRENT increments ADD UP rather than racing a read-then-write — the atomic " +
     "INSERT..ON CONFLICT idiom, exercised with real parallel calls, not just asserted from the SQL " +
     "text", async () => {
    const now = new Date("2026-08-21T15:00:00Z");
    const store = createDbYouTubeQuotaStore();
    // 10 concurrent increments of 1 each against the SAME day/bucket — a read-then-write race would
    // lose some of these; the atomic UPDATE...SET col = col + EXCLUDED.col must not.
    await Promise.all(Array.from({ length: 10 }, () => store.record("videosInsertCallsToday", 1, now)));
    expect((await store.snapshot(now)).videosInsertCallsToday!.used).toBe(10);
  });
});
