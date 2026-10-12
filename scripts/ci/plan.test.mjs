// WSK-69 — unit tests for scripts/ci/plan.mjs. Run: node --test scripts/ci/plan.test.mjs
// The git layer is exercised for real (throwaway repos); only the container registry is faked.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { planCi, planRelease, gitAdapter } from "./plan.mjs";
import { COMPONENTS, CI_GROUPS } from "./config.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DAY = 86400;
const T0 = 1_760_000_000; // fixed epoch seconds, so "age" is deterministic

function sh(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
}

/** A repo with every component dir present, plus a helper to commit/tag at a given time. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "wsk69-"));
  sh(dir, "init", "-q", "-b", "main");
  for (const c of COMPONENTS) { mkdirSync(join(dir, c.path), { recursive: true }); writeFileSync(join(dir, c.path, "Dockerfile"), "FROM scratch\n"); }
  mkdirSync(join(dir, ".github/workflows"), { recursive: true });
  writeFileSync(join(dir, ".github/workflows/release.yml"), "name: release\n");
  const api = {
    dir,
    commit(msg, atSec, files = {}) {
      for (const [p, body] of Object.entries(files)) {
        if (body === null) rmSync(join(dir, p), { recursive: true, force: true });
        else { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), body); }
      }
      sh(dir, "add", "-A");
      const d = `${atSec} +0000`;
      execFileSync("git", ["commit", "-q", "--allow-empty", "-m", msg, "--date", d], { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_COMMITTER_DATE: d } });
      return sh(dir, "rev-parse", "HEAD");
    },
    tag: (name) => sh(dir, "tag", name),
    head: () => sh(dir, "rev-parse", "HEAD"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
  return api;
}

/** Fake registry: every component has a signed image at every tag in `signedAt` (default: all). */
const registry = ({ missing = new Set() } = {}) => ({
  signedDigest: (comp, tag) => (missing.has(`${comp}@${tag}`) ? null : `sha256:${comp}-${tag}`.padEnd(71, "0")),
});

const names = (a) => [...a].sort();

// ------------------------------------------------------------------ release plan

test("release: a webdesk-only diff builds only webdesk-api and re-tags the other 11", () => {
  const r = makeRepo();
  try {
    r.commit("base", T0, { "x": "1" });
    r.tag("v1.0.0-alpha.1");
    r.commit("webdesk api change", T0 + DAY, { "webdesk/api/src/a.ts": "a" });
    r.commit("webdesk api change 2", T0 + DAY, { "webdesk/api/src/b.ts": "b" });
    r.commit("a markdown note", T0 + DAY, { "docs/note.md": "n" }); // docs never reach an image
    const plan = planRelease({ head: r.head(), currentTag: "v1.0.0-alpha.2", now: (T0 + 2 * DAY) * 1000, git: gitAdapter(r.dir), registry: registry() });
    assert.deepEqual(names(plan.build), ["webdesk-api"]);
    assert.equal(plan.retag.length, 11);
    assert.ok(plan.retag.every((x) => x.fromTag === "v1.0.0-alpha.1" && x.digest.startsWith("sha256:")));
    assert.deepEqual(plan.removed, []);
  } finally { r.cleanup(); }
});

test("release: a webdesk/blocks or webdesk/delivery/vocabulary diff rebuilds webdesk-api, it is not re-tagged (M6-P4r-a)", () => {
  // The api image packs webdesk/blocks into a tarball and the contract generator inlines the vocabulary, so a diff
  // there changes the image even though it is outside webdesk/api/. Anything else under webdesk/ does not.
  const planFor = (file) => {
    const r = makeRepo();
    try {
      r.commit("base", T0, { "x": "1" });
      r.tag("v1.0.0-alpha.1");
      r.commit("change", T0 + DAY, { [file]: "changed" });
      return planRelease({ head: r.head(), currentTag: "v1.0.0-alpha.2", now: (T0 + 2 * DAY) * 1000, git: gitAdapter(r.dir), registry: registry() });
    } finally { r.cleanup(); }
  };
  for (const f of ["webdesk/blocks/src/components/Hero.astro", "webdesk/blocks/package.json", "webdesk/delivery/vocabulary/blocks.ts"]) {
    const plan = planFor(f);
    assert.deepEqual(names(plan.build), ["webdesk-api"], f);
    assert.match(plan.reasons["webdesk-api"], /changed since/, f);
  }
  for (const f of ["webdesk/migrations/0099_x.sql", "webdesk/delivery/test/vocabulary.test.mjs", "webdesk/ops/x.sh"]) {
    const plan = planFor(f);
    assert.deepEqual(plan.build, [], f);
  }
});

test("release: a shared-file diff (release.yml) rebuilds every component", () => {
  const r = makeRepo();
  try {
    r.commit("base", T0);
    r.tag("v1.0.0-alpha.1");
    r.commit("edit the release workflow", T0 + DAY, { ".github/workflows/release.yml": "name: release\n# changed\n" });
    const plan = planRelease({ head: r.head(), currentTag: "v1.0.0-alpha.2", now: (T0 + 2 * DAY) * 1000, git: gitAdapter(r.dir), registry: registry() });
    assert.equal(plan.build.length, COMPONENTS.length);
    assert.equal(plan.retag.length, 0);
    assert.match(plan.reasons["mcp-hub"], /shared input changed/);
  } finally { r.cleanup(); }
});

test("release: a change to scripts/ci/ alone does NOT rebuild images (it never reaches one)", () => {
  const r = makeRepo();
  try {
    r.commit("base", T0);
    r.tag("v1.0.0-alpha.1");
    r.commit("tweak planner", T0 + DAY, { "scripts/ci/plan.mjs": "// x" });
    const plan = planRelease({ head: r.head(), currentTag: "v1.0.0-alpha.2", now: (T0 + 2 * DAY) * 1000, git: gitAdapter(r.dir), registry: registry() });
    assert.equal(plan.build.length, 0);
    assert.equal(plan.retag.length, COMPONENTS.length);
  } finally { r.cleanup(); }
});

test("release: the first tag (no previous release tag) builds everything", () => {
  const r = makeRepo();
  try {
    r.commit("base", T0);
    const plan = planRelease({ head: r.head(), currentTag: "v1.0.0-alpha.1", now: (T0 + DAY) * 1000, git: gitAdapter(r.dir), registry: registry() });
    assert.equal(plan.build.length, COMPONENTS.length);
    assert.equal(plan.retag.length, 0);
    assert.match(plan.reasons["platform-ui"], /first release/);
  } finally { r.cleanup(); }
});

test("release: the tag being released is never its own baseline, and non-release tags are ignored", () => {
  const r = makeRepo();
  try {
    r.commit("base", T0);
    r.tag("v1.0.0-alpha.1");
    r.commit("c", T0 + DAY);
    r.tag("experiment-foo"); // not a release tag pattern
    r.tag("v1.0.0-alpha.2"); // current
    const tags = gitAdapter(r.dir).releaseTags(r.head(), "v1.0.0-alpha.2");
    assert.deepEqual(tags.map((t) => t.tag), ["v1.0.0-alpha.1"]);
  } finally { r.cleanup(); }
});

test("release: a deleted component (build context gone at HEAD) is neither built nor re-tagged", () => {
  const r = makeRepo();
  try {
    r.commit("base", T0);
    r.tag("v1.0.0-alpha.1");
    r.commit("remove search-crawl-go", T0 + DAY, { "search-crawl-go": null });
    const plan = planRelease({ head: r.head(), currentTag: "v1.0.0-alpha.2", now: (T0 + 2 * DAY) * 1000, git: gitAdapter(r.dir), registry: registry() });
    assert.deepEqual(plan.removed, ["search-crawl-go"]);
    assert.ok(!plan.build.includes("search-crawl-go"));
    assert.ok(!plan.retag.some((x) => x.component === "search-crawl-go"));
    assert.equal(plan.build.length + plan.retag.length, COMPONENTS.length - 1);
  } finally { r.cleanup(); }
});

test("release: a missing previous image walks back to an older tag and diffs against THAT one", () => {
  const r = makeRepo();
  try {
    r.commit("base", T0);
    r.tag("v1.0.0-alpha.1");
    r.commit("platform-ui change", T0 + DAY, { "platform-ui/src/p.ts": "p" }); // lives between alpha.1 and alpha.2
    r.tag("v1.0.0-alpha.2"); // a release whose platform-ui image never got signed
    r.commit("webdesk change", T0 + 2 * DAY, { "webdesk/api/src/a.ts": "a" });
    const reg = registry({ missing: new Set(["platform-ui@v1.0.0-alpha.2"]) });
    const plan = planRelease({ head: r.head(), currentTag: "v1.0.0-alpha.3", now: (T0 + 3 * DAY) * 1000, git: gitAdapter(r.dir), registry: reg });
    // platform-ui falls back to alpha.1, whose diff includes the platform-ui change -> must build.
    assert.ok(plan.build.includes("platform-ui"));
    assert.match(plan.reasons["platform-ui"], /since v1\.0\.0-alpha\.1/);
    // others are re-tagged from alpha.2 (the newest signed image)
    assert.equal(plan.retag.find((x) => x.component === "mcp-hub").fromTag, "v1.0.0-alpha.2");
  } finally { r.cleanup(); }
});

test("release: no signed image in any candidate tag -> rebuild; too-old image -> rebuild; force_all -> rebuild", () => {
  const r = makeRepo();
  try {
    r.commit("base", T0);
    r.tag("v1.0.0-alpha.1");
    r.commit("noop", T0 + DAY);
    const git = gitAdapter(r.dir);
    const none = planRelease({ head: r.head(), currentTag: "v1.0.0-alpha.2", now: (T0 + 2 * DAY) * 1000, git, registry: { signedDigest: () => null } });
    assert.equal(none.build.length, COMPONENTS.length);
    assert.match(none.reasons["mcp-hub"], /no signed previous image/);

    const old = planRelease({ head: r.head(), currentTag: "v1.0.0-alpha.2", now: (T0 + 40 * DAY) * 1000, git, registry: registry() });
    assert.equal(old.build.length, COMPONENTS.length);
    assert.match(old.reasons["mcp-hub"], /old > 30d/);

    const forced = planRelease({ head: r.head(), currentTag: "v1.0.0-alpha.2", forceAll: true, now: (T0 + 2 * DAY) * 1000, git, registry: registry() });
    assert.equal(forced.build.length, COMPONENTS.length);
  } finally { r.cleanup(); }
});

test("release: Dockerfile change inside a component rebuilds only that component", () => {
  const r = makeRepo();
  try {
    r.commit("base", T0);
    r.tag("v1.0.0-alpha.1");
    r.commit("dockerfile", T0 + DAY, { "report-renderer/Dockerfile": "FROM scratch\n# new\n" });
    const plan = planRelease({ head: r.head(), currentTag: "v1.0.0-alpha.2", now: (T0 + 2 * DAY) * 1000, git: gitAdapter(r.dir), registry: registry() });
    assert.deepEqual(plan.build, ["report-renderer"]);
  } finally { r.cleanup(); }
});

// ------------------------------------------------------------------ CI plan

const on = (o) => Object.entries(o).filter(([k, v]) => v === true && !k.startsWith("any_")).map(([k]) => k).sort();

test("ci: a webdesk-only change runs only webdesk groups", () => {
  const { outputs } = planCi({ files: ["webdesk/api/src/a.ts"] });
  assert.deepEqual(on(outputs), ["webdesk_api"]);
  const both = planCi({ files: ["webdesk/delivery/vocabulary/primitives.ts"] }).outputs;
  assert.deepEqual(on(both), ["nest", "webdesk_api", "webdesk_blocks", "webdesk_wordpress"]);
  // The vocabulary tests (webdesk/delivery/test/) run in the webdesk-api job; the blocks package only vendors vocabulary/.
  assert.deepEqual(on(planCi({ files: ["webdesk/delivery/test/vocabulary.test.mjs"] }).outputs), ["webdesk_api"]);
  // M6-P4r-a: the api image packs webdesk/blocks, so a blocks-only change runs the webdesk-api group as well.
  assert.deepEqual(on(planCi({ files: ["webdesk/blocks/src/index.ts"] }).outputs), ["webdesk_api", "webdesk_blocks"]);
});

test("ci: a platform-nest-only change runs the nest group (+ nothing else); migrations also run sync-engine", () => {
  assert.deepEqual(on(planCi({ files: ["platform-nest/src/x.ts"] }).outputs), ["nest"]);
  assert.deepEqual(on(planCi({ files: ["platform-nest/migrations/20261010_x.sql"] }).outputs), ["nest", "sync"]);
  assert.deepEqual(on(planCi({ files: ["platform-nest/cerbos/policies/derived_roles.yaml"] }).outputs), ["nest", "ui"]);
});

test("ci: a shared CI input (ci.yml, scripts/ci) runs everything", () => {
  for (const f of [".github/workflows/ci.yml", "scripts/ci/plan.mjs"]) {
    const { outputs } = planCi({ files: [f] });
    assert.equal(on(outputs).length, Object.keys(CI_GROUPS).length, f);
  }
});

test("ci: unknown diff base and forced runs run everything; a docs-only diff runs nothing", () => {
  assert.equal(on(planCi({ files: null }).outputs).length, Object.keys(CI_GROUPS).length);
  assert.equal(on(planCi({ files: [], forceAll: true }).outputs).length, Object.keys(CI_GROUPS).length);
  assert.deepEqual(on(planCi({ files: ["docs/x.md"] }).outputs), []);
});

test("ci: any_test / any_webdesk_light roll up the merged-job conditions", () => {
  assert.equal(planCi({ files: ["mcp-hub/src/a.ts"] }).outputs.any_test, true);
  assert.equal(planCi({ files: ["mcp-hub/src/a.ts"] }).outputs.any_webdesk_light, false);
  assert.equal(planCi({ files: ["webdesk/deploy/src/a.ts"] }).outputs.any_webdesk_light, true);
  assert.equal(planCi({ files: ["webdesk/api/src/a.ts"] }).outputs.any_test, false);
});

test("ci: webdesk_wordpress fires on the theme, the vocabulary and the PHP SDK generator only (M6-P5b)", () => {
  const wp = (f) => planCi({ files: [f] }).outputs;
  assert.equal(wp("webdesk/wordpress/test/router-probe.php").webdesk_wordpress, true);
  assert.equal(wp("webdesk/delivery/vocabulary/blocks.ts").webdesk_wordpress, true);
  assert.equal(wp("webdesk/api/src/codegen/generator/sdk-php.mts").webdesk_wordpress, true);
  assert.equal(wp("webdesk/api/src/codegen/generator/sdk-ts.mts").webdesk_wordpress, false);
  assert.equal(wp("webdesk/wordpress/test/router-probe.php").any_webdesk_light, true);
});

// ------------------------------------------------------------------ repo coherence guards

test("coherence: every release component's build context exists in this repo", () => {
  for (const c of COMPONENTS) assert.ok(existsSync(join(REPO_ROOT, c.path, "Dockerfile")), `${c.path}Dockerfile`);
});

test("coherence: deploy.yml COMPONENTS is a subset of the release components (so retag covers what deploy verifies)", () => {
  const yml = readFileSync(join(REPO_ROOT, ".github/workflows/deploy.yml"), "utf8").replaceAll("\r", "");
  const m = yml.match(/COMPONENTS:\s*>-\s*\n((?:\s+[a-z0-9 -]+\n)+)/);
  assert.ok(m, "could not find COMPONENTS in deploy.yml");
  const deployed = m[1].split(/\s+/).filter(Boolean);
  assert.ok(deployed.length >= 9);
  const known = new Set(COMPONENTS.map((c) => c.name));
  for (const d of deployed) assert.ok(known.has(d), `${d} verified by deploy.yml but not planned by release`);
  assert.ok(!deployed.includes("webdesk-api"), "webdesk-api must stay out of deploy.yml (see webdesk/docker-compose.aicenter-release.yml)");
});

test("coherence: ci.yml consumes every plan output it depends on", () => {
  const yml = readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
  for (const k of Object.keys(CI_GROUPS)) assert.ok(yml.includes(`needs.plan.outputs.${k}`), `ci.yml never reads plan output '${k}'`);
});
