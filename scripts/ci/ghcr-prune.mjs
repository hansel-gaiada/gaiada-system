#!/usr/bin/env node
// Reference-aware GHCR prune. Replaces actions/delete-package-versions, which deleted the untagged CHILD
// manifest of a still-tagged image index ("untagged" is NOT "unreferenced"; see release.yml).
//
//   GH_TOKEN=... node scripts/ci/ghcr-prune.mjs [--dry-run] [--min-age-days 14] [--owner hansel-gaiada] [--package gaiada-x]
//   GH_TOKEN=... GHCR_PRUNE_CONFIRM=delete node scripts/ci/ghcr-prune.mjs --delete
//
// Dependency-free (Node 22, global fetch). Pure decision logic (`planPackage`) is exported and unit-tested in
// ghcr-prune.test.mjs; the CLI only wires the Packages API and the registry in. Default is a DRY RUN.
//
// PROTECTED set (fixed point): every TAGGED version; the children of any protected index; versions tagged
// sha256-<hex>[.sig|.att|...] of a protected digest D (and what they reference); anything whose `subject` is
// protected. Candidates = not protected AND older than --min-age-days. A tagged version is NEVER a candidate
// (asserted). Any API/registry error for a package => that package is skipped, nothing in it is deleted.
import { pathToFileURL } from "node:url";
import * as cfg from "./config.mjs";

const DAY_MS = 86_400_000;
const REF_TAG = /^sha256-([0-9a-f]{64})(\.[A-Za-z0-9_-]+)?$/;
export const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

export class PruneError extends Error {}

export const tagsOf = (v) => v?.metadata?.container?.tags ?? [];
export const isIndex = (m) => Array.isArray(m?.manifests);

/**
 * Decide what may be deleted from ONE package.
 *   versions:    Packages API rows ({id, name: "sha256:..", created_at, metadata.container.tags})
 *   getManifest: async (digest) => parsed manifest JSON, or null when the registry says 404. Any other failure throws.
 * Throws PruneError (=> caller skips the package) on anything odd. Returns
 *   { total, tagged, protectedUntagged, candidates: [{id,digest,ageDays,created_at}], missing: [digest], protectedBy: Map }
 */
export async function planPackage({ versions, getManifest, now = Date.now(), minAgeDays = 14, concurrency = 8 }) {
  if (!Array.isArray(versions)) throw new PruneError("versions is not an array");
  const byDigest = new Map();
  for (const v of versions) {
    if (!v || typeof v.name !== "string" || !/^sha256:[0-9a-f]{64}$/.test(v.name) || v.id == null) {
      throw new PruneError(`odd version row: ${JSON.stringify(v)?.slice(0, 120)}`);
    }
    if (byDigest.has(v.name)) throw new PruneError(`duplicate digest ${v.name}`);
    if (!Number.isFinite(Date.parse(v.created_at))) throw new PruneError(`bad created_at on ${v.name}`);
    byDigest.set(v.name, v);
  }

  // 1. manifests of EVERY listed version (needed for `subject` links and index children). 404 on a listed version is odd => skip.
  const manifests = new Map();
  const queue = [...byDigest.keys()];
  async function worker() {
    for (let d = queue.shift(); d !== undefined; d = queue.shift()) {
      let m;
      try { m = await getManifest(d); } catch (e) { throw new PruneError(`manifest fetch failed for ${d}: ${e.message}`); }
      if (m == null) throw new PruneError(`listed version ${d} has no manifest in the registry (404)`);
      manifests.set(d, m);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker));

  // 2. fixed point.
  const protectedBy = new Map(); // digest -> first reason
  const missing = new Set();
  const work = [];
  const protect = (d, why) => { if (!protectedBy.has(d)) { protectedBy.set(d, why); work.push(d); } };
  const tagIndex = new Map(); // tag -> digest
  for (const v of versions) for (const t of tagsOf(v)) tagIndex.set(t, v.name);
  const subjectsOf = new Map(); // subject digest -> [referrer digests]
  for (const [d, m] of manifests) {
    const s = m?.subject?.digest;
    if (typeof s === "string") {
      if (!subjectsOf.has(s)) subjectsOf.set(s, []);
      subjectsOf.get(s).push(d);
    }
  }
  for (const v of versions) if (tagsOf(v).length) protect(v.name, `tagged ${tagsOf(v)[0]}`);

  while (work.length) {
    const d = work.pop();
    const hex = d.slice("sha256:".length);
    const m = manifests.get(d);
    if (isIndex(m)) {
      for (const c of m.manifests) {
        if (typeof c?.digest !== "string") throw new PruneError(`index ${d} has a child without a digest`);
        if (!byDigest.has(c.digest)) missing.add(c.digest); // referenced but not a version (already deleted?): report, never crash
        protect(c.digest, `child of ${d}`);
      }
    }
    for (const [t, td] of tagIndex) { // referrer / cosign tags of D
      const mt = REF_TAG.exec(t);
      if (mt && mt[1] === hex) protect(td, `tag ${t} of ${d}`);
    }
    for (const r of subjectsOf.get(d) ?? []) protect(r, `subject-linked to ${d}`);
  }

  // 3. candidates.
  const candidates = [];
  let tagged = 0;
  for (const v of versions) {
    if (tagsOf(v).length) {
      tagged++;
      if (!protectedBy.has(v.name)) throw new PruneError(`internal: tagged ${v.name} not protected`);
      continue;
    }
    if (protectedBy.has(v.name)) continue;
    const ageDays = (now - Date.parse(v.created_at)) / DAY_MS;
    if (ageDays >= minAgeDays) candidates.push({ id: v.id, digest: v.name, ageDays: Math.floor(ageDays), created_at: v.created_at });
  }
  for (const c of candidates) { // assert: never a tagged or protected version
    if (tagsOf(byDigest.get(c.digest)).length || protectedBy.has(c.digest)) throw new PruneError(`internal: candidate ${c.digest} is tagged/protected`);
  }
  let protectedUntagged = 0;
  for (const d of protectedBy.keys()) if (byDigest.has(d) && !tagsOf(byDigest.get(d)).length) protectedUntagged++;
  return { total: versions.length, tagged, protectedUntagged, candidates, missing: [...missing], protectedBy };
}

// ---- GitHub / registry I/O ----------------------------------------------------------------------------------
const GH_HEADERS = (token) => ({ Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" });

export async function listVersions({ owner, pkg, token, fetchImpl = fetch }) {
  const out = [];
  for (let page = 1; ; page++) {
    const r = await fetchImpl(`https://api.github.com/users/${owner}/packages/container/${pkg}/versions?per_page=100&page=${page}`, { headers: GH_HEADERS(token) });
    if (!r.ok) throw new PruneError(`list versions ${pkg}: HTTP ${r.status}`);
    const rows = await r.json();
    if (!Array.isArray(rows)) throw new PruneError(`list versions ${pkg}: not an array`);
    out.push(...rows);
    if (rows.length < 100) return out;
    if (page > 200) throw new PruneError("too many pages");
  }
}

export function registryManifestFetcher({ owner, pkg, token, user = owner, fetchImpl = fetch }) {
  let bearer;
  async function auth() {
    const r = await fetchImpl(`https://ghcr.io/token?service=ghcr.io&scope=repository:${owner}/${pkg}:pull`, {
      headers: { Authorization: `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}` },
    });
    if (!r.ok) throw new Error(`registry token HTTP ${r.status}`);
    bearer = (await r.json()).token;
    if (!bearer) throw new Error("registry token response had no token");
  }
  return async function getManifest(digest) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!bearer) await auth();
      const r = await fetchImpl(`https://ghcr.io/v2/${owner}/${pkg}/manifests/${digest}`, { headers: { Authorization: `Bearer ${bearer}`, Accept: MANIFEST_ACCEPT } });
      if (r.status === 401 && attempt === 0) { bearer = undefined; continue; }
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    }
    throw new Error("unauthorized");
  };
}

async function deleteVersion({ owner, pkg, id, token }) {
  const r = await fetch(`https://api.github.com/users/${owner}/packages/container/${pkg}/versions/${id}`, { method: "DELETE", headers: GH_HEADERS(token) });
  if (r.status !== 204) throw new Error(`DELETE ${id}: HTTP ${r.status}`);
}

export function parseArgs(argv) {
  const o = { delete: false, minAgeDays: 14, owner: process.env.GHCR_OWNER || "hansel-gaiada", pkg: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") o.delete = false;
    else if (a === "--delete") o.delete = true;
    else if (a === "--min-age-days") o.minAgeDays = Number(argv[++i]);
    else if (a === "--owner") o.owner = argv[++i];
    else if (a === "--package") o.pkg = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  if (!Number.isFinite(o.minAgeDays) || o.minAgeDays < 0) throw new Error("--min-age-days must be a number >= 0");
  return o;
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  const token = process.env.GH_TOKEN;
  if (!token) { console.error("GH_TOKEN is required"); process.exit(2); }
  if (opts.delete && process.env.GHCR_PRUNE_CONFIRM !== "delete") {
    console.error("--delete requires GHCR_PRUNE_CONFIRM=delete; refusing."); process.exit(2);
  }
  const names = opts.pkg ? [opts.pkg] : cfg.COMPONENTS.map((c) => `gaiada-${c.name}`);
  console.log(`ghcr-prune: owner=${opts.owner} mode=${opts.delete ? "DELETE" : "DRY-RUN"} min-age-days=${opts.minAgeDays}`);
  let skipped = 0, deleted = 0;
  for (const pkg of names) {
    try {
      const versions = await listVersions({ owner: opts.owner, pkg, token });
      const getManifest = registryManifestFetcher({ owner: opts.owner, pkg, token });
      const plan = await planPackage({ versions, getManifest, minAgeDays: opts.minAgeDays });
      console.log(`\n== ${pkg}: total=${plan.total} tagged=${plan.tagged} protected-untagged=${plan.protectedUntagged} candidates=${plan.candidates.length} missing-referenced=${plan.missing.length}`);
      for (const m of plan.missing) console.log(`   MISSING referenced digest (not a version; already deleted?): ${m}`);
      for (const c of plan.candidates) console.log(`   candidate id=${c.id} ${c.digest} age=${c.ageDays}d`);
      if (opts.delete) {
        for (const c of plan.candidates) { await deleteVersion({ owner: opts.owner, pkg, id: c.id, token }); deleted++; console.log(`   deleted ${c.id}`); }
      }
    } catch (e) {
      skipped++;
      console.log(`\n== ${pkg}: SKIPPED (fail-safe, nothing deleted): ${e.message}`);
      console.log(`::warning::ghcr-prune skipped ${pkg}: ${e.message}`);
    }
  }
  console.log(`\nsummary: packages=${names.length} skipped=${skipped} ${opts.delete ? `deleted=${deleted}` : "(dry run, nothing deleted)"}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().catch((e) => { console.error(e); process.exit(1); });
