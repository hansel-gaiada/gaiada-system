#!/usr/bin/env node
// WSK-69 — "what can this change affect?" planner, shared by ci.yml and release.yml.
//
//   node scripts/ci/plan.mjs ci      --base <sha> [--head HEAD] [--all]
//   node scripts/ci/plan.mjs release --tag <tag> --owner <ghcr-owner> [--head HEAD] [--all]
//
// Dependency-free (node + git; `release` also shells out to `docker buildx imagetools`). Pure
// decision logic is exported and unit-tested in plan.test.mjs; the CLI only wires git/docker in.
//
// SAFETY STANCE: every uncertainty resolves to "run / rebuild". Unknown diff base, base commit not
// in the clone, no previous release tag, previous image missing or unsigned, a shared input
// changed, previous image too old: all of those run everything / rebuild the component.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import * as cfg from "./config.mjs";

export const matches = (file, prefixes) => prefixes.some((p) => file.startsWith(p));

/**
 * CI plan. `files` is the changed-file list, or null when the diff base is unknown (=> run all).
 * Returns { outputs: {group: boolean, any_*: boolean}, reasons: {group: string} }.
 */
export function planCi({ files, forceAll = false, groups = cfg.CI_GROUPS, shared = cfg.CI_SHARED }) {
  const outputs = {};
  const reasons = {};
  const sharedHit = files ? files.find((f) => matches(f, shared)) : undefined;
  for (const [name, prefixes] of Object.entries(groups)) {
    if (forceAll) { outputs[name] = true; reasons[name] = "forced (dispatch / --all)"; continue; }
    if (!files) { outputs[name] = true; reasons[name] = "diff base unknown -> run everything"; continue; }
    if (sharedHit) { outputs[name] = true; reasons[name] = `shared CI input changed: ${sharedHit}`; continue; }
    const hit = files.find((f) => matches(f, prefixes));
    outputs[name] = Boolean(hit);
    reasons[name] = hit ? `changed: ${hit}` : "no relevant change -> skipped";
  }
  outputs.any_test = ["wa_chat_bot", "mcp_hub", "ai_agents", "report_renderer"].some((k) => outputs[k]);
  outputs.any_webdesk_light = ["webdesk_root", "webdesk_blocks", "webdesk_deploy"].some((k) => outputs[k]);
  return { outputs, reasons };
}

/**
 * Release plan. Ports (all injectable for tests):
 *   git.releaseTags(head, excludeTag) -> [{tag, commit, dateMs}] newest first
 *   git.diffFiles(baseCommit, head)   -> string[]
 *   git.pathExists(head, path)        -> boolean
 *   registry.signedDigest(component, tag) -> "sha256:..." | null   (image + .sig + .att all present)
 * Returns { build: string[], retag: [{component, fromTag, digest}], removed: string[], reasons }.
 */
export function planRelease({
  head, currentTag, forceAll = false, now = Date.now(), git, registry,
  components = cfg.COMPONENTS, shared = cfg.RELEASE_SHARED,
  maxAgeDays = cfg.MAX_REUSE_AGE_DAYS, maxCandidates = cfg.MAX_CANDIDATE_TAGS,
}) {
  const build = []; const retag = []; const removed = []; const reasons = {};
  const candidates = forceAll ? [] : git.releaseTags(head, currentTag).slice(0, maxCandidates);
  const diffCache = new Map();
  const diff = (c) => { if (!diffCache.has(c)) diffCache.set(c, git.diffFiles(c, head)); return diffCache.get(c); };

  for (const comp of components) {
    if (!git.pathExists(head, comp.path)) {
      removed.push(comp.name);
      reasons[comp.name] = `build context ${comp.path} does not exist at HEAD -> not built, not re-tagged (remove it from scripts/ci/config.mjs)`;
      continue;
    }
    if (forceAll) { build.push(comp.name); reasons[comp.name] = "forced (force_all)"; continue; }
    if (candidates.length === 0) { build.push(comp.name); reasons[comp.name] = "no previous release tag -> first release builds everything"; continue; }

    let base = null; let digest = null;
    for (const cand of candidates) {
      digest = registry.signedDigest(comp.name, cand.tag);
      if (digest) { base = cand; break; }
    }
    if (!base) { build.push(comp.name); reasons[comp.name] = `no signed previous image in the last ${candidates.length} release tags`; continue; }

    const ageDays = (now - base.dateMs) / 86400000;
    if (ageDays > maxAgeDays) { build.push(comp.name); reasons[comp.name] = `previous image (${base.tag}) is ${Math.floor(ageDays)}d old > ${maxAgeDays}d -> rebuild to refresh base image`; continue; }

    const files = diff(base.commit);
    const sharedHit = files.find((f) => matches(f, shared));
    if (sharedHit) { build.push(comp.name); reasons[comp.name] = `shared input changed since ${base.tag}: ${sharedHit}`; continue; }
    const hit = files.find((f) => f.startsWith(comp.path));
    if (hit) { build.push(comp.name); reasons[comp.name] = `changed since ${base.tag}: ${hit}`; continue; }

    retag.push({ component: comp.name, fromTag: base.tag, digest });
    reasons[comp.name] = `unchanged since ${base.tag} -> re-tag ${digest.slice(0, 19)}`;
  }
  return { build, retag, removed, reasons };
}

// ---------------------------------------------------------------- real adapters (CLI only)

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...opts });
}

export function gitAdapter(cwd = process.cwd()) {
  const git = (...a) => run("git", a, { cwd });
  return {
    commitExists: (sha) => { try { git("rev-parse", "--verify", "--quiet", `${sha}^{commit}`); return true; } catch { return false; } },
    diffFiles: (base, head) => git("diff", "--name-only", "--no-renames", "-z", base, head).split("\0").filter(Boolean),
    pathExists: (head, p) => { try { git("cat-file", "-e", `${head}:${p.replace(/\/$/, "")}`); return true; } catch { return false; } },
    releaseTags: (head, exclude) => {
      const out = git("for-each-ref", "--merged", head, "--sort=-creatordate",
        "--format=%(refname:short)\t%(creatordate:unix)", "refs/tags");
      return out.split("\n").filter(Boolean).map((l) => l.split("\t"))
        .filter(([tag]) => cfg.RELEASE_TAG_RE.test(tag) && tag !== exclude)
        .map(([tag, ts]) => ({ tag, dateMs: Number(ts) * 1000, commit: git("rev-parse", `${tag}^{commit}`).trim() }));
    },
  };
}

export function dockerRegistryAdapter(owner) {
  const ref = (c, t) => `ghcr.io/${owner}/gaiada-${c}:${t}`;
  const inspect = (r) => {
    try {
      const m = JSON.parse(run("docker", ["buildx", "imagetools", "inspect", r, "--format", "{{json .Manifest}}"]));
      return m.digest || null;
    } catch { return null; }
  };
  return {
    // The image must exist AND carry cosign's signature + attestation tags: a release that died
    // between push and sign leaves an image deploy.yml would refuse.
    signedDigest(component, tag) {
      const digest = inspect(ref(component, tag));
      if (!digest) return null;
      const stem = `sha256-${digest.replace(/^sha256:/, "")}`;
      return inspect(ref(component, `${stem}.sig`)) && inspect(ref(component, `${stem}.att`)) ? digest : null;
    },
  };
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") o.all = true;
    else if (a.startsWith("--")) o[a.slice(2)] = argv[++i];
    else o._.push(a);
  }
  return o;
}

function emit(kv) {
  const text = Object.entries(kv).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n") + "\n";
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, text);
  else process.stdout.write(`--- outputs ---\n${text}`);
}

function summary(title, rows) {
  const md = `### ${title}\n\n| item | decision |\n|---|---|\n${rows.map(([k, v]) => `| ${k} | ${v} |`).join("\n")}\n`;
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
  process.stdout.write(rows.map(([k, v]) => `${k.padEnd(18)} ${v}`).join("\n") + "\n");
}

export function main(argv) {
  const [cmd] = argv;
  const o = parseArgs(argv.slice(1));
  const head = o.head || "HEAD";
  const git = gitAdapter();

  if (cmd === "ci") {
    let files = null;
    if (!o.all && o.base && git.commitExists(o.base)) files = git.diffFiles(o.base, head);
    else if (!o.all) console.log(`diff base '${o.base || ""}' unavailable -> running everything`);
    const { outputs, reasons } = planCi({ files, forceAll: Boolean(o.all) });
    emit(outputs);
    summary("CI plan", Object.entries(reasons).map(([k, v]) => [k, `${outputs[k] ? "RUN" : "skip"} — ${v}`]));
    return 0;
  }

  if (cmd === "release") {
    if (!o.tag || !o.owner) { console.error("release: --tag and --owner are required"); return 2; }
    const headSha = run("git", ["rev-parse", head]).trim();
    const plan = planRelease({
      head: headSha, currentTag: o.tag, forceAll: Boolean(o.all), git, registry: dockerRegistryAdapter(o.owner),
    });
    emit({ build: plan.build, retag: plan.retag, has_build: String(plan.build.length > 0), has_retag: String(plan.retag.length > 0) });
    summary("Release plan", [
      ...plan.build.map((c) => [c, `BUILD — ${plan.reasons[c]}`]),
      ...plan.retag.map((r) => [r.component, `RE-TAG — ${plan.reasons[r.component]}`]),
      ...plan.removed.map((c) => [c, `REMOVED — ${plan.reasons[c]}`]),
    ]);
    return 0;
  }

  console.error("usage: plan.mjs ci --base <sha> [--head HEAD] [--all] | release --tag <tag> --owner <owner> [--head HEAD] [--all]");
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(main(process.argv.slice(2)));
