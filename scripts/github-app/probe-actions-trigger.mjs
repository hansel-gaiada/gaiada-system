#!/usr/bin/env node
/**
 * Q1 PROBE — does a push made with a GitHub App INSTALLATION TOKEN trigger Actions?
 *
 * Why this is not obvious: the default `GITHUB_TOKEN` inside a workflow deliberately does NOT
 * trigger further workflow runs (GitHub's recursion guard). An App installation token is a
 * different credential and is expected to behave differently — but the estate's whole deploy
 * pipeline is `git push --tags` -> Actions, so "expected" is not good enough.
 *
 * Tests BOTH shapes the pipeline uses:
 *   1. a branch push  (on: push: branches)
 *   2. a TAG push     (on: push: tags)  <- the one deploys actually rely on
 *
 * Creates a throwaway private repo, proves it, and DELETES the repo in a finally block.
 *
 * Usage:
 *   node scripts/github-app/probe-actions-trigger.mjs --org gaiadabali \
 *     --app-id 4777424 --installation-id 157879245 --pem <path> [--keep]
 */

import crypto from "node:crypto";
import fs from "node:fs";

const a = new Map();
const keep = process.argv.includes("--keep");
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith("--") && process.argv[i] !== "--keep") {
    a.set(process.argv[i].slice(2), process.argv[i + 1]);
  }
}
const org = a.get("org");
const appId = a.get("app-id");
const instId = a.get("installation-id");
const pemPath = a.get("pem");
if (!org || !appId || !instId || !pemPath) {
  console.error("usage: --org <org> --app-id <id> --installation-id <id> --pem <path> [--keep]");
  process.exit(2);
}

const REPO = "erp-apptoken-probe";
const FULL = `${org}/${REPO}`;

const b64url = (b) =>
  Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function jwtFor(id, pem) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const p = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: id }));
  const s = crypto.createSign("RSA-SHA256");
  s.update(`${h}.${p}`);
  return `${h}.${p}.${b64url(s.sign(pem))}`;
}

async function api(path, token, method = "GET", body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "gaiada-q1-probe",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WORKFLOW = `name: probe
on:
  push:
    branches: [main]
    tags: ['v*']
jobs:
  say:
    runs-on: ubuntu-latest
    steps:
      - run: echo "triggered by \${{ github.event_name }} ref=\${{ github.ref }}"
`;

/** Poll for workflow runs matching a ref, up to timeoutMs. */
async function waitForRun(token, predicate, label, timeoutMs = 90000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const runs = await api(`/repos/${FULL}/actions/runs?per_page=20`, token);
    const hit = (runs.workflow_runs ?? []).find(predicate);
    if (hit) {
      console.log(`  ${label}: RUN CREATED after ${Math.round((Date.now() - started) / 1000)}s`);
      console.log(`     run_id=${hit.id} event=${hit.event} ref=${hit.head_branch ?? hit.head_sha?.slice(0, 7)} status=${hit.status}`);
      console.log(`     actor=${hit.actor?.login}  triggering_actor=${hit.triggering_actor?.login}`);
      return hit;
    }
    await sleep(5000);
  }
  console.log(`  ${label}: NO RUN after ${timeoutMs / 1000}s  <-- workflows were NOT triggered`);
  return null;
}

const jwt = jwtFor(appId, fs.readFileSync(pemPath, "utf8"));
const { token } = await api(`/app/installations/${instId}/access_tokens`, jwt, "POST");
console.log("installation token minted\n");

let created = false;
try {
  console.log(`creating throwaway repo ${FULL} (private)...`);
  await api(`/orgs/${org}/repos`, token, "POST", {
    name: REPO,
    private: true,
    auto_init: true,
    description: "TEMPORARY — Q1 probe: does an App installation token trigger Actions? Safe to delete.",
  });
  created = true;
  await sleep(3000);

  console.log("committing workflow via Contents API (this is the branch push)...");
  const put = await api(
    `/repos/${FULL}/contents/${encodeURIComponent(".github/workflows/probe.yml")}`,
    token, "PUT",
    { message: "add probe workflow", content: Buffer.from(WORKFLOW).toString("base64") }
  );
  const sha = put.commit.sha;
  console.log(`  commit ${sha.slice(0, 7)}  author=${put.commit.author?.name}  committer=${put.commit.committer?.name}\n`);

  console.log("TEST 1 — branch push:");
  const branchRun = await waitForRun(token, (r) => r.event === "push" && r.head_branch === "main", "branch push");

  console.log("\ncreating tag v0.0.1 (this is the tag push the deploy pipeline uses)...");
  await api(`/repos/${FULL}/git/refs`, token, "POST", { ref: "refs/tags/v0.0.1", sha });

  console.log("TEST 2 — tag push:");
  const tagRun = await waitForRun(token, (r) => r.head_branch === "v0.0.1" || r.event === "push" && r.head_branch === "v0.0.1", "tag push");

  console.log("\n================ Q1 VERDICT ================");
  console.log(`  branch push triggers Actions : ${branchRun ? "YES" : "NO"}`);
  console.log(`  TAG push triggers Actions    : ${tagRun ? "YES" : "NO"}   <- what deploys depend on`);
  if (branchRun) {
    console.log(`\n  runs are attributed to: ${branchRun.actor?.login} (the app's bot identity)`);
  }
  console.log("============================================");
} finally {
  if (created && !keep) {
    process.stdout.write("\ncleaning up: deleting throwaway repo... ");
    try {
      await api(`/repos/${FULL}`, token, "DELETE");
      console.log("deleted.");
    } catch (e) {
      console.log(`FAILED — delete ${FULL} by hand.\n  ${e.message}`);
    }
  } else if (keep) {
    console.log(`\n--keep set: ${FULL} left in place. Delete it when done.`);
  }
}
