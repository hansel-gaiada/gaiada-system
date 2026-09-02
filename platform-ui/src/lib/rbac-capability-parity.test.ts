// IAM-05b-3 — the capability-axis parity guard. Sibling and structural twin of
// `rbac-cerbos-parity.test.ts` (which pins the ROLE axis: every raw role Cerbos grants has a
// `Role` member). This file pins the CAPABILITY axis: for every `(role, capability)` pair,
// `ROLE_CAPS[role].includes(capability)` must agree with `semanticsEval(bundle(role),
// CAPABILITY_MAP[capability])` — the exact biconditional the design ruling specifies.
//
// Full ruling: `docs/superpowers/plans/2026-08-10-iam-05b-design.md` §3.2-3.3. Ticket:
// `docs/superpowers/plans/2026-08-10-iam-05b-design.md` §5 (IAM-05b-3). Findings report:
// `docs/superpowers/plans/2026-08-10-iam-05b-3-report.md`.
//
// THIS TEST DOES NOT SILENCE DRIFT. A failing case in "the core biconditional" section below
// names the exact `(role, capability)` pair and its direction (over-claim = dead button;
// under-claim = invisible functionality, the dangerous direction) — that is a FINDING for the
// owner/architect, never something to fix by editing this file. Only two escape hatches exist,
// both guarded so they cannot rot silently:
//   1. WHOLESALE_EXCEPTED_ROLES — an entire role is skipped from the per-pair loop because an
//      owner ruling already disposed of it in bulk (today: `group_executive`, Ruling 4 / D-7).
//   2. KNOWN_NON_DRIFT — a specific pair that LOOKS like a mismatch under this file's own
//      biconditional but is not real drift, for a written, citable reason (self-service/`owns`-
//      conditioned reach that `role-permission-bundles.json`'s bundling methodology cannot
//      distinguish from an unconditional grant — see resource_hr_case.yaml's own IAM-04b comment
//      — or a call site that double-gates so a mirror gap is inert). Every entry cites its
//      source in the comment beside it; an entry with no citable source is exactly how the
//      original Cerbos<->rbac.ts drift happened and must not be added here.
// A pair that is a genuine, UNADJUDICATED mismatch (i.e. not fitting either escape hatch) is left
// to FAIL, on purpose, per the ticket's explicit instruction: "expect first-run reds — they are
// findings, not bugs to silence."
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { CAPABILITIES, ROLE_CAPS, type Capability } from "./rbac";
import { CAPABILITY_MAP, type CapabilityDef } from "./rbac-capability-map";

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8")) as T;
}

interface CatalogPermission {
  key: string;
  class: "grantable" | "relationship";
}
interface Catalog {
  permissions: CatalogPermission[];
}
interface Bundles {
  roles: Record<string, string[]>;
}

// Same relative-path precedent `rbac-cerbos-parity.test.ts` already established for reading
// platform-nest files from platform-ui's test tree — read-only, never written.
const catalog = readJson<Catalog>("../../../platform-nest/src/rbac/permission-catalog.json");
const bundles = readJson<Bundles>("../../../platform-nest/src/rbac/role-permission-bundles.json");

const GRANTABLE_KEYS = new Set(
  catalog.permissions.filter((p) => p.class === "grantable").map((p) => p.key),
);
const RELATIONSHIP_KEYS = new Set(
  catalog.permissions.filter((p) => p.class === "relationship").map((p) => p.key),
);

// The evaluator under test — mirrors exactly the math the design doc's §3.4 end-state `can()`
// will run once IAM-05c's payload lands: `semanticsEval(effectivePermissions, CAPABILITY_MAP[cap])`.
function semanticsEval(held: ReadonlySet<string>, def: CapabilityDef): boolean {
  if (def.semantics === "any") return def.permissions.some((p) => held.has(p));
  return def.permissions.every((p) => held.has(p));
}

type Direction = "over-claim" | "under-claim";

/**
 * Does `role` (as `ROLE_CAPS` mirrors it) agree with Cerbos (as `bundles` + `map` derive it) on
 * `capability`? Returns the mismatch direction, or `null` if they agree. `map`/`roleCaps` are
 * injectable (default to the real, unedited files) so the teeth-check section can exercise this
 * exact function against a LOCAL, in-memory-only corrupted copy without ever touching
 * `rbac.ts`/`rbac-capability-map.ts` on disk.
 */
function mismatchFor(
  role: string,
  capability: Capability,
  map: Record<string, CapabilityDef> = CAPABILITY_MAP,
  roleCaps: Record<string, readonly Capability[]> = ROLE_CAPS,
): Direction | null {
  const def = map[capability];
  const held = new Set(bundles.roles[role] ?? []);
  const mirrorSays = (roleCaps[role] ?? []).includes(capability);
  const cerbosSays = semanticsEval(held, def);
  if (mirrorSays === cerbosSays) return null;
  return mirrorSays ? "over-claim" : "under-claim";
}

// ─────────────────────────── the guarded exception register ───────────────────────────

// An entire role excluded from the per-pair loop below because the owner already ruled on its
// divergence IN BULK, not pair by pair.
//
// ⚠ THE SET IS NOW EMPTY, AND THAT IS THE GUARD WORKING AS DESIGNED. Its sole member was
// `group_executive` (design doc §3.3 / Ruling 4 / D-7 — the drift register's finding #4: `ALL`
// overrode three separately-documented Cerbos narrowings plus agency_approval:approve and the whole
// `member` kind). That ruling said explicitly to correct it "in PHASE 3 when D-7 deletes the role,
// not here", and it also armed a guard test that would fail the moment the role stopped diverging.
//
// IAM-15 deleted the role on 2026-08-23. The guard fired exactly as intended — "group_executive no
// longer diverges from Cerbos under any capability ... the wholesale exclusion is now stale and
// should be dropped" — so the exclusion is dropped rather than carried forward, and the guard test
// that policed it is retired with it (a guard over an empty set proves nothing).
//
// Kept as an empty Set, not deleted: the per-pair loop reads it, and the NEXT bulk ruling should
// land here with the same discipline rather than reintroducing the mechanism from scratch.
const WHOLESALE_EXCEPTED_ROLES = new Set<string>([]);

interface RegisterEntry {
  role: string;
  capability: Capability;
  direction: Direction;
  reason: string;
  decisionRef: string;
}

// Specific (role, capability) pairs that fail this file's own biconditional but are NOT real
// Cerbos<->rbac.ts drift, each for a written, sourced reason. An entry that stops being a real
// mismatch is stale and FAILS the guard test below (§ "the register stays honest") — the same
// guard-the-guard discipline `rbac-cerbos-parity.test.ts`'s `DELIBERATELY_OUTSIDE_ROLE_CAPS` set
// already uses on the role axis.
const KNOWN_NON_DRIFT: RegisterEntry[] = [
  // ── self-service (`owns`-conditioned) reach that role-permission-bundles.json's bundling
  // methodology cannot distinguish from an unconditional role-wide grant. resource_hr_case.yaml's
  // own IAM-04b comment (lines ~79-92) states this explicitly as a known, accepted limitation of
  // the 0094 bundling methodology ("a resource-instance condition (self-ownership) is 'satisfied'
  // when computing reach... those keys sit in member's bundle indistinguishably from how
  // company_admin/module_staff/module_manager hold the SAME keys UNCONDITIONALLY... a real
  // granularity gap in the current 215-permission catalog, not something fixable from [the
  // policy layer]"). rbac.ts's own header independently states the same product decision from
  // the UI side (§11 principle 2: "nothing about you that you cannot read" — self-service is
  // deliberately NOT modeled as a capability). IAM-02a's drift register §3 already ruled these
  // exact pairs (member's self-only reads) "not drift" for the identical reason.
  {
    role: "member",
    capability: "reports.person.view",
    direction: "under-claim",
    reason:
      "member's bundle carries reports.document.read_person only via the self-owned `owns` rule (resource_report_document.yaml); rbac.ts §11 principle 2 deliberately does not model self-service as a capability.",
    decisionRef: "IAM-02a drift register §3 (false positives ruled out); rbac.ts header §11 principle 2",
  },
  {
    role: "member",
    capability: "reports.project.view",
    direction: "under-claim",
    reason: "Same self-service `owns` reach as reports.person.view above, same resource policy, same ruling.",
    decisionRef: "IAM-02a drift register §3; rbac.ts header §11 principle 2",
  },
  {
    role: "member",
    capability: "checkin.read",
    direction: "under-claim",
    reason:
      "member's bundle carries reports.checkin.read only via self-submission (`reports.checkin.submit` is the member's real grant; `read` here is the bundler crediting the self-scoped reach identically to an unconditional read) — a plain member reading THEIR OWN check-in is not the `checkin.read` capability, which means reading OTHERS'.",
    decisionRef: "IAM-02a drift register §3; rbac.ts header §11 principle 2",
  },
  {
    role: "member",
    capability: "appraisal.read",
    direction: "under-claim",
    reason:
      "member's bundle carries reports.appraisal.read only via the subject's own `owns`-conditioned read/ack path (reports.appraisal.ack); not the 'read packs beyond one's own' capability.",
    decisionRef: "IAM-02a drift register §3; rbac.ts header §11 principle 2",
  },
  // ── LMS-L1 (2026-08-24): `member`'s enrolment keys are SELF-SCOPED. Two entries, same cause as
  // the hr.payroll.read entry below — the bundler credits a resource-instance condition as reach.
  //
  // Worth distinguishing from the FIVE other under-claims the same run surfaced (hr_staff and
  // hr_manager against the lms.* capabilities): those were a genuine MIRROR OMISSION and were fixed
  // in rbac.ts, not registered here. The guard telling those two cases apart is precisely its value
  // — "register it" and "fix it" look identical until you check which side is wrong.
  {
    role: "member",
    capability: "lms.progress.view",
    direction: "under-claim",
    reason:
      "member's bundle carries lms.enrollment.read ONLY via resource_lms_enrollment.yaml's self-scoped rule (subjectUserId == principal.id). The `lms.progress.view` capability means reading OTHERS' progress, scores and failed attempts — which is what /learning/compliance gates on. A learner reading their own /me/learning holds no capability at all, which is rbac.ts §11 principle 2 working as intended.",
    decisionRef: "resource_lms_enrollment.yaml (member arm); migration 202608241340 header; rbac.ts §11 principle 2",
  },
  {
    role: "member",
    capability: "lms.assign",
    direction: "under-claim",
    reason:
      "Same self-scoped rule: member holds lms.enrollment.create/update only for their OWN row — self-enrolling in an OPTIONAL path, and recording their own attempts. `lms.assign` means assigning training to somebody else and recording progress on their behalf, which the member arm cannot reach. The controller additionally refuses member self-enrolment into MANDATORY paths, so the two cannot be confused in practice either.",
    decisionRef: "resource_lms_enrollment.yaml (member create/update arm); lms-learn.controller.ts::enrol",
  },
  // ── HR-FULL (2026-08-24): the same self/relationship-scoped conflation on the three new HR kinds.
  // Three entries, and they split into TWO distinct causes worth naming separately, because only
  // one of them is the well-trodden `owns` case above.
  {
    role: "member",
    capability: "hr.payroll.view",
    direction: "under-claim",
    reason:
      "member's bundle carries hr.payroll.read ONLY via resource_hr_payroll.yaml's self-scoped rule — the subject reading their OWN PUBLISHED payslip, gated on BOTH `subjectUserId == principal.id` AND `published == true`. The `hr.payroll.view` capability means reading the whole company's salary book, which is precisely the reach hr_staff is denied. Widening the mirror to satisfy the biconditional would show every employee a company-wide compensation surface the server refuses — the exact over-claim direction this guard exists to prevent, arriving through the under-claim door. NOTE this pair is also the ONE new HR key the 0114 self-scoped marker DOES mark, so the DB agrees it is self-scoped even though the bundler credits it as flat reach.",
    decisionRef: "resource_hr_payroll.yaml (member arm); migration 202608240144 header; rbac.ts §11 principle 2",
  },
  {
    role: "member",
    capability: "hr.recruitment.view",
    direction: "under-claim",
    reason:
      "A DIFFERENT cause from the `owns`/self entries above, and worth distinguishing: member's hr.recruitment.read comes from resource_hr_recruitment.yaml's PANEL rules, gated on `panelistUserIds`/`hiringManagerUserId` — a RELATIONSHIP gate, not a self gate. Being on one interview panel is not the `hr.recruitment.view` capability (seeing the tenant's whole pipeline), and the controller narrows the SQL to the same relationship, so the mirror denying it matches what a member actually gets. NOTE the DB marker DOES now agree this grant is narrow: 0114's self-scope classifier learned the membership form (`principal.id in attr.X`) on 2026-08-24, after an unmarked key was found mis-routing IAM overrides to hr_manager. Marking affects the grant CEILING and override routing, not bundle membership — member still HOLDS the key — so this remains a real, correctly-directed mismatch for this guard's purposes.",
    decisionRef: "resource_hr_recruitment.yaml (panel arm); migration 202608240144 header; override-request-decide.test.ts",
  },
  {
    role: "member",
    capability: "hr.policy.view",
    direction: "under-claim",
    reason:
      "The odd one out, and NOT a conflation at all: resource_hr_policy.yaml genuinely DOES grant every member `read` unconditionally — holiday calendars and leave entitlements govern everyone and hiding them is a support ticket, not a posture. The mirror still withholds the capability because `hr.policy.view` gates the HR CONSOLE's settings surface (/hr/settings), which is an HR-operations page; an employee reads the same underlying facts through /me and the leave form, not through the department console. This is a UI-navigation decision, not an authorization one, and it is the one entry here that could be reversed without touching any policy — a future /hr/settings read-only view for all staff would simply add `hr.policy.view` to more roles and drop this entry.",
    decisionRef: "resource_hr_policy.yaml (member in the read rule); HR-FULL console scoping decision 2026-08-24",
  },
  // ── same self-service conflation, different resource: resource_integration_connection.yaml
  // (read verbatim, lines 44-49) grants member/viewer/team_lead full CRUD on integration_
  // connection ONLY under `variables.owns` ("a member (or higher, incl. viewer) fully manages
  // their OWN user-owned connection... the `owns` clause keeps it to strictly their own rows").
  // `company.manage`'s set includes the SAME four integration_connection actions because that is
  // also how `manager`'s genuine (unconditional, company_admin-tier) grant is expressed
  // (resource_integration_connection.yaml's separate, unconditioned `company_admin`/`manager`
  // rule) — the bundling methodology cannot tell "I manage MY OWN row" apart from "I manage
  // ANYONE's row," so member/viewer/team_lead's bundle entries for these four keys read
  // identically to manager's, even though the underlying Cerbos rule and role list are entirely
  // different. Same root-cause class as the hr_case entries above, confirmed directly against
  // the policy text (not inferred).
  // HIER-3 (2026-08-11): the `team_lead` x `company.manage` entry that sat here was REMOVED, not
  // rewritten. `team_lead` is retired — the role, its derived role, every policy naming it, and
  // every writer that could mint the grant are gone (migration 0103). An exception register entry
  // for a role that no longer exists is exactly the stale-exception rot this file's own
  // guard-the-guard test exists to catch, and that test is what flagged it: an exception nobody
  // revisits is how a parity suite quietly stops asserting anything.
  {
    role: "member",
    capability: "company.manage",
    direction: "under-claim",
    reason: "Same self-service-only integration_connection reach as team_lead above, same policy, same conflation.",
    decisionRef: "resource_integration_connection.yaml lines 44-49; IAM-02a drift register §3 conflation class",
  },
  {
    role: "viewer",
    capability: "company.manage",
    direction: "under-claim",
    reason: "Same self-service-only integration_connection reach as team_lead/member above, same policy, same conflation.",
    decisionRef: "resource_integration_connection.yaml lines 44-49; IAM-02a drift register §3 conflation class",
  },
  // ── a call-site double-gate makes a mirror gap inert, already ruled "no live gap" by IAM-02a.
  {
    role: "hr_manager",
    capability: "approvals.decide",
    direction: "under-claim",
    reason:
      "hr_manager genuinely holds core.automation_approval.decide (module-scoped to hr), so this file's biconditional flags it. But the one real call site, hrActions.ts's decideHrLeave, gates on `can(...,'approvals.decide',...) || can(...,'hr.manage',...)`, and hr_manager holds hr.manage — so the mirror gap is provably inert, not a live under-claim.",
    decisionRef: "IAM-02a drift register §3 (\"hr_manager + approvals.decide\" false positive, already ruled out)",
  },
  // ── MON-20 (2026-09-02) — the permission catalog says `owner` holds all three; the ENFORCING
  // Cerbos policy says it holds none. `cerbos/policies/resource_monitor_channel.yaml` and
  // `resource_monitor_maintenance.yaml` each carry a "PERMISSION ARM DEFERRED, DELIBERATELY"
  // comment stating outright that the fine-grained `monitoring.*` permission catalog is NOT yet
  // wired to any Cerbos decision for this module ("a principal holding ONLY a fine-grained
  // monitoring.* permission grant and no role is DENIED here until that arm lands. Fail-closed, and
  // visible rather than silent"). Both files' actual `rules:` name only `platform_admin` (wildcard),
  // `company_admin`, `manager` and `module_manager` — `owner`/`group_executive` appears in NEITHER
  // rule, and `cerbos/policies/derived_roles.yaml` has no `owner`/`group_executive` derived-role
  // entry at all, so a principal whose only grant is `role: "owner"` is denied by Cerbos on every
  // monitor_* kind today, regardless of what `role-permission-bundles.json` (the catalog-side
  // artifact this test reads) records administratively. Widening `ROLE_CAPS.owner` to satisfy this
  // file's biconditional would be exactly the dangerous direction the register exists to catch in
  // the OTHER direction from usual: it would make the UI mirror the catalog's fiction rather than
  // the server's actual behaviour, showing `owner` a control that 403s with no visible reason. Flagged
  // for the architect — this looks like `owner` has NO Cerbos-side reach into the `monitoring` module
  // at all yet (not even read), which may itself be an unintended gap, but that is a Cerbos-policy
  // fix, not an `ROLE_CAPS` one.
  {
    role: "owner",
    capability: "monitoring.channel.manage",
    direction: "under-claim",
    reason:
      "owner's bundle carries monitoring.channel.manage via the permission catalog only; resource_monitor_channel.yaml's `manage` rule names company_admin/manager/module_manager (+platform_admin wildcard), never owner/group_executive, and that policy's own comment says the permission-catalog arm is not wired to any decision yet.",
    decisionRef: "cerbos/policies/resource_monitor_channel.yaml (rules + \"PERMISSION ARM DEFERRED\" comment); cerbos/policies/derived_roles.yaml (no owner/group_executive entry)",
  },
  {
    role: "owner",
    capability: "monitoring.maintenance.create",
    direction: "under-claim",
    reason: "Same cause as monitoring.channel.manage above: resource_monitor_maintenance.yaml's `create` rule names company_admin/manager/module_manager only.",
    decisionRef: "cerbos/policies/resource_monitor_maintenance.yaml (rules + \"PERMISSION ARM DEFERRED\" comment); cerbos/policies/derived_roles.yaml (no owner/group_executive entry)",
  },
  {
    role: "owner",
    capability: "monitoring.maintenance.delete",
    direction: "under-claim",
    reason: "Same cause as monitoring.channel.manage above: resource_monitor_maintenance.yaml's `delete` rule names company_admin/manager/module_manager only.",
    decisionRef: "cerbos/policies/resource_monitor_maintenance.yaml (rules + \"PERMISSION ARM DEFERRED\" comment); cerbos/policies/derived_roles.yaml (no owner/group_executive entry)",
  },
];

const knownNonDriftKey = (role: string, capability: Capability) => `${role} ${capability}`;
const KNOWN_NON_DRIFT_KEYS = new Set(KNOWN_NON_DRIFT.map((e) => knownNonDriftKey(e.role, e.capability)));

// ─────────────────────────────────── section 1: well-formedness ───────────────────────────────────

describe("well-formedness (belt to the type system's braces)", () => {
  it("sanity floor — catches a broken path/regex silently returning nothing, rather than passing vacuously", () => {
    expect(CAPABILITIES.length).toBeGreaterThanOrEqual(30);
    expect(catalog.permissions.length).toBeGreaterThanOrEqual(200);
    expect(Object.keys(bundles.roles).length).toBeGreaterThanOrEqual(15);
  });

  it("CAPABILITY_MAP's keys are exactly CAPABILITIES — no capability missing an entry, no entry keyed by a non-capability", () => {
    const mapKeys = Object.keys(CAPABILITY_MAP).sort();
    const capKeys = [...CAPABILITIES].sort();
    expect(mapKeys).toEqual(capKeys);
  });

  it("every permission referenced by CAPABILITY_MAP exists among the catalog's grantable keys", () => {
    const unknown: string[] = [];
    for (const [cap, def] of Object.entries(CAPABILITY_MAP) as [Capability, CapabilityDef][]) {
      for (const perm of def.permissions) {
        if (!GRANTABLE_KEYS.has(perm)) unknown.push(`${cap} -> ${perm}`);
      }
    }
    expect(unknown, `CAPABILITY_MAP references permission keys absent from the catalog's grantable set: ${unknown.join(", ")}`).toEqual([]);
  });

  it("zero CAPABILITY_MAP permission is a relationship-class key (Ruling 3 — never role-grantable)", () => {
    const offenders: string[] = [];
    for (const [cap, def] of Object.entries(CAPABILITY_MAP) as [Capability, CapabilityDef][]) {
      for (const perm of def.permissions) {
        if (RELATIONSHIP_KEYS.has(perm)) offenders.push(`${cap} -> ${perm}`);
      }
    }
    expect(offenders, `CAPABILITY_MAP references relationship-class (never role-grantable) keys: ${offenders.join(", ")}`).toEqual([]);
  });

  it("exactly two capabilities declare 'any' semantics — a third is a FINDING, not a quiet addition", () => {
    const anyCaps = (Object.entries(CAPABILITY_MAP) as [Capability, CapabilityDef][])
      .filter(([, def]) => def.semantics === "any")
      .map(([cap]) => cap)
      .sort();
    expect(anyCaps).toEqual(["approvals.decide", "company.manage"]);
  });
});

// ────────────────────────── section 2: the register stays honest ──────────────────────────

describe("the guarded exception register (guard-the-guard)", () => {
  it("the wholesale-exclusion register is EMPTY — every role is now checked pair by pair", () => {
    // Replaces "the group_executive wholesale exclusion is still warranted". That test existed to
    // notice the day the exclusion outlived its reason; IAM-15 was that day and it fired. What
    // remains worth pinning is the stronger property it was protecting: no role escapes the per-pair
    // parity loop. Re-adding one must be a deliberate, reviewed act.
    expect(
      [...WHOLESALE_EXCEPTED_ROLES],
      "a role was added back to the wholesale-exclusion set — that exempts it from EVERY capability " +
        "parity check, so it needs an owner ruling and a guard test of its own, exactly as " +
        "group_executive had (Ruling 4 / D-7).",
    ).toEqual([]);
  });

  it("every KNOWN_NON_DRIFT entry is still a real, correctly-directed mismatch under today's map/bundles", () => {
    const stale: string[] = [];
    for (const entry of KNOWN_NON_DRIFT) {
      const actual = mismatchFor(entry.role, entry.capability);
      if (actual !== entry.direction) {
        stale.push(`${entry.role} x ${entry.capability} (registered as ${entry.direction}, observed ${actual ?? "NO LONGER A MISMATCH"})`);
      }
    }
    expect(
      stale,
      `These KNOWN_NON_DRIFT register entries are stale — they no longer diverge the way they're documented, so the exception is now dead weight and must be removed (or the mismatch has changed shape and the entry needs re-review): ${stale.join("; ")}`,
    ).toEqual([]);
  });

  it("teeth: the guard above correctly rejects a FABRICATED register entry pointing at a pair that isn't actually a mismatch", () => {
    // A pair known to pass cleanly today (company_admin genuinely holds every pipeline.write
    // permission, unconditionally — no self-service ambiguity on this resource at all).
    const fakeEntry: RegisterEntry = {
      role: "company_admin",
      capability: "pipeline.write",
      direction: "under-claim",
      reason: "FABRICATED for the teeth-check — company_admin actually matches Cerbos cleanly here.",
      decisionRef: "none — this entry is intentionally bogus, never added to KNOWN_NON_DRIFT",
    };
    const actual = mismatchFor(fakeEntry.role, fakeEntry.capability);
    // The real guard test above would have failed loudly had this fake entry been added to
    // KNOWN_NON_DRIFT for real — demonstrated here without ever polluting the real register.
    expect(actual, "sanity: company_admin x pipeline.write really does pass cleanly, which is what makes the fake entry a good test of the guard").toBeNull();
    expect(actual !== fakeEntry.direction).toBe(true);
  });
});

// ───────────────────────── section 3: the core biconditional ─────────────────────────

// The role universe this file can check: roles `ROLE_CAPS` and `role-permission-bundles.json`
// both know about, minus the wholesale exception. (`client`/`webdev_staff`/`webdev_manager` exist
// in bundles but have no `Role` member at all yet — a ROLE-axis gap, `rbac-cerbos-parity.test.ts`'s
// job, not this file's; every role `ROLE_CAPS` defines IS present in bundles today, so nothing on
// this file's own axis is silently skipped by the intersection.)
const ROLES_CHECKED = Object.keys(ROLE_CAPS).filter(
  (role) => role in bundles.roles && !WHOLESALE_EXCEPTED_ROLES.has(role),
);

const rolesInRoleCapsNotInBundles = Object.keys(ROLE_CAPS).filter((r) => !(r in bundles.roles));

describe("the core biconditional — ROLE_CAPS[role] |= capability <=> semanticsEval(bundle(role), MAP[capability])", () => {
  it("sanity — every Role member this file mirrors is present in role-permission-bundles.json (or is the documented wholesale exception)", () => {
    expect(
      rolesInRoleCapsNotInBundles,
      `Role(s) in ROLE_CAPS have no entry in role-permission-bundles.json at all: ${rolesInRoleCapsNotInBundles.join(", ")}`,
    ).toEqual([]);
  });

  const cases = ROLES_CHECKED.flatMap((role) =>
    CAPABILITIES.filter((cap) => !KNOWN_NON_DRIFT_KEYS.has(knownNonDriftKey(role, cap))).map((cap) => ({
      role,
      cap,
      name: `${role} × ${cap}`,
    })),
  );

  it.each(cases)("$name", ({ role, cap }) => {
    const direction = mismatchFor(role, cap);
    const def = CAPABILITY_MAP[cap];
    const held = bundles.roles[role] ?? [];
    expect(
      direction,
      direction === null
        ? undefined
        : `${role} x ${cap}: MIRROR ${direction === "over-claim" ? "GRANTS" : "DENIES"} it, CERBOS (${def.semantics.toUpperCase()} of [${def.permissions.join(", ")}] against ${role}'s held set) ${direction === "over-claim" ? "denies" : "grants"} it. Direction: ${direction.toUpperCase()} (${direction === "under-claim" ? "DANGEROUS — hidden working functionality" : "safe-ish — a dead button, visible 403"}). role's held permissions: [${held.join(", ")}]`,
    ).toBeNull();
  });
});

// ─────────────────────────────────────── section 4: teeth ───────────────────────────────────────

describe("teeth — the checker actually detects a corrupted map entry, and un-detects it once restored", () => {
  it("corrupting one side (an extra, unheld permission added to a passing capability's 'all' set) flips a clean pair into a named, directed mismatch", () => {
    // company_admin x pipeline.write passes cleanly today (verified: mismatchFor returns null).
    expect(mismatchFor("company_admin", "pipeline.write")).toBeNull();

    // Corrupt ONLY an in-memory clone — never rbac-capability-map.ts on disk (constraint: that
    // file is owned by IAM-05b-2 and is off-limits here). "core.rollup.read" is a real, grantable
    // catalog key that company_admin's bundle genuinely does NOT hold (rollups.view is
    // platform_admin/group_executive-only) — a realistic corruption, not a nonsense key.
    const corruptedMap: Record<string, CapabilityDef> = {
      ...CAPABILITY_MAP,
      "pipeline.write": {
        semantics: "all",
        permissions: [...CAPABILITY_MAP["pipeline.write"].permissions, "core.rollup.read"],
      },
    };

    const corruptedResult = mismatchFor("company_admin", "pipeline.write", corruptedMap);
    expect(corruptedResult, "the corrupted 'all' set should now be unsatisfied for company_admin, surfacing an over-claim").toBe("over-claim");

    // Restore: re-check the SAME pair against the real, untouched CAPABILITY_MAP.
    const restoredResult = mismatchFor("company_admin", "pipeline.write");
    expect(restoredResult, "after 'restoring' (i.e. simply going back to the real map), the pair is clean again").toBeNull();
  });

  it("corrupting the OTHER side (stripping the one permission an 'any' capability's holder actually has) also flips a clean pair", () => {
    // agency_approver x approvals.decide passes cleanly today under ANY semantics (its entire
    // Cerbos reach is agency.approval.approve, the one member of this set it holds).
    expect(mismatchFor("agency_approver", "approvals.decide")).toBeNull();

    const corruptedMap: Record<string, CapabilityDef> = {
      ...CAPABILITY_MAP,
      "approvals.decide": {
        semantics: "any",
        permissions: CAPABILITY_MAP["approvals.decide"].permissions.filter((p) => p !== "agency.approval.approve"),
      },
    };

    const corruptedResult = mismatchFor("agency_approver", "approvals.decide", corruptedMap);
    // ROLE_CAPS still GRANTS agency_approver this capability (mirrorSays=true); the corrupted ANY
    // set no longer matches anything it holds (cerbosSays=false) -> over-claim (a now-dead
    // button), i.e. exactly DR-2b's original bug reintroduced on purpose to prove the checker
    // catches it.
    expect(corruptedResult, "stripping agency_approver's one held permission from an ANY set should surface an over-claim (DR-2b's regression, reintroduced on purpose to prove the checker catches it)").toBe("over-claim");

    const restoredResult = mismatchFor("agency_approver", "approvals.decide");
    expect(restoredResult).toBeNull();
  });
});
