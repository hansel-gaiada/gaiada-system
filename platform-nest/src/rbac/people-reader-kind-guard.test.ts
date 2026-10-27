// T18 (agentic-native close-out, exit item 3) — a STATIC RATCHET: no people surface may ask
// `company_memberships.kind` alone whether a row is a person.
//
//   `company_memberships.kind` = WHY an account is in this company (employee | service)
//   `users.kind`               = WHAT the account IS (employee | client | automation | bot | contributor)
//
// A reader that filters people by the membership column alone lists a contributor (a freelance writer, who
// holds an `employee`-kind membership as the anchor of the engagement) and any bot someone seeded with the
// default membership kind. The fix is `u.kind = 'employee'` in the same predicate (see users-kind-readers.db.test.ts).
//
// THE RULE. Over every non-test `src/**/*.ts` file, each SQL string (a template literal or quoted string)
// that reads `company_memberships` and has a membership-kind PREDICATE (`WHERE|AND|OR|ON [alias.]kind =|<>|!=|IN`)
// must also carry a `u.kind` / `users.kind` predicate. A `SET kind = ...` write, an `INSERT` column list and
// a bare `SELECT kind` are not predicates and are ignored. Migrations are SQL, not scanned.
//
// THE RATCHET. Known, reasoned exceptions are listed below with a count per file. A new file, or a count
// that goes up, FAILS; a count that goes down fails with "lower the allowlist" so the list can only shrink.
// Never add an entry to make a new reader pass: add `u.kind = 'employee'` to the reader.
// This test needs no database.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** file (relative to src/, posix) -> number of membership-kind predicates that are allowed to stand alone. */
export const MEMBERSHIP_KIND_ALLOWLIST: Record<string, { count: number; reason: string }> = {
  "admin/service-reconciler.ts": {
    count: 1,
    reason:
      "UPDATE company_memberships ... WHERE kind = 'service' AND managed_by IS NOT NULL: asks whether a MEMBERSHIP row is " +
      "reconciler-owned, a placement state, not whether a user is a person.",
  },
};

/** Pull the SQL-looking strings out of a TypeScript source: every template literal, plus "..." and '...' strings. */
export function sqlStrings(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/`((?:\\.|[^`\\])*)`|"((?:\\.|[^"\\\n])*)"|'((?:\\.|[^'\\\n])*)'/g)) {
    const s = m[1] ?? m[2] ?? m[3] ?? "";
    if (/company_memberships/i.test(s)) out.push(s);
  }
  return out;
}

const PREDICATE = /\b(?:WHERE|AND|OR|ON)\s+(?:(\w+)\.)?kind\s*(?:=|<>|!=|\bNOT\s+IN\b|\bIN\b)/gi;

/** Membership-kind predicates in one SQL string that has no users.kind predicate beside them. */
export function aloneMembershipKindPredicates(sql: string): number {
  const preds = [...sql.matchAll(PREDICATE)].filter((m) => !/^(u|users)$/i.test(m[1] ?? ""));
  if (preds.length === 0) return 0;
  if (/\b(?:u|users)\.kind\b/i.test(sql)) return 0; // the person test is in this query
  return preds.length;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(e) && !/\.(test|spec)\.ts$/.test(e) && !/\.d\.ts$/.test(e)) out.push(p);
  }
  return out;
}

export function scan(root: string): Record<string, number> {
  const found: Record<string, number> = {};
  for (const f of walk(root)) {
    const rel = relative(root, f).split(sep).join("/");
    if (rel.startsWith("testing/")) continue;
    let n = 0;
    for (const s of sqlStrings(readFileSync(f, "utf8"))) n += aloneMembershipKindPredicates(s);
    if (n) found[rel] = n;
  }
  return found;
}

describe("T18 · people readers never filter by company_memberships.kind alone", () => {
  const found = scan(join(__dirname, ".."));

  it("no file outside the allowlist has a membership-kind predicate without users.kind", () => {
    const offenders = Object.entries(found).filter(([f]) => !(f in MEMBERSHIP_KIND_ALLOWLIST));
    expect(
      offenders,
      "a reader filters people by company_memberships.kind alone: a contributor, bot or automation account with an " +
        "employee-kind membership would be listed as a person. Add `JOIN users u ON u.id = <m>.user_id` and " +
        "`u.kind = 'employee'` to the query. Do not add an allowlist entry for a people reader.",
    ).toEqual([]);
  });

  it("a listed file does not exceed its count, and the list only shrinks", () => {
    for (const [f, { count }] of Object.entries(MEMBERSHIP_KIND_ALLOWLIST)) {
      const n = found[f] ?? 0;
      expect(n, `${f} gained a membership-kind predicate`).toBeLessThanOrEqual(count);
      expect(n, `${f} is below its allowlisted count: lower MEMBERSHIP_KIND_ALLOWLIST`).toBeGreaterThanOrEqual(count);
    }
  });

  it("the detector has teeth: it flags the old shapes and passes the repointed one", () => {
    const old = "SELECT cm.user_id FROM company_memberships cm JOIN users u ON u.id = cm.user_id WHERE cm.kind = 'employee' AND cm.status = 'active'";
    expect(aloneMembershipKindPredicates(old)).toBe(1);
    expect(aloneMembershipKindPredicates("SELECT m.user_id FROM company_memberships m WHERE m.kind = 'employee'")).toBe(1);
    expect(aloneMembershipKindPredicates("SELECT user_id FROM company_memberships WHERE tenant_id = $1 AND kind IN ('employee')")).toBe(1);
    expect(aloneMembershipKindPredicates(old.replace("WHERE cm.kind", "WHERE u.kind = 'employee' AND cm.kind"))).toBe(0);
    // not predicates
    expect(aloneMembershipKindPredicates("INSERT INTO company_memberships (id, kind) VALUES ($1, 'employee') ON CONFLICT (id) DO UPDATE SET kind = 'employee'")).toBe(0);
    expect(aloneMembershipKindPredicates("SELECT id, kind, managed_by FROM company_memberships WHERE tenant_id = $1")).toBe(0);
    expect(sqlStrings("const q = `SELECT 1 FROM company_memberships m WHERE m.kind = 'employee'`;")).toHaveLength(1);
  });
});
