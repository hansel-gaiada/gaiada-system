// SM-04 architect-review follow-ups (2026-07-29 P1 gate) — ledger.ts had no dedicated test file;
// sumGlobalMonthToDate() was previously exercised only indirectly through dispatch.test.ts's
// spy-based "fails CLOSED" regression guard. This file adds the two things that guard specifically
// missed:
//
//   1. A SQL-SHAPE assertion, with no live database required, pinning the read-only/aggregate-only
//      invariant the lint-withtenants allowlist entry for this file's cross-tenant withTenants()
//      call is RATIFIED on. lint-withtenants itself has zero SQL awareness (it only classifies the
//      withTenants() first-argument shape), so a future edit widening the callback to select rows
//      would sail past that lint silently. This test is what actually enforces the invariant the
//      allowlist entry's prose only documents — it fails the moment GLOBAL_MTD_QUERY_SQL stops
//      being exactly one scalar aggregate column.
//   2. A smoke test for the short TTL cache added ahead of the same query (the "runs on EVERY paid
//      dispatch, no supporting index, two sequential pool checkouts" cost flagged at the gate).
//
// SM-40 (design addendum §A3.5) extends this file with the identical pair of guards for
// PROVIDER_MTD_QUERY_SQL / sumProviderMonthToDate() — the per-provider tier's cross-tenant
// aggregate, built on the exact same template (see the SM-40 lint-withtenants allowlist entry for
// ledger.ts, which this file's shape pin is the enforcement half of).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { newId, withTenants } from "../../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../testing/setup";
import { createCompany } from "../../../testing/fixtures";
import {
  GLOBAL_MTD_QUERY_SQL,
  PROVIDER_MTD_QUERY_SQL,
  insertLedgerRow,
  resetGlobalMonthToDateCache,
  resetProviderMonthToDateCache,
  sumGlobalMonthToDate,
  sumProviderMonthToDate,
} from "./ledger";

// ─────────────────────────────────────── pure unit (no DB) ──────────────────────────────────────────
describe("GLOBAL_MTD_QUERY_SQL shape — enforces the lint-withtenants ratification", () => {
  it("selects exactly ONE column, and it is an aggregate expression, never a raw row", () => {
    const m = GLOBAL_MTD_QUERY_SQL.match(/^\s*SELECT\s+([\s\S]+?)\s+FROM\s+(\S+)/i);
    expect(m).not.toBeNull();
    const [, columnList, table] = m!;
    expect(table).toBe("search_provider_calls");
    // Depth-agnostic here is fine: COALESCE(sum(cost_usd), 0) has an internal comma, but it's
    // inside parens, so a naive split WOULD wrongly report 2 — assert on the whole trimmed
    // projection instead, which is the thing that actually matters: it is a SINGLE aggregate
    // expression aliased once, not "expr1, expr2, ...".
    const trimmed = columnList.trim();
    expect(trimmed).toMatch(/^COALESCE\(\s*sum\(cost_usd\)\s*,\s*0\s*\)\s+AS\s+n$/i);
    // No row-identifying or client-private column may ever appear in this projection.
    expect(GLOBAL_MTD_QUERY_SQL).not.toMatch(/\b(id|tenant_id|engagement_id|property_id|requested_by|correlation_id|provider|endpoint)\b/i);
  });

  it("is a single read-only statement — no mutation keywords, no second statement", () => {
    expect(GLOBAL_MTD_QUERY_SQL).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|GRANT|REVOKE)\b/i);
    expect(GLOBAL_MTD_QUERY_SQL.trim().includes(";")).toBe(false); // no statement-stacking
  });

  it("the WHERE clause bounds to the calendar month and nothing narrower/wider by accident", () => {
    expect(GLOBAL_MTD_QUERY_SQL).toMatch(/WHERE\s+date_trunc\('month',\s*created_at\)\s*=\s*date_trunc\('month',\s*now\(\)\)/i);
  });

  // ── QA gate 2026-07-29 — closes a real bypass found by mutation-testing THIS pin ───────────────────
  // The "selects exactly ONE column" test above only anchors the FIRST token after FROM (`\S+`,
  // which stops at the next whitespace) — it never asserts that nothing sits between the table name
  // and WHERE. A query with `FROM search_provider_calls INNER JOIN search_engagements se ON
  // se.provider_budget_usd > 0 WHERE ...` passes EVERY assertion above (table capture is unaffected,
  // the join's ON-condition uses no blocklisted column name, it isn't a mutation keyword, it has no
  // semicolon, and it sits before WHERE so it isn't counted by the AND/OR checks either — proven by
  // reproducing it standalone against these exact assertions before writing this test). A join like
  // that can silently narrow the aggregate (under-counting spend is the FAIL-OPEN direction for a
  // ceiling meant to bound it) or smuggle in a join column the blocklist doesn't happen to name. This
  // test closes the gap directly: FROM must be followed by the table name and then WHERE, with
  // nothing else between them.
  it("nothing sits between the table name and WHERE — no join, no subquery, no second clause", () => {
    expect(GLOBAL_MTD_QUERY_SQL).toMatch(/FROM\s+search_provider_calls\s+WHERE\s+/i);
  });

  // ── SM-33 (2026-07-29) — DELIBERATE AMENDMENT to this pinned shape, per design addendum §A4.1 ──────
  // The addendum's warning is explicit: this constant is the enforcement half of a RATIFIED
  // lint-withtenants allowlist entry, so the shape assertion must be amended openly rather than
  // loosened or worked around. What the ratification rests on is unchanged and still pinned by the
  // three tests above: ONE scalar aggregate column, read-only, single statement, no row-identifying
  // or client-private column. What changed is that the platform ceiling is now MODE-FILTERED like
  // every other budget tier — simulated and real spend bind their own disjoint ledgers — so the
  // query carries one more predicate. These two tests pin the NEW half, and they are deliberately
  // stricter than "a predicate exists": they pin that it is PARAMETERIZED and that neither mode is
  // hardcoded, because a literal `simulated = false` here would make the live ceiling permanently
  // blind to the simulate ledger AND vice versa — and a literal `true` would leave real spend
  // unbounded, which is precisely the §4d fail-open class this file exists to prevent.
  it("carries the mode filter as a BOUND PARAMETER, never a hardcoded mode", () => {
    expect(GLOBAL_MTD_QUERY_SQL).toMatch(/AND\s+simulated\s*=\s*\$1\b/i);
    expect(GLOBAL_MTD_QUERY_SQL).not.toMatch(/simulated\s*=\s*(true|false)\b/i);
    // Exactly one placeholder: the mode. A second parameter would mean the query grew another
    // predicate without this pin being re-reviewed.
    expect(GLOBAL_MTD_QUERY_SQL.match(/\$\d+/g)).toEqual(["$1"]);
  });

  it("the mode filter is ANDed onto the month bound, never ORed or applied to a wider scope", () => {
    // An OR here would silently union the two ledgers back together — the failure mode that makes
    // "mode-filtered budgets" a lie while still looking like a filter in review.
    expect(GLOBAL_MTD_QUERY_SQL).not.toMatch(/\bOR\b/i);
    const where = GLOBAL_MTD_QUERY_SQL.slice(GLOBAL_MTD_QUERY_SQL.search(/WHERE/i));
    expect(where.match(/\bAND\b/gi)).toHaveLength(1);
  });
});

// ─────────────────────────────────────── integration (live PG) ──────────────────────────────────────
describe.skipIf(!TEST_URL)("sumGlobalMonthToDate — short TTL cache (SM-04 gate follow-up, 2026-07-29)", () => {
  beforeAll(async () => {
    await initTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(() => {
    resetGlobalMonthToDateCache();
  });

  it("returns a finite non-negative number", async () => {
    const v = await sumGlobalMonthToDate();
    expect(typeof v).toBe("number");
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(0);
  });

  it("a second call within the TTL window returns the SAME cached value (no re-query surprises)", async () => {
    const first = await sumGlobalMonthToDate();
    const second = await sumGlobalMonthToDate();
    expect(second).toBe(first);
  });

  it("the TTL cache is keyed PER MODE — a mode flip never serves the other ledger's total (SM-33)", async () => {
    // One shared cache slot would let a live dispatch be evaluated against simulated spend (or the
    // reverse) for up to the TTL window — a fail-open on the platform ceiling that no WHERE clause
    // would reveal, because the query would be right and the value stale-from-the-wrong-partition.
    const live = await sumGlobalMonthToDate(false);
    const sim = await sumGlobalMonthToDate(true);
    expect(typeof sim).toBe("number");
    // Both are cached independently and each keeps returning its OWN value on re-read.
    expect(await sumGlobalMonthToDate(false)).toBe(live);
    expect(await sumGlobalMonthToDate(true)).toBe(sim);
  });

  it("resetGlobalMonthToDateCache() forces a real recompute that still succeeds standalone", async () => {
    const first = await sumGlobalMonthToDate();
    resetGlobalMonthToDateCache();
    const second = await sumGlobalMonthToDate();
    expect(typeof second).toBe("number");
    expect(Number.isFinite(second)).toBe(true);
    // Value equality is expected here too (no spend happened between calls in this test) — the
    // point of this test is that the RECOMPUTE path (cache miss) still works on its own, not that
    // it differs from the cached path.
    expect(second).toBe(first);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// SM-40 (design addendum §A3.5) — PROVIDER_MTD_QUERY_SQL / sumProviderMonthToDate(): the per-provider
// ceiling's cross-tenant aggregate. Built on the SM-04/§4d template verbatim: same shape-pin
// discipline (structure anchored, not a table-name token — the §6d lesson), same
// mode-filtered-and-TTL-cached-per-partition discipline (§A4.1/SM-33), plus one more axis this tier
// adds: the cache and the WHERE clause must ALSO partition by `provider`, or a second vendor's
// dispatch could read (or be bounded by) the first vendor's month-to-date figure.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("PROVIDER_MTD_QUERY_SQL shape — the SM-40 provider-tier cross-tenant aggregate", () => {
  it("selects exactly ONE column, and it is an aggregate expression, never a raw row", () => {
    const m = PROVIDER_MTD_QUERY_SQL.match(/^\s*SELECT\s+([\s\S]+?)\s+FROM\s+(\S+)/i);
    expect(m).not.toBeNull();
    const [, columnList, table] = m!;
    expect(table).toBe("search_provider_calls");
    const trimmed = columnList.trim();
    expect(trimmed).toMatch(/^COALESCE\(\s*sum\(cost_usd\)\s*,\s*0\s*\)\s+AS\s+n$/i);
    // No row-identifying or OTHER client-private column may appear in the PROJECTION. `provider`
    // is deliberately NOT in this blocklist for this query (unlike GLOBAL_MTD_QUERY_SQL's): the
    // WHERE clause legitimately filters on it — that IS this tier's whole purpose — so the
    // assertion is scoped to the SELECT list only, where it must never appear.
    expect(columnList).not.toMatch(/\b(id|tenant_id|engagement_id|property_id|requested_by|correlation_id|endpoint)\b/i);
    expect(columnList).not.toMatch(/\bprovider\b/i);
  });

  it("is a single read-only statement — no mutation keywords, no second statement", () => {
    expect(PROVIDER_MTD_QUERY_SQL).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|GRANT|REVOKE)\b/i);
    expect(PROVIDER_MTD_QUERY_SQL.trim().includes(";")).toBe(false);
  });

  it("the WHERE clause bounds to the calendar month and nothing narrower/wider by accident", () => {
    expect(PROVIDER_MTD_QUERY_SQL).toMatch(/WHERE\s+date_trunc\('month',\s*created_at\)\s*=\s*date_trunc\('month',\s*now\(\)\)/i);
  });

  // ── The §6d lesson, applied preemptively: anchor STRUCTURE, not a table-name token ──────────────
  // GLOBAL_MTD_QUERY_SQL's original pin only anchored the first token after FROM, which a QA gate
  // proved bypassable with `FROM search_provider_calls INNER JOIN ... ON ... WHERE ...` — the join
  // sits before WHERE, names no blocklisted column, and isn't a mutation keyword, so it passed every
  // other assertion. This query's pin is written with that lesson already applied: nothing may sit
  // between the table name and WHERE.
  it("nothing sits between the table name and WHERE — no join, no subquery, no second clause", () => {
    expect(PROVIDER_MTD_QUERY_SQL).toMatch(/FROM\s+search_provider_calls\s+WHERE\s+/i);
  });

  it("carries the mode filter as a BOUND PARAMETER, never a hardcoded mode", () => {
    expect(PROVIDER_MTD_QUERY_SQL).toMatch(/AND\s+simulated\s*=\s*\$1\b/i);
    expect(PROVIDER_MTD_QUERY_SQL).not.toMatch(/simulated\s*=\s*(true|false)\b/i);
  });

  it("carries the provider filter as a BOUND PARAMETER, never an interpolated/hardcoded provider key", () => {
    expect(PROVIDER_MTD_QUERY_SQL).toMatch(/AND\s+provider\s*=\s*\$2\b/i);
    // No provider key string-literal anywhere in the query text (would mean the predicate was
    // interpolated rather than bound, or hardcoded to one vendor).
    expect(PROVIDER_MTD_QUERY_SQL).not.toMatch(/provider\s*=\s*'[^']*'/i);
  });

  it("carries EXACTLY two placeholders — mode and provider — never a third undeclared predicate", () => {
    expect(PROVIDER_MTD_QUERY_SQL.match(/\$\d+/g)).toEqual(["$1", "$2"]);
  });

  it("both predicates are ANDed onto the month bound, never ORed or applied to a wider scope", () => {
    expect(PROVIDER_MTD_QUERY_SQL).not.toMatch(/\bOR\b/i);
    const where = PROVIDER_MTD_QUERY_SQL.slice(PROVIDER_MTD_QUERY_SQL.search(/WHERE/i));
    expect(where.match(/\bAND\b/gi)).toHaveLength(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// SM-50 (design addendum §A11.2 #1-#5) — THE STATUS-BLINDNESS PROHIBITION, pinned MECHANICALLY.
//
// The whole ruling rests on one verified fact: every money sum over search_provider_calls is
// status-blind, so a row recording "the vendor charged us and delivered nothing" binds every budget
// tier and the exec rollup with ZERO changes to any query. That property is free to acquire and
// trivially easy to destroy — one plausible-looking "AND status <> 'incurred'" added by someone
// tidying up a ceiling, and real deposit burn silently stops counting against the cap that exists to
// bound it. It would review as a cleanup and behave as a fail-open.
//
// The §A11.2 disposition is explicit that the pinned shapes "must NOT gain a status predicate" and
// that the pin should block it MECHANICALLY, not by prose. These tests are that block for the two
// exported constants; incurred-cost.test.ts's AC3/AC3c pin the same property behaviourally, on the
// arithmetic a budget tier actually performs, for sumMonthToDate (which builds its SQL at runtime and
// so has no constant to anchor).
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("SM-50 — the money sums must stay STATUS-BLIND (addendum §A11.2)", () => {
  for (const [name, sql] of [
    ["GLOBAL_MTD_QUERY_SQL", GLOBAL_MTD_QUERY_SQL],
    ["PROVIDER_MTD_QUERY_SQL", PROVIDER_MTD_QUERY_SQL],
  ] as const) {
    it(`${name} carries NO status predicate — incurred spend must never be exempt from a ceiling`, () => {
      // Any mention of the column at all, in any position, is the tripwire: there is no legitimate
      // reason for a month-to-date money aggregate to know about status, and a narrower assertion
      // (e.g. only "status <>") would miss `status IN (...)`, `status = 'posted'`, a FILTER clause, or
      // a CASE expression that reaches the same fail-open by another route.
      expect(sql).not.toMatch(/\bstatus\b/i);
      // Nor may the amount itself be made conditional — same fail-open, different syntax.
      expect(sql).not.toMatch(/\b(FILTER|CASE)\b/i);
    });
  }

  it("the placeholder count is still exactly what each query declares — no smuggled extra predicate", () => {
    // A new predicate cannot arrive without a new bound parameter (interpolation is already forbidden
    // by the tests above), so pinning the parameter count catches the addition even if a future author
    // names the column something this file does not blocklist.
    expect(GLOBAL_MTD_QUERY_SQL.match(/\$\d+/g)).toEqual(["$1"]);
    expect(PROVIDER_MTD_QUERY_SQL.match(/\$\d+/g)).toEqual(["$1", "$2"]);
  });
});

describe.skipIf(!TEST_URL)("sumProviderMonthToDate — filtering + mode + TTL cache (SM-40)", () => {
  let tenant: string;

  beforeAll(async () => {
    await initTestDb();
    tenant = await createCompany("SM-40 Provider-Ceiling Co", ["search"]);
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(() => {
    resetProviderMonthToDateCache();
  });

  /** Insert one ledger row for an arbitrary (test-unique) provider key, directly — no engagement
   *  needed (engagement_id is nullable on search_provider_calls), so this is isolated from any
   *  fixture the dispatch-level suites create. */
  async function seedRow(providerKey: string, costUsd: number, simulated: boolean): Promise<void> {
    await withTenants(
      [tenant],
      (c) => insertLedgerRow(c, {
        tenantId: tenant, engagementId: null, provider: providerKey, endpoint: "seed.sm40",
        items: 1, costUsd, cacheHit: false, status: "completed", requestedBy: null, simulated,
      }),
      { modules: ["search"] },
    );
  }

  let seq = 0;
  const uniqueProvider = (label: string) => `sm40-${label}-${Date.now()}-${seq++}`;

  it("returns a finite non-negative number for a provider with no spend yet", async () => {
    const v = await sumProviderMonthToDate(uniqueProvider("empty"));
    expect(typeof v).toBe("number");
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBe(0);
  });

  it("sums exactly this provider's spend, and no other's — the FILTER, proven directly", async () => {
    const a = uniqueProvider("filter-a");
    const b = uniqueProvider("filter-b");
    await seedRow(a, 7, false);
    await seedRow(a, 3, false);
    await seedRow(b, 100, false); // a DIFFERENT provider — must never leak into `a`'s sum
    expect(await sumProviderMonthToDate(a)).toBeCloseTo(10, 6);
    expect(await sumProviderMonthToDate(b)).toBeCloseTo(100, 6);
  });

  it("is mode-filtered on a MIXED table — each mode sees only its own rows, for the SAME provider (§A4.1)", async () => {
    const p = uniqueProvider("mixed");
    await seedRow(p, 7, false); // REAL
    await seedRow(p, 3, false); // REAL
    await seedRow(p, 100, true); // SIMULATED
    // The fail-open shape this forecloses is live mode DROPPING real rows: assert the exact real
    // total, not merely "less than everything".
    expect(await sumProviderMonthToDate(p, false)).toBeCloseTo(10, 6);
    expect(await sumProviderMonthToDate(p, true)).toBeCloseTo(100, 6);
    // Default = live: an un-migrated caller keeps its old meaning (real rows only).
    expect(await sumProviderMonthToDate(p)).toBeCloseTo(10, 6);
  });

  it("the TTL cache is keyed PER (provider, mode) — neither a different provider nor a mode flip ever serves the wrong slot", async () => {
    const a = uniqueProvider("cache-a");
    const b = uniqueProvider("cache-b");
    await seedRow(a, 5, false);
    await seedRow(b, 50, false);
    await seedRow(a, 500, true);

    const aLive = await sumProviderMonthToDate(a, false);
    const bLive = await sumProviderMonthToDate(b, false);
    const aSim = await sumProviderMonthToDate(a, true);
    expect(aLive).toBeCloseTo(5, 6);
    expect(bLive).toBeCloseTo(50, 6);
    expect(aSim).toBeCloseTo(500, 6);
    // Re-reads within the TTL window keep returning each slot's OWN cached value — no cross-slot
    // bleed between providers, and none between modes for the SAME provider.
    expect(await sumProviderMonthToDate(a, false)).toBe(aLive);
    expect(await sumProviderMonthToDate(b, false)).toBe(bLive);
    expect(await sumProviderMonthToDate(a, true)).toBe(aSim);
  });

  it("resetProviderMonthToDateCache() forces a real recompute that still succeeds standalone", async () => {
    const p = uniqueProvider("reset");
    await seedRow(p, 42, false);
    const first = await sumProviderMonthToDate(p);
    resetProviderMonthToDateCache();
    const second = await sumProviderMonthToDate(p);
    expect(second).toBe(first);
    expect(second).toBeCloseTo(42, 6);
  });
});
