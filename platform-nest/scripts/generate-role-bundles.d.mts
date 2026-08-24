// Type declaration for `generate-role-bundles.mjs` (IAM-02h single source of truth for
// REAL_ROLES). Kept hand-written (not `.d.ts` generated) because the script is plain ESM run
// standalone via `node` and is intentionally not compiled/type-checked itself; this file exists
// solely so `.ts` importers (the two `.db.test.ts` parity/bundle suites) get real types instead
// of an implicit `any`, per IAM-FIX-TYPES.
//
// Shape mirrors the script's actual exports (scripts/generate-role-bundles.mjs):
//   - `REAL_ROLES`: the 24 real, nameable Cerbos roles, as a readonly tuple so importers get
//     literal-typed elements (role-permission-parity.db.test.ts derives
//     `type RealRole = (typeof REAL_ROLES)[number]` from it). HIER-2/0102 added `org_unit_lead`
//     (20 -> 21); HIER-3 (2026-08-11) retired `team_lead` (21 -> 20); SMM-30 (2026-08-12) added
//     `social_staff`/`social_manager` (20 -> 22); MON-10b (2026-08-19) added
//     `monitoring_staff`/`monitoring_manager` (22 -> 24); FINANCE-F0 and LMS-L1 (both 2026-08-24)
//     added `finance_staff`/`finance_manager` and `lms_staff`/`lms_manager` (24 -> 28) — keep this
//     tuple in lockstep
//     with the .mjs's own REAL_ROLES array; a mismatch here is a TS error at every importer, not a
//     silent drift, which is the point of hand-writing it rather than inferring `string[]`.
//   - `PERMISSION_NATIVE_ROLES` (IAM-14): roles with NO Cerbos rules, whose reach IS their bundle
//     (IAM-04c §3). They cannot be derived from policy — the parse finds no rule naming them — so the
//     generator appends them after derivation. Kept as a separate tuple rather than folded into
//     REAL_ROLES because the two are used differently: anything comparing a bundle against ROLE-ARM
//     reach must skip these (they have none), while anything comparing the artifact to the DATABASE
//     must include them.
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
  "social_staff", "social_manager",
  "monitoring_staff", "monitoring_manager",
  // FINANCE-F0 and LMS-L1, both 2026-08-24. Added TOGETHER because this file caught both omissions
  // in the same typecheck — which is the mechanism working as designed: two concurrent sessions each
  // added a module tier to the .mjs, neither updated this tuple, and the mismatch surfaced as a TS
  // error at every importer rather than as a suite that silently stopped comparing two roles (the
  // exact defect the header records for webdev_staff/webdev_manager).
  "finance_staff", "finance_manager",
  "lms_staff", "lms_manager",
];

export const PERMISSION_NATIVE_ROLES: readonly ["owner"];

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
