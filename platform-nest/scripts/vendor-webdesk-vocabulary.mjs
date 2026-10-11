#!/usr/bin/env node
// platform-nest/scripts/vendor-webdesk-vocabulary.mjs
//
// WSK-49c — vendors the part of `webdesk/delivery/vocabulary/**` that the ERP's client-website BFF needs to
// apply WSK-D59 / WSK-D62 ("a client changes only what the composition marks client-editable") BEFORE a
// write leaves the ERP: `client-editable.ts` (the ONE rule, `isClientEditable`, and the content diff) and
// everything it imports (`primitives.ts`, `composition.ts`, and what those import: `blocks.ts`, `version.ts`).
//
// WHY A COPY, AND WHY NOT AN IMPORT. platform-nest and webdesk are separate packages that CI builds and
// tests as separate jobs, and platform-nest is built from its own directory (its Docker build context does
// not contain `webdesk/`). A relative import across the package boundary compiles on a developer's machine
// and breaks in the CI job or the image, so nothing in platform-nest imports from `../webdesk`. A hand-copy
// would drift silently, and the whole point of this layer is that it agrees with WebDesk's own check. So the
// files are COPIED BY THIS SCRIPT, never edited, and `--check` (run by the test suite, `npm run
// vendor:check`) fails the moment the copy and the source disagree. This is the same approach as
// `webdesk/blocks/scripts/vendor-vocabulary.mjs`.
//
// THE ONE MECHANICAL REWRITE. The vocabulary writes its relative imports with an explicit `.ts` suffix
// (`from './primitives.ts'`, the way WebDesk's ESM/Node type-stripping toolchain wants it). platform-nest
// compiles to CommonJS with `tsc` and does not allow that suffix, so the script rewrites exactly the relative
// import/export specifiers `'./x.ts'` -> `'./x'` and changes NOTHING else. The rewrite is part of the
// generator, so `--check` applies the same function to the source and compares: a drift check on the
// transformed bytes, not a loose "similar enough".
//
// Usage (from platform-nest/):
//   node scripts/vendor-webdesk-vocabulary.mjs          (re)writes src/modules/webdev/vocabulary/*.ts
//   node scripts/vendor-webdesk-vocabulary.mjs --check  exits 1 if any vendored file differs from the source
// Env overrides (the drift test uses them against a temp copy): WEBDESK_VOCAB_SRC, WEBDESK_VOCAB_DEST.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const SOURCE_DIR = process.env.WEBDESK_VOCAB_SRC
  ? path.resolve(process.env.WEBDESK_VOCAB_SRC)
  : path.resolve(here, "..", "..", "webdesk", "delivery", "vocabulary");
const DEST_DIR = process.env.WEBDESK_VOCAB_DEST
  ? path.resolve(process.env.WEBDESK_VOCAB_DEST)
  : path.resolve(here, "..", "src", "modules", "webdev", "vocabulary");

// client-editable.ts and its transitive imports. NOT the whole vocabulary (no breaking-change.ts, envelope.ts, ...).
const FILES = ["version.ts", "primitives.ts", "blocks.ts", "composition.ts", "client-editable.ts"];

const CHECK = process.argv.includes("--check");

/** `from './x.ts'` -> `from './x'` (relative specifiers only; single or double quotes). The only rewrite. */
export function rewriteRelativeTsSuffix(source) {
  return source.replace(/(\bfrom\s+)(['"])(\.{1,2}\/[^'"\n]*?)\.ts\2/g, "$1$2$3$2");
}

function banner(file) {
  return (
    `// VENDORED from webdesk/delivery/vocabulary/${file} by platform-nest/scripts/vendor-webdesk-vocabulary.mjs (WSK-49c).\n` +
    `// DO NOT HAND-EDIT. Regenerate with \`npm run vendor:webdesk-vocabulary\`; \`npm run vendor:check\` (and the test\n` +
    `// suite) fails when this file and its source disagree. The only change from the source is that a relative\n` +
    `// import's \`.ts\` suffix is dropped (this package compiles to CommonJS with tsc).\n\n`
  );
}

/** Line endings are normalised to LF on both sides of the comparison, so a Windows checkout (autocrlf) agrees with CI. */
const lf = (text) => text.replace(/\r\n/g, "\n");

export function expectedContent(file, source) {
  return banner(file) + rewriteRelativeTsSuffix(lf(source));
}

let drift = false;
let missing = false;
for (const file of FILES) {
  const srcPath = path.join(SOURCE_DIR, file);
  const destPath = path.join(DEST_DIR, file);
  if (!fs.existsSync(srcPath)) {
    console.error(`MISSING  ${srcPath} does not exist (was webdesk/delivery/vocabulary restructured?)`);
    missing = true;
    continue;
  }
  const expected = expectedContent(file, fs.readFileSync(srcPath, "utf8"));
  if (CHECK) {
    const actual = fs.existsSync(destPath) ? lf(fs.readFileSync(destPath, "utf8")) : null;
    if (actual !== expected) {
      drift = true;
      console.error(`DRIFT    ${path.relative(process.cwd(), destPath)} no longer matches webdesk/delivery/vocabulary/${file}; run \`npm run vendor:webdesk-vocabulary\``);
    } else {
      console.log(`OK       ${file}`);
    }
  } else {
    fs.mkdirSync(DEST_DIR, { recursive: true });
    fs.writeFileSync(destPath, expected);
    console.log(`wrote    ${path.relative(process.cwd(), destPath)}`);
  }
}

if (missing) {
  console.error("\nvendor-webdesk-vocabulary: aborting, a source file is missing.");
  process.exit(1);
}
if (CHECK && drift) {
  console.error("\nvendor-webdesk-vocabulary --check: FAILED, the vendored copies are stale.");
  process.exit(1);
}
if (CHECK) console.log("\nvendor-webdesk-vocabulary --check: OK, every vendored file matches the source vocabulary.");
