#!/usr/bin/env node
/**
 * Read-only peek into one repo's tree and (optionally) a file's contents, via the
 * gaiada-erp installation. Writes nothing.
 *
 * Usage:
 *   node scripts/github-app/peek-repo.mjs --repo gaiadabali/deploy-workflows \
 *     --app-id 4777424 --installation-id 157879245 --pem <path> [--path .github/workflows/x.yml]
 */

import crypto from "node:crypto";
import fs from "node:fs";

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args.set(a.slice(2), process.argv[++i]);
}
const { "app-id": appId, "installation-id": instId, pem: pemPath, repo } = Object.fromEntries(args);
if (!appId || !instId || !pemPath || !repo) {
  console.error("usage: --repo owner/name --app-id <id> --installation-id <id> --pem <path> [--path <file>]");
  process.exit(2);
}

const b64url = (b) =>
  Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const now = Math.floor(Date.now() / 1000);
const h = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
const p = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
const sig = crypto.createSign("RSA-SHA256");
sig.update(`${h}.${p}`);
const jwt = `${h}.${p}.${b64url(sig.sign(fs.readFileSync(pemPath, "utf8")))}`;

async function api(path, token, method = "GET") {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "gaiada-peek",
    },
  });
  const t = await res.text();
  if (!res.ok) return { __err: `${res.status} ${t.slice(0, 160)}` };
  return t ? JSON.parse(t) : null;
}

const { token } = await api(`/app/installations/${instId}/access_tokens`, jwt, "POST");

const file = args.get("path");
if (file) {
  const c = await api(`/repos/${repo}/contents/${encodeURIComponent(file)}`, token);
  if (c.__err) { console.error(c.__err); process.exit(1); }
  console.log(Buffer.from(c.content, "base64").toString("utf8"));
  process.exit(0);
}

const info = await api(`/repos/${repo}`, token);
if (info.__err) { console.error(info.__err); process.exit(1); }
console.log(`${info.full_name}  private=${info.private}  branch=${info.default_branch}`);
console.log(`  ${info.description ?? "(no description)"}\n`);

const tree = await api(`/repos/${repo}/git/trees/${info.default_branch}?recursive=1`, token);
if (tree.__err) { console.error(tree.__err); process.exit(1); }
console.log(`TREE (${tree.tree.length} entries${tree.truncated ? ", TRUNCATED" : ""}):`);
for (const e of tree.tree.filter((e) => e.type === "blob")) {
  console.log(`  ${String(e.size).padStart(7)}  ${e.path}`);
}
