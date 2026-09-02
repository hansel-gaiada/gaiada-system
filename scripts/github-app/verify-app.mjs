#!/usr/bin/env node
/**
 * Verify a GitHub App credential end to end, without writing anything.
 *
 * Mints an App JWT (RS256, 9-minute life) from the private key, then reads back what GitHub
 * ACTUALLY recorded — permissions, events, and installations. The point is to check the app
 * against the design rather than against the creation form, which is where typos survive.
 *
 * Prints no secret material: never the PEM, never the JWT, never an installation token.
 *
 * Usage:
 *   node scripts/github-app/verify-app.mjs --app-id 4777424 \
 *     --pem "$HOME/.gaiada-secrets/github-apps/gaiada-erp.private-key.pem"
 */

import crypto from "node:crypto";
import fs from "node:fs";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}
const appId = args.get("app-id");
const pemPath = args.get("pem");
if (!appId || !pemPath) {
  console.error("usage: --app-id <id> --pem <path to private-key.pem>");
  process.exit(2);
}

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function mintJwt(id, pem) {
  const now = Math.floor(Date.now() / 1000);
  // iat backdated 60s: GitHub rejects a token whose iat is even slightly in its future.
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: id }));
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${b64url(signer.sign(pem))}`;
}

async function gh(path, jwt) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "gaiada-app-verify",
    },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

// The permission sets docs/blueprints/github-integration-foundation.md §2.2 specifies, keyed by slug.
const PROFILES = {
  "gaiada-erp": {
    perms: {
      administration: "write", actions: "write", checks: "read", statuses: "read",
      contents: "write", deployments: "write", environments: "write", issues: "write",
      metadata: "read", pull_requests: "write", secrets: "write",
      repository_hooks: "write", workflows: "write", members: "read",
    },
    events: ["push", "pull_request", "workflow_run", "check_suite", "repository", "release", "deployment_status"],
    // gaiada-erp is the write arm; no read-only assertion applies.
    readOnly: false,
  },
  // Pre-existing app, not created by this design. Audited 2026-08-31 and left in place: it is the
  // read credential delphi/helios authenticate with to FETCH deploy artifact branches (§2.2).
  // Read-only is why it does not threaten the §4.6 ledger-completeness argument.
  "gaiadabali-deploy": {
    perms: { contents: "read", metadata: "read" },
    events: [],
    readOnly: true,
  },
  "gaiada-agents": {
    perms: {
      actions: "read", contents: "read", metadata: "read",
      pull_requests: "read", statuses: "read",
    },
    events: [],
    // The whole reason this app is separate: a prompt-injected agent must not be able to write.
    // Asserted structurally below, not just compared field by field.
    readOnly: true,
  },
};

const pem = fs.readFileSync(pemPath, "utf8");
if (!pem.includes("PRIVATE KEY")) {
  console.error(`${pemPath} does not look like a PEM private key`);
  process.exit(1);
}

const jwt = mintJwt(appId, pem);

const app = await gh("/app", jwt);
console.log(`\nCREDENTIAL OK — the private key signs for app_id ${appId}`);
console.log(`  name    ${app.name}  (slug: ${app.slug})`);
console.log(`  owner   ${app.owner?.login}`);
console.log(`  created ${app.created_at}`);

const profile = PROFILES[app.slug];
if (!profile) {
  console.log(`\nNo blueprint profile for slug "${app.slug}" — reporting only, no comparison.`);
}
const EXPECTED = profile?.perms ?? {};
const EXPECTED_EVENTS = profile?.events ?? [];

const got = app.permissions ?? {};
console.log(`\nPERMISSIONS as GitHub recorded them (${Object.keys(got).length}):`);
const problems = [];
for (const [k, v] of Object.entries(EXPECTED)) {
  const actual = got[k];
  const ok = actual === v;
  console.log(`  ${ok ? "ok  " : "MISS"} ${k.padEnd(16)} want=${v.padEnd(5)} got=${actual ?? "(none)"}`);
  if (!ok) problems.push(`${k}: want ${v}, got ${actual ?? "none"}`);
}
const extra = Object.keys(got).filter((k) => !(k in EXPECTED));
if (extra.length) {
  console.log(`  note: also granted -> ${extra.map((k) => `${k}=${got[k]}`).join(", ")}`);
  if (profile) problems.push(`unexpected permissions granted: ${extra.join(", ")}`);
}

// The structural assertion: for a read-only app, NO permission may be write/admin, whatever
// the expected list says. Comparing field-by-field would miss a write scope nobody listed.
if (profile?.readOnly) {
  const writable = Object.entries(got).filter(([, v]) => v !== "read");
  console.log(
    `\nREAD-ONLY ASSERTION: ${writable.length === 0
      ? "PASS — every granted scope is read"
      : `FAIL — writable scopes present: ${writable.map(([k, v]) => `${k}=${v}`).join(", ")}`}`
  );
  if (writable.length) problems.push(`app must be read-only but has: ${writable.map(([k, v]) => `${k}=${v}`).join(", ")}`);
}

const events = app.events ?? [];
const missingEvents = EXPECTED_EVENTS.filter((e) => !events.includes(e));
console.log(`\nEVENTS subscribed (${events.length}): ${events.join(", ") || "(none)"}`);
if (missingEvents.length) problems.push(`events missing: ${missingEvents.join(", ")}`);
if (profile && !EXPECTED_EVENTS.length && events.length) {
  problems.push(`expected no event subscriptions, found: ${events.join(", ")}`);
}

const installs = await gh("/app/installations", jwt);
console.log(`\nINSTALLATIONS (${installs.length}):`);
if (!installs.length) {
  problems.push("app is not installed anywhere — creation is not installation");
}
for (const i of installs) {
  console.log(`  installation_id ${i.id}`);
  console.log(`    account      ${i.account?.login} (${i.target_type})`);
  console.log(`    repo access  ${i.repository_selection}`);
  console.log(`    created      ${i.created_at}`);
}

console.log("");
if (problems.length) {
  console.log("MISMATCHES vs the blueprint:");
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log("Matches the blueprint. Nothing was written.");
