// IAM-02g — the completeness guard that ends this defect class.
//
// THE DEFECT CLASS (found FOUR TIMES in one day, 2026-08-10, each by a different agent, each by
// accident): a role provisioned at one layer of the stack but not the next.
//   1. named in Cerbos policy + platform-ui's rbac.ts, no `roles` row at all       -> 0091
//   2. baseline roles created only by the manual `seed:agency` script, no migration -> 0095
//   3. `agency_approver`, same shape as #2                                          -> 0096
//   4. a `roles` row exists (so the name IS grantable), but zero `role_permissions`
//      rows back it, so the permission layer resolves it to NOTHING               -> 0097/0098
//      (webdev_staff/webdev_manager — this ticket's own Part 1)
//
// This test targets variant #4 specifically, and is deliberately NOT scoped to "the 20 roles
// this ticket happens to know about" — it DERIVES the full set of global (`company_id IS NULL`)
// roles straight from the `roles` table itself, live, on every run. A future migration that seeds
// a 21st role and forgets its bundle fails THIS test immediately, by name, with no code change
// required here — the same "derive, don't hand-maintain" discipline
// `role-catalog-drift.db.test.ts` (IAM-02d/IAM-02f) already established for role NAMES; this file
// is that guard's sibling for role BUNDLES.
//
// ── THE EXEMPTION ALLOWLIST — DELIBERATELY EMPTY ──────────────────────────────────────────────
// The ticket asked whether any role SHOULD legitimately carry zero permissions before writing an
// allowlist. Considered and rejected:
//   - `client` (portal-only) looked like the best candidate at a glance, but it holds 6 real
//     permissions (`portal.read`/`sign`/`pay`/`decide`/`request_change`/`update_profile` —
//     `resource_portal.yaml`) — not a plausible exemption.
//   - Every one of the 20 currently-seeded global roles is either a broad staff/admin tier or a
//     narrow module/approver tier, and EVERY one of them exists specifically because some Cerbos
//     policy names it — a role that grants literally nothing through the permission layer would be
//     indistinguishable, once IAM-03a/04 make `role_permissions` load-bearing, from the exact
//     silent-nothing failure this whole ticket chain exists to close (a served-company grant that
//     "succeeds" and authorizes nobody for anything). There is no role in this codebase today whose
//     PURPOSE is to be a no-op grant.
//   - A plausible FUTURE exemption is Phase 3's `owner` role (D-8), explicitly noted elsewhere in
//     this program as "not yet defined" — but it does not exist as a seeded `roles` row today, so
//     it is out of scope for a guard that only inspects what is actually seeded. If it lands with a
//     deliberate placeholder-empty bundle, add it here with a comment naming the design doc that
//     authorized it — do not let it slip through by omission.
// Conclusion: the allowlist is empty. That is a STRONGER guarantee than a populated one (every
// seeded global role must resolve to at least one grantable permission, no exceptions), not a
// missing feature — stated plainly per the ticket's own framing.
const EXEMPT_EMPTY_BUNDLE_ROLES: ReadonlySet<string> = new Set([]);

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";

interface RoleBundleCount {
  role_id: string;
  role_name: string;
  bundled: number;
}

/** Live derivation: every global role and how many `role_permissions` rows back it, via a LEFT
 *  JOIN so a role with literally zero bundle rows still appears (count 0) rather than vanishing
 *  from the result set — the exact shape that made variant #4 invisible to a plain INNER JOIN
 *  query in the first place. */
async function loadGlobalRoleBundleCounts(): Promise<RoleBundleCount[]> {
  const { rows } = await adminPool().query<RoleBundleCount>(
    `SELECT r.id AS role_id, r.name AS role_name, count(rp.permission_id)::int AS bundled
       FROM roles r
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
      WHERE r.company_id IS NULL
      GROUP BY r.id, r.name
      ORDER BY r.name`,
  );
  return rows;
}

describe.skipIf(!TEST_URL)("IAM-02g · every seeded global role has a non-empty permission bundle", () => {
  beforeAll(async () => {
    await initTestDb();
  }, 120_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  it("sanity: this is not a near-empty result set (a broken query would pass trivially)", async () => {
    const rows = await loadGlobalRoleBundleCounts();
    expect(rows.length).toBeGreaterThan(5);
  });

  it("every global roles row is either bundled (>0 permissions) or on the (currently empty) exemption allowlist", async () => {
    const rows = await loadGlobalRoleBundleCounts();
    const empty = rows.filter((r) => r.bundled === 0 && !EXEMPT_EMPTY_BUNDLE_ROLES.has(r.role_name));
    expect(
      empty.map((r) => r.role_name),
      `these global 'roles' rows exist (so the name IS grantable) but have ZERO role_permissions ` +
        `rows behind them — the exact IAM-02g defect (variant #4: provisioned at the role layer, ` +
        `not the permission layer). Either this role needs a bundle migration (see 0098 for the ` +
        `pattern), or it belongs on EXEMPT_EMPTY_BUNDLE_ROLES with a written justification (this ` +
        `guard's own header explains why that list is empty today): ` +
        empty.map((r) => r.role_name).join(", "),
    ).toEqual([]);
  });

  it("the exemption allowlist itself never references a role that no longer exists (dead entries would silently widen the guard's blind spot)", async () => {
    const rows = await loadGlobalRoleBundleCounts();
    const liveNames = new Set(rows.map((r) => r.role_name));
    const dangling = [...EXEMPT_EMPTY_BUNDLE_ROLES].filter((n) => !liveNames.has(n));
    expect(dangling, `EXEMPT_EMPTY_BUNDLE_ROLES names a role that isn't even seeded: ${dangling.join(", ")}`).toEqual([]);
  });
});
