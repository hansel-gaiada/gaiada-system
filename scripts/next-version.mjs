#!/usr/bin/env node
// App version helper — see docs/modules/VERSIONING.md.
//
// WHY THIS EXISTS. The app version used to be hand-picked, and several sessions cut releases against
// this repo concurrently. On 2026-08-31 two of them independently chose `Alpha 01.071.0208a` minutes
// apart. Both wrote the SAME string into /VERSION, so git auto-merged with no conflict and the
// collision was invisible in the diff — but the tag `alpha-01.071.0208a` resolves to only one of the
// two commits, and the fix merged moments later was NOT in that build even though /VERSION said
// `0208a`. Anyone reading /VERSION would have concluded the fix shipped.
//
// Tags are the real point of contention (git refuses a duplicate), so derive the number FROM the
// tags rather than from /VERSION or from memory.
//
//   node scripts/next-version.mjs              print the next free app version
//   node scripts/next-version.mjs --tag        ...as a tag name (alpha-01.071.0211a)
//   node scripts/next-version.mjs --check X    exit 1 if version X's tag is already taken
//   node scripts/next-version.mjs --check-file exit 1 if /VERSION's tag is already taken
//
// NOTE: /VERSION names the version most recently CUT, not what is deployed and not what HEAD
// contains. To ask "did commit C ship in tag T?", use `git merge-base --is-ancestor C T`.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (...a) => execFileSync("git", ["-C", ROOT, ...a], { encoding: "utf8", maxBuffer: 1 << 28 });

// `Alpha 01.071.0209a` <-> `alpha-01.071.0209a`
const VERSION_RE = /^([A-Za-z]+) (\d+)\.(\d+)\.(\d+)([a-z])$/;
const TAG_RE = /^([a-z]+)-(\d+)\.(\d+)\.(\d+)([a-z])$/;

export function parse(s, re = VERSION_RE) {
  const m = String(s).trim().match(re);
  if (!m) return null;
  return { stage: m[1], milestone: m[2], release: m[3], ref: m[4], rev: m[5] };
}

const toTag = (v) => `${v.stage.toLowerCase()}-${v.milestone}.${v.release}.${v.ref}${v.rev}`;
const toVersion = (v) =>
  `${v.stage[0].toUpperCase()}${v.stage.slice(1).toLowerCase()} ${v.milestone}.${v.release}.${v.ref}${v.rev}`;
const rank = (v) => [Number(v.milestone), Number(v.release), Number(v.ref), v.rev.charCodeAt(0)];
const cmp = (a, b) => { const x = rank(a), y = rank(b); for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

function allTags() {
  return git("tag", "--list")
    .split("\n").map((s) => s.trim()).filter(Boolean)
    .map((t) => ({ tag: t, v: parse(t, TAG_RE) }))
    .filter((e) => e.v);
}

function readVersionFile() {
  const raw = readFileSync(join(ROOT, "VERSION"), "utf8").trim();
  const v = parse(raw);
  if (!v) { console.error(`VERSION is not a recognised app version: ${JSON.stringify(raw)}`); process.exit(2); }
  return v;
}

/** Highest existing tag for the same stage, or null. */
function highestFor(stage) {
  const same = allTags().filter((e) => e.v.stage === stage.toLowerCase());
  if (!same.length) return null;
  return same.sort((a, b) => cmp(a.v, b.v)).at(-1).v;
}

/** Next free version: the highest TAG's module-reference counter + 1.
 *  Deliberately derived from tags, never from /VERSION — /VERSION can be stale or contested.
 *  The `release` field is carried through unchanged: which of the two counters is authoritative is
 *  an open ruling (see VERSIONING.md), and this script must not silently decide it. */
export function nextVersion(stage = "Alpha") {
  const top = highestFor(stage) ?? parse(`${stage} 01.001.0000a`);
  const width = top.ref.length;
  let next = { ...top, ref: String(Number(top.ref) + 1).padStart(width, "0"), rev: "a" };
  const taken = new Set(allTags().map((e) => e.tag));
  while (taken.has(toTag(next))) next = { ...next, ref: String(Number(next.ref) + 1).padStart(width, "0") };
  return next;
}

function checkFree(v, label) {
  const tag = toTag(v);
  const hit = allTags().find((e) => e.tag === tag);
  if (!hit) { console.log(`ok — ${toVersion(v)} is free (${tag} does not exist)`); return 0; }
  const at = git("rev-list", "-1", tag).trim().slice(0, 8);
  console.error(
    `${label} is ALREADY TAKEN: ${tag} exists and points at ${at}.\n` +
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
  process.exit(checkFree(v, `${toVersion(v)}`));
} else if (flag === "--check-file") {
  process.exit(checkFree(readVersionFile(), "/VERSION"));
} else if (flag === "--tag") {
  console.log(toTag(nextVersion()));
} else {
  console.log(toVersion(nextVersion()));
}
