// SM-70 — field-mapping tests for the Gaia Nexus harvest parser. Fixtures below are inlined,
// hand-reduced excerpts of the REAL corpus shapes found in a 2026-08-20 survey of
// gaiadabali/gaia-nexus (docs/audits/*.md, docs/seo/*.md) — not synthetic guesses — covering the
// documented edge cases: the "Med" vs "Medium" severity spelling, a "Could not verify (no access)"
// heading variant, a parked/redirect status line, and a low-presence SEO file with prose instead of
// a numeric Semrush breakdown. No DB, no network — pure function tests only (src/seed/nexus-import.
// test.ts is the DB-backed idempotency test).
import { describe, it, expect } from "vitest";
import { parseTechnicalAudit, parseSeoAnalysis, NEXUS_IMPORT_SOURCE } from "./nexus-import-parser";
import { hashReport } from "./search-audit";

const TECH_MD = `# Technical Audit — viceroybali.com

> **In plain terms (for the team):** Your site has a significant security vulnerability because anyone can toggle WP_DEBUG via the URL.

**Server:** ce01 · **Audited:** 2026-06-11 · **Status:** live

## Verified signals
- HTTP/redirects: 301 → 200.
- Platform/version: WordPress 7.0; DB table_prefix = 'vb21_' (non-default ✓).

## Technical findings
| Area | Finding | Severity |
|---|---|---|
| Security | WP_DEBUG togglable via URL param. | High |
| Security | DISALLOW_FILE_EDIT commented out. | Med |
| Theme bloat | 5+ viceroy*-git theme variants on disk. | Low |
| Indexability | Polylang redirect; confirm hreflang. | Info |

## Could not verify
- CWV field data; exact plugin versions.

## Top technical fixes (analysis only — NOT executed)
1. Remove the debug branch.
2. Pick one caching plugin.
`;

const TECH_MD_PARKED = `# Technical Audit — interlace.com

> **In plain terms (for the team):** Your site is completely inaccessible to Google because the domain is parked.

**Server:** ce01 · **Platform:** wp · **Audited:** 2026-06-11 · **Status:** parked (GoDaddy/AWS domain-parking lander; DNS not pointed at ce01)

## Verified signals
- HTTP/redirects: parking lander on every path.

## Technical findings
| Area | Finding | Severity |
|---|---|---|
| DNS / hosting | Domain parked. | High |
| Security (positive) | Non-default table prefix and WP_DEBUG=false. | Low |

## Could not verify (no access)
- Exposed-file checks on the real WP install.

## Top technical fixes (analysis only — NOT executed)
1. Repoint DNS.
`;

const SEO_MD = `# SEO Analysis — viceroybali.com

> **In plain terms (for the team):** This site gets real traffic and dominates branded searches.

**Analysed:** 2026-06-11 · **Semrush DB:** id · **Status:** live

## Search profile (Semrush)
- Keywords / Traffic / Rank / Ads:
  - Domain: viceroybali.com
  - Rank: 26887
  - Organic Keywords: 1300
  - Organic Traffic: 7188
  - Organic Cost: 1407
  - Adwords Keywords: 0
- Top organic keywords:
  - viceroy bali (Position: 1, Search Volume: 1600, Traffic (%): 17.80)

## GSC performance
- GSC: not available this run.

## Search/content issues
- Weak positions for high-volume keywords.
- No paid search presence: 0 Adwords keywords.

## Meta-rewrite proposals
| Page | Issue | Proposed angle | Why |
|---|---|---|---|
| Homepage | Optimize for branded luxury | Viceroy Bali: Luxury Ubud Resort | Reinforces brand. |

## Work plan (analysis only — NOT executed)
- Blog: Develop content clusters.
`;

const SEO_MD_LOW_PRESENCE = `# SEO Analysis — interlace.com

> **In plain terms (for the team):** This site has virtually no organic search presence.

**Analysed:** 2026-06-11 · **Semrush DB:** us · **Status:** low-presence

## Search profile (Semrush)
- Keywords / Traffic / Rank / Ads: Semrush reports no organic keywords, no organic traffic, no traffic cost, and no ads keywords.
- Top organic keywords: No top organic keywords found.

## GSC performance
- GSC: not available this run.

## Search/content issues
- Very thin search footprint.
- Significant keyword gaps.

## Meta-rewrite proposals
| Page | Issue | Proposed angle | Why |
|---|---|---|---|
| Homepage | No search presence / Low visibility | Clearly define the site's core offering | To establish initial relevance. |

## Work plan (analysis only — NOT executed)
- Blog: Develop a content strategy.
`;

describe("SM-70 nexus-import-parser — technical audit field mapping", () => {
  it("extracts metadata, findings and score from a live-site audit", () => {
    const doc = parseTechnicalAudit("viceroybali.com", TECH_MD);
    expect(doc.kind).toBe("technical");
    expect(doc.domain).toBe("viceroybali.com");
    expect(doc.auditedAt).toBe(new Date("2026-06-11T00:00:00.000Z").toISOString());
    expect(doc.summary.server).toBe("ce01");
    expect(doc.summary.statusRaw).toBe("live");
    expect(doc.summary.plainSummary).toMatch(/significant security vulnerability/);
    expect(doc.findings).toHaveLength(4);
    // Severity normalization: High -> high, Med -> medium, Low -> low, Info -> info.
    expect(doc.findings.map((f) => f.severity)).toEqual(["high", "medium", "low", "info"]);
    expect(doc.findings[0].category).toBe("Security");
    expect(doc.findings[0].message).toBe("WP_DEBUG togglable via URL param.");
    expect(doc.summary.couldNotVerify).toMatch(/CWV field data/);
    expect(doc.summary.topFixes).toMatch(/Remove the debug branch/);
    expect(doc.score).toBeLessThan(100); // deductions applied
    expect(doc.warnings).toHaveLength(0);
  });

  it("is deterministic: re-parsing byte-identical content yields the same report_hash and finding codes", () => {
    const a = parseTechnicalAudit("viceroybali.com", TECH_MD);
    const b = parseTechnicalAudit("viceroybali.com", TECH_MD);
    expect(a.reportHash).toBe(b.reportHash);
    expect(a.findings.map((f) => f.code)).toEqual(b.findings.map((f) => f.code));
  });

  it("a content change (even whitespace-insensitive to JSON key order via hashReport's canonicalize) still changes the hash", () => {
    const a = parseTechnicalAudit("viceroybali.com", TECH_MD);
    const b = parseTechnicalAudit("viceroybali.com", TECH_MD.replace("High |", "Critical |"));
    expect(a.reportHash).not.toBe(b.reportHash);
  });

  it("strips a parenthetical severity qualifier before matching (real-corpus finding: 'Info (good)', 'Med (technical signal)', 'Low (OK)')", () => {
    const md = TECH_MD.replace("| High |", "| Info (good) |").replace("| Med |", "| Med (technical signal) |").replace("| Low |", "| Low (OK) |");
    const doc = parseTechnicalAudit("viceroybali.com", md);
    expect(doc.findings.map((f) => f.severity)).toEqual(["info", "medium", "low", "info"]);
    expect(doc.warnings).toHaveLength(0);
  });

  it("handles the 'Could not verify (no access)' heading variant and a parked/redirect status line", () => {
    const doc = parseTechnicalAudit("interlace.com", TECH_MD_PARKED);
    expect(doc.summary.statusRaw).toBe("parked (GoDaddy/AWS domain-parking lander; DNS not pointed at ce01)");
    expect(doc.summary.platform).toBe("wp");
    expect(doc.summary.couldNotVerify).toMatch(/Exposed-file checks/);
    expect(doc.findings).toHaveLength(2);
  });

  it("stamps NEXUS_IMPORT_SOURCE as the hashReport source input (not 'crawler'/'ai'/etc.)", () => {
    const doc = parseTechnicalAudit("viceroybali.com", TECH_MD);
    expect(doc.reportHash).toBe(hashReport("technical", NEXUS_IMPORT_SOURCE, { domain: "viceroybali.com", rawMarkdown: TECH_MD }));
  });
});

describe("SM-70 nexus-import-parser — SEO analysis field mapping", () => {
  it("extracts Semrush aggregates, search-issue findings (stamped severity=medium) and metadata from a live/structured file", () => {
    const doc = parseSeoAnalysis("viceroybali.com", SEO_MD);
    expect(doc.kind).toBe("content");
    expect(doc.summary.semrushDb).toBe("id");
    expect(doc.summary.statusRaw).toBe("live");
    const semrush = doc.summary.semrush as Record<string, number | null>;
    expect(semrush.rank).toBe(26887);
    expect(semrush.organicKeywords).toBe(1300);
    expect(semrush.organicTraffic).toBe(7188);
    expect(semrush.organicCost).toBe(1407);
    expect(semrush.adwordsKeywords).toBe(0);
    expect(doc.findings).toHaveLength(2);
    expect(doc.findings.every((f) => f.severity === "medium" && f.category === "seo")).toBe(true);
    expect(doc.summary.metaRewriteProposalsRaw).toMatch(/Viceroy Bali: Luxury Ubud Resort/);
    expect(doc.summary.workPlanRaw).toMatch(/Develop content clusters/);
  });

  it("degrades gracefully on a low-presence file with prose instead of a numeric Semrush breakdown (nulls, not throws)", () => {
    const doc = parseSeoAnalysis("interlace.com", SEO_MD_LOW_PRESENCE);
    expect(doc.summary.statusRaw).toBe("low-presence");
    const semrush = doc.summary.semrush as Record<string, number | null>;
    expect(semrush.rank).toBeNull();
    expect(semrush.organicKeywords).toBeNull();
    expect(semrush.organicTraffic).toBeNull();
    // Full section text is still preserved even when the numeric extraction misses everything.
    expect(doc.summary.searchProfileRaw).toMatch(/Semrush reports no organic keywords/);
    expect(doc.findings).toHaveLength(2);
    expect(doc.findings[0].message).toBe("Very thin search footprint.");
  });

  it("never throws on a document with an empty 'Search/content issues' section", () => {
    const md = SEO_MD.replace(/## Search\/content issues\n[\s\S]*?\n\n## Meta/, "## Search/content issues\n\n## Meta");
    const doc = parseSeoAnalysis("empty-issues.test", md);
    expect(doc.findings).toHaveLength(0);
    expect(doc.score).toBe(100);
  });
});

describe("SM-70 nexus-import-parser — cross-cutting", () => {
  it("technical and content report hashes for the SAME domain never collide with each other", () => {
    const tech = parseTechnicalAudit("viceroybali.com", TECH_MD);
    const seo = parseSeoAnalysis("viceroybali.com", SEO_MD);
    expect(tech.reportHash).not.toBe(seo.reportHash);
  });

  it("severityCounts on the summary matches severitySummary()-derived counts (technical: 1 high/1 med/1 low/1 info)", () => {
    const doc = parseTechnicalAudit("viceroybali.com", TECH_MD);
    expect(doc.summary.severityCounts).toEqual({ critical: 0, high: 1, medium: 1, low: 1, info: 1 });
  });
});
