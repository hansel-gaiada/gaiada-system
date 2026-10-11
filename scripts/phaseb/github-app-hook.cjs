// ERP names Phase B3: point the `gaiada-erp` GitHub App's webhook at HOOK_URL, through GitHub's API (no console
// step). Run INSIDE the platform container, which holds the sealed App credential:
//
//   docker exec -i -e HOOK_URL=https://erp.gaiada.com/api/webhooks/github gaiada-platform-1 node - < github-app-hook.cjs
//
// Reads the credential the way the service does (credential-store.ts), mints a short App JWT (jwt.ts), reads
// `GET /app/hook/config`, PATCHes only `url` when it differs (content_type, secret and insecure_ssl are left
// alone), and reads it back. It never prints the key, the JWT or the webhook secret. The old URL keeps working
// (the vhost keeps /api/webhooks/ on erp.gaiada.online), so a failure here breaks nothing.
const { loadAppCredential } = require("/app/dist/core/github/credential-store.js");
const { mintAppJwt } = require("/app/dist/core/github/jwt.js");

const want = process.env.HOOK_URL;
const API = "https://api.github.com/app/hook/config";

(async () => {
  if (!want || !/^https:\/\/[a-z0-9.-]+\/api\/webhooks\/github$/.test(want)) throw new Error(`HOOK_URL looks wrong: ${want}`);
  const tenant = process.env.GITHUB_REPO_SYNC_TENANT_ID;
  if (!tenant) throw new Error("GITHUB_REPO_SYNC_TENANT_ID is unset in the platform container");
  const cred = await loadAppCredential(tenant, "erp");
  if (!cred) throw new Error("no sealed gaiada-erp App credential for the org tenant");
  const headers = {
    authorization: `Bearer ${mintAppJwt({ appId: cred.appId, privateKeyPem: cred.privateKeyPem, ttlSeconds: 300 })}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "gaiada-erp-phaseb-cutover",
  };
  const read = async () => {
    const r = await fetch(API, { headers });
    if (!r.ok) throw new Error(`GET /app/hook/config -> ${r.status}`);
    return r.json();
  };
  const before = await read();
  console.log(`  app ${cred.appId}: webhook url was ${before.url} (content_type ${before.content_type})`);
  if (before.url !== want) {
    const r = await fetch(API, { method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ url: want }) });
    if (!r.ok) throw new Error(`PATCH /app/hook/config -> ${r.status}`);
  }
  const after = await read();
  if (after.url !== want) throw new Error(`webhook url reads back as ${after.url}, expected ${want}`);
  console.log(`  ok   webhook url is ${after.url}`);
  process.exit(0);
})().catch((e) => { console.error(`  FAIL ${e.message}`); process.exit(1); });
