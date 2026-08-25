// LMS module contract (L1). Design: docs/blueprints/lms-foundation.md.
//
// Its OWN module key, not filed under `hr` — owner decision 2026-08-24. The LMS serves all eight
// departments, and filing a company-wide capability under one of them would make Creatives' or SEO's
// training silently depend on `hr` being served to them. Certification crosses a ONE-WAY seam: the
// LMS writes an `hr_record` on path completion and reads nothing back.
//
// ⚠ THE ONE PLACE TWO MODULE SCOPES ARE OPENED AT ONCE. That certification write touches an `hr_*`
//   table from LMS code, so it runs under `withTenants(..., { modules: ["lms", "hr"] })`. Every
//   OTHER query in this module declares `["lms"]` alone. Widening the scope by habit would quietly
//   give LMS handlers reach into HR's tables, which is exactly what the third wall exists to stop.
import type { ModuleContract, RollupProvider } from "../contract";

const lmsRollups: RollupProvider = {
  metrics: [
    { metricKey: "lms.enrollments_active", description: "Learning paths assigned and not yet completed", unit: "count", isMonetary: false, aggregationRule: "sum" },
    { metricKey: "lms.enrollments_overdue", description: "Assigned learning past its due date", unit: "count", isMonetary: false, aggregationRule: "sum" },
    { metricKey: "lms.mandatory_outstanding", description: "Outstanding enrolments on a MANDATORY path — the compliance number", unit: "count", isMonetary: false, aggregationRule: "sum" },
    { metricKey: "lms.courses_published", description: "Published courses in the catalogue", unit: "count", isMonetary: false, aggregationRule: "sum" },
    { metricKey: "lms.completions_90d", description: "Path completions in the last 90 days", unit: "count", isMonetary: false, aggregationRule: "sum" },
  ],
  compute: async (client) => {
    const active = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM lms_enrollments WHERE status IN ('assigned','in_progress')`,
    );
    const overdue = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM lms_enrollments
        WHERE status IN ('assigned','in_progress') AND due_on IS NOT NULL AND due_on < CURRENT_DATE`,
    );
    // The compliance headline: mandatory training not yet done. Joined rather than flagged on the
    // enrolment because a path can BECOME mandatory after somebody was assigned it.
    const mandatory = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM lms_enrollments e JOIN lms_paths p ON p.id = e.path_id
        WHERE e.status IN ('assigned','in_progress') AND p.is_mandatory AND p.deleted_at IS NULL`,
    );
    const published = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM lms_courses WHERE status = 'published' AND deleted_at IS NULL`,
    );
    const completions = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM lms_completions
        WHERE path_id IS NOT NULL AND completed_at >= now() - INTERVAL '90 days'`,
    );
    return [
      { metricKey: "lms.enrollments_active", numerator: Number(active.rows[0].n) },
      { metricKey: "lms.enrollments_overdue", numerator: Number(overdue.rows[0].n) },
      { metricKey: "lms.mandatory_outstanding", numerator: Number(mandatory.rows[0].n) },
      { metricKey: "lms.courses_published", numerator: Number(published.rows[0].n) },
      { metricKey: "lms.completions_90d", numerator: Number(completions.rows[0].n) },
    ];
  },
};

export const lmsModule: ModuleContract = {
  key: "lms",
  migrations: [
    "202608241322_module_lms_l1.sql",        // 9 tables behind the lms third wall
    "202608241340_iam_lms_l1_permissions.sql", // 2 roles, 12 permissions, bundles
    // L2: companies.is_training + cohorts + the reset allow-list and its append-only ledger.
    "202608241550_lms_l2_general_track_and_training_tenant.sql",
    // L5b: the platform's record of a dispatch to the lab runner, and the rate-limit index.
    "202608250950_lms_l5_lab_runs.sql",
  ],
  permissions: [
    { key: "lms.course.read", description: "Browse the learning catalogue" },
    { key: "lms.course.create", description: "Author a course or learning path" },
    { key: "lms.course.update", description: "Edit a course or path (a published edit opens a new version)" },
    { key: "lms.course.publish", description: "Publish a course version, making it assignable" },
    { key: "lms.course.retire", description: "Withdraw a course from assignment" },
    { key: "lms.course.delete", description: "Delete a course outright (prefer retire)" },
    { key: "lms.enrollment.read", description: "Read enrolments, progress and scores" },
    { key: "lms.enrollment.create", description: "Assign a learning path" },
    { key: "lms.enrollment.update", description: "Record progress and submit attempts" },
    { key: "lms.enrollment.grade", description: "Grade a submitted attempt for a reviewed activity" },
    { key: "lms.enrollment.waive", description: "Excuse somebody from mandatory training" },
    { key: "lms.enrollment.export", description: "Bulk-export the training register (high assurance)" },
  ],
  customFieldTargets: ["lms_course", "lms_path"],
  mcpTools: [
    // READS ONLY, for the same reason HR-FULL's tools are reads only: a declared WRITE tool with no
    // D14 executor suspends for a human and then silently does nothing. "Enrol 40 people and then
    // don't" is a worse failure than having no agent path.
    {
      name: "lms.listCatalogue",
      description: "Browse published courses and learning paths, optionally filtered by track, department unit, discipline or level.",
      minAssurance: "verified",
      method: "GET",
      pathTemplate: "/api/:tenantId/modules/lms/courses",
      inputSchema: {
        type: "object",
        properties: {
          tenantId: { type: "string" },
          track: { type: "string", enum: ["general", "department"] },
          unitNodeId: { type: "string" },
          discipline: { type: "string" },
          level: { type: "string", enum: ["foundation", "practitioner", "advanced", "lead"] },
        },
        required: ["tenantId"],
      },
    },
    {
      name: "lms.myLearning",
      description: "The caller's own assigned learning: paths, progress, what is outstanding and what is overdue.",
      minAssurance: "verified",
      method: "GET",
      pathTemplate: "/api/:tenantId/modules/lms/me",
      inputSchema: { type: "object", properties: { tenantId: { type: "string" } }, required: ["tenantId"] },
    },
    {
      name: "lms.getComplianceSummary",
      description:
        "Who has and has not completed mandatory training, by path. The compliance answer — outstanding and overdue counts, never a per-person score dump.",
      minAssurance: "verified",
      method: "GET",
      pathTemplate: "/api/:tenantId/modules/lms/compliance",
      inputSchema: { type: "object", properties: { tenantId: { type: "string" } }, required: ["tenantId"] },
    },
  ],
  rollupProviders: [lmsRollups],
  uiManifest: [
    { label: "Learning", path: "/learning" },
    { label: "My learning", path: "/me/learning" },
    { label: "Catalogue", path: "/learning/catalogue" },
    { label: "Compliance", path: "/learning/compliance" },
  ],
  // No event handlers in L1. The mandatory-path auto-assignment runner is L2, and it is a sweep
  // rather than an event consumer — a new employee needs enrolling whether or not anybody emitted
  // an event, and a sweep is idempotent where a missed event is silent.
};
