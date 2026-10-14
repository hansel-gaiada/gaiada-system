// DW-6n n7, n8, n9 (docs/FRONTEND-BFF-CONTRACT.md §40.5.3, proof §40.5.6) against live Postgres + RLS. The readers are
// called directly with a ReaderCtx. Window: 2020-03-01 .. 2020-03-31 inclusive; every boundary is built from the zone
// with at(), never assumed to be UTC. Rows are seeded through the admin pool (RLS bypass) so the `social` wall is what
// keeps a module-less tenant's rows out, which is exactly what the null cases prove.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../../../testing/setup";
import { clientApprovalTurnaround, engagementGrowth, postsOnSchedule } from "./social";
import { at, seedDept, uuid, UNIT, type DeptWorld } from "../../../../testing/dept-kpi-seed";

const MIN = 60;

const ctx = (tenantId: string, asOf = "2020-03-31") => ({
  tenantId,
  unitId: UNIT,
  periodKind: "custom" as const,
  start: "2020-03-01",
  end: "2020-03-31",
  asOf,
});

// One publisher org per (tenant, client) and one engagement per client, created on first use.
const orgs = new Map<string, string>();
const engagements = new Map<string, string>();

async function publisherOrg(tenant: string, client: string): Promise<string> {
  const key = `${tenant}/${client}`;
  let id = orgs.get(key);
  if (!id) {
    const { rows } = await adminPool().query<{ id: string }>(
      `INSERT INTO social_publisher_orgs (tenant_id, client_id, postiz_org_id, api_key_ref) VALUES ($1,$2,$3,'test-ref') RETURNING id`,
      [tenant, client, `org-${uuid()}`],
    );
    id = rows[0].id;
    orgs.set(key, id);
  }
  return id;
}
async function account(tenant: string, client: string): Promise<string> {
  const org = await publisherOrg(tenant, client);
  const { rows } = await adminPool().query<{ id: string }>(
    `INSERT INTO social_accounts (tenant_id, client_id, publisher_org_id, network, handle) VALUES ($1,$2,$3,'instagram',$4) RETURNING id`,
    [tenant, client, org, `h-${uuid()}`],
  );
  return rows[0].id;
}
async function engagement(tenant: string, client: string): Promise<string> {
  const key = `${tenant}/${client}`;
  let id = engagements.get(key);
  if (!id) {
    const { rows } = await adminPool().query<{ id: string }>(
      `INSERT INTO social_engagements (tenant_id, client_id, name) VALUES ($1,$2,'Engagement') RETURNING id`,
      [tenant, client],
    );
    id = rows[0].id;
    engagements.set(key, id);
  }
  return id;
}

interface VariantOpts {
  sched?: Date | null;
  postSched?: Date | null;
  published?: Date | null;
  status?: string;
  native?: boolean;
  deleted?: boolean;
}
/** One post + one variant on a fresh account. Returns the variant id. */
async function variant(tenant: string, client: string, o: VariantOpts): Promise<string> {
  const eng = await engagement(tenant, client);
  const acct = await account(tenant, client);
  const post = await adminPool().query<{ id: string }>(
    `INSERT INTO social_posts (tenant_id, engagement_id, title, scheduled_at) VALUES ($1,$2,'Post',$3) RETURNING id`,
    [tenant, eng, o.postSched ?? null],
  );
  const { rows } = await adminPool().query<{ id: string }>(
    `INSERT INTO social_post_variants (tenant_id, post_id, account_id, status, native_import, scheduled_at, published_at, deleted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      tenant,
      post.rows[0].id,
      acct,
      o.native ? "published" : (o.status ?? "approved"),
      o.native ?? false,
      o.sched ?? null,
      o.published ?? null,
      o.deleted ? new Date() : null,
    ],
  );
  return rows[0].id;
}
const plus = (d: Date, seconds: number) => new Date(d.getTime() + seconds * 1000);

describe.skipIf(!TEST_URL)("DW-6n social readers (live PG + RLS)", () => {
  let off: DeptWorld;
  let other: DeptWorld;

  beforeAll(async () => {
    await initTestDb();
    off = await seedDept("DW6n-social Off", []);
    other = await seedDept("DW6n-social Other", ["social"]);
  }, 120_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  // ═════════════════════════════════ n7 postsOnSchedule ═════════════════════════════════
  describe("n7 postsOnSchedule", () => {
    it("counts on time (<= 15 min), 15 min exactly, 16 min late, a child unit's client, unpublished past due and due today; not future", async () => {
      const w = await seedDept("DW6n-n7 A", ["social"]);
      const t = w.tenant;
      const s1 = await at("2020-03-05", 10 * 3600);
      await variant(t, w.clients.inUnit, { sched: s1, published: plus(s1, 5 * MIN) }); // on time
      const s2 = await at("2020-03-06", 10 * 3600);
      await variant(t, w.clients.inUnit, { sched: s2, published: plus(s2, 15 * MIN) }); // exactly 15: on time
      const s3 = await at("2020-03-07", 10 * 3600);
      await variant(t, w.clients.inUnit, { sched: s3, published: plus(s3, 16 * MIN) }); // 16 min late
      const s4 = await at("2020-03-08", 10 * 3600);
      await variant(t, w.clients.child, { sched: s4, published: s4 }); // child unit: on time
      await variant(t, w.clients.inUnit, { sched: await at("2020-03-10", 10 * 3600) }); // unpublished, past due: late
      await variant(t, w.clients.inUnit, { sched: await at("2020-03-20", 10 * 3600) }); // unpublished, due today (asOf): late
      await variant(t, w.clients.inUnit, { sched: await at("2020-03-25", 10 * 3600) }); // unpublished, not yet due: excluded
      const v = await postsOnSchedule(ctx(t, "2020-03-20"));
      expect(v).toEqual({ value: 3 / 6, numerator: 3, denominator: 6 });
      // The same rows judged later: the 03-25 one is now due and late.
      const later = await postsOnSchedule(ctx(t, "2020-03-31"));
      expect(later).toEqual({ value: 3 / 7, numerator: 3, denominator: 7 });
    });

    it("leaves out a sibling unit's client, an internal client, another tenant, never-scheduled, native_import, cancelled and deleted variants", async () => {
      const w = await seedDept("DW6n-n7 B", ["social"]);
      const t = w.tenant;
      const s = await at("2020-03-05", 10 * 3600);
      await variant(t, w.clients.inUnit, { sched: s, published: s }); // the only on-time row
      const lateOf = (client: string, tenant = t) => variant(tenant, client, { sched: s, published: plus(s, 60 * MIN) });
      await lateOf(w.clients.sibling);
      await lateOf(w.clients.internal);
      await lateOf(other.clients.inUnit, other.tenant);
      await variant(t, w.clients.inUnit, { published: s }); // published, never scheduled
      await variant(t, w.clients.inUnit, { sched: s, published: s, native: true });
      await variant(t, w.clients.inUnit, { sched: s, published: plus(s, 60 * MIN), status: "cancelled" });
      await variant(t, w.clients.inUnit, { sched: s, published: plus(s, 60 * MIN), deleted: true });
      // A variant with no slot of its own takes the post's slot.
      const ps = await at("2020-03-09", 10 * 3600);
      await variant(t, w.clients.inUnit, { postSched: ps, published: plus(ps, 2 * MIN) });
      expect(await postsOnSchedule(ctx(t))).toEqual({ value: 1, numerator: 2, denominator: 2 });
    });

    it("window boundaries: first instant in, one second before out, last second in, end + 1 day 00:00 out", async () => {
      const w = await seedDept("DW6n-n7 C", ["social"]);
      const t = w.tenant;
      for (const [slot, inWindow] of [
        [await at("2020-03-01"), true],
        [await at("2020-03-01", -1), false],
        [await at("2020-04-01", -1), true],
        [await at("2020-04-01"), false],
      ] as const) {
        // In-window rows are on time; out-of-window rows are 1 hour late, so a leak would lower the value.
        await variant(t, w.clients.inUnit, { sched: slot, published: inWindow ? slot : plus(slot, 3600) });
      }
      expect(await postsOnSchedule(ctx(t))).toEqual({ value: 1, numerator: 2, denominator: 2 });
    });

    it("is null when nothing qualifies, and null (not an error) when the module is off for the tenant", async () => {
      const w = await seedDept("DW6n-n7 D", ["social"]);
      expect(await postsOnSchedule(ctx(w.tenant))).toBeNull();
      await variant(w.tenant, w.clients.inUnit, { sched: await at("2020-03-25", 36000) }); // not yet due at asOf
      expect(await postsOnSchedule(ctx(w.tenant, "2020-03-20"))).toBeNull();
      // The wall is the declared scope, not companies.enabled_modules: a tenant without the module has no module rows.
      await expect(postsOnSchedule(ctx(off.tenant))).resolves.toBeNull();
    });
  });

  // ═════════════════════════════════ n8 clientApprovalTurnaround ═════════════════════════════════
  describe("n8 clientApprovalTurnaround", () => {
    async function review(world: DeptWorld, client: string, status: string, requested: Date, decided: Date | null) {
      const v = await variant(world.tenant, client, {});
      await adminPool().query(
        `INSERT INTO social_post_client_reviews (tenant_id, variant_id, client_id, status, requested_at, decided_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [world.tenant, v, client, status, requested, decided],
      );
    }

    it("is the mean minutes of two decided reviews (approved + changes_requested); pending and withdrawn are excluded", async () => {
      const w = await seedDept("DW6n-n8 A", ["social"]);
      const d1 = await at("2020-03-10", 12 * 3600);
      await review(w, w.clients.inUnit, "approved", plus(d1, -60 * MIN), d1); // 60
      const d2 = await at("2020-03-12", 12 * 3600);
      await review(w, w.clients.child, "changes_requested", plus(d2, -120 * MIN), d2); // 120
      await review(w, w.clients.inUnit, "pending", plus(d1, -600 * MIN), null);
      await review(w, w.clients.inUnit, "withdrawn", plus(d1, -600 * MIN), d1);
      const v = await clientApprovalTurnaround(ctx(w.tenant));
      expect(v).toEqual({ value: 90 });
      expect(v).not.toHaveProperty("numerator");
    });

    it("excludes a sibling unit's client, an internal client and another tenant; honours the window boundaries", async () => {
      const w = await seedDept("DW6n-n8 B", ["social"]);
      const first = await at("2020-03-01");
      await review(w, w.clients.inUnit, "approved", plus(first, -10 * MIN), first); // 10, first instant: in
      await review(w, w.clients.inUnit, "approved", plus(first, -1 - 1000 * MIN), plus(first, -1)); // one second before: out
      const last = await at("2020-04-01", -1);
      await review(w, w.clients.child, "approved", plus(last, -30 * MIN), last); // 30, last second: in
      const end = await at("2020-04-01");
      await review(w, w.clients.inUnit, "approved", plus(end, -1000 * MIN), end); // end + 1 day 00:00: out
      const mid = await at("2020-03-15");
      await review(w, w.clients.sibling, "approved", plus(mid, -1000 * MIN), mid);
      await review(w, w.clients.internal, "approved", plus(mid, -1000 * MIN), mid);
      await review(other, other.clients.inUnit, "approved", plus(mid, -1000 * MIN), mid);
      expect(await clientApprovalTurnaround(ctx(w.tenant))).toEqual({ value: 20 });
    });

    it("is null with no decided review, and null (not an error) when the module is off", async () => {
      const w = await seedDept("DW6n-n8 C", ["social"]);
      expect(await clientApprovalTurnaround(ctx(w.tenant))).toBeNull();
      const mid = await at("2020-03-15");
      await review(w, w.clients.inUnit, "pending", plus(mid, -60 * MIN), null);
      expect(await clientApprovalTurnaround(ctx(w.tenant))).toBeNull();
      await expect(clientApprovalTurnaround(ctx(off.tenant))).resolves.toBeNull();
    });
  });

  // ═════════════════════════════════ n9 engagementGrowth ═════════════════════════════════
  describe("n9 engagementGrowth", () => {
    // The window is 31 days (2020-03-01..03-31); the previous 31 days are 2020-01-30..2020-02-29.
    async function metric(world: DeptWorld, acct: string, date: string, engagements: number | null) {
      await adminPool().query(`INSERT INTO social_metrics_daily (tenant_id, account_id, date, engagements) VALUES ($1,$2,$3::date,$4)`, [
        world.tenant,
        acct,
        date,
        engagements,
      ]);
    }
    async function series(world: DeptWorld, client: string, prev: number | null, cur: number | null) {
      const a = await account(world.tenant, client);
      if (prev !== null) await metric(world, a, "2020-02-10", prev);
      if (cur !== null) await metric(world, a, "2020-03-10", cur);
      return a;
    }

    it("pools growth over qualifying accounts, with both window edges and the days just outside them", async () => {
      const w = await seedDept("DW6n-n9 A", ["social"]);
      const a = await account(w.tenant, w.clients.inUnit);
      await metric(w, a, "2020-01-29", 999); // one day before prev starts: out
      await metric(w, a, "2020-01-30", 40); // prev first day: in
      await metric(w, a, "2020-02-29", 60); // prev last day: in
      await metric(w, a, "2020-03-01", 100); // cur first day: in
      await metric(w, a, "2020-03-31", 50); // cur last day: in
      await metric(w, a, "2020-04-01", 999); // after the window: out
      await series(w, w.clients.child, 50, 50); // a child unit's client: in
      // Not counted: a sibling, an internal client, another tenant, accounts with data in one window only, a null prev.
      await series(w, w.clients.sibling, 1, 10000);
      await series(w, w.clients.internal, 1, 10000);
      await series(other, other.clients.inUnit, 1, 10000);
      await series(w, w.clients.inUnit, null, 5000); // current only
      await series(w, w.clients.inUnit, 5000, null); // previous only
      const nullPrev = await series(w, w.clients.inUnit, null, 5000);
      await metric(w, nullPrev, "2020-02-11", null); // a row in prev, but engagements is null
      // cur = 150 + 50, prev = 100 + 50
      const v = await engagementGrowth(ctx(w.tenant));
      expect(v!.value).toBeCloseTo(50 / 150, 10);
    });

    it("a running window is measured to date: cur is [start, asOf], prev the same number of days before start", async () => {
      const w = await seedDept("DW6n-n9 D", ["social"]);
      const a = await account(w.tenant, w.clients.inUnit);
      await metric(w, a, "2026-02-18", 999); // before prev starts (Feb 19): out
      await metric(w, a, "2026-02-19", 30); // prev first day: in
      await metric(w, a, "2026-02-28", 70); // prev last day: in
      await metric(w, a, "2026-03-01", 60); // cur first day: in
      await metric(w, a, "2026-03-10", 90); // asOf: in
      await metric(w, a, "2026-03-11", 999); // after asOf: out
      await metric(w, a, "2026-03-31", 999); // window end, after asOf: out
      const running = { ...ctx(w.tenant), start: "2026-03-01", end: "2026-03-31", asOf: "2026-03-10" };
      // L = 10: cur = 150, prev = 100
      expect((await engagementGrowth(running))!.value).toBeCloseTo(0.5, 10);
      // A window that has not begun reads null.
      expect(await engagementGrowth({ ...running, asOf: "2026-02-28" })).toBeNull();
    });

    it("a decline is negative", async () => {
      const w = await seedDept("DW6n-n9 B", ["social"]);
      await series(w, w.clients.inUnit, 100, 50);
      expect((await engagementGrowth(ctx(w.tenant)))!.value).toBeCloseTo(-0.5, 10);
    });

    it("is null when prev is 0, when no account qualifies, and (not an error) when the module is off", async () => {
      const w = await seedDept("DW6n-n9 C", ["social"]);
      expect(await engagementGrowth(ctx(w.tenant))).toBeNull();
      await series(w, w.clients.inUnit, 0, 10);
      expect(await engagementGrowth(ctx(w.tenant))).toBeNull();
      await expect(engagementGrowth(ctx(off.tenant))).resolves.toBeNull();
    });
  });
});
