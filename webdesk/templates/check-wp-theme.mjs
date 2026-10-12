#!/usr/bin/env node
// Drift check: the wp template's theme must equal the canonical theme byte for byte, except
// vendor/gaiada-sdk/sdk.php (the scaffolder replaces that per tenant). Exit 1 on any drift.
//   node webdesk/templates/check-wp-theme.mjs
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const CANON = path.resolve(here, "..", "wordpress", "theme", "gaiada-webdesk");
const COPY = path.resolve(here, "wp", "wp-content", "themes", "gaiada-webdesk");
const SDK = "vendor/gaiada-sdk/sdk.php";

function walk(dir, rel = "") {
  if (!fs.existsSync(path.join(dir, rel))) return [];
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(dir, r));
    else out.push(r);
  }
  return out;
}

const a = new Set(walk(CANON));
const b = new Set(walk(COPY));
const problems = [];
for (const f of a) if (!b.has(f)) problems.push(`missing in template: ${f}`);
for (const f of b) if (!a.has(f)) problems.push(`extra in template: ${f}`);
for (const f of a) {
  if (f === SDK || !b.has(f)) continue;
  if (!fs.readFileSync(path.join(CANON, f)).equals(fs.readFileSync(path.join(COPY, f)))) {
    problems.push(`differs: ${f}`);
  }
}

if (problems.length) {
  console.error("wp template theme has drifted from webdesk/wordpress/theme/gaiada-webdesk/:");
  for (const p of problems) console.error("  " + p);
  console.error("Fix: copy the canonical theme over the template copy (SDK file exempt).");
  process.exit(1);
}
console.log(`wp template theme matches canonical (${a.size} files; ${SDK} exempt)`);
