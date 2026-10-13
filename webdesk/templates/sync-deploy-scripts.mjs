#!/usr/bin/env node
// The deploy job's scripts live ONCE, in webdesk/templates/_deploy/ (tested there, on sumopod, against real daemons). A site repo
// is a published copy of ONE template directory and has no `_deploy/`, so each template carries a copy at `.webdesk/deploy/`,
// which its `.github/workflows/site.yml` calls. This script makes the copies and checks them, so they cannot drift (the same
// idea as check-wp-theme.mjs).
//   node webdesk/templates/sync-deploy-scripts.mjs            copy _deploy/ -> <template>/.webdesk/deploy/ for all three templates
//   node webdesk/templates/sync-deploy-scripts.mjs --check    exit 1 on any difference (runs as part of `npm test` in webdesk/)
// Exec bits are not carried by a copy on Windows: the workflows call every script as `bash <path>`, so they are not needed, but
// keep them 100755 in git (`git update-index --chmod=+x`).
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const SRC = path.join(here, "_deploy");
const TEMPLATES = ["static-astro", "fullstack-next-nest", "wp"];
/** What a site repo needs at run time, plus the derivation test and its fixture. Not the README, the harness or the offline tests. */
export const SHARED = [
  "deploy.sh",
  "make-manifest.sh",
  "plan.sh",
  "write-stamp.sh",
  "secret-name.sh",
  "deploy-from-secret.sh",
  "secret-name.fixture.json",
  "test-secret-name.sh",
];
const POINTER = `# .webdesk/deploy

The scripts this repo's deploy job (\`.github/workflows/site.yml\`) runs. They are COPIES: the source is
\`webdesk/templates/_deploy/\` in the Gaiada monorepo (documentation, the per-site secret's shape and the tests are there).
Do not edit them here; a change made here is overwritten by the next publish.

\`bash .webdesk/deploy/test-secret-name.sh\` proves the secret-name derivation against the fixture the ERP is tested with.
`;

const check = process.argv.includes("--check");
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p) : null);
const problems = [];
let n = 0;
for (const t of TEMPLATES) {
  const dest = path.join(here, t, ".webdesk", "deploy");
  const want = new Map(SHARED.map((f) => [f, fs.readFileSync(path.join(SRC, f))]));
  want.set("README.md", Buffer.from(POINTER));
  for (const [f, bytes] of want) {
    const target = path.join(dest, f);
    const have = read(target);
    if (have && have.equals(bytes)) continue;
    if (check) {
      problems.push(`${t}/.webdesk/deploy/${f}: ${have ? "differs from _deploy/" : "missing"}`);
    } else {
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(target, bytes);
      n++;
    }
  }
  if (fs.existsSync(dest)) {
    for (const f of fs.readdirSync(dest)) if (!want.has(f)) problems.push(`${t}/.webdesk/deploy/${f}: not a shared script (remove it)`);
  }
}
if (problems.length) {
  console.error("the templates' deploy script copies have drifted from webdesk/templates/_deploy/:");
  for (const p of problems) console.error("  " + p);
  console.error("Fix: node webdesk/templates/sync-deploy-scripts.mjs");
  process.exit(1);
}
console.log(check ? `deploy script copies match _deploy/ (${TEMPLATES.length} templates, ${SHARED.length + 1} files each)` : `synced ${n} file(s)`);
