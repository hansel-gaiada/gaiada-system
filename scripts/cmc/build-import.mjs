#!/usr/bin/env node
// Builds the one-off CMC → Client Centre import (docs/plans/2026-09-29-client-centre.md, CC-D2).
//
//   node scripts/cmc/build-import.mjs <cmc-companies.local.json> <erp-clients.local.json> <out-dir> [--origin-site=<site>]
//
// Inputs (both are REAL CLIENT DATA: keep them as *.local.* files or outside the repo, never commit):
//   cmc-companies.local.json  a JSON array of CMC `companies` rows, produced read-only on helios with:
//                             sudo -u postgres psql -d cmc_app -At -c "select json_agg(row_to_json(c) order by name) from companies c"
//   erp-clients.local.json    a JSON array of `{id, tenant_id, name}` for the ERP clients the rows may map to
//
// Outputs in <out-dir>:
//   mapping.local.csv   one line per CMC company: match status, CMC id/name → ERP client id/name. REVIEW IT.
//                       A row is imported only when its status is `auto` or `manual`; edit `status`/`erp_client_id`
//                       by hand and re-run with --mapping=<that file> to apply your review.
//   import.local.sql    one transaction per tenant; sets the RLS tenant GUC, upserts on (tenant_id, client_id),
//                       and is safe to re-run (a re-run overwrites the imported row with the same CMC data).
//   report.local.txt    counts, unmatched companies, dropped unknown keys, credential-looking values.
//
// Nothing here connects to a database. It reads two files and writes three.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const registry = JSON.parse(
  fs.readFileSync(path.join(here, "../../platform-nest/src/modules/clients/centre/registry.json"), "utf8"),
);

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith("--")).map((a) => a.slice(2).split("=")));
const [cmcPath, erpPath, outDir] = args.filter((a) => !a.startsWith("--"));
if (!cmcPath || !erpPath || !outDir) {
  console.error("usage: build-import.mjs <cmc-companies.json> <erp-clients.json> <out-dir> [--origin-site=x] [--mapping=reviewed.csv]");
  process.exit(2);
}
const originSite = flags["origin-site"] ?? "aicenter";

const cmc = JSON.parse(fs.readFileSync(cmcPath, "utf8"));
const erp = JSON.parse(fs.readFileSync(erpPath, "utf8"));

// Same credential patterns the API refuses (plan § Validation). The import REPORTS rather than drops,
// so a human decides; `--drop-secrets` blanks them.
const SECRET_RES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bAKIA[0-9A-Z]{16}\b/, /\bsk-[A-Za-z0-9_-]{16,}/, /\bghp_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/, /\bxox[abp]-[A-Za-z0-9-]{10,}/, /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\b(pass(word)?|pwd)\s*[:=]\s*\S+/i,
];
const looksSecret = (v) => typeof v === "string" && SECRET_RES.some((re) => re.test(v));

const norm = (s) =>
  String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").replace(/\b(pt|cv|ltd|inc|llc|the)\b/g, " ").replace(/\s+/g, " ").trim();

// ── mapping ─────────────────────────────────────────────────────────────────────────────────────────
let mapping;
if (flags.mapping) {
  const lines = fs.readFileSync(flags.mapping, "utf8").trim().split(/\r?\n/).slice(1);
  mapping = lines.map((l) => {
    const [status, cmc_id, cmc_name, erp_client_id, erp_name] = parseCsvLine(l);
    return { status, cmc_id, cmc_name, erp_client_id, erp_name };
  });
} else {
  const byNorm = new Map();
  for (const c of erp) {
    const k = norm(c.name);
    byNorm.set(k, [...(byNorm.get(k) ?? []), c]);
  }
  mapping = cmc.map((row) => {
    const hits = byNorm.get(norm(row.name)) ?? [];
    if (hits.length === 1) return { status: "auto", cmc_id: row.id, cmc_name: row.name, erp_client_id: hits[0].id, erp_name: hits[0].name };
    return {
      status: hits.length > 1 ? "ambiguous" : "unmatched",
      cmc_id: row.id, cmc_name: row.name,
      erp_client_id: hits.map((h) => h.id).join("|"), erp_name: hits.map((h) => h.name).join("|"),
    };
  });
}

// ── transform ───────────────────────────────────────────────────────────────────────────────────────
const report = { imported: 0, skipped: [], unknownKeys: [], secrets: [], badBusinessType: [] };
const fieldKeys = new Set(Object.keys(registry.fields));
const connKeys = new Set(Object.keys(registry.connections));
const sectionIds = new Set(Object.keys(registry.sectionSettings));
const deptIds = new Set([...registry.departments.map((d) => d.id), "ix"]);
const btypes = new Set(registry.businessTypes.map((b) => b.id));
const connSubKeys = new Set(["tool", "account", "url", "owner", "creds", "method", "status", "notes"]);
const erpById = new Map(erp.map((c) => [c.id, c]));

function cleanString(where, v) {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim().slice(0, 5000);
  if (!s) return undefined;
  if (looksSecret(s)) {
    report.secrets.push(where);
    if (flags["drop-secrets"] !== undefined) return undefined;
  }
  return s;
}

const rowsByTenant = new Map();
for (const m of mapping) {
  const row = cmc.find((r) => r.id === m.cmc_id);
  if (!row) { report.skipped.push(`${m.cmc_id}: not in the CMC export`); continue; }
  if (m.status !== "auto" && m.status !== "manual") { report.skipped.push(`${row.name}: ${m.status}`); continue; }
  const target = erpById.get(m.erp_client_id);
  if (!target) { report.skipped.push(`${row.name}: ERP client ${m.erp_client_id} not in the ERP export`); continue; }

  const profile = {};
  for (const [k, v] of Object.entries(row.profile ?? {})) {
    if (!fieldKeys.has(k)) { report.unknownKeys.push(`${row.name}: profile.${k}`); continue; }
    const s = cleanString(`${row.name}: profile.${k}`, v);
    if (s !== undefined) profile[k] = s;
  }
  const customConnections = {};
  const customIds = new Set();
  for (const [sec, list] of Object.entries(row.custom_conns ?? {})) {
    if (!sectionIds.has(sec) || !Array.isArray(list)) { report.unknownKeys.push(`${row.name}: custom_conns.${sec}`); continue; }
    const kept = list
      .filter((x) => x && /^x[a-z0-9]{4,40}$/.test(String(x.id)) && String(x.name ?? "").trim())
      .map((x) => ({ id: String(x.id), name: String(x.name).trim().slice(0, 120) }));
    if (kept.length) { customConnections[sec] = kept; kept.forEach((x) => customIds.add(x.id)); }
  }
  const connections = {};
  for (const [k, entry] of Object.entries(row.connections ?? {})) {
    if (!connKeys.has(k) && !customIds.has(k)) { report.unknownKeys.push(`${row.name}: connections.${k}`); continue; }
    const out = {};
    for (const [sk, sv] of Object.entries(entry ?? {})) {
      if (!connSubKeys.has(sk)) { report.unknownKeys.push(`${row.name}: connections.${k}.${sk}`); continue; }
      if (sk === "method" && !registry.connectionMethods.includes(sv)) continue;
      if (sk === "status" && !registry.connectionStatuses.includes(sv)) continue;
      const s = cleanString(`${row.name}: connections.${k}.${sk}`, sv);
      if (s !== undefined) out[sk] = s;
    }
    if (Object.keys(out).length) connections[k] = out;
  }
  const departments = {};
  for (const [k, v] of Object.entries(row.depts ?? {})) {
    if (!deptIds.has(k)) { report.unknownKeys.push(`${row.name}: depts.${k}`); continue; }
    departments[k] = Boolean(v);
  }
  let businessType = row.business_type ?? "other";
  if (!btypes.has(businessType)) { report.badBusinessType.push(`${row.name}: ${businessType}`); businessType = "other"; }

  const list = rowsByTenant.get(target.tenant_id) ?? [];
  list.push({ clientId: target.id, legacyId: row.id, businessType, profile, connections, departments, customConnections });
  rowsByTenant.set(target.tenant_id, list);
  report.imported++;
}

// ── write ───────────────────────────────────────────────────────────────────────────────────────────
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, "mapping.local.csv"),
  ["status,cmc_id,cmc_name,erp_client_id,erp_name", ...mapping.map((m) => [m.status, m.cmc_id, m.cmc_name, m.erp_client_id, m.erp_name].map(csv).join(","))].join("\n") + "\n",
);

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const jsonLit = (o) => `${lit(JSON.stringify(o))}::jsonb`;
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let sql = `-- CMC → Client Centre import. GENERATED by scripts/cmc/build-import.mjs. Contains REAL client data: never commit.\n\\set ON_ERROR_STOP on\n`;
for (const [tenantId, rows] of rowsByTenant) {
  if (!uuidRe.test(tenantId)) throw new Error(`bad tenant id ${tenantId}`);
  sql += `\nBEGIN;\nSELECT set_config('app.current_tenant_ids', ${lit(tenantId)}, true);\n`;
  for (const r of rows) {
    if (!uuidRe.test(r.clientId)) throw new Error(`bad client id ${r.clientId}`);
    sql += `INSERT INTO client_centre_profiles (tenant_id, client_id, business_type, profile, connections, departments, custom_connections, legacy_cmc_id, origin_site)
VALUES (${lit(tenantId)}, ${lit(r.clientId)}, ${lit(r.businessType)}, ${jsonLit(r.profile)}, ${jsonLit(r.connections)}, ${jsonLit(r.departments)}, ${jsonLit(r.customConnections)}, ${lit(r.legacyId)}, ${lit(originSite)})
ON CONFLICT (tenant_id, client_id) DO UPDATE SET business_type = EXCLUDED.business_type, profile = EXCLUDED.profile,
  connections = EXCLUDED.connections, departments = EXCLUDED.departments, custom_connections = EXCLUDED.custom_connections,
  legacy_cmc_id = EXCLUDED.legacy_cmc_id, revision = client_centre_profiles.revision + 1, updated_at = now();\n`;
  }
  sql += `-- Fail the transaction if RLS silently filtered the upserts (unset GUC => zero rows, no error).\n`;
  sql += `DO $$ BEGIN IF (SELECT count(*) FROM client_centre_profiles WHERE legacy_cmc_id IS NOT NULL) < ${rows.length} THEN RAISE EXCEPTION 'import visible rows below ${rows.length}'; END IF; END $$;\nCOMMIT;\n`;
}
fs.writeFileSync(path.join(outDir, "import.local.sql"), sql);

const txt = [
  `CMC companies: ${cmc.length}   ERP clients offered: ${erp.length}`,
  `mapping: ${Object.entries(mapping.reduce((a, m) => ((a[m.status] = (a[m.status] ?? 0) + 1), a), {})).map(([k, v]) => `${k}=${v}`).join(" ")}`,
  `imported: ${report.imported}`,
  `skipped (${report.skipped.length}):`, ...report.skipped.map((s) => `  ${s}`),
  `unknown keys dropped (${report.unknownKeys.length}):`, ...report.unknownKeys.map((s) => `  ${s}`),
  `credential-looking values (${report.secrets.length})${flags["drop-secrets"] !== undefined ? " — DROPPED" : " — KEPT; re-run with --drop-secrets or fix by hand"}:`, ...report.secrets.map((s) => `  ${s}`),
  `unknown business types → other (${report.badBusinessType.length}):`, ...report.badBusinessType.map((s) => `  ${s}`),
].join("\n");
fs.writeFileSync(path.join(outDir, "report.local.txt"), txt + "\n");
console.log(txt.split("\n").slice(0, 3).join("\n"));

function csv(v) { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function parseCsvLine(line) {
  const out = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur); return out;
}
