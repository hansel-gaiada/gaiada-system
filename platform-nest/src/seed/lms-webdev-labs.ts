// THE FIRST HANDS-ON LABS — FE, BE and QA (L5c).
//
// Design: docs/blueprints/lms-foundation.md §5.1, "FE / BE / QA → run and assert". These attach to
// the course keys L4 already published, so the curriculum gains practice without being rebuilt.
//
// ── WHY ONLY THREE DISCIPLINES ────────────────────────────────────────────────────────────────
// FE, BE and QA are the tractable case: execute, capture stdout and exit code, assert. DevOps is
// artefact-graded and Cyber needs a disposable target pair — both are L6, and both need the runner
// to do something it does not do yet. Shipping them here as `lab` activities that nothing can pass
// would make their paths uncompletable, which is the exact failure L4 refused to ship.
//
// ── THE SHAPE OF A LAB ACTIVITY'S `spec` ──────────────────────────────────────────────────────
//   { image, files[], gradingSpec: { checks[], passThreshold }, limits? }
// `files[]` are the CHALLENGE's fixtures — the graded tests. `lab-dispatch.ts` merges them with the
// learner's submission and a learner file may NEVER displace one, because overwriting the test file
// is the obvious full-marks exploit.
//
// ⚠ FIXTURES ARE THE ANSWER KEY. They live in `lms_activities.spec` and are redacted by
//   spec-redaction.ts for anyone who is not authoring the course. `assertions` is on that
//   strip-list, so a learner reading the course does not get the test file handed to them.
//
// ── GRADING PAIRS AN ASSERTION WITH THE OUTPUT, NEVER `fileExists` ALONE ──────────────────────
// The artefact listing comes from inside the learner's own container, so `touch dist/app.js`
// satisfies "did you produce dist/app.js". Every check below is an exit code or a match on the
// test runner's own summary line — things the learner would have to actually make true.
import { withTenants, withGlobal, closePool, newId } from "../db";

const AGENCY_NAME = "Gaia Digital Agency";

export interface LabSpec {
  courseKey: string;
  moduleTitle: string;
  title: string;
  brief: string;
  /** Files the CHALLENGE provides. The learner cannot overwrite these. */
  fixtures: { path: string; content: string }[];
  /** Files the learner starts from — shown in the UI, replaceable. */
  starter: { path: string; content: string }[];
  checks: Record<string, unknown>[];
  minutes: number;
}

/** A tiny assertion harness, shared by every lab so the summary line is uniform and matchable. */
const HARNESS = `let passed = 0, failed = 0;
const t = (name, fn) => {
  try { fn(); passed++; }
  catch (e) { failed++; console.log('FAIL ' + name + ': ' + (e && e.message ? e.message : e)); }
};
const eq = (got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) throw new Error('expected ' + w + ' but got ' + g);
};
const done = () => {
  console.log(passed + ' passing, ' + failed + ' failing');
  process.exit(failed ? 1 : 0);
};
module.exports = { t, eq, done };
`;

/** Standard checks: it ran, everything passed, nothing failed. */
const standardChecks = (expectedPassing: number) => ([
  { kind: "exitCode", equals: 0, describe: "the test suite exits clean", weight: 2 },
  { kind: "stdoutMatches", pattern: `${expectedPassing} passing`, describe: `all ${expectedPassing} assertions pass`, weight: 2 },
  { kind: "stdoutLacks", pattern: "FAIL ", describe: "no assertion failed" },
]);

/** Exported so the reference solutions can be driven against the REAL runner. A lab whose own
 *  reference solution does not pass is worse than no lab: it teaches people that correct work
 *  fails. `lms-webdev-labs.reference.test.ts` is that check. */
export const LABS: LabSpec[] = [
  // ═══════════════════════════════════════════════════════════════════════════════════ FE ════
  {
    courseKey: "webdev-fe-practice",
    moduleTitle: "Hands on",
    title: "Lab: an accessible, keyboard-operable disclosure",
    minutes: 45,
    brief:
      "Implement `createDisclosure(button, panel)` in solution.js so a disclosure widget is correct " +
      "for a keyboard and a screen reader, not only for a mouse.\n\n" +
      "It must: set aria-expanded on the button (string \"true\"/\"false\"), toggle the panel's hidden " +
      "property to match, start collapsed, and close on Escape.\n\n" +
      "You are given a minimal DOM stub — no browser, no framework. That is deliberate: the point is " +
      "the semantics, and the semantics are what survive a framework change.",
    fixtures: [
      { path: "harness.js", content: HARNESS },
      {
        path: "dom.js",
        content:
          "// A DOM stub small enough to read. Only what the lab needs.\n" +
          "class El {\n" +
          "  constructor(tag) { this.tag = tag; this.attrs = {}; this.hidden = false; this.handlers = {}; }\n" +
          "  setAttribute(k, v) { this.attrs[k] = String(v); }\n" +
          "  getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; }\n" +
          "  addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); }\n" +
          "  dispatch(type, ev) { (this.handlers[type] || []).forEach((f) => f(ev || {})); }\n" +
          "}\n" +
          "module.exports = { El };\n",
      },
      {
        path: "test.js",
        content:
          "const { t, eq, done } = require('./harness');\n" +
          "const { El } = require('./dom');\n" +
          "const { createDisclosure } = require('./solution');\n" +
          "const mk = () => { const b = new El('button'), p = new El('div'); createDisclosure(b, p); return { b, p }; };\n" +
          "t('starts collapsed', () => { const { b, p } = mk(); eq(b.getAttribute('aria-expanded'), 'false'); eq(p.hidden, true); });\n" +
          "t('click expands', () => { const { b, p } = mk(); b.dispatch('click'); eq(b.getAttribute('aria-expanded'), 'true'); eq(p.hidden, false); });\n" +
          "t('click again collapses', () => { const { b, p } = mk(); b.dispatch('click'); b.dispatch('click'); eq(b.getAttribute('aria-expanded'), 'false'); eq(p.hidden, true); });\n" +
          "t('Escape closes an open panel', () => { const { b, p } = mk(); b.dispatch('click'); b.dispatch('keydown', { key: 'Escape' }); eq(b.getAttribute('aria-expanded'), 'false'); eq(p.hidden, true); });\n" +
          "t('aria-expanded and hidden never disagree', () => { const { b, p } = mk(); for (let i = 0; i < 5; i++) b.dispatch('click'); eq(b.getAttribute('aria-expanded') === 'true', p.hidden === false); });\n" +
          "done();\n",
      },
      { path: "run.sh", content: "node test.js" },
    ],
    starter: [
      {
        path: "solution.js",
        content:
          "// Wire the button to the panel.\n" +
          "// aria-expanded is a STRING attribute: 'true' / 'false', not a boolean.\n" +
          "function createDisclosure(button, panel) {\n" +
          "  // your code here\n" +
          "}\n" +
          "module.exports = { createDisclosure };\n",
      },
    ],
    checks: standardChecks(5),
  },

  // ═══════════════════════════════════════════════════════════════════════════════════ BE ════
  {
    courseKey: "webdev-be-practice",
    moduleTitle: "Hands on",
    title: "Lab: an endpoint that survives being called twice",
    minutes: 60,
    brief:
      "Implement `createPayment(store, { idempotencyKey, amount })` so that calling it twice with " +
      "the same key charges once and returns the SAME payment both times.\n\n" +
      "This is the course's central claim made executable: a response that never arrived is " +
      "indistinguishable from a request that never ran, so every write will happen twice. Two " +
      "different keys must still produce two payments, and a missing key must be refused rather " +
      "than quietly treated as unique.",
    fixtures: [
      { path: "harness.js", content: HARNESS },
      {
        path: "store.js",
        content:
          "// An in-memory stand-in for the database. `insert` throws on a duplicate key, exactly as a\n" +
          "// unique constraint would — that is the behaviour you are meant to rely on.\n" +
          "function makeStore() {\n" +
          "  const rows = new Map();\n" +
          "  return {\n" +
          "    insert(key, row) {\n" +
          "      if (rows.has(key)) { const e = new Error('duplicate key'); e.code = '23505'; throw e; }\n" +
          "      rows.set(key, row); return row;\n" +
          "    },\n" +
          "    get(key) { return rows.get(key); },\n" +
          "    count() { return rows.size; },\n" +
          "  };\n" +
          "}\n" +
          "module.exports = { makeStore };\n",
      },
      {
        path: "test.js",
        content:
          "const { t, eq, done } = require('./harness');\n" +
          "const { makeStore } = require('./store');\n" +
          "const { createPayment } = require('./solution');\n" +
          "t('a single call charges once', () => { const s = makeStore(); const p = createPayment(s, { idempotencyKey: 'k1', amount: 100 }); eq(p.amount, 100); eq(s.count(), 1); });\n" +
          "t('the same key twice charges ONCE', () => { const s = makeStore(); createPayment(s, { idempotencyKey: 'k1', amount: 100 }); createPayment(s, { idempotencyKey: 'k1', amount: 100 }); eq(s.count(), 1); });\n" +
          "t('and returns the same payment both times', () => { const s = makeStore(); const a = createPayment(s, { idempotencyKey: 'k1', amount: 100 }); const b = createPayment(s, { idempotencyKey: 'k1', amount: 100 }); eq(a, b); });\n" +
          "t('different keys are different payments', () => { const s = makeStore(); createPayment(s, { idempotencyKey: 'k1', amount: 100 }); createPayment(s, { idempotencyKey: 'k2', amount: 100 }); eq(s.count(), 2); });\n" +
          "t('a missing key is refused, not treated as unique', () => {\n" +
          "  const s = makeStore(); let threw = false;\n" +
          "  try { createPayment(s, { amount: 100 }); } catch (e) { threw = true; }\n" +
          "  eq(threw, true);\n" +
          "});\n" +
          "t('a retry does not double the amount', () => { const s = makeStore(); createPayment(s, { idempotencyKey: 'k9', amount: 250 }); const again = createPayment(s, { idempotencyKey: 'k9', amount: 250 }); eq(again.amount, 250); });\n" +
          "done();\n",
      },
      { path: "run.sh", content: "node test.js" },
    ],
    starter: [
      {
        path: "solution.js",
        content:
          "// `store.insert(key, row)` throws { code: '23505' } on a duplicate, like a unique constraint.\n" +
          "// Decide what a second call with the same key should do — and what it should RETURN.\n" +
          "function createPayment(store, { idempotencyKey, amount } = {}) {\n" +
          "  // your code here\n" +
          "}\n" +
          "module.exports = { createPayment };\n",
      },
    ],
    checks: standardChecks(6),
  },

  // ═══════════════════════════════════════════════════════════════════════════════════ QA ════
  {
    courseKey: "webdev-qa-practice",
    moduleTitle: "Hands on",
    title: "Lab: write the tests that catch a real bug",
    minutes: 50,
    brief:
      "The reverse of the usual exercise. `discount.js` is GIVEN and it has bugs. Write tests in " +
      "`mytests.js` that catch them.\n\n" +
      "`applyDiscount(price, percent)` should: reject a negative price, reject a percent outside " +
      "0–100, round to 2 decimals, and never return a negative total. At least one of those is " +
      "wrong.\n\n" +
      "You are graded on whether your tests FAIL against the broken implementation and PASS against " +
      "a correct one — which is the only definition of a useful test: the value of a test is " +
      "entirely in the failure it would produce.",
    fixtures: [
      { path: "harness.js", content: HARNESS },
      {
        path: "discount.js",
        content:
          "// The implementation under test. Assume nothing.\n" +
          "function applyDiscount(price, percent) {\n" +
          "  if (price < 0) throw new Error('price must not be negative');\n" +
          "  // BUG: the upper bound is not checked, so 150% yields a negative total.\n" +
          "  if (percent < 0) throw new Error('percent out of range');\n" +
          "  // BUG: truncates instead of rounding.\n" +
          "  return Math.floor(price * (1 - percent / 100) * 100) / 100;\n" +
          "}\n" +
          "module.exports = { applyDiscount };\n",
      },
      {
        path: "correct.js",
        content:
          "function applyDiscount(price, percent) {\n" +
          "  if (price < 0) throw new Error('price must not be negative');\n" +
          "  if (percent < 0 || percent > 100) throw new Error('percent out of range');\n" +
          "  return Math.round(price * (1 - percent / 100) * 100) / 100;\n" +
          "}\n" +
          "module.exports = { applyDiscount };\n",
      },
      {
        path: "test.js",
        content:
          "// Runs the learner's tests TWICE: against the broken implementation and against a correct\n" +
          "// one. Good tests fail the first and pass the second. Tests that always pass catch nothing;\n" +
          "// tests that always fail are not tests either.\n" +
          "const path = require('path');\n" +
          "function runAgainst(mod) {\n" +
          "  const results = [];\n" +
          "  const t = (name, fn) => { try { fn(); results.push([name, true]); } catch (e) { results.push([name, false]); } };\n" +
          "  const eq = (got, want) => {\n" +
          "    const g = JSON.stringify(got), w = JSON.stringify(want);\n" +
          "    if (g !== w) throw new Error('expected ' + w + ' but got ' + g);\n" +
          "  };\n" +
          "  const { applyDiscount } = require(mod);\n" +
          "  const tests = require('./mytests');\n" +
          "  tests({ t, eq, applyDiscount });\n" +
          "  return results;\n" +
          "}\n" +
          "const broken = runAgainst('./discount');\n" +
          "for (const k of Object.keys(require.cache)) delete require.cache[k];\n" +
          "const correct = runAgainst('./correct');\n" +
          "\n" +
          "const total = broken.length;\n" +
          "let caught = 0, falseAlarms = 0;\n" +
          "for (let i = 0; i < total; i++) {\n" +
          "  if (!broken[i][1] && correct[i] && correct[i][1]) caught++;\n" +
          "  if (correct[i] && !correct[i][1]) { falseAlarms++; console.log('FAIL ' + correct[i][0] + ': fails against a CORRECT implementation'); }\n" +
          "}\n" +
          "if (total < 3) console.log('FAIL coverage: write at least 3 tests, you wrote ' + total);\n" +
          "if (caught < 2) console.log('FAIL detection: your tests caught ' + caught + ' of the 2 bugs');\n" +
          "console.log('caught ' + caught + ' of 2 bugs across ' + total + ' tests');\n" +
          "const ok = total >= 3 && caught >= 2 && falseAlarms === 0;\n" +
          "console.log(ok ? 'LAB PASSED' : 'LAB FAILED');\n" +
          "process.exit(ok ? 0 : 1);\n",
      },
      { path: "run.sh", content: "node test.js" },
    ],
    starter: [
      {
        path: "mytests.js",
        content:
          "// Export a function that receives { t, eq, applyDiscount } and registers your tests.\n" +
          "// It is run TWICE — once against the broken implementation, once against a correct one.\n" +
          "//\n" +
          "//   t('a name', () => { eq(applyDiscount(100, 10), 90); });\n" +
          "//\n" +
          "// Write at least 3, and make at least 2 of them fail against the broken version.\n" +
          "module.exports = function ({ t, eq, applyDiscount }) {\n" +
          "  // your tests here\n" +
          "};\n",
      },
    ],
    checks: [
      { kind: "exitCode", equals: 0, describe: "your tests caught the bugs and raised no false alarms", weight: 3 },
      { kind: "stdoutMatches", pattern: "caught 2 of 2 bugs", describe: "both bugs were caught", weight: 2 },
      { kind: "stdoutLacks", pattern: "fails against a CORRECT implementation", describe: "no test fails a correct implementation" },
      { kind: "stdoutMatches", pattern: "LAB PASSED", describe: "the lab passed" },
    ],
  },
];

export interface LabSeedResult {
  tenantId: string;
  created: string[];
  existing: string[];
  skippedMissingCourse: string[];
}

export async function seedWebdevLabs(companyName = AGENCY_NAME): Promise<LabSeedResult> {
  const company = await withGlobal((c) =>
    c.query<{ id: string; enabled_modules: string[] }>(
      `SELECT id, enabled_modules FROM companies WHERE name = $1 AND deleted_at IS NULL ORDER BY created_at LIMIT 1`,
      [companyName],
    ),
  );
  const tenantId = company.rows[0]?.id;
  if (!tenantId) throw new Error(`company not found: ${companyName}`);
  if (!company.rows[0].enabled_modules.includes("lms")) {
    throw new Error(
      `the 'lms' module is NOT enabled for ${companyName}. Every write would silently affect zero ` +
      `rows and this seed would report success.`,
    );
  }

  const created: string[] = [];
  const existing: string[] = [];
  const skipped: string[] = [];

  for (const lab of LABS) {
    const done = await withTenants(
      [tenantId],
      async (c) => {
        const course = await c.query<{ id: string }>(
          `SELECT id FROM lms_courses WHERE course_key = $1 AND deleted_at IS NULL ORDER BY version DESC LIMIT 1`,
          [lab.courseKey],
        );
        // A lab whose course does not exist is REPORTED, never silently dropped: it means the L4
        // curriculum was not seeded, and a silent skip would leave a discipline with no practice
        // and no message anywhere saying why.
        if (!course.rows[0]) return "missing-course" as const;
        const courseId = course.rows[0].id;

        const already = await c.query<{ id: string }>(
          `SELECT a.id FROM lms_activities a
             JOIN lms_modules m ON m.id = a.module_id
            WHERE m.course_id = $1 AND a.title = $2`,
          [courseId, lab.title],
        );
        if (already.rows[0]) return "exists" as const;

        // The lab lives in its own module at the END of the course — theory first, practice after.
        const modRow = await c.query<{ id: string }>(
          `SELECT id FROM lms_modules WHERE course_id = $1 AND title = $2`,
          [courseId, lab.moduleTitle],
        );
        let moduleId = modRow.rows[0]?.id;
        if (!moduleId) {
          const maxOrder = await c.query<{ n: number | null }>(
            `SELECT max(sort_order) AS n FROM lms_modules WHERE course_id = $1`, [courseId],
          );
          moduleId = newId();
          await c.query(
            `INSERT INTO lms_modules (id, tenant_id, course_id, sort_order, title, summary)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [moduleId, tenantId, courseId, (maxOrder.rows[0].n ?? 0) + 10, lab.moduleTitle,
             "Run it, and be graded on what it actually does."],
          );
        }

        await c.query(
          `INSERT INTO lms_activities (id, tenant_id, module_id, sort_order, kind, title, spec,
                                       is_required, pass_threshold, grading, max_attempts,
                                       estimated_minutes)
           VALUES ($1,$2,$3,$4,'lab',$5,$6,true,$7,'auto',$8,$9)`,
          [newId(), tenantId, moduleId, 10, lab.title,
           JSON.stringify({
             image: "node22",
             brief: lab.brief,
             // The learner's starting point — replaceable, and shown in the UI.
             starter: lab.starter,
             // The graded tests. A learner file may never displace one of these.
             files: lab.fixtures,
             limits: { timeoutSec: 60, memoryMb: 384 },
             gradingSpec: { checks: lab.checks, passThreshold: 100 },
           }),
           // A lab MUST be auto-graded and MUST carry a threshold (ck_lms_activities_lab_graded and
           // ck_lms_activities_threshold, both from L1).
           100, 5, lab.minutes],
        );
        return "created" as const;
      },
      { modules: ["lms"] },
    );
    if (done === "created") created.push(lab.title);
    else if (done === "exists") existing.push(lab.title);
    else skipped.push(`${lab.title} (course ${lab.courseKey} not found)`);
  }

  return { tenantId, created, existing, skippedMissingCourse: skipped };
}

export async function verifyWebdevLabs(tenantId: string): Promise<Record<string, number>> {
  return withTenants(
    [tenantId],
    async (c) => {
      const labs = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM lms_activities WHERE kind = 'lab'`,
      );
      const gradeable = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM lms_activities
          WHERE kind = 'lab' AND grading = 'auto' AND pass_threshold IS NOT NULL
            AND jsonb_array_length(COALESCE(spec->'gradingSpec'->'checks','[]'::jsonb)) > 0`,
      );
      return { labs: Number(labs.rows[0].n), gradeable: Number(gradeable.rows[0].n) };
    },
    { modules: ["lms"] },
  );
}

if (require.main === module) {
  seedWebdevLabs()
    .then(async (r) => {
      console.log("[seed:lms-webdev-labs] tenant", r.tenantId);
      console.log(`  created  ${r.created.length}`);
      console.log(`  existing ${r.existing.length}`);
      if (r.skippedMissingCourse.length) {
        console.log(
          `  ⚠ SKIPPED ${r.skippedMissingCourse.length} — run \`npm run seed:lms-webdev-curriculum\` first:\n` +
          r.skippedMissingCourse.map((s) => `      - ${s}`).join("\n"),
        );
      }
      const counts = await verifyWebdevLabs(r.tenantId);
      console.log("[seed:lms-webdev-labs] verified through withTenants:", JSON.stringify(counts));
      if (counts.labs !== counts.gradeable) {
        throw new Error(
          `${counts.labs - counts.gradeable} lab(s) have no gradeable spec. A required activity ` +
          `nothing can pass makes its whole path permanently uncompletable.`,
        );
      }
      console.log(
        "\nThese need the LAB RUNNER. Without LAB_RUNNER_URL and LAB_RUNNER_TOKEN set, an attempt " +
        "is refused with a clear message rather than left pending — but the exercises cannot be " +
        "completed, so do not assign these paths until the runner is reachable.",
      );
      await closePool();
    })
    .catch(async (e) => {
      console.error("[seed:lms-webdev-labs] FAILED:", e instanceof Error ? e.message : e);
      await closePool();
      process.exit(1);
    });
}
