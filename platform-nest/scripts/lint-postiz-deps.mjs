#!/usr/bin/env node
// SMM-05 — the AGPL containment line, mechanically enforced.
//
// smm-design.md §06 invariant 1 and §11 both say the same thing in different vocabularies: the
// platform interacts with Postiz over REST only, from one adapter, with **zero Postiz code, types
// or packages inside platform-nest**. §11 states it as a lint requirement verbatim — "lint-enforced
// zero Postiz deps in platform-nest" — and this is that lint.
//
// ── WHY A LINT AND NOT A CODE REVIEW ────────────────────────────────────────────────────────────
// The containment argument is a LICENSING argument before it is an architectural one. Postiz is
// AGPL-3.0; our containment memo (OQ-3, awaiting counsel) rests on running it at arm's length as a
// separate service with no shared code, no shared database and no shared process. A single
// `import` of a Postiz package — a types package, a generated client, a copied Prisma model —
// would not "slightly weaken" that argument; it would put our proprietary platform in the same
// derivative-work conversation the whole design exists to stay out of, and the fallback price is
// a $299-$1,199 Mixpost Pro licence plus a re-platform. That is not a thing to leave to whether a
// reviewer happened to notice a new line in a diff.
//
// It is also the security boundary (§11: "the license boundary and the security boundary
// coincide"). Since SMM-04b the licence zone is a different MACHINE, reached over a WireGuard
// tunnel — an in-process dependency would quietly re-couple what a host boundary separated.
//
// ── WHAT IT CHECKS ──────────────────────────────────────────────────────────────────────────────
//   1. package.json — no dependency, devDependency, peer or optional dependency whose name looks
//      like a Postiz package (`postiz`, `@postiz/*`, `@gitroomhq/*`, `gitroom*`).
//   2. src/**.ts — no `import`/`require`/dynamic-import of such a module specifier.
//
// It does NOT ban the *string* "postiz". `social_publisher_orgs.postiz_org_id` is a column name,
// `SOCIAL_POSTIZ_BASE_URL` is a config key, and the driver file is called `postiz.ts` — all of
// those are us naming the thing we talk to over HTTP, which is exactly what containment looks
// like. Banning the word would train people to work around the lint, which is worse than not
// having it. What is forbidden is a MODULE BOUNDARY being crossed, and that is what a specifier
// in an import/require position expresses.
//
// Deliberately grep/AST-lite for the same reason lint-withtenants.mjs is: it needs to classify
// module specifiers, not understand TypeScript, and adding a parser dependency to guard against
// adding a dependency would be its own joke.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SRC = join(ROOT, "src");

/** A module specifier that would put licence-zone code inside this process. */
const FORBIDDEN_SPECIFIER = /^(@postiz\/|postiz$|postiz\/|@gitroomhq\/|gitroom)/i;

/** import ... from "x" | import("x") | require("x") | export ... from "x" */
const SPECIFIER_SITES = [
  /\bfrom\s+["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\s+["']([^"']+)["']/g,
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts") || entry.endsWith(".mts") || entry.endsWith(".js") || entry.endsWith(".mjs")) out.push(full);
  }
  return out;
}

function main() {
  const findings = [];

  // (1) package.json
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      if (FORBIDDEN_SPECIFIER.test(name)) {
        findings.push({ file: "package.json", line: 0, what: `${field}: ${name}` });
      }
    }
  }

  // (2) import/require sites
  const files = walk(SRC);
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    if (!/postiz|gitroom/i.test(text)) continue; // fast path
    const lines = text.split(/\r?\n/);
    for (const pattern of SPECIFIER_SITES) {
      pattern.lastIndex = 0;
      let m;
      while ((m = pattern.exec(text)) !== null) {
        const spec = m[1];
        if (!FORBIDDEN_SPECIFIER.test(spec)) continue;
        const line = text.slice(0, m.index).split(/\r?\n/).length;
        findings.push({ file: relative(ROOT, file), line, what: lines[line - 1]?.trim() ?? spec });
      }
    }
  }

  if (findings.length > 0) {
    console.error(
      `[lint-postiz-deps] FAIL: ${findings.length} Postiz module boundary violation(s).\n\n` +
      "smm-design.md §06 invariant 1 / §11: platform-nest must carry ZERO Postiz packages, types or\n" +
      "code. The publisher is reached over HTTP+JSON from src/modules/social/publisher/postiz.ts and\n" +
      "nowhere else — that adapter IS the AGPL containment line, and it is a licensing boundary\n" +
      "before it is an architectural one.\n",
    );
    for (const f of findings) console.error(`  ${f.file}${f.line ? `:${f.line}` : ""}  ${f.what}`);
    console.error(
      "\nIf a capability genuinely needs something Postiz's REST API cannot express, that is a\n" +
      "fork-touchpoint-budget question (design §06) for the architect/owner — and the documented\n" +
      "answer to a tripwire is the Mixpost fallback, never an in-process dependency.",
    );
    process.exit(1);
  }

  console.log(
    `[lint-postiz-deps] OK — scanned package.json + ${files.length} source files; ` +
    "zero Postiz packages and zero Postiz module imports. The adapter speaks HTTP+JSON only.",
  );
}

main();
