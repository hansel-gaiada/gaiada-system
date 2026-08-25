// THE HANDS-ON LABS — FE, BE, QA (L5c), and DevOps + Cyber (L6b/L6c).
//
// Design: docs/blueprints/lms-foundation.md §5.1, "FE / BE / QA → run and assert", extended by §5
// for the two disciplines that needed the runner to do something it did not do yet. All five attach
// to course keys L4 already published, so the curriculum gains practice without being rebuilt.
//
// ── WHY DEVOPS AND CYBER WAITED FOR L6 ─────────────────────────────────────────────────────────
// FE, BE and QA are the tractable case: execute, capture stdout and exit code, assert. DevOps is
// artefact-graded — its lab below is graded on a REAL tool's own stderr/exit (`nginx -t`), never on
// `fileExists` alone, for the same reason as the warning further down: the artefact listing comes
// from inside the learner's own container and is forgeable. Cyber needs a disposable, deliberately
// vulnerable companion container (`spec.target`) that the runner did not support until L6a. Shipping
// either as a `lab` activity nothing could pass would have made its path permanently uncompletable —
// the exact failure L4 refused to ship — so both waited for the runner capability that makes them
// gradeable at all.
//
// ── THE SHAPE OF A LAB ACTIVITY'S `spec` ──────────────────────────────────────────────────────
//   { image, files[], gradingSpec: { checks[], passThreshold }, limits?, target? }
// `files[]` are the CHALLENGE's fixtures — the graded tests. `lab-dispatch.ts` merges them with the
// learner's submission and a learner file may NEVER displace one, because overwriting the test file
// is the obvious full-marks exploit. `target` (Cyber only) is the companion container's image key,
// alias and boot delay — forwarded to the runner verbatim by `lab-dispatch.ts`, same as `image`.
//
// ⚠ FIXTURES ARE THE ANSWER KEY. They live in `lms_activities.spec` and are redacted by
//   spec-redaction.ts for anyone who is not authoring the course. `assertions` is on that
//   strip-list, so a learner reading the course does not get the test file handed to them.
//   `gradingSpec` itself is ALSO on that list — stripped WHOLESALE, not field-by-field — which is
//   why the Cyber lab's flag can live directly in a `stdoutMatches` pattern below rather than in some
//   separate, harder-to-audit secret store: the redaction already covers the whole object it lives in.
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
  /** Runner image KEY. Defaults to "node22" — the FE/BE/QA labs' JS harness runtime. DevOps needs
   *  a different one; Cyber's attacker stays on node22 (Node 22's global `fetch`, no dependency). */
  image?: string;
  /** Per-lab resource/network overrides, merged over the shared default. Only the Cyber lab sets
   *  `network: "isolated"` — everything else stays fully network-less, the default posture. */
  limits?: { timeoutSec?: number; memoryMb?: number; network?: "none" | "isolated" };
  /** Present only for the Cyber lab (L6c): the disposable, deliberately vulnerable companion
   *  container the learner's own container talks to on a per-run, internal-only network. See
   *  `sandbox.ts`'s `buildTargetArgs` for the isolation it gets — same hardening as the attacker,
   *  no published port, ever. */
  target?: { image: string; alias?: string; readySec?: number };
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

/** A syntactically valid stand-in, used ONLY when no flag is configured. */
const FLAG_PLACEHOLDER = "000000000000000000000000";

/**
 * The Cyber lab's flag payload, from the environment.
 *
 * ⚠ THIS DOES NOT THROW, and the first version did — which broke CI the moment it landed. `LABS` is
 *   a module-level array literal, so this runs at IMPORT time; a throw here takes down every
 *   importer, including a test suite that only ever asserts the flag's SHAPE and has no business
 *   holding the real value. An operational guard belongs at the operation, not at module load.
 *
 * The real refusal is `assertCyberFlagConfigured()`, called by the seed. Seeding live without a
 * flag still fails loudly; importing this module does not.
 */
function cyberFlagPayload(): string {
  const m = (process.env.LMS_CYBER_FLAG ?? "").match(/^FLAG\{([a-f0-9]{8,})\}$/);
  return m ? m[1] : FLAG_PLACEHOLDER;
}

/**
 * Refuse to SEED without a real flag.
 *
 * A placeholder would seed a grading spec that cannot match what the target image actually holds,
 * so a learner would exploit the box correctly and still score zero — a failure that reads as "my
 * exploit is wrong" and is very hard to argue with.
 */
function assertCyberFlagConfigured(): void {
  if (cyberFlagPayload() === FLAG_PLACEHOLDER) {
    throw new Error(
      "LMS_CYBER_FLAG is required to seed the Cyber lab, as FLAG{<hex>} — the same value the " +
      "`gaiada-lab-target-nettools` image was built with. It is deliberately NOT in this repository: " +
      "a flag in the repo is readable by exactly the people taking the lab.",
    );
  }
}

/** Exported so the reference solutions can be driven against the REAL runner. A lab whose own
 *  reference solution does not pass is worse than no lab: it teaches people that correct work
 *  fails; and a lab whose STARTER passes teaches nothing at all. Both directions are driven
 *  against the deployed runner, because neither can be checked from here. */
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

  // ═══════════════════════════════════════════════════════════════════════════════ DEVOPS ════
  {
    courseKey: "webdev-devops-practice",
    moduleTitle: "Hands on",
    title: "Lab: an nginx config that survives nginx's OWN validator",
    minutes: 40,
    image: "nginx",
    brief:
      "Fix `default.conf` — a virtual-host snippet `include`d into nginx's `http {}` block, exactly " +
      "as a real `/etc/nginx/conf.d/default.conf` is — so it passes `nginx -t`, nginx's own " +
      "configuration test. You are not graded against a checklist: the grader runs the real nginx " +
      "binary against your file and reads its real stderr, so the only way to pass is to make nginx " +
      "itself agree the file is correct.\n\n" +
      "The starter has two separate bugs, and nginx's own parser refuses each for a different, " +
      "genuine reason. `default.conf` must define two virtual hosts sharing port 8080 — a public " +
      "one and an internal ops one — but only ONE of them may be nginx's default for that port; " +
      "nginx refuses a second default with 'a duplicate default server for 0.0.0.0:8080'. And the " +
      "public host's `/health` location must return a valid HTTP status code — nginx accepts 0 or " +
      "100–999 and refuses anything else with 'invalid return code'. Both failure messages are " +
      "nginx's own words, not this course's, and both stop appearing only once both are actually " +
      "fixed.",
    fixtures: [
      {
        path: "run.sh",
        content:
          "# The scaffolding nginx needs to run `-t` at all inside a read-only, non-root container —\n" +
          "# pid, error log and every temp path pointed at /work, the one writable directory this\n" +
          "# sandbox has. None of this is what you are graded on; default.conf is.\n" +
          "mkdir -p /work/tmp\n" +
          "cat > /work/_main.conf <<'MAINCONF'\n" +
          "events {}\n" +
          "http {\n" +
          "    client_body_temp_path /work/tmp/client;\n" +
          "    proxy_temp_path       /work/tmp/proxy;\n" +
          "    fastcgi_temp_path     /work/tmp/fastcgi;\n" +
          "    uwsgi_temp_path       /work/tmp/uwsgi;\n" +
          "    scgi_temp_path        /work/tmp/scgi;\n" +
          "    include /work/default.conf;\n" +
          "}\n" +
          "MAINCONF\n" +
          "nginx -t -c /work/_main.conf -g 'pid /work/nginx.pid; error_log /dev/stderr;' 2>&1\n" +
          "exit $?\n",
      },
    ],
    starter: [
      {
        path: "default.conf",
        content:
          "# your code here — this file is included inside nginx's http{} block, exactly like a\n" +
          "# real /etc/nginx/conf.d/default.conf.\n" +
          "#\n" +
          "# Two virtual hosts must share port 8080: the public one below, and an internal ops one.\n" +
          "# Exactly ONE of them may be nginx's default for that port.\n" +
          "server {\n" +
          "    listen 8080 default_server;\n" +
          "    server_name lab.gaiada.test;\n" +
          "\n" +
          "    location /health {\n" +
          "        return 9999 \"ok\\n\";\n" +
          "    }\n" +
          "}\n" +
          "\n" +
          "server {\n" +
          "    listen 8080 default_server;\n" +
          "    server_name ops.lab.gaiada.test;\n" +
          "\n" +
          "    location / {\n" +
          "        return 200 \"internal\\n\";\n" +
          "    }\n" +
          "}\n",
      },
    ],
    checks: [
      { kind: "exitCode", equals: 0, describe: "nginx -t accepts your config", weight: 3 },
      { kind: "stdoutMatches", pattern: "test is successful", describe: "nginx's own validator confirms it", weight: 2 },
      { kind: "stdoutLacks", pattern: "\\[emerg\\]", describe: "no nginx emerg-level configuration error" },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════════════ CYBER ═════
  {
    courseKey: "webdev-cyber-practice",
    moduleTitle: "Hands on",
    title: "Lab: exploit a command injection and read the flag",
    minutes: 45,
    image: "node22",
    limits: { network: "isolated" },
    target: { image: "nettools", alias: "target", readySec: 4 },
    brief:
      "`target` is a disposable NetTools box, reachable only from your own container on a per-run, " +
      "internal-only network — nowhere else — and it is destroyed with your run. Its `/ping?host=` " +
      "endpoint shells out to the system `ping` with your `host` value concatenated straight into " +
      "the command line: classic command injection, the exact shape this course teaches you to look " +
      "for, in shells, SQL, LDAP and templates alike.\n\n" +
      "The flag lives at `/opt/flag.txt` and is never served — hitting `/flag` gets you a 403. " +
      "Complete `exploit.js` so it makes the target run an EXTRA command alongside the ping, reads " +
      "the flag, and prints it to stdout. You are graded on the real HTTP response the target " +
      "actually sent back to your request, nothing else.",
    fixtures: [
      { path: "run.sh", content: "node exploit.js\n" },
    ],
    starter: [
      {
        path: "exploit.js",
        content:
          "// your code here\n" +
          "//\n" +
          "// `target` resolves to the vulnerable NetTools box (see the brief). Its /ping endpoint\n" +
          "// runs: execSync(`ping -c 1 ${host} 2>&1`) — your `host` value lands INSIDE a shell\n" +
          "// command line unescaped. A shell metacharacter (`;`, `&&`, `|`, backticks…) after a\n" +
          "// throwaway address lets you run a second command in the same breath as the ping.\n" +
          "//\n" +
          "// fetch is global in Node 22 — no dependency needed. Print ONLY what the target sends\n" +
          "// back; the grader reads your real stdout.\n" +
          "async function main() {\n" +
          "  // your code here\n" +
          "}\n" +
          "main();\n",
      },
    ],
    checks: [
      { kind: "exitCode", equals: 0, describe: "the exploit script runs to completion", weight: 1 },
      // ⚠ THE FLAG IS NOT IN THIS REPOSITORY, and that is the point. It is read from the
      // environment at seed time and baked into the target image at build time (see
      // `lab-runner/targets/webapp-cmdi/Dockerfile`, ARG FLAG). A literal here would be
      // readable by every Web Dev person with repo access — which is exactly the set of
      // people taking this lab — and would defeat spec-redaction.ts entirely.
      { kind: "stdoutMatches", pattern: `FLAG\{${cyberFlagPayload()}\}`, describe: "the target discloses its flag", weight: 4 },
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
  assertCyberFlagConfigured();
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
             image: lab.image ?? "node22",
             brief: lab.brief,
             // The learner's starting point — replaceable, and shown in the UI.
             starter: lab.starter,
             // The graded tests. A learner file may never displace one of these.
             files: lab.fixtures,
             limits: { timeoutSec: 60, memoryMb: 384, ...(lab.limits ?? {}) },
             // Only the Cyber lab carries this — omitted entirely for everyone else, never sent as
             // an explicit `null`/`undefined`, because the runner treats `target !== undefined` as
             // "validate target.image" and would reject every other lab's request otherwise.
             ...(lab.target ? { target: lab.target } : {}),
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
