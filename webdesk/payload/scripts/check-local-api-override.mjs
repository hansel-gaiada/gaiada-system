#!/usr/bin/env node
// WSK-D25's required follow-up — the lint that keeps the SECOND wall standing on the Payload side.
//
// ── THE GAP THIS EXISTS TO CLOSE ────────────────────────────────────────────────────────────────
// WSK-D16 says tenant isolation is TWO independent mechanisms: Postgres FORCE RLS (the GUC) and an
// app-layer predicate. WSK-04 proved their mutual independence for `webdesk/api`. WSK-D25 added the
// predicate on the Payload side too (`src/tenant-access.mjs`) — and closed the gap only PARTIALLY,
// for a structural reason:
//
//   Payload runs a collection's `access.*` function only when the caller's `overrideAccess` is
//   falsy, and **the Local API defaults `overrideAccess: true`**. REST leaves it undefined, so the
//   predicate fires there. A Local API call that does not explicitly opt in therefore runs on
//   **RLS alone** — one mechanism, not two. That is a defence-in-depth claim that is only half true.
//
// The design named the fix and nobody built it: "a lint or convention forcing project Local API
// callers to pass `overrideAccess: false`, or a future author silently reintroduces exactly the gap
// this decision closed." This is that lint.
//
// ── WHAT IT DOES AND DOES NOT COVER, HONESTLY ───────────────────────────────────────────────────
// It is a static text check, not a type system. It finds Local API operation calls whose options
// object does not mention `overrideAccess`, in project source only. It CANNOT see a call whose
// options are built dynamically (`payload.find(opts)`), and it does not try to — a lint that
// pretends to catch everything is worse than one whose blind spot is written down. The dynamic form
// does not appear in this project today; if it ever does, this check will not save you.
//
// Scope: project source. `test/` is excluded on purpose — the suites deliberately exercise BOTH
// settings (that is how mutual independence gets proven), so linting them would forbid the evidence.
//
// Run:  node scripts/check-local-api-override.mjs           (exit 1 on any finding)
//       node scripts/check-local-api-override.mjs --selftest (proves the check can FAIL)

import { readdirSync, readFileSync, statSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";

const OPS = ["find", "findByID", "create", "update", "delete"];

/** Files that may legitimately use the Local API WITHOUT the predicate.
 *  Each entry needs a reason — an allowlist without reasons becomes a place to hide. */
const ALLOWLIST = new Map([
  [
    join("scripts", "setup-schema.mjs"),
    "owner-run schema bootstrap: connects AS THE OWNER ROLE to create tables before any tenant " +
      "exists. There is no tenant context to scope to, and it never serves a request.",
  ],
]);

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "test", "migrations", "vocabulary"]);

/** This file itself. It contains the bad form on purpose — that is what `--selftest` asserts on —
 *  so scanning it reports the checker as its own first violation. Found by running it. */
const SELF = join("scripts", "check-local-api-override.mjs");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(full);
  }
  return out;
}

/** Returns the source slice of a balanced `{...}` starting at `open`, or null if unbalanced. */
function balancedObject(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

export function findViolations(src, label) {
  const found = [];
  // `.find({`, `.create({`, ... — the Local API's object-options form.
  const re = new RegExp(`\\.(${OPS.join("|")})\\s*\\(\\s*\\{`, "g");
  let m;
  while ((m = re.exec(src)) !== null) {
    const openBrace = src.indexOf("{", m.index);
    const obj = balancedObject(src, openBrace);
    if (obj === null) continue;
    // A Local API call always names its collection; this is what separates it from array `.find(`,
    // `Map.delete(`, a repository `.update(`, and every other same-named method in the language.
    if (!/\bcollection\s*:/.test(obj)) continue;
    if (/\boverrideAccess\s*:/.test(obj)) continue;
    found.push({
      file: label,
      line: src.slice(0, m.index).split("\n").length,
      op: m[1],
    });
  }
  return found;
}

function selftest() {
  const dir = mkdtempSync(join(tmpdir(), "wd-lint-"));
  let failures = 0;
  const check = (name, cond) => {
    console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}`);
    if (!cond) failures++;
  };

  const bad = `await payload.find({ collection: 'pages', where: { id: { equals: 1 } } })`;
  const good = `await payload.find({ collection: 'pages', overrideAccess: false, where: {} })`;
  const notLocalApi = `const x = list.find({ id: 1 }); map.delete({ k: 1 });`;
  const nested = `await payload.create({ collection: 'pages', data: { title: 'a', meta: { x: 1 } } })`;

  check("a Local API call with NO overrideAccess is flagged", findViolations(bad, "t").length === 1);
  check("the same call WITH overrideAccess:false is not flagged", findViolations(good, "t").length === 0);
  check("non-Payload .find/.delete (no `collection:`) is not flagged", findViolations(notLocalApi, "t").length === 0);
  check("a nested options object does not break brace balancing", findViolations(nested, "t").length === 1);

  writeFileSync(join(dir, "probe.mjs"), bad);
  check("THE REGRESSION: a real file on disk containing the bad form is caught",
    findViolations(readFileSync(join(dir, "probe.mjs"), "utf8"), "probe.mjs").length === 1);

  rmSync(dir, { recursive: true, force: true });
  console.log(`\n  selftest: ${5 - failures} passed, ${failures} failed`);
  return failures === 0 ? 0 : 1;
}

function main() {
  if (process.argv.includes("--selftest")) return selftest();

  const root = process.cwd();
  const violations = [];
  for (const file of walk(root)) {
    const rel = relative(root, file);
    if (rel === SELF || ALLOWLIST.has(rel)) continue;
    violations.push(...findViolations(readFileSync(file, "utf8"), rel.split(sep).join("/")));
  }

  if (violations.length === 0) {
    console.log(
      `[local-api-override] OK — every project Local API call passes overrideAccess ` +
        `(${ALLOWLIST.size} documented exception${ALLOWLIST.size === 1 ? "" : "s"}).`,
    );
    return 0;
  }

  console.error(
    `[local-api-override] ${violations.length} Local API call(s) do not pass \`overrideAccess\`.\n` +
      `Payload defaults it to TRUE there, so these run on RLS ALONE — one wall, not the two\n` +
      `WSK-D16 requires. Pass \`overrideAccess: false\` so src/tenant-access.mjs's predicate fires,\n` +
      `or add the file to this script's ALLOWLIST **with the reason it is safe**.\n`,
  );
  for (const v of violations) console.error(`  ${v.file}:${v.line}  .${v.op}({ … })`);
  return 1;
}

process.exit(main());
