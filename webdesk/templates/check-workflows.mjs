#!/usr/bin/env node
// Structural guard for the three templates' .github/workflows/site.yml (M6-P6f). actionlint proves the files are valid
// workflows; this proves they keep the SHAPE the credential model depends on. No YAML parser (webdesk/ has no such dependency):
// jobs are cut at their two-space-indent keys, which is how every template is written.
//   node webdesk/templates/check-workflows.mjs        exit 1 on any violation
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const TEMPLATES = { "static-astro": "static", "fullstack-next-nest": "fullstack", wp: "wp" };
const problems = [];
const bad = (t, msg) => problems.push(`${t}: ${msg}`);

for (const [dir, kind] of Object.entries(TEMPLATES)) {
  const file = path.join(here, dir, ".github", "workflows", "site.yml");
  const text = fs.readFileSync(file, "utf8");
  if (text.includes("\r")) bad(dir, "has CR characters (LF only)");

  // every action is pinned to a full commit sha
  for (const m of text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
    if (!/@[0-9a-f]{40}$/.test(m[1])) bad(dir, `action not pinned by sha: ${m[1]}`);
  }
  if (/pull_request_target/.test(text.replace(/^\s*#.*$/gm, ""))) bad(dir, "uses pull_request_target");
  if (!/^permissions:\n  contents: read\n/m.test(text)) bad(dir, "top-level permissions must be exactly `contents: read`");
  if (!/^  workflow_dispatch:/m.test(text)) bad(dir, "no workflow_dispatch trigger");
  for (const input of ["approval_id", "kind", "published_at", "environment"]) {
    if (!new RegExp(`^      ${input}:`, "m").test(text)) bad(dir, `workflow_dispatch has no input ${input}`);
  }
  if (!/approval_id:\n(?:        .*\n)*?        required: true/.test(text)) bad(dir, "approval_id must be a required input");

  // cut the jobs
  const jobsAt = text.indexOf("\njobs:\n");
  if (jobsAt < 0) { bad(dir, "no jobs"); continue; }
  const jobs = {};
  let cur = null;
  for (const line of text.slice(jobsAt + 6).split("\n")) {
    const k = /^  ([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (k) { cur = k[1]; jobs[cur] = ""; }
    else if (cur) jobs[cur] += line + "\n";
  }
  const names = Object.keys(jobs);
  const expected = kind === "fullstack" ? ["build", "deploy-web", "deploy-api"] : ["build", "deploy"];
  if (names.join() !== expected.join()) bad(dir, `jobs are ${names.join(",")}, expected ${expected.join(",")}`);

  // the build job never sees the per-site secret or any deploy credential
  const build = jobs.build ?? "";
  if (/toJSON\(secrets\)/.test(build)) bad(dir, "build job reads toJSON(secrets)");
  for (const m of build.matchAll(/secrets\.([A-Za-z0-9_]+)/g)) {
    if (!["WEBDESK_HOST", "WEBDESK_API_KEY", "WEBDESK_TENANT_SLUG"].includes(m[1])) bad(dir, `build job reads secrets.${m[1]} (only the content read key is allowed)`);
  }
  if (/WEBDESK_DEPLOY_/.test(build.replace(/^\s*#.*$/gm, ""))) bad(dir, "build job mentions a WEBDESK_DEPLOY_ secret");
  if (!/upload-artifact@/.test(build)) bad(dir, "build job does not upload the artifact");
  if (!/include-hidden-files:\s*true/.test(build)) bad(dir, "upload must include hidden files (.htaccess)");

  for (const name of names.filter((n) => n.startsWith("deploy"))) {
    const body = jobs[name];
    if (!/needs: build/.test(body)) bad(dir, `${name}: must need build`);
    if (!/needs\.build\.outputs\.deploy == 'true'/.test(body)) bad(dir, `${name}: not gated on the plan's deploy output`);
    if (name === "deploy-api") {
      if (/secrets\.|toJSON|artifact@|lftp|deploy\.sh|deploy-from-secret/.test(body.replace(/^\s*#.*$/gm, ""))) bad(dir, "deploy-api must not touch a secret or upload anything");
      if (!/the fullstack API deploy to a Node host is M6-P6l, not built yet/.test(body)) bad(dir, "deploy-api lacks its named reason");
      continue;
    }
    if (!/concurrency:\n\s+group: webdesk-deploy-\$\{\{ github\.repository \}\}-\$\{\{ needs\.build\.outputs\.environment \}\}\n\s+cancel-in-progress: false/.test(body)) {
      bad(dir, `${name}: needs a concurrency group per site and environment with cancel-in-progress: false`);
    }
    if (/\b(npm|npx|yarn|pnpm|pip3?|composer|gem|go install|cargo)\b/.test(body.replace(/^\s*#.*$/gm, ""))) bad(dir, `${name}: runs a package manager`);
    if (!/secret-name\.sh/.test(body)) bad(dir, `${name}: does not derive the per-site secret's name with secret-name.sh`);
    if (!/github\.repository_id/.test(body)) bad(dir, `${name}: does not use github.repository_id`);
    if (!/does not exist yet or is not granted to this repo; see the console's pending list/.test(body)) bad(dir, `${name}: lacks the named absent-secret failure`);
    if (!/WEBDESK_DEPLOY_GRANT/.test(body)) bad(dir, `${name}: lacks the gate flag check`);
    // the apt-get for lftp comes BEFORE the step that reads the secrets
    const apt = body.indexOf("apt-get install");
    const sec = body.indexOf("toJSON(secrets)");
    if (apt < 0 || sec < 0 || apt > sec) bad(dir, `${name}: lftp must be installed before the secrets are read`);
    if (!/echo/.test(body) || /echo[^\n]*\$secret|echo[^\n]*\$\{secret|echo[^\n]*ALL_SECRETS/.test(body)) bad(dir, `${name}: echoes a secret`);
  }
}

if (problems.length) {
  console.error("workflow shape violations:");
  for (const p of problems) console.error("  " + p);
  process.exit(1);
}
console.log(`workflows keep the credential shape (${Object.keys(TEMPLATES).length} templates)`);
