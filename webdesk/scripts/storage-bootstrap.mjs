#!/usr/bin/env node
// WSK-52 (WSK-D42) — idempotent object-storage bootstrap for WebDesk Zone B (RustFS).
//
// Replaces everything WSK-07/WSK-28 did with `mc` (RustFS ships no `mc`) and closes WSK-07's
// carried gap (the api running as the storage ROOT user). Uses ONLY the S3 API
// (@aws-sdk/client-s3) plus RustFS's admin API (/rustfs/admin/v3/, plain SigV4, service "s3"),
// signed with @smithy/signature-v4. Both libraries are resolved from webdesk/api/node_modules, so
// run `npm ci` in webdesk/api first.
//
// What it makes (and re-checks on every run — a second run changes nothing and says so):
//   1. Buckets  media / video / uploads / artifacts (names from STORAGE_BUCKET_*), created WITH
//      object lock enabled, versioning Enabled, default retention GOVERNANCE for N days (default 1 —
//      exactly what WSK-07's adapter configured). Plus `backups` (WSK-28) with GOVERNANCE 30 days.
//   2. Optional anonymous prefix-scoped public read (WEBDESK_STORAGE_PUBLIC_READ="bucket:prefix,...").
//      WSK-07 configured NONE (media is served through the api / presigned URLs), so the default is
//      none; any bucket not listed has its bucket policy removed if one exists.
//   3. The api service user: policy `webdesk-api` (object get/put/delete + list on the four buckets
//      ONLY — no PutBucketPolicy, no bucket create/delete, no versioning/lock/retention changes, no
//      DeleteObjectVersion, no BypassGovernanceRetention) bound to STORAGE_ACCESS_KEY_ID.
//   4. Optional backup writer user (policy `webdesk-backup`, put/get/list on `backups` only) when
//      WEBDESK_BACKUP_ACCESS_KEY_ID / WEBDESK_BACKUP_SECRET_ACCESS_KEY are set.
//
// Root credentials are used ONLY here. Required env:
//   STORAGE_ENDPOINT, RUSTFS_ROOT_USER, RUSTFS_ROOT_PASSWORD,
//   STORAGE_ACCESS_KEY_ID, STORAGE_SECRET_ACCESS_KEY
// Optional env: STORAGE_REGION (us-east-1), STORAGE_BUCKET_{MEDIA,VIDEO,UPLOADS,ARTIFACTS},
//   WEBDESK_BACKUP_BUCKET (backups), WEBDESK_STORAGE_LOCK_DAYS (1), WEBDESK_BACKUP_RETENTION_DAYS (30),
//   WEBDESK_STORAGE_PUBLIC_READ, WEBDESK_BACKUP_ACCESS_KEY_ID, WEBDESK_BACKUP_SECRET_ACCESS_KEY.
//
// Last stdout line is machine-readable: `STORAGE_BOOTSTRAP changes=<n>`.
import { createRequire } from "node:module";
import { createHash, createHmac } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const apiRequire = createRequire(new URL("../api/package.json", import.meta.url));
let S3, SignatureV4;
try {
  S3 = apiRequire("@aws-sdk/client-s3");
  ({ SignatureV4 } = apiRequire("@smithy/signature-v4"));
} catch (err) {
  console.error(`storage-bootstrap: cannot load the AWS SDK from webdesk/api/node_modules (run \`npm ci\` in webdesk/api): ${err.message}`);
  process.exit(2);
}

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`storage-bootstrap: ${name} is required`);
    process.exit(2);
  }
  return v;
}

const endpoint = need("STORAGE_ENDPOINT").replace(/\/+$/, "");
const rootUser = need("RUSTFS_ROOT_USER");
const rootPassword = need("RUSTFS_ROOT_PASSWORD");
const svcKey = need("STORAGE_ACCESS_KEY_ID");
const svcSecret = need("STORAGE_SECRET_ACCESS_KEY");
const region = process.env.STORAGE_REGION || "us-east-1";
if (svcKey === rootUser) {
  console.error("storage-bootstrap: STORAGE_ACCESS_KEY_ID must NOT equal RUSTFS_ROOT_USER (the api must never run as root)");
  process.exit(2);
}
if (svcSecret.length < 8) {
  console.error("storage-bootstrap: STORAGE_SECRET_ACCESS_KEY must be at least 8 characters");
  process.exit(2);
}

const lockDays = Number(process.env.WEBDESK_STORAGE_LOCK_DAYS ?? 1);
const backupDays = Number(process.env.WEBDESK_BACKUP_RETENTION_DAYS ?? 30);
const apiBuckets = [
  process.env.STORAGE_BUCKET_MEDIA || "media",
  process.env.STORAGE_BUCKET_VIDEO || "video",
  process.env.STORAGE_BUCKET_UPLOADS || "uploads",
  process.env.STORAGE_BUCKET_ARTIFACTS || "artifacts",
];
const backupBucket = process.env.WEBDESK_BACKUP_BUCKET || "backups";
const bkKey = process.env.WEBDESK_BACKUP_ACCESS_KEY_ID || "";
const bkSecret = process.env.WEBDESK_BACKUP_SECRET_ACCESS_KEY || "";
if ((bkKey && !bkSecret) || (!bkKey && bkSecret)) {
  console.error("storage-bootstrap: set BOTH WEBDESK_BACKUP_ACCESS_KEY_ID and WEBDESK_BACKUP_SECRET_ACCESS_KEY, or neither");
  process.exit(2);
}
if (bkKey && (bkKey === rootUser || bkKey === svcKey)) {
  console.error("storage-bootstrap: the backup key must differ from the root user and the api service key");
  process.exit(2);
}

// "bucket:prefix,bucket:prefix" -> Map(bucket -> prefix[])
const publicRead = new Map();
for (const part of (process.env.WEBDESK_STORAGE_PUBLIC_READ || "").split(",").map((p) => p.trim()).filter(Boolean)) {
  const [bucket, ...rest] = part.split(":");
  const prefix = rest.join(":").replace(/^\/+|\/+$/g, "");
  if (!bucket || !prefix) {
    console.error(`storage-bootstrap: WEBDESK_STORAGE_PUBLIC_READ entry '${part}' must be bucket:prefix (a whole-bucket public read is not allowed)`);
    process.exit(2);
  }
  publicRead.set(bucket, [...(publicRead.get(bucket) || []), prefix]);
}

for (const b of publicRead.keys()) {
  if (!apiBuckets.includes(b)) {
    console.error(`storage-bootstrap: public read is only allowed on the api buckets (${apiBuckets.join(", ")}), not '${b}'`);
    process.exit(2);
  }
}

let changes = 0;
const changed = (msg) => {
  changes += 1;
  console.log(`CHANGED  ${msg}`);
};
const same = (msg) => console.log(`ok       ${msg}`);

// --- S3 client (root). WHEN_REQUIRED for the same reason as the api's client. ----------------------
const s3 = new S3.S3Client({
  endpoint,
  region,
  forcePathStyle: true,
  credentials: { accessKeyId: rootUser, secretAccessKey: rootPassword },
  requestChecksumCalculation: "WHEN_REQUIRED",
});

// --- Admin API (SigV4, service "s3") --------------------------------------------------------------
class NodeSha256 {
  constructor(secret) {
    this.h = secret ? createHmac("sha256", secret) : createHash("sha256");
  }
  update(data) {
    this.h.update(typeof data === "string" ? Buffer.from(data) : Buffer.from(data.buffer ?? data, data.byteOffset, data.byteLength));
  }
  async digest() {
    return new Uint8Array(this.h.digest());
  }
  reset() {}
}
const signer = new SignatureV4({
  service: "s3",
  region,
  credentials: { accessKeyId: rootUser, secretAccessKey: rootPassword },
  sha256: NodeSha256,
  uriEscapePath: true,
});

async function admin(method, path, query = {}, jsonBody) {
  const url = new URL(endpoint);
  const body = jsonBody === undefined ? undefined : JSON.stringify(jsonBody);
  const req = ({
    method,
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port ? Number(url.port) : undefined,
    path: `/rustfs/admin/v3/${path}`,
    query,
    headers: { host: url.host, ...(body ? { "content-type": "application/json" } : {}) },
    body,
  });
  const signed = await signer.sign(req);
  const qs = new URLSearchParams(query).toString();
  const res = await fetch(`${endpoint}/rustfs/admin/v3/${path}${qs ? `?${qs}` : ""}`, {
    method,
    headers: signed.headers,
    body,
  });
  const text = await res.text();
  return { status: res.status, text, json: () => JSON.parse(text) };
}

const errName = (e) => e?.name || e?.Code || "";
const httpStatus = (e) => e?.$metadata?.httpStatusCode;

// --- 1. Buckets -----------------------------------------------------------------------------------
async function ensureBucket(bucket, days) {
  let exists = true;
  try {
    await s3.send(new S3.HeadBucketCommand({ Bucket: bucket }));
  } catch (e) {
    if (httpStatus(e) === 404 || errName(e) === "NotFound" || errName(e) === "NoSuchBucket") exists = false;
    else throw e;
  }
  if (!exists) {
    // Object lock can ONLY be enabled at creation (S3-API rule) — decide it up front.
    await s3.send(new S3.CreateBucketCommand({ Bucket: bucket, ObjectLockEnabledForBucket: true }));
    changed(`bucket ${bucket}: created with object lock enabled`);
  } else {
    same(`bucket ${bucket}: exists`);
  }

  const ver = await s3.send(new S3.GetBucketVersioningCommand({ Bucket: bucket }));
  if (ver.Status !== "Enabled") {
    await s3.send(new S3.PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: "Enabled" } }));
    changed(`bucket ${bucket}: versioning enabled`);
  } else {
    same(`bucket ${bucket}: versioning Enabled`);
  }

  let lock = null;
  try {
    lock = (await s3.send(new S3.GetObjectLockConfigurationCommand({ Bucket: bucket }))).ObjectLockConfiguration;
  } catch (e) {
    if (errName(e) !== "ObjectLockConfigurationNotFoundError" && httpStatus(e) !== 404) throw e;
  }
  const r = lock?.Rule?.DefaultRetention;
  if (lock?.ObjectLockEnabled !== "Enabled" || r?.Mode !== "GOVERNANCE" || Number(r?.Days) !== days) {
    try {
      await s3.send(
        new S3.PutObjectLockConfigurationCommand({
          Bucket: bucket,
          ObjectLockConfiguration: { ObjectLockEnabled: "Enabled", Rule: { DefaultRetention: { Mode: "GOVERNANCE", Days: days } } },
        }),
      );
    } catch (e) {
      console.error(
        `storage-bootstrap: bucket ${bucket} cannot be put under object lock (${errName(e)}: ${e.message}). ` +
          "It was probably created without object lock; lock can only be set at creation — recreate the (empty) bucket.",
      );
      process.exit(1);
    }
    changed(`bucket ${bucket}: default retention GOVERNANCE ${days}d`);
  } else {
    same(`bucket ${bucket}: default retention GOVERNANCE ${days}d`);
  }
}

// --- 2. Public-read policies ----------------------------------------------------------------------
function publicPolicy(bucket, prefixes) {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { AWS: ["*"] },
        Action: ["s3:GetObject"],
        Resource: prefixes.map((p) => `arn:aws:s3:::${bucket}/${p}/*`),
      },
    ],
  };
}

async function ensureBucketPolicy(bucket) {
  const prefixes = publicRead.get(bucket);
  let current = null;
  try {
    current = JSON.parse((await s3.send(new S3.GetBucketPolicyCommand({ Bucket: bucket }))).Policy);
  } catch (e) {
    if (errName(e) !== "NoSuchBucketPolicy" && httpStatus(e) !== 404) throw e;
  }
  if (!prefixes) {
    if (current) {
      await s3.send(new S3.DeleteBucketPolicyCommand({ Bucket: bucket }));
      changed(`bucket ${bucket}: removed bucket policy (no public read configured)`);
    } else {
      same(`bucket ${bucket}: no public read`);
    }
    return;
  }
  const want = publicPolicy(bucket, prefixes);
  if (!current || !policyEquivalent(current, want)) {
    await s3.send(new S3.PutBucketPolicyCommand({ Bucket: bucket, Policy: JSON.stringify(want) }));
    changed(`bucket ${bucket}: public read on ${prefixes.join(", ")}`);
  } else {
    same(`bucket ${bucket}: public read on ${prefixes.join(", ")}`);
  }
}

// RustFS may normalise a stored policy (string vs array, ids). Compare the parts that matter.
function norm(v) {
  return Array.isArray(v) ? [...v].sort() : v === undefined ? [] : [v];
}
function policyEquivalent(a, b) {
  const sa = norm(a.Statement), sb = norm(b.Statement);
  if (sa.length !== sb.length) return false;
  const flat = (s) => ({
    Effect: s.Effect,
    Principal: JSON.stringify(s.Principal?.AWS ?? s.Principal),
    Action: norm(s.Action),
    Resource: norm(s.Resource),
  });
  return isDeepStrictEqual(sa.map(flat), sb.map(flat));
}

// --- 3/4. Least-privilege users (RustFS admin API; it does not implement the AWS IAM API) ---------
function apiPolicy() {
  const bucketArns = apiBuckets.map((b) => `arn:aws:s3:::${b}`);
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: ["s3:ListBucket", "s3:GetBucketLocation", "s3:ListBucketMultipartUploads"],
        Resource: bucketArns,
      },
      {
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
        Resource: bucketArns.map((a) => `${a}/*`),
      },
    ],
  };
}
function backupPolicy() {
  const arn = `arn:aws:s3:::${backupBucket}`;
  return {
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: ["s3:ListBucket", "s3:GetBucketLocation"], Resource: [arn] },
      { Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject", "s3:AbortMultipartUpload"], Resource: [`${arn}/*`] },
    ],
  };
}

async function ensurePolicy(name, doc) {
  const cur = await admin("GET", "info-canned-policy", { name });
  let have = null;
  if (cur.status === 200) have = cur.json().policy;
  else if (!/does not exist/i.test(cur.text)) throw new Error(`info-canned-policy ${name}: HTTP ${cur.status} ${cur.text}`);
  if (have && isDeepStrictEqual(canon(have), canon(doc))) {
    same(`policy ${name}: up to date`);
    return;
  }
  const res = await admin("PUT", "add-canned-policy", { name }, doc);
  if (res.status !== 200) throw new Error(`add-canned-policy ${name}: HTTP ${res.status} ${res.text}`);
  changed(`policy ${name}: ${have ? "updated" : "created"}`);
}
const canon = (p) => ({
  Version: p.Version,
  Statement: norm(p.Statement).map((s) => ({ Effect: s.Effect, Action: norm(s.Action), Resource: norm(s.Resource) })),
});

// Does <key>/<secret> authenticate? (ListBuckets with that credential; 403 on policy is still "key accepted".)
async function keyAuthenticates(key, secret) {
  const c = new S3.S3Client({ endpoint, region, forcePathStyle: true, credentials: { accessKeyId: key, secretAccessKey: secret }, requestChecksumCalculation: "WHEN_REQUIRED" });
  try {
    await c.send(new S3.HeadBucketCommand({ Bucket: apiBuckets[0] }));
    return true;
  } catch (e) {
    return !["InvalidAccessKeyId", "SignatureDoesNotMatch"].includes(errName(e));
  }
}

async function ensureUser(key, secret, policyName) {
  const info = await admin("GET", "user-info", { accessKey: key });
  const exists = info.status === 200;
  if (!exists && info.status !== 404) throw new Error(`user-info ${key}: HTTP ${info.status} ${info.text}`);
  const userJson = exists ? info.json() : {};
  const secretOk = exists && (await keyAuthenticates(key, secret));
  if (!exists || !secretOk || userJson.status !== "enabled") {
    const res = await admin("PUT", "add-user", { accessKey: key }, { secretKey: secret, status: "enabled" });
    if (res.status !== 200) throw new Error(`add-user ${key}: HTTP ${res.status} ${res.text}`);
    changed(`user ${key}: ${exists ? "secret reset / re-enabled" : "created"}`);
  } else {
    same(`user ${key}: exists, secret verified, enabled`);
  }
  const bound = exists ? (await admin("GET", "user-info", { accessKey: key })).json().policyName : undefined;
  if (bound !== policyName) {
    const res = await admin("PUT", "set-user-or-group-policy", { policyName, userOrGroup: key, isGroup: "false" });
    if (res.status !== 200) throw new Error(`set-user-or-group-policy ${key}: HTTP ${res.status} ${res.text}`);
    changed(`user ${key}: policy ${policyName} attached`);
  } else {
    same(`user ${key}: policy ${policyName} attached`);
  }
}

// --- run ------------------------------------------------------------------------------------------
try {
  for (const b of apiBuckets) {
    await ensureBucket(b, lockDays);
    await ensureBucketPolicy(b);
  }
  await ensureBucket(backupBucket, backupDays);
  await ensureBucketPolicy(backupBucket);

  await ensurePolicy("webdesk-api", apiPolicy());
  await ensureUser(svcKey, svcSecret, "webdesk-api");
  if (bkKey) {
    await ensurePolicy("webdesk-backup", backupPolicy());
    await ensureUser(bkKey, bkSecret, "webdesk-backup");
  } else {
    same("backup user: not requested (WEBDESK_BACKUP_ACCESS_KEY_ID unset)");
  }
} catch (e) {
  console.error(`storage-bootstrap FAILED: ${errName(e)} ${e?.message ?? e}`);
  process.exit(1);
}
console.log(`STORAGE_BOOTSTRAP changes=${changes}`);
