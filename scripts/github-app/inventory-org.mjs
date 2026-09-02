#!/usr/bin/env node
/**
 * Read-only inventory of everything the gaiada-erp installation can see.
 *
 * Doubles as the GH-06 crawl in miniature and as the GH-11 migration seed. Also surfaces
 * traces of OTHER automation on the org — webhooks, Actions secrets, deploy keys — which is
 * how you find a second writer that no App list told you about.
 *
 * Writes nothing. Prints no secret values (secret NAMES only; GitHub never returns values).
 *
 * Usage:
 *   node scripts/github-app/inventory-org.mjs --app-id 4777424 \
 *     --installation-id 157879245 \
 *     --pem "$HOME/.gaiada-secrets/github-apps/gaiada-erp.private-key.pem"
 *   [--deep]   also probe per-repo webhooks / secrets / deploy keys (costs ~3 calls per repo)
 */

import crypto from "node:crypto";
import fs from "node:fs";

const args = new Map();
const flags = new Set();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--deep") { flags.add("deep"); continue; }
  if (a.startsWith("--")) { args.set(a.slice(2), process.argv[++i]); }
}
const appId = args.get("app-id");
const instId = args.get("installation-id");
const pemPath = args.get("pem");
if (!appId || !instId || !pemPath) {
  console.error("usage: --app-id <id> --installation-id <id> --pem <path> [--deep]");
  process.exit(2);
}

const b64url = (b) =>
  Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function mintJwt(id, pem) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const p = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: id }));
  const s = crypto.createSign("RSA-SHA256");
  s.update(`${h}.${p}`);
  return `${h}.${p}.${b64url(s.sign(pem))}`;
}

let RATE = {};
async function api(path, token, method = "GET") {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "gaiada-org-inventory",
    },
  });
  RATE = {
    limit: res.headers.get("x-ratelimit-limit"),
    remaining: res.headers.get("x-ratelimit-remaining"),
  };
  const text = await res.text();
  if (res.status === 403 || res.status === 404) return { __err: res.status };
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

const pem = fs.readFileSync(pemPath, "utf8");
const jwt = mintJwt(appId, pem);

const tok = await api(`/app/installations/${instId}/access_tokens`, jwt, "POST");
const token = tok.token;
console.log(`installation token minted, expires ${tok.expires_at}`);
console.log(`token permissions: ${Object.keys(tok.permissions ?? {}).length} scopes\n`);

// ── repos ──────────────────────────────────────────────────────────────────────────────────
let repos = [];
for (let page = 1; ; page++) {
  const r = await api(`/installation/repositories?per_page=100&page=${page}`, token);
  repos = repos.concat(r.repositories ?? []);
  if (!r.repositories?.length || repos.length >= (r.total_count ?? 0)) break;
}

console.log(`REPOSITORIES VISIBLE TO THE INSTALLATION: ${repos.length}\n`);
if (!repos.length) {
  console.log("  (none — the org has no repositories yet, or the installation excludes them)");
}
for (const r of repos) {
  const age = r.pushed_at ? r.pushed_at.slice(0, 10) : "never";
  console.log(
    `  ${r.private ? "priv" : "PUB "} ${r.full_name.padEnd(42)} ` +
    `branch=${(r.default_branch ?? "-").padEnd(10)} pushed=${age}` +
    `${r.archived ? " [ARCHIVED]" : ""}${r.fork ? " [fork]" : ""}`
  );
}

// ── traces of other automation ─────────────────────────────────────────────────────────────
if (flags.has("deep") && repos.length) {
  console.log(`\nPER-REPO AUTOMATION TRACES (webhooks / Actions secrets / deploy keys)`);
  console.log(`A secret or deploy key here that gaiada-erp did not create is another writer.\n`);
  for (const r of repos) {
    const [hooks, secrets, keys] = await Promise.all([
      api(`/repos/${r.full_name}/hooks`, token),
      api(`/repos/${r.full_name}/actions/secrets`, token),
      api(`/repos/${r.full_name}/keys`, token),
    ]);
    const bits = [];
    if (Array.isArray(hooks) && hooks.length) {
      bits.push(`hooks: ${hooks.map((h) => h.config?.url ?? h.name).join(", ")}`);
    }
    if (secrets?.secrets?.length) {
      bits.push(`secrets: ${secrets.secrets.map((s) => s.name).join(", ")}`);
    }
    if (Array.isArray(keys) && keys.length) {
      bits.push(`deploy keys: ${keys.map((k) => `${k.title}${k.read_only ? "(ro)" : "(RW)"}`).join(", ")}`);
    }
    if (bits.length) console.log(`  ${r.full_name}\n     ${bits.join("\n     ")}`);
    else console.log(`  ${r.full_name}  — clean`);
  }
}

console.log(`\nrate limit: ${RATE.remaining}/${RATE.limit} remaining`);
console.log("Nothing was written.");
