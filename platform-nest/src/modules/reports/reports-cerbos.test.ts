// ⚡ TR-25 — Cerbos policy parity matrix for the FIVE tracker/reporting resource kinds
// (docs/blueprints/tracker-reporting-foundation.md §8). Same direct-check pattern as SM-03's
// `search-cerbos.test.ts` and `src/rbac/cerbos.test.ts` (5b.4): hits a LIVE Cerbos over the versioned
// policy repo, no DB/app needed. Needs CERBOS_URL (skips otherwise).
//
// ⚠ A NEW OR EDITED POLICY FILE IS NOT HOT-RELOADED through the Windows Docker bind mount —
// `docker restart gaiada-test-cerbos` after every policy edit, or every check against a changed rule
// silently returns EFFECT_DENY and reads exactly like a logic bug. This has cost two tickets real
// debugging time (§15 TR-07 note 9).
//
// ─────────────────────────── WHAT THIS FILE DOES AND DOES NOT PROVE ───────────────────────────
// This is the CERBOS half of the boundary: which TIER may attempt which ACTION on which GRAIN. §8's
// "own unit" columns are HALF-enforced here by design — Cerbos cannot express "manager of THIS org
// unit" (person-scope.ts's header explains why that is a substrate fact, not an omission), so the
// dept-lead tier is COARSE here and narrowed in-app. The narrowing half is proved by
// `person-scope.test.ts` (pure) and `tr25-person-axis.db.test.ts` (live, through the real endpoints,
// against real RLS). A green run of THIS file alone does NOT mean §8 holds — all three are the proof.
//
// ─────────────────────────── THE PARITY MATRIX (§8's columns, named) ───────────────────────────
//   owner            = platform_admin   (global, unconditional wildcard)
//   exec             = group_executive  (global, cross-company — §8's "Exec group")
//   admin            = company_admin    (the tenant's OWN administrator)
//   lead             = manager          (company-scoped — §8's "Dept lead (own unit)", COARSE here)
//   teamLead         = team_lead        (team-scoped — the same tier by another grant shape)
//   member           = member           (company-scoped — §8's "Self")
//   hrReader         = hr_staff         (§8's "HR-appraisal role", BASELINE half — TR-25 finding ②)
//   hrOps            = hr_manager       (§8's "HR-appraisal role", ACTING half)
//   servedLead       = reports_manager  (reconciler-materialized on the SERVED company — §8's fifth
//                                        column; exists ONLY while the assignment is status='active')
//   servedStaff      = reports_staff    (same, non-lead half)
//   wrongCompanyLead = manager scoped to T2, attempting T1's resources (cross-tenant denial)
//   low              = a high tier at assurance "low" (D4 ceiling)
import { describe, it, expect } from "vitest";
import { check, type Resource } from "../../rbac/cerbos";
import type { Principal, RoleGrant } from "../../rbac/principal";

const live = process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const T1 = "dddddddd-2222-0000-0000-000000000001"; // the tenant under test
const T2 = "dddddddd-2222-0000-0000-000000000002"; // a DIFFERENT company

const SELF = "11111111-aaaa-0000-0000-000000000001";
const OTHER = "11111111-aaaa-0000-0000-000000000002";

function principal(
  roles: RoleGrant[],
  companies: string[] = [T1],
  assurance: Principal["assurance"] = "high",
  userId = SELF,
): Principal {
  return { userId, assurance, companies, roles, sessionVersion: 1 };
}
const allow = async (p: Principal, r: Resource, a: string) => (await check(p, r, a)).allow;

// ── principals ────────────────────────────────────────────────────────────────────────────────
const owner = principal([{ role: "platform_admin", scopeType: "global", scopeId: null }], []);
const exec = principal([{ role: "group_executive", scopeType: "global", scopeId: null }], []);
const admin = principal([{ role: "company_admin", scopeType: "company", scopeId: T1 }]);
const lead = principal([{ role: "manager", scopeType: "company", scopeId: T1 }]);
const teamLead = principal([{ role: "team_lead", scopeType: "team", scopeId: "d-seo" }]);
const member = principal([{ role: "member", scopeType: "company", scopeId: T1 }]);
const hrReader = principal([{ role: "hr_staff", scopeType: "company", scopeId: T1 }]);
const hrOps = principal([{ role: "hr_manager", scopeType: "company", scopeId: T1 }]);
const servedLead = principal([{ role: "reports_manager", scopeType: "company", scopeId: T1 }], [T1, T2]);
const servedStaff = principal([{ role: "reports_staff", scopeType: "company", scopeId: T1 }], [T1, T2]);
const wrongCompanyLead = principal([{ role: "manager", scopeType: "company", scopeId: T2 }], [T1, T2]);

// ── resources (exactly the attr shapes the controllers build) ──────────────────────────────────
// reports.controller.ts's `authorizeReportDocumentRead`: module "reports", id = scopeRef, and the
// grain-specific id echoed into ownerId / projectId / teamId.
const personDoc = (owned: boolean): Resource => ({
  kind: "report_document", tenantId: T1, module: "reports", id: owned ? SELF : OTHER, ownerId: owned ? SELF : OTHER,
});
const projectDoc: Resource = { kind: "report_document", tenantId: T1, module: "reports", id: "p1", projectId: "p1" };
const deptDoc: Resource = { kind: "report_document", tenantId: T1, module: "reports", id: "d-seo", teamId: "d-seo" };
const companyDoc: Resource = { kind: "report_document", tenantId: T1, module: "reports", id: T1 };
/** `overview`/`metrics`: NO ownerId/projectId/teamId — there is no single scope. */
const listing: Resource = { kind: "report_document", tenantId: T1, module: "reports" };

const period: Resource = { kind: "report_period", tenantId: T1, module: "reports" };
const reportAdmin: Resource = { kind: "report_admin", tenantId: T1 };
const checkinSelf: Resource = { kind: "checkin", tenantId: T1, subjectUserId: SELF };
const checkinOther: Resource = { kind: "checkin", tenantId: T1, subjectUserId: OTHER };
const checkinNoSubject: Resource = { kind: "checkin", tenantId: T1 };
const appraisalSelf: Resource = { kind: "appraisal", tenantId: T1, subjectUserId: SELF };
const appraisalOther: Resource = { kind: "appraisal", tenantId: T1, subjectUserId: OTHER };
const appraisalNoSubject: Resource = { kind: "appraisal", tenantId: T1 };

const GRAIN_ACTIONS = ["read_person", "read_project", "read_department", "read_company"] as const;

describe.skipIf(!live)("⚡ TR-25 Cerbos policy parity — tracker/reporting §8 matrix", () => {
  // ═════════════════════════ platform_admin: unconditional, every kind ═════════════════════════
  it("owner (platform_admin) can do anything on all five resource kinds", async () => {
    for (const a of GRAIN_ACTIONS) expect(await allow(owner, companyDoc, a)).toBe(true);
    expect(await allow(owner, period, "seal")).toBe(true);
    expect(await allow(owner, period, "amend")).toBe(true);
    expect(await allow(owner, reportAdmin, "recompute")).toBe(true);
    expect(await allow(owner, checkinOther, "excuse")).toBe(true);
    expect(await allow(owner, checkinNoSubject, "missed_by_unit")).toBe(true);
    expect(await allow(owner, appraisalOther, "cycle_admin")).toBe(true);
    expect(await allow(owner, appraisalOther, "finalize")).toBe(true);
  });

  // ═════════════════════════ §8 row: person/project/department/company document read ═════════════
  describe("report_document — the per-grain read matrix", () => {
    it("exec reads EVERY grain incl. company (§8: the only column with a company-grain ✅)", async () => {
      for (const a of GRAIN_ACTIONS) expect(await allow(exec, companyDoc, a)).toBe(true);
    });

    it("the tenant's own admin reads every grain incl. company", async () => {
      for (const a of GRAIN_ACTIONS) expect(await allow(admin, companyDoc, a)).toBe(true);
    });

    it("dept lead reads person/project/department but NOT company (§8: dept lead ⛔ on that row)", async () => {
      expect(await allow(lead, personDoc(false), "read_person")).toBe(true); // COARSE — narrowed in-app
      expect(await allow(lead, projectDoc, "read_project")).toBe(true);
      expect(await allow(lead, deptDoc, "read_department")).toBe(true);
      expect(await allow(lead, companyDoc, "read_company")).toBe(false);
    });

    it("a team-scoped team_lead grant behaves as the same tier on its OWN unit, and not on another", async () => {
      expect(await allow(teamLead, deptDoc, "read_department")).toBe(true); // teamId === 'd-seo'
      const otherDept: Resource = { kind: "report_document", tenantId: T1, module: "reports", id: "d-web", teamId: "d-web" };
      expect(await allow(teamLead, otherDept, "read_department")).toBe(false);
      expect(await allow(teamLead, companyDoc, "read_company")).toBe(false);
    });

    it("HR (both halves) read person/project/department, NEVER company — §8's 'person data yes, company strategy no'", async () => {
      for (const p of [hrReader, hrOps]) {
        expect(await allow(p, personDoc(false), "read_person")).toBe(true);
        expect(await allow(p, projectDoc, "read_project")).toBe(true);
        expect(await allow(p, deptDoc, "read_department")).toBe(true);
        expect(await allow(p, companyDoc, "read_company")).toBe(false);
      }
    });

    it("self (member) reads ONLY their OWN person document — someone else's is denied", async () => {
      expect(await allow(member, personDoc(true), "read_person")).toBe(true);
      expect(await allow(member, personDoc(false), "read_person")).toBe(false);
    });

    it("a plain member is denied department- and company-grain outright", async () => {
      expect(await allow(member, deptDoc, "read_department")).toBe(false);
      expect(await allow(member, companyDoc, "read_company")).toBe(false);
    });

    it("a LISTING call (overview/metrics: no ownerId) fails CLOSED for a member — it cannot list everyone", async () => {
      expect(await allow(member, listing, "read_person")).toBe(false);
      expect(await allow(member, listing, "read_department")).toBe(false);
      // ...while the broader tiers, gated on inTenant rather than `owns`, are unaffected.
      expect(await allow(lead, listing, "read_person")).toBe(true);
      expect(await allow(hrReader, listing, "read_person")).toBe(true);
    });
  });

  // ═════════════════════════ §8's fifth column: served-dept (provider lead, A→B) ═════════════════
  describe("served-dept provider tier (reports_manager/reports_staff on the SERVED company)", () => {
    it("reads department + project under the assignment (§8: own provider unit incl. served slice)", async () => {
      for (const p of [servedLead, servedStaff]) {
        expect(await allow(p, deptDoc, "read_department")).toBe(true);
        expect(await allow(p, projectDoc, "read_project")).toBe(true);
      }
    });

    it("is DENIED person-grain — §8's cell is not enforceable as written, so it is not granted", async () => {
      // §8 says "✅ ONLY persons acting under the active assignment, via the rollup/provider view".
      // No endpoint can bound a person read that way (`servedTenant` is department-only, and
      // report_work_facts has no unit_tenant_id — §15 TR-07 ⑦), so granting read_person would deliver
      // ARBITRARY served-company persons: precisely what that cell forbids. Denied, and §8 corrected.
      expect(await allow(servedLead, personDoc(false), "read_person")).toBe(false);
      expect(await allow(servedStaff, personDoc(false), "read_person")).toBe(false);
    });

    it("is DENIED company-grain, appraisals, sealing and recompute in the served company (§8: all ⛔)", async () => {
      expect(await allow(servedLead, companyDoc, "read_company")).toBe(false);
      expect(await allow(servedLead, appraisalOther, "read")).toBe(false);
      expect(await allow(servedLead, appraisalOther, "cycle_admin")).toBe(false);
      expect(await allow(servedLead, appraisalOther, "write")).toBe(false);
      expect(await allow(servedLead, period, "seal")).toBe(false);
      expect(await allow(servedLead, period, "amend")).toBe(false);
      expect(await allow(servedLead, reportAdmin, "recompute")).toBe(false);
      expect(await allow(servedLead, checkinOther, "read")).toBe(false);
      expect(await allow(servedLead, checkinOther, "excuse")).toBe(false);
    });

    it("an UNRELATED module's served grant does NOT light up the reports surface", async () => {
      // module_staff/module_manager string-compose the role name from resource.attr.module, and every
      // reports caller passes module:"reports" — so an hr_staff grant riding an HR service assignment
      // cannot read report documents through this tier. (It reaches them through hr_people_reader
      // instead, which is a deliberate, separate §8 column — asserted above.)
      const searchServed = principal([{ role: "search_manager", scopeType: "company", scopeId: T1 }], [T1, T2]);
      expect(await allow(searchServed, deptDoc, "read_department")).toBe(false);
      expect(await allow(searchServed, personDoc(false), "read_person")).toBe(false);
    });
  });

  // ═════════════════════════ §8 row: seal / amend period ═════════════════════════
  describe("report_period — seal/amend/pin vs view", () => {
    it("exec + the tenant's admin may seal/amend/pin", async () => {
      for (const p of [exec, admin]) {
        expect(await allow(p, period, "seal")).toBe(true);
        expect(await allow(p, period, "amend")).toBe(true);
        expect(await allow(p, period, "pin")).toBe(true);
      }
    });

    it("dept lead, HR (both halves) and member are ALL denied seal/amend/pin (§8: ⛔ across the row)", async () => {
      for (const p of [lead, teamLead, hrReader, hrOps, member]) {
        expect(await allow(p, period, "seal")).toBe(false);
        expect(await allow(p, period, "amend")).toBe(false);
        expect(await allow(p, period, "pin")).toBe(false);
      }
    });

    it("`view` (metadata only — never a document's numbers) reaches every read tier incl. member", async () => {
      for (const p of [exec, admin, lead, hrReader, hrOps, member]) {
        expect(await allow(p, period, "view")).toBe(true);
      }
    });
  });

  // ═════════════════════════ §8 row: facts recompute (finding ③) ═════════════════════════
  describe("report_admin — facts recompute (TR-25 finding ③: folded in and reviewed)", () => {
    it("exec + the tenant's admin may recompute", async () => {
      expect(await allow(exec, reportAdmin, "recompute")).toBe(true);
      expect(await allow(admin, reportAdmin, "recompute")).toBe(true);
    });

    it("dept lead, HR (both halves) and member are DENIED — a lead who re-derives a window moves their own team's appraisal inputs", async () => {
      for (const p of [lead, teamLead, hrReader, hrOps, member]) {
        expect(await allow(p, reportAdmin, "recompute")).toBe(false);
      }
    });
  });

  // ═════════════════════════ §8 rows: check-in submit / read / excuse ═════════════════════════
  describe("checkin — submit is self-only, excuse is the acting tier", () => {
    it("submit: self ONLY, and only when subjectUserId === the principal", async () => {
      expect(await allow(member, checkinSelf, "submit")).toBe(true);
      expect(await allow(member, checkinOther, "submit")).toBe(false);
    });

    it("submit is denied to EVERY other tier for someone else — §8: '⛔ for others', no exceptions", async () => {
      for (const p of [exec, admin, lead, hrReader, hrOps]) {
        expect(await allow(p, checkinOther, "submit")).toBe(false);
      }
    });

    it("submit fails CLOSED when a handler forgets subjectUserId (has() guard)", async () => {
      expect(await allow(member, checkinNoSubject, "submit")).toBe(false);
    });

    it("read: self reads own; exec/admin/lead/HR read others (lead COARSE, narrowed in-app)", async () => {
      expect(await allow(member, checkinSelf, "read")).toBe(true);
      expect(await allow(member, checkinOther, "read")).toBe(false);
      for (const p of [exec, admin, lead, hrReader, hrOps]) expect(await allow(p, checkinOther, "read")).toBe(true);
    });

    it("⚡ finding ②: excuse is hr_manager's, NOT hr_staff's — it rewrites an appraisal-SAFE metric", async () => {
      expect(await allow(hrOps, checkinOther, "excuse")).toBe(true);
      expect(await allow(hrReader, checkinOther, "excuse")).toBe(false);
      // ...while hrReader keeps the baseline READ it legitimately needs.
      expect(await allow(hrReader, checkinOther, "read")).toBe(true);
    });

    it("excuse: exec/admin/lead allowed; a plain member never", async () => {
      for (const p of [exec, admin, lead]) expect(await allow(p, checkinOther, "excuse")).toBe(true);
      expect(await allow(member, checkinOther, "excuse")).toBe(false);
      expect(await allow(member, checkinSelf, "excuse")).toBe(false); // not even one's own
    });

    it("finding ③: the n8n ops reads are company_admin-only — lead, exec, HR and member all denied", async () => {
      for (const action of ["pending_reminders", "missed_by_unit"]) {
        expect(await allow(admin, checkinNoSubject, action)).toBe(true);
        for (const p of [lead, teamLead, exec, hrReader, hrOps, member]) {
          expect(await allow(p, checkinNoSubject, action)).toBe(false);
        }
      }
    });
  });

  // ═════════════════════════ §8 rows: appraisal read/write/ack/cycle-admin ═════════════════════
  describe("appraisal — the most sensitive kind", () => {
    it("⚡ finding ②: hr_staff has NO appraisal access at all; hr_manager is the acting tier", async () => {
      for (const action of ["cycle_admin", "finalize", "read", "confirm_evidence", "write", "submit", "ack"]) {
        expect(await allow(hrReader, appraisalOther, action)).toBe(false);
      }
      expect(await allow(hrOps, appraisalOther, "cycle_admin")).toBe(true);
      expect(await allow(hrOps, appraisalOther, "finalize")).toBe(true);
      expect(await allow(hrOps, appraisalOther, "read")).toBe(true);
      expect(await allow(hrOps, appraisalOther, "confirm_evidence")).toBe(true);
    });

    it("HR is 'cycle admin, NOT scores' — write/submit/ack denied to hr_manager (§8's exact wording)", async () => {
      expect(await allow(hrOps, appraisalOther, "write")).toBe(false);
      expect(await allow(hrOps, appraisalOther, "submit")).toBe(false);
      expect(await allow(hrOps, appraisalOther, "ack")).toBe(false);
    });

    it("exec is READ-ONLY — never write/submit/ack/cycle_admin/finalize (§8)", async () => {
      expect(await allow(exec, appraisalOther, "read")).toBe(true);
      for (const action of ["write", "submit", "ack", "cycle_admin", "finalize"]) {
        expect(await allow(exec, appraisalOther, action)).toBe(false);
      }
    });

    it("dept lead may read/write/submit (COARSE — narrowed in-app to an EXACT manager_user_id match) but never finalize or cycle_admin", async () => {
      expect(await allow(lead, appraisalOther, "read")).toBe(true);
      expect(await allow(lead, appraisalOther, "write")).toBe(true);
      expect(await allow(lead, appraisalOther, "submit")).toBe(true);
      expect(await allow(lead, appraisalOther, "finalize")).toBe(false);
      expect(await allow(lead, appraisalOther, "cycle_admin")).toBe(false);
      expect(await allow(lead, appraisalOther, "ack")).toBe(false); // ack is the SUBJECT's own act
    });

    it("⚠ FINDING: `team_lead` is listed in resource_appraisal.yaml but is UNREACHABLE there — pinned as a denial so it cannot become a silent grant", async () => {
      // `gaiada_scopes.team_lead` matches ONLY when `grant.scopeId == resource.attr.teamId`.
      // `appraisals.controller.ts` never sets `teamId` on an `appraisal` resource (it has no unit axis
      // — it narrows on `manager_user_id`), so the attribute is "" and the derived role can never
      // match. The rule is therefore inert: harmless and fail-CLOSED, but misleading to a reader who
      // assumes listing a role grants it. TR-25 chose to KEEP the rule and pin its real behaviour here
      // rather than delete it, because it becomes live the moment a future ticket passes a `teamId` —
      // and this assertion turns that from a silent widening into a failing test.
      //
      // The same is true of `team_lead` on `resource_report_period.yaml`'s `view` and on
      // `resource_report_document.yaml`'s `read_person`/`read_project` (neither resource carries
      // `teamId` for those grains). It is REACHABLE, and genuinely meaningful, on exactly one action:
      // `read_department`, where `teamId` IS the org unit node id — asserted in the report_document
      // block above. That single reachable case is the closest thing this codebase has to a real
      // unit-scoped authz primitive, and the reason it cannot be adopted wholesale is recorded in
      // person-scope.ts's header: `user_roles.scope_id` is `uuid`, while org-unit node ids are
      // free-form text, so the GRANT cannot be stored even though the POLICY can express it.
      for (const action of ["read", "write", "submit", "confirm_evidence", "finalize", "cycle_admin"]) {
        expect(await allow(teamLead, appraisalOther, action)).toBe(false);
      }
      expect(await allow(teamLead, period, "view")).toBe(false);
      expect(await allow(teamLead, personDoc(false), "read_person")).toBe(false);
      expect(await allow(teamLead, projectDoc, "read_project")).toBe(false);
    });

    it("self reads + acks own only; never writes, submits, finalizes or admins a cycle", async () => {
      expect(await allow(member, appraisalSelf, "read")).toBe(true);
      expect(await allow(member, appraisalSelf, "ack")).toBe(true);
      expect(await allow(member, appraisalOther, "read")).toBe(false);
      expect(await allow(member, appraisalOther, "ack")).toBe(false);
      for (const action of ["write", "submit", "finalize", "cycle_admin", "confirm_evidence"]) {
        expect(await allow(member, appraisalSelf, action)).toBe(false);
      }
    });

    it("self rules fail CLOSED when subjectUserId is missing", async () => {
      expect(await allow(member, appraisalNoSubject, "read")).toBe(false);
      expect(await allow(member, appraisalNoSubject, "ack")).toBe(false);
    });

    it("company_admin does NOT get score write/submit either — scoring is the assigned manager's act", async () => {
      expect(await allow(admin, appraisalOther, "write")).toBe(false);
      expect(await allow(admin, appraisalOther, "submit")).toBe(false);
    });
  });

  // ═════════════════════════ cross-tenant denials (D5) — no grant ever cascades ═════════════════
  describe("cross-tenant: a grant in one company never reaches another's person data", () => {
    it("a T2-scoped manager grant is denied EVERY action on T1's resources", async () => {
      expect(await allow(wrongCompanyLead, personDoc(false), "read_person")).toBe(false);
      expect(await allow(wrongCompanyLead, deptDoc, "read_department")).toBe(false);
      expect(await allow(wrongCompanyLead, projectDoc, "read_project")).toBe(false);
      expect(await allow(wrongCompanyLead, checkinOther, "read")).toBe(false);
      expect(await allow(wrongCompanyLead, checkinOther, "excuse")).toBe(false);
      expect(await allow(wrongCompanyLead, appraisalOther, "read")).toBe(false);
      expect(await allow(wrongCompanyLead, period, "view")).toBe(false);
      expect(await allow(wrongCompanyLead, reportAdmin, "recompute")).toBe(false);
    });

    it("a T1 HR/served grant does NOT authorize T2's equivalents", async () => {
      const t2Person: Resource = { kind: "report_document", tenantId: T2, module: "reports", id: OTHER, ownerId: OTHER };
      const t2Dept: Resource = { kind: "report_document", tenantId: T2, module: "reports", id: "d-seo", teamId: "d-seo" };
      const t2Appraisal: Resource = { kind: "appraisal", tenantId: T2, subjectUserId: OTHER };
      expect(await allow(hrOps, t2Person, "read_person")).toBe(false);
      expect(await allow(hrOps, t2Appraisal, "cycle_admin")).toBe(false);
      expect(await allow(servedLead, t2Dept, "read_department")).toBe(false);
    });

    it("being a MEMBER of a company (companies[] contains it) is not itself a grant", async () => {
      // `inTenant` is necessary but never sufficient — every rule also needs a matching derived role.
      const bareMembership = principal([], [T1, T2]);
      expect(await allow(bareMembership, personDoc(true), "read_person")).toBe(false);
      expect(await allow(bareMembership, period, "view")).toBe(false);
      expect(await allow(bareMembership, checkinSelf, "read")).toBe(false);
    });
  });

  // ═════════════════════════ D4 low-assurance ceiling — chat sessions get NO person data ════════
  describe("low-assurance (D4): a chat-surface principal reaches nothing on the person axis", () => {
    it("every tier loses every read at assurance=low", async () => {
      const tiers: [string, RoleGrant[]][] = [
        ["exec", [{ role: "group_executive", scopeType: "global", scopeId: null }]],
        ["admin", [{ role: "company_admin", scopeType: "company", scopeId: T1 }]],
        ["lead", [{ role: "manager", scopeType: "company", scopeId: T1 }]],
        ["hrReader", [{ role: "hr_staff", scopeType: "company", scopeId: T1 }]],
        ["hrOps", [{ role: "hr_manager", scopeType: "company", scopeId: T1 }]],
        ["servedLead", [{ role: "reports_manager", scopeType: "company", scopeId: T1 }]],
      ];
      for (const [, roles] of tiers) {
        const low = principal(roles, [T1], "low");
        expect(await allow(low, personDoc(false), "read_person")).toBe(false);
        expect(await allow(low, deptDoc, "read_department")).toBe(false);
        expect(await allow(low, companyDoc, "read_company")).toBe(false);
        expect(await allow(low, checkinOther, "read")).toBe(false);
        expect(await allow(low, appraisalOther, "read")).toBe(false);
        expect(await allow(low, period, "view")).toBe(false);
        expect(await allow(low, reportAdmin, "recompute")).toBe(false);
      }
    });

    it("a low-assurance member cannot even read their OWN report/appraisal/check-in", async () => {
      const low = principal([{ role: "member", scopeType: "company", scopeId: T1 }], [T1], "low");
      expect(await allow(low, personDoc(true), "read_person")).toBe(false);
      expect(await allow(low, appraisalSelf, "read")).toBe(false);
      expect(await allow(low, checkinSelf, "read")).toBe(false);
    });

    it("a genuinely low-assurance member cannot submit a check-in — and the WA loop is NOT affected, because a real OBO caller is 'linked'", async () => {
      // Worth pinning precisely, because it looks like it should break §9.2's WhatsApp check-in loop
      // and it does not. There are TWO assurance vocabularies in this estate (§15's TR-11 finding):
      // the hub's is `anonymous | low | verified`, the PLATFORM's is `low | linked | high`
      // (src/rbac/principal.ts:15). `auth/guards.ts:88` resolves an OBO envelope with a D4-VERIFIED
      // identity link to **`"linked"`**, and an unverified/unknown one to a minimal principal whose
      // `userId` is null (which the controller 400s on before authz). Since `linked` is not `low`,
      // `notLow` passes and the chat-originated submit works — while a genuinely low-assurance session
      // is refused. Both halves asserted so a future change to either vocabulary fails here.
      const low = principal([{ role: "member", scopeType: "company", scopeId: T1 }], [T1], "low");
      expect(await allow(low, checkinSelf, "submit")).toBe(false);
      const linked = principal([{ role: "member", scopeType: "company", scopeId: T1 }], [T1], "linked");
      expect(await allow(linked, checkinSelf, "submit")).toBe(true);
    });
  });

  // ═════════════════════════ MCP/agent OBO: no escalation, ever (§8 hard rule 1) ════════════════
  describe("MCP/agent OBO principals cannot escalate past this matrix", () => {
    it("an OBO principal is evaluated by the SAME policies — it has no privileged path", async () => {
      // The hub mints the principal from the real user (D4) and cannot assert roles
      // (mcp-hub/src/principal.ts). So an OBO caller is, at the policy layer, exactly its underlying
      // user: whatever that user's grants permit and nothing more. These two checks pin that the only
      // thing an OBO envelope could plausibly carry — a self-scoped member identity — reaches only
      // self-scoped things, at every assurance the hub can actually produce.
      const oboVerified = principal([{ role: "member", scopeType: "company", scopeId: T1 }], [T1], "linked");
      expect(await allow(oboVerified, checkinSelf, "submit")).toBe(true);
      expect(await allow(oboVerified, checkinOther, "submit")).toBe(false);
      expect(await allow(oboVerified, personDoc(false), "read_person")).toBe(false);
    });

    it("appraisal is unreachable over MCP at the POLICY layer too, not only by tool omission", async () => {
      // §9.2 / the standing ruling: no appraisal tool is registered in ModuleContract.mcpTools, so
      // there is no tool to reach it (asserted structurally in tr25-person-axis.db.test.ts). Defence
      // in depth: even if a tool were added, an OBO principal's own grants gate it — a member-identity
      // OBO caller gets read/ack on their OWN row and nothing else, and can never write a score.
      const obo = principal([{ role: "member", scopeType: "company", scopeId: T1 }], [T1], "linked");
      expect(await allow(obo, appraisalOther, "read")).toBe(false);
      expect(await allow(obo, appraisalOther, "write")).toBe(false);
      expect(await allow(obo, appraisalSelf, "write")).toBe(false);
      expect(await allow(obo, appraisalSelf, "submit")).toBe(false);
      expect(await allow(obo, appraisalSelf, "finalize")).toBe(false);
      expect(await allow(obo, appraisalSelf, "cycle_admin")).toBe(false);
    });

    it("an anonymous/unresolved envelope reaches nothing", async () => {
      const anon: Principal = { userId: null, assurance: "low", companies: [], roles: [], sessionVersion: 1 };
      expect(await allow(anon, checkinSelf, "submit")).toBe(false);
      expect(await allow(anon, personDoc(true), "read_person")).toBe(false);
      expect(await allow(anon, appraisalSelf, "read")).toBe(false);
    });
  });
});
