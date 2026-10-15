// DW-7j f6 (docs/FRONTEND-BFF-CONTRACT.md §40.6.2 and §40.6.3): mandatory learning complete. Company grain (§40.6.1). Register as
// `gated("lms", mandatoryLearning)`: it reads the LMS module's tables; the roster is core. Its walls are `lms` AND `hr`, the pair
// the LMS-HR seam opens (lms/index.ts).
//
//   `hr.mandatory_learning`: a POINT IN TIME at `asOf` (the window's start plays no part).
//   The people: DW-4g's roster at company grain. `loadUnitRoster` over the whole org tree (the root node and every department and
//   division below it, `collectUnitSubtree`): the users whose PRIMARY org-unit membership is valid on `asOf` (REPORTS_TZ), so a
//   person whose membership ended before `asOf` is out, as they are on the unit compliance page (`?unit=`, BFF §38). Intersected
//   with active company membership (`company_memberships`: active, not deleted), so a disabled login with an open org seat is out
//   too. The company-wide compliance page (no `?unit=`) counts every enrolment with no roster at all; this reader follows the
//   unit page's rule so a company number and its departments' numbers are built from the same people. No org tree reads `null`.
//   The paths: published, not deleted, `is_mandatory`.
//   Required: the roster's (person, path) pairs that have at least one enrolment that is not `waived`. A pair is counted ONCE even
//   when recertification left an `expired` row beside a newer enrolment: counting both would cap a recertified person's result
//   below 100% for good. Completed: required pairs with an enrolment `completed` whose `completed_at` is on or before the end
//   of `asOf` in REPORTS_TZ. `expired` counts as not complete. A window in the past reads completions up to its end but the
//   enrolments and the roster as they are on `asOf`, not as they were. `null` when required is 0.
import { config } from "../../../../config";
import { withTenants } from "../../../../db";
import { collectUnitSubtree, loadOrgStructure, loadUnitRoster, unwrapOrgRoot } from "../../person-scope";
import type { ModuleKpiReader } from "../types";
import { windowEndSql } from "../scope";

/** The walls this reader declares: LMS's tables, with the HR scope the seam opens. */
export const LMS_HR_WALLS = { modules: ["lms", "hr"] };

/** f6 · `hr.mandatory_learning` */
export const mandatoryLearning: ModuleKpiReader = async (ctx) => {
  const row = await withTenants(
    [ctx.tenantId],
    async (c) => {
      const structure = await loadOrgStructure(c, ctx.tenantId);
      const rootId = unwrapOrgRoot(structure)?.id;
      if (typeof rootId !== "string") return null;
      const roster = await loadUnitRoster(c, ctx.tenantId, collectUnitSubtree(structure, rootId), ctx.asOf);
      if (roster.length === 0) return null;
      // $1 tenant, $2 roster, $3 asOf, $4 zone
      const { rows } = await c.query<{ required: number; completed: number }>(
        `SELECT count(*)::int AS required,
                (count(*) FILTER (WHERE x.done))::int AS completed
           FROM (
             SELECT e.subject_user_id, e.path_id,
                    bool_or(e.status = 'completed' AND e.completed_at < ${windowEndSql(3, 4)}) AS done
               FROM lms_enrollments e
               JOIN lms_paths p ON p.id = e.path_id AND p.tenant_id = e.tenant_id
               JOIN company_memberships m ON m.tenant_id = e.tenant_id AND m.user_id = e.subject_user_id
                                         AND m.deleted_at IS NULL AND m.status = 'active'
              WHERE e.tenant_id = $1::uuid
                AND e.subject_user_id = ANY($2::uuid[])
                AND p.deleted_at IS NULL AND p.status = 'published' AND p.is_mandatory
                AND e.status <> 'waived'
              GROUP BY e.subject_user_id, e.path_id
           ) x`,
        [ctx.tenantId, roster, ctx.asOf, config.reportsTz],
      );
      return rows[0];
    },
    LMS_HR_WALLS,
  );
  const required = Number(row?.required ?? 0);
  if (!row || required === 0) return null;
  const completed = Number(row.completed);
  return { value: completed / required, numerator: completed, denominator: required };
};
