#!/usr/bin/env node
// Generates docs/MAP.md — the structural index of this repo.
//
// WHY THIS EXISTS: every hand-maintained status/orientation doc in this program has gone stale
// and then misled someone (the 2026-07-09 root guide is archived in docs/history/ for exactly
// that reason). A map that is DERIVED from the filesystem cannot drift: if it disagrees with the
// repo, regenerating it is the fix, and CI fails when someone forgets.
//
//   node scripts/gen-map.mjs           # write docs/MAP.md
//   node scripts/gen-map.mjs --check   # exit 1 if the file on disk is not what we'd generate
//
// DETERMINISM IS A HARD REQUIREMENT — no dates, no versions, no counts of anything that changes
// without a structural change, everything sorted. The --check mode is a CI gate, so any
// nondeterminism turns into a red build on an unrelated PR. That is also why /VERSION is
// deliberately NOT included: it changes every release and would make this file need a
// regeneration commit per tag.
//
// No dependencies, on purpose (this must run before any npm ci).
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs", "MAP.md");
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage", "__pycache__", "venv", "playwright-report", "test-results"]);

const read = (p) => { try { return readFileSync(join(ROOT, p), "utf8"); } catch { return ""; } };
const has = (p) => existsSync(join(ROOT, p));
const posix = (p) => p.split(sep).join("/");
const esc = (s) => String(s).replace(/\|/g, "\\|");

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(join(ROOT, dir), { withFileTypes: true }); } catch { return out; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith(".") && e.name !== ".github") continue;
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(rel, out); }
    else out.push(rel);
  }
  return out;
}

// ── components ────────────────────────────────────────────────────────────────────────────────
function components() {
  const dirs = readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name))
    .map((e) => e.name)
    .filter((d) => has(`${d}/package.json`) || has(`${d}/go.mod`))
    .sort();

  return dirs.map((d) => {
    const row = { dir: d, kind: "", name: "", entry: "", docker: has(`${d}/Dockerfile`), guide: has(`${d}/CLAUDE.md`) };
    if (has(`${d}/go.mod`)) {
      row.kind = "go";
      row.name = (read(`${d}/go.mod`).match(/^module\s+(\S+)/m) || [, "?"])[1];
      const cmds = existsSync(join(ROOT, d, "cmd"))
        ? readdirSync(join(ROOT, d, "cmd"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => `cmd/${e.name}`).sort()
        : [];
      row.entry = cmds.join(" · ");
    } else {
      row.kind = "node";
      const pkg = JSON.parse(read(`${d}/package.json`) || "{}");
      row.name = pkg.name || "?";
      row.entry = Object.keys(pkg.scripts || {}).filter((s) => ["dev", "start", "run-agent"].includes(s)).sort().join(" · ");
      row.scripts = Object.keys(pkg.scripts || {}).sort();
    }
    return row;
  });
}

// ── compose ───────────────────────────────────────────────────────────────────────────────────
// Line-indent parse, not a YAML implementation: we read only top-level `services:` keys and a
// handful of scalar/sequence children. Anything it cannot parse is simply omitted rather than
// guessed — a blank cell here means "look at the file", never "there is nothing".
// Unquote one scalar and drop a trailing inline `# comment`. Compose ports in this repo carry
// long explanatory comments (`"127.0.0.1:8025:8025" # UI+API — loopback only`), and a naive
// quote-strip drags the whole comment into the table cell.
const scalar = (raw) => {
  let s = String(raw).trim();
  const q = s[0];
  if (q === '"' || q === "'") {
    const end = s.indexOf(q, 1);
    if (end > 0) return s.slice(1, end);
  }
  const c = s.indexOf(" #");
  if (c >= 0) s = s.slice(0, c);
  return s.trim().replace(/^["']|["']$/g, "");
};

function composeServices(file) {
  const text = read(file);
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  const services = [];
  let inServices = false, cur = null, listKey = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line || /^\s*#/.test(line)) continue;
    if (/^services:\s*$/.test(line)) { inServices = true; continue; }
    if (/^\S/.test(line)) { inServices = /^services:/.test(line); cur = null; continue; }
    if (!inServices) continue;
    const m2 = line.match(/^ {2}([A-Za-z0-9_.-]+):\s*$/);
    if (m2) { cur = { name: m2[1], image: "", build: "", profiles: [], ports: [], depends: [] }; services.push(cur); listKey = null; continue; }
    if (!cur) continue;
    const kv = line.match(/^ {4}([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (kv) {
      const [, k, v] = kv;
      listKey = v === "" ? k : null;
      const inline = v.match(/^\[(.*)\]/);
      const vals = inline ? inline[1].split(",").map((s) => scalar(s)).filter(Boolean) : null;
      if (k === "image") cur.image = scalar(v);
      else if (k === "build") cur.build = scalar(v) || "(block)";
      else if (vals && k === "profiles") cur.profiles = vals;
      else if (vals && k === "ports") cur.ports = vals;
      else if (vals && k === "depends_on") cur.depends = vals;
      continue;
    }
    const item = line.match(/^ {6}- (.*)$/);
    if (item && listKey) {
      const v = scalar(item[1]);
      if (listKey === "profiles") cur.profiles.push(v);
      else if (listKey === "ports") cur.ports.push(v);
      else if (listKey === "depends_on") cur.depends.push(v);
      continue;
    }
    const dep = line.match(/^ {6}([A-Za-z0-9_.-]+):\s*$/);
    if (dep && listKey === "depends_on") cur.depends.push(dep[1]);
  }
  return services;
}

// ── platform-nest ─────────────────────────────────────────────────────────────────────────────
function nestModules() {
  const registered = [...read("platform-nest/src/main.ts").matchAll(/registerModule\((\w+)\)/g)].map((m) => m[1]);
  const dirs = existsSync(join(ROOT, "platform-nest/src/modules"))
    ? readdirSync(join(ROOT, "platform-nest/src/modules"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
    : [];
  return dirs.map((d) => {
    const idx = read(`platform-nest/src/modules/${d}/index.ts`);
    const key = (idx.match(/key:\s*["'`]([^"'`]+)["'`]/) || [, ""])[1];
    const varName = (idx.match(/export const (\w+Module)\b/) || [, ""])[1];
    return { dir: d, key, registered: varName ? registered.includes(varName) : false };
  });
}

function controllers() {
  const out = [];
  for (const f of walk("platform-nest/src")) {
    if (!f.endsWith(".controller.ts") || f.endsWith(".test.ts")) continue;
    const text = read(f);
    for (const m of text.matchAll(/@Controller\(\s*(?:["'`]([^"'`]*)["'`])?\s*\)/g)) out.push({ prefix: m[1] ?? "", file: f });
  }
  // One file may declare several controller classes on the same prefix; dedupe so the table
  // never prints an identical row twice as if it were two distinct surfaces.
  const seen = new Set();
  return out
    .filter((c) => { const k = `${c.prefix} ${c.file}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (a.prefix || " ").localeCompare(b.prefix || " ") || a.file.localeCompare(b.file));
}

function migrations() {
  const dir = join(ROOT, "platform-nest", "migrations");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  if (!files.length) return null;
  const nums = files.map((f) => Number(f.slice(0, 4)));
  const head = files[files.length - 1];
  const gaps = [];
  for (let i = nums[0]; i < nums[nums.length - 1]; i++) if (!nums.includes(i)) gaps.push(String(i).padStart(4, "0"));
  return { count: files.length, head, next: String(nums[nums.length - 1] + 1).padStart(4, "0"), gaps };
}

// ── platform-ui routes ────────────────────────────────────────────────────────────────────────
// App-Router path → URL. Route groups `(x)` and parallel slots `@drawer` contribute no URL
// segment, and an intercepting prefix `(.)`/`(..)`/`(...)` is not part of the path either — a
// literal directory listing would print `/@drawer/(.)assistant`, which is not a URL anyone can hit.
const segToUrl = (p) =>
  "/" + p.split("/").filter(Boolean)
    .filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith("@"))
    .map((s) => s.replace(/^\(\.{1,3}\)/, ""))
    .join("/");

function uiRoutes() {
  const routes = [];
  for (const f of walk("platform-ui/src/app")) {
    const m = f.match(/^platform-ui\/src\/app\/(.*)page\.tsx$/);
    if (!m) continue;
    const url = segToUrl(m[1]);
    routes.push({ url: url === "/" ? "/" : url.replace(/\/$/, ""), file: f });
  }
  const api = [];
  for (const f of walk("platform-ui/src/app")) {
    const m = f.match(/^platform-ui\/src\/app\/(.*)route\.ts$/);
    if (!m) continue;
    api.push(segToUrl(m[1]));
  }
  return { routes: routes.sort((a, b) => a.url.localeCompare(b.url)), api: [...new Set(api)].sort() };
}

// ── n8n workflows ─────────────────────────────────────────────────────────────────────────────
function workflows() {
  const dir = join(ROOT, "automation", "workflows");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => {
    let j = {};
    try { j = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { /* listed with blanks */ }
    return { file: f, id: j.id || "", name: j.name || "" };
  });
}

// ── docs ──────────────────────────────────────────────────────────────────────────────────────
// MAP.md excludes ITSELF from the docs listing: it lives in docs/, so including it would make the
// first generation differ from the second and --check would never converge.
const listFiles = (dir, ext) => {
  const p = join(ROOT, dir);
  if (!existsSync(p) || !statSync(p).isDirectory()) return [];
  return readdirSync(p).filter((f) => f.endsWith(ext) && !(dir === "docs" && f === "MAP.md")).sort();
};

// ── render ────────────────────────────────────────────────────────────────────────────────────
function render() {
  const L = [];
  const w = (s = "") => L.push(s);

  w("# Repo map — GENERATED, do not edit by hand");
  w();
  w("> Regenerate with `node scripts/gen-map.mjs`. CI (`docs-map` job) fails if this file does not");
  w("> match the repo, so it cannot go stale — if it disagrees with what you see, regenerate, don't");
  w("> patch. Deliberately structural only: no versions, no status, no counts that move on their own.");
  w("> Status lives in `docs/modules/MODULES.md`; rules live in the per-component `CLAUDE.md` files.");
  w();

  w("## Components");
  w();
  w("| Dir | Kind | Module / package | Entrypoints | Dockerfile | CLAUDE.md |");
  w("|---|---|---|---|---|---|");
  const comps = components();
  for (const c of comps) w(`| \`${c.dir}/\` | ${c.kind} | \`${esc(c.name)}\` | ${c.entry ? `\`${esc(c.entry)}\`` : "—"} | ${c.docker ? "yes" : "—"} | ${c.guide ? "yes" : "**missing**"} |`);
  w();
  w("Node scripts per component:");
  w();
  for (const c of comps.filter((x) => x.kind === "node")) w(`- \`${c.dir}\` — ${c.scripts.map((s) => `\`${s}\``).join(", ")}`);
  w();

  const files = ["docker-compose.vps.yml", "docker-compose.local.yml", "docker-compose.hostdata.yml", "docker-compose.observability.yml", "docker-compose.build.yml"];
  w("## Compose");
  w();
  w("All compose files in `infra/compose/`: " + listFiles("infra/compose", ".yml").map((f) => `\`${f}\``).join(", ") + ".");
  w("Never run one alone — see `infra/CLAUDE.md` for the required pairs.");
  w();
  for (const f of files) {
    const svcs = composeServices(`infra/compose/${f}`);
    if (!svcs || !svcs.length) continue;
    w(`### \`infra/compose/${f}\``);
    w();
    w("| Service | Image / build | Profiles | Ports | depends_on |");
    w("|---|---|---|---|---|");
    for (const s of svcs.sort((a, b) => a.name.localeCompare(b.name))) {
      w(`| \`${s.name}\` | ${esc(s.image || s.build || "—")} | ${s.profiles.map((p) => `\`${p}\``).join(" ") || "—"} | ${s.ports.map((p) => `\`${esc(p)}\``).join(" ") || "—"} | ${s.depends.join(", ") || "—"} |`);
    }
    w();
  }

  w("## platform-nest — modules");
  w();
  w("| Dir | Contract key | Registered in `main.ts` |");
  w("|---|---|---|");
  for (const m of nestModules()) w(`| \`${m.dir}\` | ${m.key ? `\`${m.key}\`` : "—"} | ${m.registered ? "yes" : "—"} |`);
  w();

  const mig = migrations();
  if (mig) {
    w("## platform-nest — migrations");
    w();
    w(`- Head: \`${mig.head}\``);
    w(`- Next free number: \`${mig.next}\` — **reserve it by creating the file**, concurrent sessions share this checkout.`);
    w(`- Applied files on disk: ${mig.count}`);
    w(`- Unused numbers below head: ${mig.gaps.length ? mig.gaps.map((g) => `\`${g}\``).join(", ") + " (dead reservations — do not backfill)" : "none"}`);
    w();
  }

  w("## platform-nest — HTTP surface (`@Controller` prefixes)");
  w();
  w("| Prefix | File |");
  w("|---|---|");
  for (const c of controllers()) w(`| ${c.prefix ? `\`/${c.prefix}\`` : "_(root)_"} | \`${c.file}\` |`);
  w();

  const ui = uiRoutes();
  w("## platform-ui — routes");
  w();
  w(`Pages (\`page.tsx\`), route groups \`(x)\` stripped:`);
  w();
  for (const r of ui.routes) w(`- \`${r.url}\``);
  w();
  if (ui.api.length) {
    w("Browser-facing route handlers (`route.ts`) — these exist only where the browser itself must hit a URL:");
    w();
    for (const a of ui.api) w(`- \`${a}\``);
    w();
  }

  const wf = workflows();
  if (wf.length) {
    w("## automation — n8n workflows");
    w();
    w("Declared `id` is load-bearing (sub-workflow references). Import with the CLI, never the public API — see `automation/CLAUDE.md`.");
    w();
    w("| File | Declared id | Name |");
    w("|---|---|---|");
    for (const x of wf) w(`| \`${x.file}\` | ${x.id ? `\`${x.id}\`` : "—"} | ${esc(x.name || "—")} |`);
    w();
  }

  w("## Docs, runbooks, guides");
  w();
  w("Contracts + top-level docs (`docs/`): " + listFiles("docs", ".md").map((f) => `\`${f}\``).join(", "));
  w();
  w("Runbooks (`infra/runbooks/`): " + listFiles("infra/runbooks", ".md").map((f) => `\`${f}\``).join(", "));
  w();
  w("Ops scripts (`infra/scripts/`): " + listFiles("infra/scripts", ".sh").map((f) => `\`${f}\``).join(", "));
  w();
  // Walk for these rather than deriving from `comps` — `infra/` and `automation/` carry a guide
  // but have no package.json/go.mod, so they'd be silently missing from a component-derived list.
  const guides = ["CLAUDE.md", ...walk("").filter((f) => f.endsWith("/CLAUDE.md"))].sort();
  w("Component guides: " + guides.map((g) => `\`${g}\``).join(", "));
  w();

  return L.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

const next = render();
if (process.argv.includes("--check")) {
  const cur = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (cur !== next) {
    console.error(`docs/MAP.md is out of date. Run: node scripts/gen-map.mjs`);
    process.exit(1);
  }
  console.log("docs/MAP.md is up to date.");
} else {
  writeFileSync(OUT, next);
  console.log(`wrote ${posix(relative(ROOT, OUT))} (${next.length} bytes)`);
}
