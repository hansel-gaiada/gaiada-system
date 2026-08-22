// SM-70 — Gaia Nexus harvest importer (docs/plans/2026-08-13-gaia-nexus-harvest.md §4 H1, §5 SM-70).
// Imports the real audit + SEO Markdown corpus harvested from the (decommissioned) Gaia Nexus repo
// into `search_audits` + `search_audit_findings`, plus best-effort RAG ingest into the WS8 knowledge
// store. Direct DB inserts via withGlobal/withTenants — same idiom as src/seed/search.ts and
// src/seed/agency.ts — NOT the HTTP ingest controller: that endpoint's `INGESTABLE_SOURCES` only
// understands the crawler's Report shape (see search-audit.ts's AUDIT_SOURCES comment), and this
// corpus is analyst-authored prose with no such shape.
//
// IDEMPOTENT BY CONSTRUCTION, not by a separate "already ran" flag: every write below is either
// `ON CONFLICT ... DO NOTHING` (properties, audits) keyed off a real uniqueness constraint already in
// the schema (0034's `UNIQUE (tenant_id, client_id, domain)`, 0045's `UNIQUE (tenant_id, property_id,
// kind, report_hash)`), or a find-before-insert lookup (clients — no natural unique key exists there
// yet, see the README section below). A second run over an UNCHANGED source directory inserts zero
// new rows; a run over a source directory where files changed inserts only the changed ones (their
// report_hash differs) and leaves the old rows in place — this is a harvest, not a sync, so history
// is additive-only by design (nothing here deletes or supersedes a prior audit row).
//
// Run: NEXUS_SOURCE_DIR=/path/to/gaia-nexus/clone DATABASE_URL=... tsx src/seed/nexus-import.ts
// (NOBYPASSRLS app role in real envs, same as every other seed in this directory).
//
// ── WHAT THIS DOES NOT DO (read before extending) ───────────────────────────────────────────────
// - Does not create/verify a `files` row or write bytes to the storage backache for a "raw export"
//   artifact (search_audits.report_file_id stays NULL for every imported row). The full source
//   Markdown is preserved losslessly instead in `search_audits.summary.rawMarkdown` (jsonb), which
//   costs nothing and needs no storage-backend wiring. Wiring an actual blob artifact through `files`
//   is a reasonable follow-up once there is a decision on the storage path for import-script output;
//   it is not attempted here.
// - Does not emit `search.audit.completed` / `search.audit.regression` events (unlike the SM-08 HTTP
//   ingest path). These are 63-year-old-on-import-day historical audits, not new work landing today;
//   firing "audit completed" events for 126 rows in one batch would be indistinguishable, to every
//   downstream notification/rollup consumer, from 126 real audits having just finished. If a future
//   ticket wants the regression-diff pipeline to run over this history, that is a deliberate,
//   separate decision (and SM-08's diffAudits() already exists to do it) — not a side effect of a
//   backfill script.
// - Does not decide the two open questions in the harvest plan §10 for real production data: whether
//   `search_properties` needs a client FK at all for a solo agency-as-tenant model, and whether
//   `clients` needs a first-class `is_internal` boolean. This script uses `clients.custom_fields` as
//   a NON-SCHEMA-CHANGING stand-in (`{nexus_domain, source: 'nexus-import'}`) so a THROWAWAY test run
//   can proceed without an unreviewed core-table migration; see the module README / harvest report
//   for why an `is_internal` column is a bigger, cross-cutting (billing-touching) decision that
//   belongs with an architect/senior-db ruling, not a script default.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { newId, withGlobal, withTenants, closePool } from "../db";
import { config } from "../config";
import { migrate } from "../db/migrate";
import { parseTechnicalAudit, parseSeoAnalysis, type NexusParsedDoc } from "../modules/search/nexus-import-parser";
import { ingestPropertyKnowledge } from "../modules/search/knowledge-client";
import { chunkText } from "../modules/knowledge/ingest/chunk";

const site = () => config.originSite;

export interface ImportSummary {
  domainsSeen: number;
  clientsCreated: number;
  clientsExisting: number;
  propertiesCreated: number;
  propertiesExisting: number;
  auditsInserted: number;
  auditsSkippedDuplicate: number;
  findingsInserted: number;
  /** Chunks handed to `ingestPropertyKnowledge` for NEWLY inserted audits. `ingestPropertyKnowledge`
   *  is deliberately fail-soft (module header) and returns void, so this counts DISPATCH attempts,
   *  not confirmed writes — see `ragServiceConfigured` below. Reporting this as "ingested" without
   *  that caveat would be exactly the "successful-looking run, zero rows, no error" trap this
   *  codebase has been bitten by before: when `KNOWLEDGE_URL` is unset the underlying call short-
   *  circuits before any HTTP request is made at all, and this number would still look nonzero. */
  ragChunksAttempted: number;
  /** Whether `KNOWLEDGE_URL`/`KNOWLEDGE_SERVICE_TOKEN` were set for THIS run — false means every
   *  `ragChunksAttempted` above was a guaranteed no-op (the WS8 knowledge service was never called),
   *  not a best-effort attempt that may have failed. Check this before trusting the count above. */
  ragServiceConfigured: boolean;
  parseWarnings: string[];
  skippedFiles: string[]; // e.g. the seo-work-scope planning doc — not a per-property document
  /** Asserted post-run counts (the hard rule: never trust a "successful-looking" write without
   *  reading the row count back under an explicit tenant context — see platform-nest/CLAUDE.md's
   *  RLS-zero-rows trap). */
  assertedAuditRowCount: number;
  assertedFindingRowCount: number;
}

function emptySummary(): ImportSummary {
  return {
    domainsSeen: 0, clientsCreated: 0, clientsExisting: 0, propertiesCreated: 0, propertiesExisting: 0,
    auditsInserted: 0, auditsSkippedDuplicate: 0, findingsInserted: 0, ragChunksAttempted: 0,
    ragServiceConfigured: !!(config.services.knowledge.url && config.services.knowledge.token),
    parseWarnings: [], skippedFiles: [], assertedAuditRowCount: 0, assertedFindingRowCount: 0,
  };
}

async function ensureClient(tenantId: string, domain: string, summary: ImportSummary): Promise<string> {
  const found = await withTenants(
    [tenantId],
    (c) => c.query<{ id: string }>(
      `SELECT id FROM clients WHERE tenant_id = $1 AND custom_fields->>'nexus_domain' = $2 AND deleted_at IS NULL LIMIT 1`,
      [tenantId, domain],
    ),
  );
  if (found.rows[0]) {
    summary.clientsExisting += 1;
    return found.rows[0].id;
  }
  const id = newId();
  await withTenants(
    [tenantId],
    (c) => c.query(
      `INSERT INTO clients (id, tenant_id, name, custom_fields, origin_site)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, tenantId, domain, JSON.stringify({ nexus_domain: domain, source: "nexus-import" }), site()],
    ),
  );
  summary.clientsCreated += 1;
  return id;
}

async function ensureProperty(tenantId: string, clientId: string, domain: string, summary: ImportSummary): Promise<string> {
  const id = newId();
  const insertRes = await withTenants(
    [tenantId],
    (c) => c.query<{ id: string }>(
      `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url, status, origin_site)
       VALUES ($1, $2, $3, $4, $5, 'active', $6)
       ON CONFLICT (tenant_id, client_id, domain) DO NOTHING
       RETURNING id`,
      [id, tenantId, clientId, domain, `https://${domain}`, site()],
    ),
    { modules: ["search"] },
  );
  if (insertRes.rows[0]) {
    summary.propertiesCreated += 1;
    return insertRes.rows[0].id;
  }
  summary.propertiesExisting += 1;
  const existing = await withTenants(
    [tenantId],
    (c) => c.query<{ id: string }>(
      `SELECT id FROM search_properties WHERE tenant_id = $1 AND client_id = $2 AND domain = $3`,
      [tenantId, clientId, domain],
    ),
    { modules: ["search"] },
  );
  return existing.rows[0].id;
}

/** One audit row (+ its findings, + best-effort RAG ingest) for one parsed document. Returns true
 *  iff a NEW row was inserted (false on an idempotent re-run hitting the report_hash conflict). */
async function importOneDoc(tenantId: string, propertyId: string, doc: NexusParsedDoc, summary: ImportSummary): Promise<boolean> {
  const startedAt = doc.auditedAt ?? new Date().toISOString();
  const auditId = newId();
  const insertRes = await withTenants(
    [tenantId],
    (c) => c.query<{ id: string }>(
      `INSERT INTO search_audits
         (id, tenant_id, property_id, kind, source, status, score, summary, started_at, completed_at, report_hash, origin_site)
       VALUES ($1,$2,$3,$4,'nexus-import','completed',$5,$6,$7,$7,$8,$9)
       ON CONFLICT (tenant_id, property_id, kind, report_hash) DO NOTHING
       RETURNING id`,
      [auditId, tenantId, propertyId, doc.kind, doc.score, JSON.stringify(doc.summary), startedAt, doc.reportHash, site()],
    ),
    { modules: ["search"] },
  );
  if (!insertRes.rows[0]) {
    summary.auditsSkippedDuplicate += 1;
    return false;
  }
  summary.auditsInserted += 1;

  await withTenants(
    [tenantId],
    async (c) => {
      for (const f of doc.findings) {
        await c.query(
          `INSERT INTO search_audit_findings
             (id, tenant_id, audit_id, code, severity, category, message, url_count, sample_urls, status,
              first_seen_audit_id, last_seen_audit_id, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'open',$10,$10,$11)`,
          [newId(), tenantId, auditId, f.code, f.severity, f.category, f.message, f.urlCount, JSON.stringify(f.sampleUrls), auditId, site()],
        );
        summary.findingsInserted += 1;
      }
    },
    { modules: ["search"] },
  );

  // Best-effort RAG ingest (fail-soft by construction — see knowledge-client.ts). Full raw Markdown,
  // not just the extracted findings, so a retrieval hit can quote the analyst's own prose.
  const rawMarkdown = String((doc.summary as { rawMarkdown?: unknown }).rawMarkdown ?? "");
  const chunks = chunkText(rawMarkdown);
  if (chunks.length > 0) {
    await ingestPropertyKnowledge(tenantId, `search-property:${propertyId}:nexus-audit:${doc.kind}`, propertyId, chunks);
    summary.ragChunksAttempted += chunks.length;
  }
  return true;
}

/** Every `<domain>.md` in `dir`, keyed by domain (filename without `.md`). */
function readMarkdownDir(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    out.set(basename(name, ".md"), readFileSync(join(dir, name), "utf8"));
  }
  return out;
}

/**
 * Imports every `docs/audits/<domain>.md` (+ its `docs/seo/<domain>.md` counterpart, when present)
 * under `sourceDir` into `tenantId`. The AUDITS directory is the master domain list on purpose: the
 * SEO directory carries one extra non-per-property planning document in the real corpus
 * (`seo-work-scope-20-sites.md`, a scope-planning doc, not a site analysis) which this driving order
 * naturally excludes rather than needing a hand-maintained skip-list.
 */
export async function importNexusDocuments(sourceDir: string, tenantId: string): Promise<ImportSummary> {
  const summary = emptySummary();
  const auditFiles = readMarkdownDir(join(sourceDir, "docs", "audits"));
  const seoFiles = readMarkdownDir(join(sourceDir, "docs", "seo"));

  for (const [domain, markdown] of auditFiles) {
    summary.domainsSeen += 1;
    const clientId = await ensureClient(tenantId, domain, summary);
    const propertyId = await ensureProperty(tenantId, clientId, domain, summary);

    const techDoc = parseTechnicalAudit(domain, markdown);
    summary.parseWarnings.push(...techDoc.warnings.map((w) => `${domain} (technical): ${w}`));
    await importOneDoc(tenantId, propertyId, techDoc, summary);

    const seoMd = seoFiles.get(domain);
    if (seoMd) {
      const seoDoc = parseSeoAnalysis(domain, seoMd);
      summary.parseWarnings.push(...seoDoc.warnings.map((w) => `${domain} (content): ${w}`));
      await importOneDoc(tenantId, propertyId, seoDoc, summary);
    }
  }

  for (const name of seoFiles.keys()) {
    if (!auditFiles.has(name)) summary.skippedFiles.push(`docs/seo/${name}.md (no matching docs/audits/${name}.md — not a per-property document)`);
  }

  // The hard rule: assert a row count under an explicit tenant + module context rather than trusting
  // that the loop above "looked successful" — an unset GUC or a missing `{modules:['search']}` reads
  // back ZERO rows with no error (platform-nest/CLAUDE.md's RLS-zero-rows trap), which is exactly the
  // failure mode a bare "it ran without throwing" would miss.
  const auditCount = await withTenants(
    [tenantId],
    (c) => c.query<{ n: string }>(`SELECT count(*)::int n FROM search_audits WHERE tenant_id = $1 AND source = 'nexus-import'`, [tenantId]),
    { modules: ["search"] },
  );
  summary.assertedAuditRowCount = Number(auditCount.rows[0].n);
  const findingCount = await withTenants(
    [tenantId],
    (c) => c.query<{ n: string }>(
      `SELECT count(*)::int n FROM search_audit_findings f JOIN search_audits a ON a.id = f.audit_id
       WHERE f.tenant_id = $1 AND a.source = 'nexus-import'`,
      [tenantId],
    ),
    { modules: ["search"] },
  );
  summary.assertedFindingRowCount = Number(findingCount.rows[0].n);

  return summary;
}

async function resolveGdaTenant(): Promise<string | null> {
  const found = await withGlobal((c) =>
    c.query<{ id: string }>(`SELECT id FROM companies WHERE name = $1 AND type = 'agency' AND deleted_at IS NULL LIMIT 1`, ["Gaia Digital Agency"]),
  );
  return found.rows[0]?.id ?? null;
}

if (require.main === module) {
  (async () => {
    const sourceDir = process.env.NEXUS_SOURCE_DIR;
    if (!sourceDir) {
      console.error("NEXUS_SOURCE_DIR is required (path to a local clone of the gaia-nexus repo).");
      process.exit(1);
    }
    await migrate();
    const tenantId = await resolveGdaTenant();
    if (!tenantId) {
      console.error('Tenant "Gaia Digital Agency" not found. Run seed:agency first.');
      await closePool();
      process.exit(1);
    }
    const summary = await importNexusDocuments(sourceDir as string, tenantId);
    console.log(JSON.stringify(summary, null, 2));
    await closePool();
    process.exit(0);
  })().catch((e) => { console.error(e); process.exit(1); });
}
