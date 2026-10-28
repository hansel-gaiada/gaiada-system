// SCP-Sg — the client's accounts read back, against REAL Postgres (the three walls) and REAL Cerbos, through the real HTTP layer: BFF §63.10.
//
//   GET engagements/:engagementId/accounts-summary    social_post · read
//
// THE CLAIMS UNDER TEST
//   1. WHO: anyone with a social read tier reads it (200); a member with no social tier is 403, and BEFORE the engagement is looked at (an unknown id is 403 for
//      them, not 404); an id that is not a uuid, does not exist, is deleted, or is another company's is 404 `engagement_not_found`.
//   2. THE NUMBERS: `followers` is the newest row's; `followersDelta30d` is that minus the oldest reported followers inside the 30-day window; `reach30d` and
//      `impressions30d` sum the window only (an older row never counts); `lastSyncedAt` is the newest row's `updated_at`; rows are the account's own.
//   3. NULL IS NOT ZERO: a client with no account, an account with no row, a window with no reported counter, a stale sync (the newest row older than the window)
//      and a single point in the window answer null where nothing was measured, never 0.
//   4. NEVER MIXED: a simulated account counts `simulated` rows only (`source: "simulated"`), a real one `pull` rows only (`source: "pull"`), whatever else sits in
//      the table; the top-level `simulated` is true when any account answered simulated numbers; the totals add what the accounts reported.
//   5. A deleted account and another client's account are not in the answer.
//
// The days are relative to today's UTC date (the day the sweep keys its rows on), so the 30-day window is exercised on both sides.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../../config";
import { withTenants, newId } from "../../../db";
import { buildApp } from "../../../main";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../../../testing/fixtures";
import { seedSocialOrgTree, grantSocialRole } from "../../../testing/social-pipeline-fixtures";
import { registerModule, resetModules } from "../../registry";
import { socialModule } from "../index";

const SOCIAL = { modules: ["social"] };
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

/** The UTC day `n` days before today. */
const ago = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const at = (n: number, hh = "10:00:00.000Z"): string => `${ago(n)}T${hh}`;

describe.skipIf(!TEST_URL)("SCP-Sg · GET engagements/:engagementId/accounts-summary (BFF §63.10)", () => {
  let app: NestFastifyApplication;
  let A: string;
  let C: string;
  const U: Record<string, string> = {};
  let n = 0;
  const base = (tenant = A) => `/api/${tenant}/modules/social`;

  interface Eng { engagementId: string; clientId: string; orgId: string }
  type Summary = {
    accounts: Array<{
      accountId: string; network: string; handle: string; simulated: boolean; followers: number | null; followersDelta30d: number | null;
      reach30d: number | null; impressions30d: number | null; lastSyncedAt: string | null; source: "pull" | "simulated" | null;
    }>;
    totals: { followers: number | null; reach30d: number | null };
    simulated: boolean;
    lastSyncedAt: string | null;
  };

  const get = (who: string, engagementId: string, tenant = A) =>
    app.inject({ method: "GET", url: `${base(tenant)}/engagements/${engagementId}/accounts-summary`, headers: asUser(who) });
  const read = async (engagementId: string): Promise<Summary> => {
    const r = await get(U.reader, engagementId);
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as Summary;
  };

  /** A client with an engagement and its publisher organisation (no account yet). */
  async function makeClient(tenant: string, officer: string): Promise<Eng> {
    n += 1;
    const clientId = await createClient(tenant, `Mock Client Sg ${n}`);
    const engagementId = newId();
    const orgId = newId();
    await withTenants([tenant], async (c) => {
      await c.query(
        `INSERT INTO social_engagements (id, tenant_id, client_id, name, owner_id, status, tool_scope, creative_source, platforms, origin_site)
         VALUES ($1, $2, $3, $4, $5, 'active', $6, 'in_team', $7, 'central')`,
        [engagementId, tenant, clientId, `Mock engagement Sg ${n}`, officer, JSON.stringify({ networks: { instagram: true } }), ["instagram"]],
      );
      await c.query(
        `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
         VALUES ($1, $2, $3, 'postiz', $4, 'default', 'active', 'central')`,
        [orgId, tenant, clientId, `mock-org-sg-${n}-${newId().slice(0, 8)}`],
      );
    }, SOCIAL);
    return { engagementId, clientId, orgId };
  }

  async function addAccount(tenant: string, e: Eng, network: string, handle: string, o: { simulated?: boolean; deleted?: boolean } = {}): Promise<string> {
    const id = newId();
    await adminPool().query(
      `INSERT INTO social_accounts (id, tenant_id, client_id, publisher_org_id, network, handle, status, simulated, deleted_at, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6, 'connected', $7, $8, 'central')`,
      [id, tenant, e.clientId, e.orgId, network, handle, o.simulated === true, o.deleted ? new Date() : null],
    );
    return id;
  }

  interface Day { ago: number; followers?: number | null; reach?: number | null; impressions?: number | null; source?: "pull" | "simulated"; updatedAt?: string }
  async function addDays(tenant: string, accountId: string, days: readonly Day[]): Promise<void> {
    for (const d of days) {
      await adminPool().query(
        `INSERT INTO social_metrics_daily (tenant_id, account_id, date, followers, reach, impressions, source, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [tenant, accountId, ago(d.ago), d.followers ?? null, d.reach ?? null, d.impressions ?? null, d.source ?? "pull", d.updatedAt ?? at(d.ago)],
      );
    }
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    registerModule(socialModule);

    A = await createCompany("SCPSg Agency", ["social", "pm"]);
    C = await createCompany("SCPSg Other Co", ["social"]);
    await seedSocialOrgTree(A);
    for (const p of ["officer", "reader", "noTier", "foreign"]) U[p] = await createUser(`scpsg-${p.toLowerCase()}@mock.test`, `Mock ${p}`);
    for (const p of ["officer", "reader", "noTier"]) {
      await addMembership(A, U[p]);
      if (p !== "noTier") await grantSocialRole(A, U[p], "member"); // noTier: a member of the company with no social tier
    }
    await addMembership(C, U.foreign);
    await grantSocialRole(C, U.foreign, "member");
    for (const p of ["officer", "reader"]) await grantSocialRole(A, U[p], "social_staff");
    await grantSocialRole(C, U.foreign, "social_staff");
    app = await buildApp();
  });
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  describe("who may read, and which engagement", () => {
    it("answers the social read tier, 403s a member with no tier before the engagement is looked at, and 404s what is not this company's", async () => {
      const e = await makeClient(A, U.officer);
      expect((await get(U.reader, e.engagementId)).statusCode).toBe(200);
      expect((await get(U.officer, e.engagementId)).statusCode).toBe(200);
      expect((await get(U.noTier, e.engagementId)).statusCode).toBe(403);
      expect((await get(U.noTier, newId())).statusCode).toBe(403); // the decision first: a refused caller is never told whether it exists
      expect((await get(U.reader, newId())).statusCode).toBe(404);
      const bad = await get(U.reader, "not-a-uuid");
      expect(bad.statusCode).toBe(404);
      expect(bad.json().error).toBe("engagement_not_found");
    });

    it("hides another company's engagement, in both directions, and a deleted one", async () => {
      const mine = await makeClient(A, U.officer);
      const foreign = await makeClient(C, U.foreign);
      expect((await get(U.reader, foreign.engagementId)).statusCode).toBe(404); // through this company's path
      expect((await get(U.foreign, mine.engagementId, C)).statusCode).toBe(404); // through the other company's own path
      await adminPool().query(`UPDATE social_engagements SET deleted_at = now() WHERE id = $1`, [mine.engagementId]);
      const gone = await get(U.reader, mine.engagementId);
      expect(gone.statusCode).toBe(404);
      expect(gone.json().error).toBe("engagement_not_found");
    });
  });

  describe("the numbers", () => {
    it("answers the latest followers, the 30-day change, the window's sums and the newest sync of a pulled account", async () => {
      const e = await makeClient(A, U.officer);
      const acc = await addAccount(A, e, "instagram", "@mock-sg-a");
      await addDays(A, acc, [
        { ago: 40, followers: 500, reach: 1_000_000, impressions: 1_000_000 }, // outside the window: never summed, never the baseline
        { ago: 29, followers: 1000, reach: 10, impressions: 100 }, // the window's first day (today and the 29 before it)
        { ago: 10, followers: 1100, reach: 20, impressions: 200 },
        { ago: 0, followers: 1250, reach: 30, impressions: 300, updatedAt: at(0, "09:30:00.000Z") },
      ]);
      const j = await read(e.engagementId);
      expect(j.accounts).toEqual([{
        accountId: acc, network: "instagram", handle: "@mock-sg-a", simulated: false, followers: 1250, followersDelta30d: 250, reach30d: 60, impressions30d: 600,
        lastSyncedAt: at(0, "09:30:00.000Z"), source: "pull",
      }]);
      expect(j.totals).toEqual({ followers: 1250, reach30d: 60 });
      expect(j.simulated).toBe(false);
      expect(j.lastSyncedAt).toBe(at(0, "09:30:00.000Z"));
    });

    it("skips a row that reported no followers when it picks the latest, and counts a counter nobody reported as null, not 0", async () => {
      const e = await makeClient(A, U.officer);
      const acc = await addAccount(A, e, "facebook", "@mock-sg-b");
      await addDays(A, acc, [
        { ago: 5, followers: 200 },
        { ago: 1, followers: 230 },
        { ago: 0, followers: null, reach: null }, // today's row reported nothing yet
      ]);
      const [a] = (await read(e.engagementId)).accounts;
      expect(a).toMatchObject({ followers: 230, followersDelta30d: 30, reach30d: null, impressions30d: null, source: "pull" });
      expect(a.lastSyncedAt).toBe(at(0)); // the empty row is still a sync
    });

    it("answers a delta of null for a single point in the window and for a stale sync, and the stale one's followers all the same", async () => {
      const e = await makeClient(A, U.officer);
      const one = await addAccount(A, e, "instagram", "@mock-sg-one");
      const stale = await addAccount(A, e, "tiktok", "@mock-sg-stale");
      await addDays(A, one, [{ ago: 60, followers: 10 }, { ago: 3, followers: 400, reach: 7 }]);
      await addDays(A, stale, [{ ago: 50, followers: 90, reach: 5 }, { ago: 45, followers: 95, reach: 6 }]);
      const j = await read(e.engagementId);
      const by = (h: string) => j.accounts.find((a) => a.handle === h)!;
      expect(by("@mock-sg-one")).toMatchObject({ followers: 400, followersDelta30d: null, reach30d: 7 });
      expect(by("@mock-sg-stale")).toMatchObject({ followers: 95, followersDelta30d: null, reach30d: null, impressions30d: null, source: "pull" });
      expect(by("@mock-sg-stale").lastSyncedAt).toBe(at(45)); // synced, but long ago: the page says when
    });

    it("answers nulls and `Not synced yet` for a client with no account, and for an account with no row", async () => {
      const none = await makeClient(A, U.officer);
      expect(await read(none.engagementId)).toEqual({ accounts: [], totals: { followers: null, reach30d: null }, simulated: false, lastSyncedAt: null });
      const e = await makeClient(A, U.officer);
      const acc = await addAccount(A, e, "instagram", "@mock-sg-empty", { simulated: true });
      expect(await read(e.engagementId)).toEqual({
        accounts: [{
          accountId: acc, network: "instagram", handle: "@mock-sg-empty", simulated: true, followers: null, followersDelta30d: null, reach30d: null, impressions30d: null,
          lastSyncedAt: null, source: null,
        }],
        totals: { followers: null, reach30d: null }, simulated: false, lastSyncedAt: null, // nothing counted: nothing to mark simulated
      });
    });

    it("orders the accounts by network then handle, leaves out a deleted account and another client's account", async () => {
      const e = await makeClient(A, U.officer);
      const other = await makeClient(A, U.officer);
      await addAccount(A, e, "tiktok", "@mock-sg-z");
      await addAccount(A, e, "facebook", "@mock-sg-m");
      await addAccount(A, e, "facebook", "@mock-sg-a");
      const gone = await addAccount(A, e, "instagram", "@mock-sg-deleted", { deleted: true });
      const elsewhere = await addAccount(A, other, "instagram", "@mock-sg-elsewhere");
      await addDays(A, gone, [{ ago: 1, followers: 999 }]);
      await addDays(A, elsewhere, [{ ago: 1, followers: 888 }]);
      const j = await read(e.engagementId);
      expect(j.accounts.map((a) => `${a.network} ${a.handle}`)).toEqual(["facebook @mock-sg-a", "facebook @mock-sg-m", "tiktok @mock-sg-z"]);
      expect(j.totals.followers).toBeNull();
      expect(j.lastSyncedAt).toBeNull();
    });
  });

  describe("never mixes simulated and pulled", () => {
    it("marks a simulated account's numbers `simulated`, the totals SIMULATED, and adds what each account reported", async () => {
      const e = await makeClient(A, U.officer);
      const sim = await addAccount(A, e, "instagram", "@mock-sg-sim", { simulated: true });
      const real = await addAccount(A, e, "facebook", "@mock-sg-real");
      await addDays(A, sim, [
        { ago: 20, followers: 3000, reach: 100, source: "simulated" },
        { ago: 0, followers: 3100, reach: 150, source: "simulated", updatedAt: at(0, "11:00:00.000Z") },
      ]);
      await addDays(A, real, [{ ago: 3, followers: 700, reach: 40, source: "pull", updatedAt: at(3, "08:00:00.000Z") }]);
      const j = await read(e.engagementId);
      const sa = j.accounts.find((a) => a.accountId === sim)!;
      const ra = j.accounts.find((a) => a.accountId === real)!;
      expect(sa).toMatchObject({ simulated: true, source: "simulated", followers: 3100, followersDelta30d: 100, reach30d: 250, lastSyncedAt: at(0, "11:00:00.000Z") });
      expect(ra).toMatchObject({ simulated: false, source: "pull", followers: 700, followersDelta30d: null, reach30d: 40, lastSyncedAt: at(3, "08:00:00.000Z") });
      expect(j.totals).toEqual({ followers: 3800, reach30d: 290 });
      expect(j.simulated).toBe(true);
      expect(j.lastSyncedAt).toBe(at(0, "11:00:00.000Z"));
    });

    it("counts a simulated account's simulated rows only, and a real account's pulled rows only, whatever else the table holds", async () => {
      const e = await makeClient(A, U.officer);
      const sim = await addAccount(A, e, "instagram", "@mock-sg-sim2", { simulated: true });
      const real = await addAccount(A, e, "facebook", "@mock-sg-real2");
      await addDays(A, sim, [
        { ago: 2, followers: 111, reach: 11, source: "simulated" },
        { ago: 1, followers: 99_999, reach: 99_999, source: "pull", updatedAt: at(1, "23:00:00.000Z") }, // a pulled row under a simulated account: not counted
      ]);
      await addDays(A, real, [
        { ago: 2, followers: 222, reach: 22, source: "pull" },
        { ago: 1, followers: 88_888, reach: 88_888, source: "simulated", updatedAt: at(1, "22:00:00.000Z") }, // a simulated row under a real account: not counted
      ]);
      const j = await read(e.engagementId);
      expect(j.accounts.find((a) => a.accountId === sim)).toMatchObject({ followers: 111, reach30d: 11, source: "simulated", lastSyncedAt: at(2) });
      expect(j.accounts.find((a) => a.accountId === real)).toMatchObject({ followers: 222, reach30d: 22, source: "pull", lastSyncedAt: at(2) });
      expect(j.totals).toEqual({ followers: 333, reach30d: 33 });
      expect(j.lastSyncedAt).toBe(at(2));
    });

    it("is not simulated when only a real account reported", async () => {
      const e = await makeClient(A, U.officer);
      const sim = await addAccount(A, e, "instagram", "@mock-sg-sim3", { simulated: true }); // no rows: nothing of it is counted
      const real = await addAccount(A, e, "facebook", "@mock-sg-real3");
      await addDays(A, real, [{ ago: 0, followers: 50, reach: 5 }]);
      const j = await read(e.engagementId);
      expect(j.simulated).toBe(false);
      expect(j.accounts.find((a) => a.accountId === sim)).toMatchObject({ simulated: true, source: null, followers: null });
      expect(j.totals).toEqual({ followers: 50, reach30d: 5 });
    });
  });
});
