#!/usr/bin/env node
// WSK-40 — editorial assertion key generation and JWKS maintenance (write-plane design §5;
// rotation runbook: infra/runbooks/webdesk-editorial-keys.md).
//
// The ERP signs editorial assertions with an Ed25519 private key; WebDesk verifies them with the
// matching PUBLIC key from a pinned JWKS file. This script produces both, and edits the JWKS for a
// rotation. Plain node:crypto, no dependencies, so it runs anywhere Node >= 18 runs (including inside
// the platform container).
//
//   generate --kid <kid> --out <dir> [--jwks <existing editorial.jwks.json>]
//       Writes <dir>/editorial-signing.<kid>.pk8.pem   (PKCS8 PEM, mode 0400; the ERP's SECRET)
//              <dir>/editorial.jwks.json               (mode 0444; the WebDesk mount)
//       With --jwks, the new public key is APPENDED to that file's keys (rotation step 2) and the
//       result is written to <dir>/editorial.jwks.json. Refuses to overwrite any existing file.
//   remove --jwks <file> --kid <kid> --out <file>
//       Writes a copy of the JWKS without <kid> (rotation step 4 / emergency revocation). Refuses to
//       leave an empty key set.
//   inspect --jwks <file>
//       Prints each kid and its RFC 7638 thumbprint. Public data only.
//
// NEVER prints, logs or echoes private key material: stdout carries file paths, kids and public
// thumbprints only. The private key file is created with O_EXCL and mode 0400 in one step.
import { createHash, generateKeyPairSync, createPublicKey } from "node:crypto";
import { openSync, writeSync, closeSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const KID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const X_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_KEYS = 2;

function fail(msg) {
  process.stderr.write(`webdesk-editorial-keygen: ${msg}\n`);
  process.exit(2);
}

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) fail(`${a} needs a value`);
      out[a.slice(2)] = v;
      i++;
    } else out._.push(a);
  }
  return out;
}

/** RFC 7638 thumbprint of an OKP public JWK. */
function thumbprint(jwk) {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return createHash("sha256").update(canonical).digest("base64url");
}

/** Same rules as webdesk/api/src/control/auth/editorial-jwks.ts, so a file this script accepts boots there. */
function readJwks(path) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    fail(`${path} is not a readable JSON file (${err.code ?? err.message})`);
  }
  if (!doc || !Array.isArray(doc.keys)) fail(`${path} has no "keys" array`);
  const kids = new Set();
  for (const [i, k] of doc.keys.entries()) {
    if (!k || k.kty !== "OKP" || k.crv !== "Ed25519" || typeof k.x !== "string" || !X_RE.test(k.x)) fail(`${path} keys[${i}] is not a public Ed25519 JWK`);
    if ("d" in k) fail(`${path} keys[${i}] carries private material ("d"); refusing to touch it`);
    if (typeof k.kid !== "string" || !KID_RE.test(k.kid)) fail(`${path} keys[${i}] has an invalid kid`);
    if (kids.has(k.kid)) fail(`${path} has a duplicate kid ${k.kid}`);
    kids.add(k.kid);
    createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: k.x }, format: "jwk" }); // throws if not a real key
  }
  return doc;
}

function writeExclusive(path, content, mode) {
  if (existsSync(path)) fail(`${path} already exists; refusing to overwrite (move it away first)`);
  const fd = openSync(path, "wx", mode);
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

function publicJwk(kid, publicKey) {
  const j = publicKey.export({ format: "jwk" });
  return { kty: "OKP", crv: "Ed25519", kid, x: j.x, use: "sig", alg: "EdDSA" };
}

function jwksText(keys) {
  return `${JSON.stringify({ keys }, null, 2)}\n`;
}

const a = args(process.argv.slice(2));
const verb = a._[0];

if (verb === "generate") {
  const kid = a.kid;
  if (!kid || !KID_RE.test(kid)) fail(`--kid must match ${KID_RE} (e.g. wde-2026-10)`);
  if (!a.out) fail("--out <dir> is required");
  const dir = resolve(a.out);
  const keys = a.jwks ? readJwks(resolve(a.jwks)).keys : [];
  if (keys.some((k) => k.kid === kid)) fail(`kid ${kid} is already in ${a.jwks}`);
  if (keys.length + 1 > MAX_KEYS) fail(`the JWKS would hold ${keys.length + 1} keys; WebDesk accepts at most ${MAX_KEYS} (remove the retired kid first)`);

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyPath = join(dir, `editorial-signing.${kid}.pk8.pem`);
  const jwksPath = join(dir, "editorial.jwks.json");
  const jwk = publicJwk(kid, publicKey);
  // Write the JWKS check first so a refusal never leaves an orphan private key behind.
  if (existsSync(jwksPath)) fail(`${jwksPath} already exists; refusing to overwrite (move it away first)`);
  writeExclusive(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), 0o400);
  writeExclusive(jwksPath, jwksText([...keys, jwk]), 0o444);
  process.stdout.write(
    `${JSON.stringify({
      generated: kid,
      thumbprint: thumbprint(jwk),
      erpPrivateKeyFile: keyPath,
      webdeskJwksFile: jwksPath,
      jwksKids: [...keys.map((k) => k.kid), kid],
    })}\n`,
  );
} else if (verb === "remove") {
  if (!a.jwks || !a.kid || !a.out) fail("remove needs --jwks <file> --kid <kid> --out <file>");
  const doc = readJwks(resolve(a.jwks));
  const kept = doc.keys.filter((k) => k.kid !== a.kid);
  if (kept.length === doc.keys.length) fail(`kid ${a.kid} is not in ${a.jwks}`);
  if (kept.length === 0) fail(`removing ${a.kid} would leave an empty key set; install the new kid first`);
  writeExclusive(resolve(a.out), jwksText(kept), 0o444);
  process.stdout.write(`${JSON.stringify({ removed: a.kid, out: resolve(a.out), jwksKids: kept.map((k) => k.kid) })}\n`);
} else if (verb === "inspect") {
  if (!a.jwks) fail("inspect needs --jwks <file>");
  const doc = readJwks(resolve(a.jwks));
  process.stdout.write(`${JSON.stringify({ keys: doc.keys.map((k) => ({ kid: k.kid, thumbprint: thumbprint(k) })) })}\n`);
} else {
  fail("usage: generate --kid <kid> --out <dir> [--jwks <file>] | remove --jwks <file> --kid <kid> --out <file> | inspect --jwks <file>");
}
