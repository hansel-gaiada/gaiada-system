#!/usr/bin/env node
// App version helper — see docs/modules/VERSIONING.md.
//
// FORMAT: SemVer 2.0.0 with a pre-release identifier (2026-08-31 ruling).
//   /VERSION  1.0.0-alpha.302        tag  v1.0.0-alpha.302
// The stage ladder falls out of SemVer's own precedence rules for free:
//   1.0.0-alpha.302 < 1.0.0-beta.1 < 1.0.0-rc.1 < 1.0.0
// ...because pre-release identifiers compare alphabetically ("alpha" < "beta" < "rc") and numeric
// ones numerically, and any pre-release sorts BELOW the release it precedes.
//
// LEGACY: `Alpha 01.071.0301a` / `alpha-01.071.0301a` is still parsed so this keeps working across
// the cutover, but new versions are only ever emitted as SemVer.
//
// WHY DERIVE FROM TAGS. Several sessions cut releases here concurrently. On 2026-08-31 two of them
// independently chose `Alpha 01.071.0208a` minutes apart. Both wrote the SAME string into /VERSION,
// so git auto-merged with no conflict and the collision was invisible in the diff — but a tag
// resolves to exactly one commit, so the fix merged moments later was NOT in that build while
// /VERSION still read `0208a`. Tags are the only thing git actually makes contended. Trust them.
//
//   node scripts/next-version.mjs              print the next free app version
//   node scripts/next-version.mjs --tag        ...as a tag name (v1.0.0-alpha.303)
//   node scripts/next-version.mjs --check X    exit 1 if version X's tag is already taken
//   node scripts/next-version.mjs --check-file exit 1 if /VERSION's tag is already taken
//
// NOTE: /VERSION names the version most recently CUT — not what is deployed, not what HEAD
// contains. To ask "did commit C ship in tag T?" use `git merge-base --is-ancestor C T`.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (...a) => execFileSync("git", ["-C", ROOT, ...a], { encoding: "utf8", maxBuffer: 1 << 28 });

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)-([a-z]+)\.(\d+)$/;
const LEGACY_RE = /^([A-Za-z]+)[ -](\d+)\.(\d+)\.(\d+)([a-z])$/;

/** → {major,minor,patch,stage,n} or null. Accepts both formats, with or without a `v`. */
export function parse(s) {
  const t = String(s).trim();
  const m = t.match(SEMVER_RE);
  if (m) return { major: +m[1], minor: +m[2], patch: +m[3], stage: m[4], n: +m[5], legacy: false };
  const l = t.match(LEGACY_RE);
  // Legacy carries no SemVer shape; map it onto the 1.0.0-<stage>.<ref> line it is being replaced
  // by, so the two orderings are comparable during the cutover. `ref` is the counter that actually
  // moved (+1 per cut); the milestone/release fields never moved and are dropped.
  if (l) return { major: 1, minor: 0, patch: 0, stage: l[1].toLowerCase(), n: +l[4], legacy: true };
  return null;
}

export const toVersion = (v) => `${v.major}.${v.minor}.${v.patch}-${v.stage}.${v.n}`;
export const toTag = (v) => `v${toVersion(v)}`;

const STAGES = ["alpha", "beta", "rc"];
const rank = (v) => [v.major, v.minor, v.patch, STAGES.indexOf(v.stage), v.n];
const cmp = (a, b) => { const x = rank(a), y = rank(b); for (let i = 0; i < 5; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

const allTags = () =>
  git("tag", "--list").split("\n").map((s) => s.trim()).filter(Boolean)
    .map((t) => ({ tag: t, v: parse(t) })).filter((e) => e.v);

function readVersionFile() {
  const raw = readFileSync(join(ROOT, "VERSION"), "utf8").trim();
  const v = parse(raw);
  if (!v) { console.error(`VERSION is not a recognised app version: ${JSON.stringify(raw)}`); process.exit(2); }
  return v;
}

/** Next free version: highest TAG of this stage, counter + 1, skipping anything already taken.
 *  Legacy tags are included in the max so the cutover cannot reuse a number. */
export function nextVersion(stage = "alpha") {
  const same = allTags().filter((e) => e.v.stage === stage);
  const top = same.length ? same.sort((a, b) => cmp(a.v, b.v)).at(-1).v
                          : { major: 1, minor: 0, patch: 0, stage, n: 0, legacy: false };
  const taken = new Set(allTags().flatMap((e) => [e.tag, e.tag.replace(/^v/, "")]));
  let next = { major: top.major, minor: top.minor, patch: top.patch, stage, n: top.n + 1, legacy: false };
  while (taken.has(toTag(next)) || taken.has(toVersion(next))) next = { ...next, n: next.n + 1 };
  return next;
}

function checkFree(v, label) {
  // Match on the PARSED version, not on a rebuilt string: a legacy /VERSION must be compared against
  // the legacy tag it would actually produce, and a SemVer one against `v<x.y.z-stage.n>`. Comparing
  // parsed values covers both without reconstructing either spelling.
  const hit = allTags().find((e) => e.v.stage === v.stage && e.v.n === v.n && e.v.legacy === v.legacy);
  if (!hit) { console.log(`ok — ${toVersion(v)} is free`); return 0; }
  const at = git("rev-list", "-1", hit.tag).trim().slice(0, 8);
  console.error(
    `${label} is ALREADY TAKEN: ${hit.tag} exists and points at ${at}.\n` +
    `Another session almost certainly cut it while this change was in flight.\n` +
    `Do NOT move a pushed tag. Cut the next free version instead:\n` +
    `  ${toVersion(nextVersion(v.stage))}\n` +
    `(\`node scripts/next-version.mjs\` prints it.)`,
  );
  return 1;
}

const [flag, arg] = process.argv.slice(2);
if (flag === "--check") {
  const v = parse(arg);
  if (!v) { console.error(`not a recognised app version: ${JSON.stringify(arg)}`); process.exit(2); }
  process.exit(checkFree(v, toVersion(v)));
} else if (flag === "--check-file") {
  process.exit(checkFree(readVersionFile(), "/VERSION"));
} else if (flag === "--tag") {
  console.log(toTag(nextVersion()));
} else {
  console.log(toVersion(nextVersion()));
}
