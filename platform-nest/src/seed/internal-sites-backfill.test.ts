// M6-P3b — the internal webdev_sites backfill. Pure parser + planner always run; the DB half (idempotency,
// one transaction, module RLS scope, tenant isolation) runs when DATABASE_URL_TEST is set.
// Domains are example.com-style: the repo is public and the real list lives in a gitignored *.local.* file.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants } from "../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createClient } from "../testing/fixtures";
import { createWebdevSite } from "../modules/webdev/site-registry.service";
import {
  parseArgs, parseDomainsFile, planBackfill, runBackfill, BackfillRefusal, type BackfillState,
} from "./internal-sites-backfill";

const TENANT = "0198a1b2-0000-7000-8000-000000000002";
const SENTINEL = "0198a1b2-0000-7000-8000-0000000000aa";
const empty: BackfillState = { sentinelIds: [SENTINEL], rows: [] };

describe("internal-sites-backfill: parseDomainsFile", () => {
  it("ignores blank lines and # comments, trims, lower-cases and de-duplicates", () => {
    const text = [
      "# internal sites, owner list",
      "",
      "   ",
      "  Site-One.example.com  ",
      "# site-two is parked, do not touch",
      "site-two.example.com",
      "SITE-ONE.example.com",
      "",
    ].join("\r\n");
    expect(parseDomainsFile(text)).toEqual(["site-one.example.com", "site-two.example.com"]);
  });
  it("refuses a line with inner whitespace", () => {
    expect(() => parseDomainsFile("a b.example.com\n")).toThrow(BackfillRefusal);
  });
  it("refuses a file that lists no domains", () => {
    expect(() => parseDomainsFile("# nothing here\n\n")).toThrow(BackfillRefusal);
  });
});

describe("internal-sites-backfill: parseArgs", () => {
  it("defaults to a dry run", () => {
    expect(parseArgs(["--tenant-id", TENANT, "--domains-file", "list.local.txt"])).toEqual({
      tenantId: TENANT, domainsFile: "list.local.txt", apply: false,
    });
  });
  it("--apply turns writes on", () => {
    expect(parseArgs(["--tenant-id", TENANT, "--domains-file", "f", "--apply"]).apply).toBe(true);
  });
  it.each([
    [["--domains-file", "f"]],
    [["--tenant-id", TENANT]],
    [["--tenant-id", "nope", "--domains-file", "f"]],
    [["--tenant-id", TENANT, "--domains-file", "f", "--bogus"]],
    [["--tenant-id", TENANT, "--domains-file", "--apply"]],
  ])("refuses %j", (argv) => {
    expect(() => parseArgs(argv)).toThrow(BackfillRefusal);
  });
});

describe("internal-sites-backfill: planBackfill", () => {
  const domains = ["a.example.com", "b.example.com", "gone.example.com"];

  it("NULL rows are planned as set, and missing domains are reported, not refused", () => {
    const p = planBackfill({ ...empty, rows: [
      { id: "s1", domain: "a.example.com", clientId: null },
      { id: "s2", domain: "b.example.com", clientId: null },
    ] }, domains);
    expect(p.refusals).toEqual([]);
    expect(p.writes).toBe(true);
    expect(p.lines.map((l) => `${l.domain}:${l.action}`)).toEqual([
      "a.example.com:set", "b.example.com:set", "gone.example.com:missing",
    ]);
  });
  it("a second run, once everything is on the sentinel, plans already and writes nothing", () => {
    const p = planBackfill({ ...empty, rows: [
      { id: "s1", domain: "a.example.com", clientId: SENTINEL },
    ] }, ["a.example.com"]);
    expect(p.writes).toBe(false);
    expect(p.refusals).toEqual([]);
    expect(p.lines[0].action).toBe("already");
  });
  it("a row on a DIFFERENT client is REFUSE; the whole plan writes nothing", () => {
    const p = planBackfill({ ...empty, rows: [
      { id: "s1", domain: "a.example.com", clientId: "real-client" },
      { id: "s2", domain: "b.example.com", clientId: null },
    ] }, ["a.example.com", "b.example.com"]);
    expect(p.refusals).toHaveLength(1);
    expect(p.refusals[0]).toContain("never overwrites a real client");
    expect(p.lines.map((l) => l.action)).toEqual(["REFUSE", "set"]);
    expect(p.writes).toBe(false);
  });
  it("no sentinel is a refusal", () => {
    const p = planBackfill({ sentinelIds: [], rows: [{ id: "s1", domain: "a.example.com", clientId: null }] }, ["a.example.com"]);
    expect(p.refusals).toHaveLength(1);
    expect(p.sentinelId).toBeNull();
    expect(p.writes).toBe(false);
  });
  it("two sentinels is a refusal", () => {
    const p = planBackfill({ sentinelIds: ["x", "y"], rows: [] }, ["a.example.com"]);
    expect(p.refusals).toHaveLength(1);
    expect(p.writes).toBe(false);
  });
});

describe.skipIf(!TEST_URL)("internal-sites-backfill: against Postgres", () => {
  beforeAll(async () => {
    await initTestDb();
  });
  afterAll(async () => { await teardownTestDb(); });

  // The DB allows one live internal client per tenant (unique index of 202610111100), so "two sentinels" is
  // covered by the pure planner test above, not here.
  const addSentinel = (t: string) => withTenants([t], (c) => c.query<{ id: string }>(
    `INSERT INTO clients (id, tenant_id, name, origin_site, is_internal)
     VALUES (gen_random_uuid(), $1, 'Backfill internal (test)', 'central', true) RETURNING id`, [t]).then((r) => r.rows[0].id));

  const siteClient = (t: string, siteId: string) => withTenants([t], (c) => c.query<{ client_id: string | null }>(
    `SELECT client_id FROM webdev_sites WHERE id = $1`, [siteId]).then((r) => r.rows[0].client_id), { modules: ["webdev"] });

  it("dry run writes nothing", async () => {
    const t = await createCompany("Backfill dry");
    const sentinel = await addSentinel(t);
    const s = await createWebdevSite(t, { domain: "backfill-dry.example.com" }, null);
    const r = await runBackfill({ tenantId: t, domains: ["backfill-dry.example.com"], apply: false });
    expect(r.applied).toBe(false);
    expect(r.plan.lines[0].action).toBe("set");
    expect(r.lines.join("\n")).toContain("DRY RUN: nothing was written");
    expect(await siteClient(t, s.id)).toBeNull();
    expect(sentinel).toBeTruthy();
  });

  it("apply sets NULL rows in one transaction, emits an event, and a second apply is a no-op", async () => {
    const t = await createCompany("Backfill apply");
    const sentinel = await addSentinel(t);
    const s = await createWebdevSite(t, { domain: "backfill-apply.example.com" }, null);

    const first = await runBackfill({ tenantId: t, domains: ["backfill-apply.example.com"], apply: true });
    expect(first.applied).toBe(true);
    expect(first.changed).toBe(1);
    expect(first.plan.lines[0].action).toBe("set"); // scope declared: the row is visible, not "missing"
    expect(await siteClient(t, s.id)).toBe(sentinel);
    const events = await withTenants([t], (c) => c.query<{ event_type: string }>(
      `SELECT event_type FROM outbox_events WHERE entity_id = $1`, [s.id]), { modules: ["webdev"] });
    expect(events.rows.map((e) => e.event_type)).toContain("webdev.site.client_backfilled");

    const second = await runBackfill({ tenantId: t, domains: ["backfill-apply.example.com"], apply: true });
    expect(second.applied).toBe(false);
    expect(second.changed).toBe(0);
    expect(second.plan.lines[0].action).toBe("already");
    expect(await siteClient(t, s.id)).toBe(sentinel);
  });

  it("a row on a real client is REFUSE: nothing is written, not even the NULL row beside it", async () => {
    const t = await createCompany("Backfill refuse");
    await addSentinel(t);
    const real = await createClient(t, "Backfill real client");
    const bound = await createWebdevSite(t, { domain: "backfill-real.example.com", clientId: real }, null);
    const free = await createWebdevSite(t, { domain: "backfill-free.example.com" }, null);

    const r = await runBackfill({ tenantId: t, domains: ["backfill-free.example.com", "backfill-real.example.com"], apply: true });
    expect(r.applied).toBe(false);
    expect(r.plan.refusals).toHaveLength(1);
    expect(r.lines.join("\n")).toContain("REFUSED:");
    expect(await siteClient(t, bound.id)).toBe(real);
    expect(await siteClient(t, free.id)).toBeNull();
  });

  it("no sentinel means refusal and nothing written", async () => {
    const t = await createCompany("Backfill no sentinel");
    const s = await createWebdevSite(t, { domain: "backfill-nosent.example.com" }, null);
    const r = await runBackfill({ tenantId: t, domains: ["backfill-nosent.example.com"], apply: true });
    expect(r.applied).toBe(false);
    expect(r.plan.refusals[0]).toContain("no internal sentinel client");
    expect(await siteClient(t, s.id)).toBeNull();
  });

  it("missing domains are reported as missing, not refused", async () => {
    const t = await createCompany("Backfill missing");
    const sentinel = await addSentinel(t);
    const s = await createWebdevSite(t, { domain: "backfill-here.example.com" }, null);
    const r = await runBackfill({ tenantId: t, domains: ["backfill-here.example.com", "backfill-absent.example.com"], apply: true });
    expect(r.plan.refusals).toEqual([]);
    expect(r.lines.join("\n")).toContain("missing  backfill-absent.example.com");
    expect(r.changed).toBe(1);
    expect(await siteClient(t, s.id)).toBe(sentinel);
  });

  it("is tenant-scoped: a same-named row in another tenant is never touched", async () => {
    const t = await createCompany("Backfill scope A");
    const other = await createCompany("Backfill scope B");
    const sentinel = await addSentinel(t);
    const mine = await createWebdevSite(t, { domain: "backfill-shared.example.com" }, null);
    const theirs = await createWebdevSite(other, { domain: "backfill-shared.example.com" }, null);

    const r = await runBackfill({ tenantId: t, domains: ["backfill-shared.example.com"], apply: true });
    expect(r.changed).toBe(1);
    expect(await siteClient(t, mine.id)).toBe(sentinel);
    expect(await siteClient(other, theirs.id)).toBeNull();
  });
});
