// Type declaration for `generate-role-bundles.mjs` (IAM-02h single source of truth for
// REAL_ROLES). Kept hand-written (not `.d.ts` generated) because the script is plain ESM run
// standalone via `node` and is intentionally not compiled/type-checked itself; this file exists
// solely so `.ts` importers (the two `.db.test.ts` parity/bundle suites) get real types instead
// of an implicit `any`, per IAM-FIX-TYPES.
//
// Shape mirrors the script's actual exports (scripts/generate-role-bundles.mjs):
//   - `REAL_ROLES`: the 20 real, nameable Cerbos roles, as a readonly tuple so importers get
//     literal-typed elements (role-permission-parity.db.test.ts derives
//     `type RealRole = (typeof REAL_ROLES)[number]` from it). HIER-2/0102 added `org_unit_lead`
//     (20 -> 21); HIER-3 (2026-08-11) retired `team_lead` (21 -> 20) — keep this tuple in lockstep
//     with the .mjs's own REAL_ROLES array; a mismatch here is a TS error at every importer, not a
//     silent drift, which is the point of hand-writing it rather than inferring `string[]`.
//   - `generate()`: builds the full role-permission-bundles.json document in memory.
//   - `serialize(doc)`: the exact `JSON.stringify(doc, null, 2) + "\n"` byte-for-byte
//     serialization the checked-in file must match.

export const REAL_ROLES: readonly [
  "platform_admin", "company_admin", "group_executive", "manager", "member", "viewer",
  "org_unit_lead", "client", "it_admin", "it_manager", "it",
  "agency_approver",
  "hr_staff", "hr_manager",
  "search_staff", "search_manager",
  "reports_staff", "reports_manager",
  "webdev_staff", "webdev_manager",
];

export interface RoleBundleDoc {
  _meta: {
    title: string;
    status: string;
    source: string;
    generatedBy: string;
    regenerate: string;
    rulings: string;
    companionDocs: string[];
    keyOrder: string;
    note: string;
    counts: {
      roles: number;
      totalPairs: number;
      perRole: Record<string, number>;
    };
  };
  roles: Record<string, string[]>;
}

export function generate(): RoleBundleDoc;
export function serialize(doc: RoleBundleDoc): string;
