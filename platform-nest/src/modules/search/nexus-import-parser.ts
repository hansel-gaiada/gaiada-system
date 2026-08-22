// SM-70 — Gaia Nexus harvest: parser for the 126 real audit + SEO Markdown documents
// (docs/plans/2026-08-13-gaia-nexus-harvest.md §4 H1, §5 SM-70). Pure, synchronous, no I/O — mirrors
// search-audit.ts's SM-08 adapter shape (validate/derive, no PoolClient param) so this is unit-testable
// without a live Postgres connection. src/seed/nexus-import.ts owns the DB writes.
//
// SOURCE SHAPE: analyst-authored (human + AI-assisted) prose Markdown per property, TWO files per
// site — `docs/audits/<domain>.md` (technical) and `docs/seo/<domain>.md` (SEO/content) — NOT a
// machine report. There is no shared shape with search-crawl-go's CrawlerReport, so this is its own
// adapter, not a variant of search-audit.ts's crawler path (see that file's AUDIT_SOURCES comment).
//
// FIDELITY DECISION (read before "improving" the parsing): a byte survey of the real corpus (63+63
// files, 2026-08-20) found the two sections below are the ONLY ones with a uniform, machine-parseable
// shape across every file:
//   - technical: the "## Technical findings" `| Area | Finding | Severity |` table — 401 rows total,
//     every one splits into exactly 5 fields on `|` (no embedded pipe characters).
//   - seo:       the "## Search/content issues" bullet list — always single-level `- ` bullets.
// Everything else — "Verified signals", "Could not verify", "Top technical fixes", "Search profile
// (Semrush)", "Top organic keywords", "Meta-rewrite proposals", "Work plan" — varies genuinely between
// files (e.g. some SEO files use "Domain: X\nRank: Y", others use "Domain Rank: Y" with no "Domain:"
// line at all; "Top organic keywords" ranges from `keyword (Position: 1, Search Volume: 1600, ...)` to
// `"7film": Position 50, Search Volume 90, ...`). Force-parsing that heterogeneity into a rigid
// per-keyword/per-proposal structure risks silently-wrong structured data. The deliberate choice here
// is: parse the two uniform sections into real rows (findings), best-effort regex-extract a handful of
// simple `Label: number` Semrush aggregates (nullable — absence is not an error), and preserve every
// other section as RAW TEXT in `summary` (full fidelity for a human reader and for RAG) rather than a
// brittle structured shape nobody asked for. See the harvest-plan report for the explicit "did not map
// cleanly" list this produces.
import { createHash } from "node:crypto";
import type { FindingDraft, FindingSeverity } from "./search-audit";
import { hashReport, severitySummary, computeScore } from "./search-audit";

export type NexusDocKind = "technical" | "content";
export const NEXUS_IMPORT_SOURCE = "nexus-import" as const;

export interface NexusParsedDoc {
  domain: string;
  kind: NexusDocKind;
  findings: FindingDraft[];
  summary: Record<string, unknown>;
  score: number;
  auditedAt: string | null; // ISO date (UTC midnight) if a YYYY-MM-DD date was found, else null
  reportHash: string;
  warnings: string[];
}

// ── generic Markdown helpers ────────────────────────────────────────────────────────────────────

/** Every `## Heading` section as {heading, body}, in document order. Case-sensitive on purpose —
 *  every file in the corpus uses `## ` consistently. */
function splitSections(markdown: string): Array<{ heading: string; body: string }> {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: Array<{ heading: string; body: string }> = [];
  let heading: string | null = null;
  let buf: string[] = [];
  for (const line of lines) {
    const m = /^##\s+(.*)$/.exec(line);
    if (m) {
      if (heading !== null) out.push({ heading, body: buf.join("\n").trim() });
      heading = m[1].trim();
      buf = [];
    } else if (heading !== null) {
      buf.push(line);
    }
  }
  if (heading !== null) out.push({ heading, body: buf.join("\n").trim() });
  return out;
}

/** First section whose heading STARTS WITH `prefix` (case-insensitive) — handles the corpus's
 *  heading variants, e.g. "Could not verify" vs "Could not verify (no access)". */
function sectionStartingWith(sections: Array<{ heading: string; body: string }>, prefix: string): string | null {
  const lower = prefix.toLowerCase();
  const found = sections.find((s) => s.heading.toLowerCase().startsWith(lower));
  return found ? found.body : null;
}

/** The `> **In plain terms (for the team):** ...` blockquote right under the H1 — a ready-made
 *  plain-language summary worth preserving verbatim if present. */
function extractPlainSummary(markdown: string): string | null {
  const m = /^>\s*\*\*In plain terms[^*]*\*\*:?\s*(.*)$/m.exec(markdown);
  return m ? m[1].trim() : null;
}

/** The single metadata line (`**Server:** ce01 · **Audited:** 2026-06-11 · **Status:** live` or the
 *  `**Analysed:** ...` SEO equivalent). Scoping extraction to THIS line (not the whole document)
 *  avoids ever matching the word "status" inside unrelated prose elsewhere in the file. */
function metadataLine(markdown: string): string | null {
  const m = /^\*\*(?:Server|Analysed):\*\*.*$/m.exec(markdown);
  return m ? m[0] : null;
}

function labelValue(line: string | null, label: string): string | null {
  if (!line) return null;
  // Value runs to the next " · **" separator or end of line.
  const m = new RegExp(`\\*\\*${label}:\\*\\*\\s*(.*?)(?:\\s*·\\s*\\*\\*|$)`).exec(line);
  return m ? m[1].trim() : null;
}

function extractDate(text: string | null): string | null {
  if (!text) return null;
  const m = /(\d{4}-\d{2}-\d{2})/.exec(text);
  if (!m) return null;
  const d = new Date(`${m[1]}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Best-effort `Label: 1,234` numeric extraction from free prose. Tries each label in order (some
 *  files use "Rank:", others "Domain Rank:" with no plain "Rank:" line) and returns the FIRST match.
 *  Returns null rather than throwing when nothing matches — these fields are a bonus, not a contract:
 *  the raw section text is always preserved separately regardless of whether this succeeds. */
function extractNumber(section: string | null, labels: string[]): number | null {
  if (!section) return null;
  for (const label of labels) {
    const m = new RegExp(`${label}:\\s*([\\d,]+(?:\\.\\d+)?)`, "i").exec(section);
    if (m) {
      const n = Number(m[1].replace(/,/g, ""));
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

/** Deterministic short code for a finding — same (category, message) always yields the same code,
 *  which is what makes a re-import of unchanged content converge instead of drift (belt-and-braces
 *  alongside the report_hash-level idempotency in search_audits; findings themselves carry no unique
 *  constraint, so this is what a future de-dup pass would key on). */
function findingCode(prefix: string, category: string, message: string): string {
  const slug = category.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 24) || "finding";
  const hash = createHash("sha256").update(`${category}|${message}`).digest("hex").slice(0, 10);
  return `${prefix}-${slug}-${hash}`;
}

const SEVERITY_MAP: Record<string, FindingSeverity> = {
  critical: "critical",
  high: "high",
  med: "medium",
  medium: "medium",
  low: "low",
  info: "info",
};

// A real-corpus survey turned up 4 (of 401) severity cells carrying a parenthetical qualifier —
// "Info (good)", "Med (technical signal)", "Low (OK)" — the analyst annotating a POSITIVE or
// context-setting finding rather than a plain severity. The base token is still one of the five known
// values, so it is recoverable; stripping a trailing `(...)` before matching turns these into real
// hits instead of 4 more medium-fallback warnings.
function normalizeSeverity(raw: string, warnings: string[]): FindingSeverity {
  const stripped = raw.trim().replace(/\s*\([^)]*\)\s*$/, "");
  const key = stripped.toLowerCase();
  const mapped = SEVERITY_MAP[key];
  if (mapped) return mapped;
  warnings.push(`unrecognized severity "${raw}" — defaulted to medium`);
  return "medium";
}

// ── technical audit (`docs/audits/<domain>.md`) ─────────────────────────────────────────────────

/** Parses the ONE uniform structured section: `| Area | Finding | Severity |`. Skips the header and
 *  separator rows. A row is well-formed iff it splits into exactly 5 `|`-delimited fields (leading +
 *  3 content + trailing); a malformed row is skipped and recorded in `warnings`, never thrown — one
 *  bad row must not strand the other findings in the same file (mirrors search-audit.ts's per-report,
 *  not per-page, failure granularity). */
function parseTechnicalFindingsTable(section: string | null, warnings: string[]): FindingDraft[] {
  if (!section) return [];
  const out: FindingDraft[] = [];
  for (const line of section.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|")) continue;
    const cells = t.split("|").map((c) => c.trim());
    if (cells.length !== 5) continue; // ["", Area, Finding, Severity, ""]
    const [, area, finding, severityRaw] = cells;
    if (area.toLowerCase() === "area" || /^-+$/.test(area)) continue; // header / separator row
    if (!area || !finding) {
      warnings.push(`skipped malformed findings row: ${JSON.stringify(t)}`);
      continue;
    }
    const severity = normalizeSeverity(severityRaw || "medium", warnings);
    out.push({
      code: findingCode("nexus-tech", area, finding),
      severity,
      category: area,
      message: finding,
      urlCount: 0,
      sampleUrls: [],
    });
  }
  return out;
}

export function parseTechnicalAudit(domain: string, markdown: string): NexusParsedDoc {
  const warnings: string[] = [];
  const sections = splitSections(markdown);
  const metaLine = metadataLine(markdown);
  const findings = parseTechnicalFindingsTable(sectionStartingWith(sections, "Technical findings"), warnings);
  const summary = {
    importSource: NEXUS_IMPORT_SOURCE,
    domain,
    server: labelValue(metaLine, "Server"),
    platform: labelValue(metaLine, "Platform"),
    statusRaw: labelValue(metaLine, "Status"),
    plainSummary: extractPlainSummary(markdown),
    verifiedSignals: sectionStartingWith(sections, "Verified signals"),
    couldNotVerify: sectionStartingWith(sections, "Could not verify"),
    topFixes: sectionStartingWith(sections, "Top technical fixes"),
    severityCounts: severitySummary(findings),
    rawMarkdown: markdown,
  };
  return {
    domain,
    kind: "technical",
    findings,
    summary,
    score: computeScore(findings),
    auditedAt: extractDate(labelValue(metaLine, "Audited")),
    reportHash: hashReport("technical", NEXUS_IMPORT_SOURCE, { domain, rawMarkdown: markdown }),
    warnings,
  };
}

// ── SEO analysis (`docs/seo/<domain>.md`) ───────────────────────────────────────────────────────

/** The ONE uniform structured section on the SEO side: `- ` bullets under "Search/content issues".
 *  No severity signal exists in the source for these (unlike the technical table) — every derived
 *  finding is stamped 'medium' by convention; see the module-level fidelity note. */
function parseSearchIssues(section: string | null): FindingDraft[] {
  if (!section) return [];
  const out: FindingDraft[] = [];
  for (const line of section.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("- ")) continue;
    const message = t.slice(2).trim();
    if (!message) continue;
    out.push({
      code: findingCode("nexus-seo", "seo", message),
      severity: "medium",
      category: "seo",
      message,
      urlCount: 0,
      sampleUrls: [],
    });
  }
  return out;
}

export function parseSeoAnalysis(domain: string, markdown: string): NexusParsedDoc {
  const warnings: string[] = [];
  const sections = splitSections(markdown);
  const metaLine = metadataLine(markdown);
  const profileSection = sectionStartingWith(sections, "Search profile");
  const findings = parseSearchIssues(sectionStartingWith(sections, "Search/content issues"));
  const summary = {
    importSource: NEXUS_IMPORT_SOURCE,
    domain,
    semrushDb: labelValue(metaLine, "Semrush DB"),
    statusRaw: labelValue(metaLine, "Status"),
    plainSummary: extractPlainSummary(markdown),
    // Best-effort aggregates only — see module header. Every one is nullable; a miss is not an error.
    semrush: {
      rank: extractNumber(profileSection, ["Domain Rank", "Rank"]),
      organicKeywords: extractNumber(profileSection, ["Organic Keywords"]),
      organicTraffic: extractNumber(profileSection, ["Organic Traffic"]),
      organicCost: extractNumber(profileSection, ["Organic Cost"]),
      adwordsKeywords: extractNumber(profileSection, ["Adwords Keywords"]),
    },
    searchProfileRaw: profileSection,
    topKeywordsRaw: sectionStartingWith(sections, "Top organic keywords") ?? extractSubBullets(profileSection, "Top organic keywords"),
    gscPerformance: sectionStartingWith(sections, "GSC performance"),
    metaRewriteProposalsRaw: sectionStartingWith(sections, "Meta-rewrite proposals"),
    workPlanRaw: sectionStartingWith(sections, "Work plan"),
    severityCounts: severitySummary(findings),
    rawMarkdown: markdown,
  };
  return {
    domain,
    kind: "content",
    findings,
    summary,
    score: computeScore(findings),
    auditedAt: extractDate(labelValue(metaLine, "Analysed")),
    reportHash: hashReport("content", NEXUS_IMPORT_SOURCE, { domain, rawMarkdown: markdown }),
    warnings,
  };
}

/** "Top organic keywords" is sometimes a sub-bullet of "Search profile" rather than its own `## `
 *  section (the corpus is not fully uniform about this). Best-effort fallback: find the sub-bullet
 *  line and everything indented under it. Returns null rather than guessing when absent. */
function extractSubBullets(section: string | null, label: string): string | null {
  if (!section) return null;
  const lines = section.split("\n");
  const idx = lines.findIndex((l) => l.trim().toLowerCase().startsWith(`- ${label.toLowerCase()}`));
  if (idx === -1) return null;
  const out = [lines[idx]];
  for (let i = idx + 1; i < lines.length; i += 1) {
    if (/^\s*-\s/.test(lines[i]) && !/^\s{2,}-/.test(lines[i])) break; // next top-level bullet
    out.push(lines[i]);
  }
  return out.join("\n").trim();
}
