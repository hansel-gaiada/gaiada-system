// SM-70 — DB-backed idempotency test for the Gaia Nexus harvest importer. Same LIVE-Postgres harness
// as search-audit.test.ts (SM-08): real RLS is exercised, not mocked. Writes small synthetic Markdown
// fixtures to a temp directory shaped exactly like the real `gaia-nexus` clone
// (`docs/audits/<domain>.md`, `docs/seo/<domain>.md`) rather than depending on the external, private
// gaia-nexus repo being clone-able in CI — nexus-import-parser.test.ts already covers real-corpus
// field-mapping edge cases against inlined excerpts of the actual files.
//
// THE MUST HOLD (per the harvest ticket): re-running the importer over an UNCHANGED source directory
// must not duplicate rows. That is asserted here by running `importNexusDocuments` TWICE against the
// same fixtures and comparing the DB's own row counts (read back under an explicit tenant + module
// context — never trusted from the loop's own bookkeeping alone).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTenants } from "../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany } from "../testing/fixtures";
import { importNexusDocuments } from "./nexus-import";

const SITE_A_TECH = `# Technical Audit — site-a.test

> **In plain terms (for the team):** A minor caching conflict is slowing this site down.

**Server:** ce01 · **Audited:** 2026-06-01 · **Status:** live

## Verified signals
- HTTP/redirects: 200 direct.

## Technical findings
| Area | Finding | Severity |
|---|---|---|
| Performance | Two caching plugins active. | High |
| Hygiene | Stray file in theme dir. | Med |
| Theme bloat | Old theme variants on disk. | Low |

## Could not verify
- CWV field data.

## Top technical fixes (analysis only — NOT executed)
1. Pick one caching plugin.
`;

const SITE_A_SEO = `# SEO Analysis — site-a.test

> **In plain terms (for the team):** Good branded traffic, room to grow informational content.

**Analysed:** 2026-06-01 · **Semrush DB:** id · **Status:** live

## Search profile (Semrush)
- Keywords / Traffic / Rank / Ads:
  - Domain: site-a.test
  - Rank: 12345
  - Organic Keywords: 400
  - Organic Traffic: 900
  - Organic Cost: 50
  - Adwords Keywords: 0
- Top organic keywords:
  - site a brand (Position: 1, Search Volume: 200, Traffic (%): 40.00)

## GSC performance
- GSC: not available this run.

## Search/content issues
- Weak positions for a high-volume informational keyword.

## Meta-rewrite proposals
| Page | Issue | Proposed angle | Why |
|---|---|---|---|
| Homepage | Improve branded CTR | Site A: Better Title | Reinforces brand. |

## Work plan (analysis only — NOT executed)
- Blog: Expand informational content.
`;

const SITE_B_TECH = `# Technical Audit — site-b.test

> **In plain terms (for the team):** Domain is parked; nothing is being served.

**Server:** hostinger · **Audited:** 2026-06-02 · **Status:** parked

## Verified signals
- HTTP/redirects: parking lander.

## Technical findings
| Area | Finding | Severity |
|---|---|---|
| DNS / hosting | Domain parked. | High |

## Could not verify (no access)
- Everything behind the parking lander.

## Top technical fixes (analysis only — NOT executed)
1. Repoint DNS.
`;

// This mirrors the ONE real off-list file found in the actual corpus survey
// (`docs/seo/seo-work-scope-20-sites.md`) — a portfolio scope-planning doc with no matching
// `docs/audits/<name>.md`, which the importer must report as skipped, not silently absorb as if it
// were a per-property SEO analysis.
const SCOPE_PLANNING_DOC = `# SEO work scope — 3 sites

## Tier 1 — Deep work
- site-a.test
`;

function writeFixtureCorpus(root: string): void {
  mkdirSync(join(root, "docs", "audits"), { recursive: true });
  mkdirSync(join(root, "docs", "seo"), { recursive: true });
  writeFileSync(join(root, "docs", "audits", "site-a.test.md"), SITE_A_TECH);
  writeFileSync(join(root, "docs", "seo", "site-a.test.md"), SITE_A_SEO);
  writeFileSync(join(root, "docs", "audits", "site-b.test.md"), SITE_B_TECH);
  writeFileSync(join(root, "docs", "seo", "not-a-property.test.md"), SCOPE_PLANNING_DOC);
}

describe.skipIf(!TEST_URL)("SM-70 nexus-import — DB-backed idempotent import", () => {
  let tenantId: string;
  let sourceDir: string;

  beforeAll(async () => {
    await initTestDb();
    tenantId = await createCompany("SM70 Nexus Import Co", ["search"]);
    sourceDir = mkdtempSync(join(tmpdir(), "nexus-import-test-"));
    writeFixtureCorpus(sourceDir);
  });

  afterAll(async () => {
    await teardownTestDb();
    rmSync(sourceDir, { recursive: true, force: true });
  });

  it("first run: creates clients/properties/audits/findings and reports an accurate summary", async () => {
    const summary = await importNexusDocuments(sourceDir, tenantId);

    expect(summary.domainsSeen).toBe(2); // site-a.test, site-b.test (audits dir is the master list)
    expect(summary.clientsCreated).toBe(2);
    expect(summary.propertiesCreated).toBe(2);
    // site-a: technical (3 findings) + content (1 finding) = 2 audits. site-b: technical only (1 finding) = 1 audit.
    expect(summary.auditsInserted).toBe(3);
    expect(summary.auditsSkippedDuplicate).toBe(0);
    expect(summary.findingsInserted).toBe(5); // 3 + 1 + 1
    expect(summary.parseWarnings).toHaveLength(0);
    expect(summary.skippedFiles).toHaveLength(1);
    expect(summary.skippedFiles[0]).toMatch(/not-a-property\.test\.md/);

    // The hard rule: the summary's own counters are corroborated by an independent read-back, not
    // just trusted. This is the row-count assertion the harvest ticket requires.
    expect(summary.assertedAuditRowCount).toBe(3);
    expect(summary.assertedFindingRowCount).toBe(5);

    const auditRows = await withTenants(
      [tenantId],
      (c) => c.query(`SELECT kind, source, status, score FROM search_audits WHERE tenant_id = $1 AND source = 'nexus-import' ORDER BY kind`, [tenantId]),
      { modules: ["search"] },
    );
    expect(auditRows.rows).toHaveLength(3);
    for (const row of auditRows.rows) {
      expect(row.source).toBe("nexus-import");
      expect(row.status).toBe("completed");
      expect(["technical", "content"]).toContain(row.kind);
    }
  });

  it("second run over the SAME unchanged source directory is a true no-op: zero new rows, same asserted counts", async () => {
    const summary = await importNexusDocuments(sourceDir, tenantId);

    expect(summary.domainsSeen).toBe(2);
    expect(summary.clientsCreated).toBe(0);
    expect(summary.clientsExisting).toBe(2);
    expect(summary.propertiesCreated).toBe(0);
    expect(summary.propertiesExisting).toBe(2);
    expect(summary.auditsInserted).toBe(0);
    expect(summary.auditsSkippedDuplicate).toBe(3);
    expect(summary.findingsInserted).toBe(0); // no new audit rows -> no new findings inserted either

    // The row count itself — read back fresh, not carried over from the first test — is unchanged.
    expect(summary.assertedAuditRowCount).toBe(3);
    expect(summary.assertedFindingRowCount).toBe(5);
  });

  it("a genuine content change (re-audited site) inserts a NEW row rather than mutating the old one — history is additive", async () => {
    // Simulate a re-audit: same domain, materially different finding content -> different report_hash.
    writeFileSync(
      join(sourceDir, "docs", "audits", "site-b.test.md"),
      SITE_B_TECH.replace("Domain parked.", "Domain parked AND DNS registrar expires in 5 days."),
    );

    const summary = await importNexusDocuments(sourceDir, tenantId);
    expect(summary.auditsInserted).toBe(1); // only site-b's technical audit changed
    expect(summary.auditsSkippedDuplicate).toBe(2); // site-a's two audits are unchanged
    expect(summary.assertedAuditRowCount).toBe(4); // additive: 3 + 1, the original site-b row still exists

    const siteBAudits = await withTenants(
      [tenantId],
      (c) => c.query(
        `SELECT sa.id FROM search_audits sa
         JOIN search_properties sp ON sp.id = sa.property_id
         WHERE sa.tenant_id = $1 AND sp.domain = 'site-b.test' AND sa.source = 'nexus-import'`,
        [tenantId],
      ),
      { modules: ["search"] },
    );
    expect(siteBAudits.rows).toHaveLength(2); // the original + the re-audit, both retained
  });
});
