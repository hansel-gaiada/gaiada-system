// Unit tests for scripts/ci/ghcr-prune.mjs. Run: node --test scripts/ci/ghcr-prune.test.mjs
// Only the registry is faked (a digest -> manifest map).
import test from "node:test";
import assert from "node:assert/strict";
import { planPackage, PruneError } from "./ghcr-prune.mjs";

const NOW = Date.parse("2026-10-11T00:00:00Z");
const hx = (n) => String(n).padStart(64, "0");
const D = (n) => `sha256:${hx(n)}`;
const ago = (days) => new Date(NOW - days * 86_400_000).toISOString();
let nextId = 1;
const ver = (n, { tags = [], days = 30 } = {}) => ({ id: nextId++, name: D(n), created_at: ago(days), metadata: { container: { tags } } });
const img = (extra = {}) => ({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", ...extra });
const idx = (...kids) => ({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: kids.map((k) => ({ digest: D(k) })) });
const run = (versions, manifests, opts = {}) =>
  planPackage({ versions, getManifest: async (d) => manifests[d] ?? null, now: NOW, ...opts });
const cand = (r) => r.candidates.map((c) => c.digest);

test("(a) untagged child of a tagged index is protected (the f627854c case)", async () => {
  const vs = [ver(1, { tags: ["v1.0.0-alpha.303"] }), ver(2), ver(3), ver(9)];
  const r = await run(vs, { [D(1)]: idx(2, 3), [D(2)]: img(), [D(3)]: img(), [D(9)]: img() });
  assert.deepEqual(cand(r), [D(9)]); // only the truly unreferenced one
  assert.equal(r.protectedUntagged, 2);
  assert.equal(r.tagged, 1);
});

test("(a2) a child that is already gone is reported as missing, not a crash", async () => {
  const r = await run([ver(1, { tags: ["v1"] })], { [D(1)]: idx(7) });
  assert.deepEqual(r.missing, [D(7)]);
  assert.deepEqual(r.candidates, []);
});

test("(b) cosign .sig/.att and sha256-<hex> referrer tags of a tagged digest, plus what they reference", async () => {
  const vs = [
    ver(1, { tags: ["v1"] }),
    ver(2, { tags: [`sha256-${hx(1)}.sig`] }),
    ver(3, { tags: [`sha256-${hx(1)}.att`] }),
    ver(4, { tags: [`sha256-${hx(1)}`] }), // referrers index
    ver(5), // child of the referrers index
    ver(8), // unreferenced
  ];
  const r = await run(vs, { [D(1)]: img(), [D(2)]: img(), [D(3)]: img(), [D(4)]: idx(5), [D(5)]: img(), [D(8)]: img() });
  assert.deepEqual(cand(r), [D(8)]);
  assert.ok(r.protectedBy.has(D(5)));
});

test("(b2) a signature tag of an unreferenced digest is still TAGGED, so never deleted; untagged unreachable ones go", async () => {
  const vs = [ver(1, { tags: ["v1"] }), ver(6, { tags: [`sha256-${hx(99)}.sig`] }), ver(7)];
  const r = await run(vs, { [D(1)]: img(), [D(6)]: img(), [D(7)]: img() });
  assert.deepEqual(cand(r), [D(7)]);
  assert.ok(r.protectedBy.has(D(6)));
});

test("(b3) an UNTAGGED version carrying no link is not rescued by the tags of an unrelated digest", async () => {
  const vs = [ver(1, { tags: ["v1"] }), ver(2, { tags: [`sha256-${hx(1)}.sig`] }), ver(3)];
  const r = await run(vs, { [D(1)]: img(), [D(2)]: img(), [D(3)]: img() });
  assert.deepEqual(cand(r), [D(3)]);
});

test("(c) nested index: grandchildren are protected", async () => {
  const vs = [ver(1, { tags: ["v1"] }), ver(2), ver(3), ver(4)];
  const r = await run(vs, { [D(1)]: idx(2), [D(2)]: idx(3), [D(3)]: img(), [D(4)]: img() });
  assert.deepEqual(cand(r), [D(4)]);
});

test("(d) untagged manifest whose subject is protected is protected; subject of an unprotected one is not", async () => {
  const vs = [ver(1, { tags: ["v1"] }), ver(2), ver(3), ver(4)];
  const r = await run(vs, {
    [D(1)]: img(),
    [D(2)]: img({ subject: { digest: D(1) } }),
    [D(3)]: img({ subject: { digest: D(4) } }), // subject 4 is unprotected
    [D(4)]: img(),
  });
  assert.deepEqual(cand(r).sort(), [D(3), D(4)].sort());
});

test("(e) age threshold: young unreferenced versions are kept, boundary is inclusive", async () => {
  const vs = [ver(1, { tags: ["v1"] }), ver(2, { days: 13 }), ver(3, { days: 14 }), ver(4, { days: 200 })];
  const m = { [D(1)]: img(), [D(2)]: img(), [D(3)]: img(), [D(4)]: img() };
  assert.deepEqual(cand(await run(vs, m)).sort(), [D(3), D(4)].sort());
  assert.deepEqual(cand(await run(vs, m, { minAgeDays: 30 })), [D(4)]);
});

test("(f) a failing manifest fetch aborts the package: nothing is a candidate", async () => {
  const vs = [ver(1, { tags: ["v1"] }), ver(2, { days: 99 })];
  await assert.rejects(
    planPackage({ versions: vs, now: NOW, getManifest: async (d) => { if (d === D(2)) throw new Error("HTTP 500"); return img(); } }),
    PruneError,
  );
  // a listed version that 404s is also "odd" => skip
  await assert.rejects(run(vs, { [D(1)]: img() }), PruneError);
});

test("(f2) odd API rows abort the package", async () => {
  await assert.rejects(run([{ id: 1, name: "latest", created_at: ago(1) }], {}), PruneError);
  await assert.rejects(run("nope", {}), PruneError);
});

test("(g) buildcache tag and its children are protected", async () => {
  const vs = [ver(1, { tags: ["buildcache"] }), ver(2), ver(3, { days: 99 })];
  const r = await run(vs, { [D(1)]: idx(2), [D(2)]: img(), [D(3)]: img() });
  assert.deepEqual(cand(r), [D(3)]);
  assert.ok(r.protectedBy.has(D(2)));
});

test("a tagged version is never a candidate, however old", async () => {
  const r = await run([ver(1, { tags: ["v0"], days: 9999 })], { [D(1)]: img() });
  assert.deepEqual(r.candidates, []);
});
