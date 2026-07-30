// SM-08 — Site-audit ingest adapter (design §12 SM-08 + the audit/findings entities in §04
// "Audits"). Pure, synchronous, no I/O: the controller owns the DB writes (search.controller.ts
// follows the existing `withTenants` pattern), this file only (a) validates + hashes a raw crawl
// Report and (b) turns it into a severity-ranked findings-by-code map + a summary/score.
//
// INPUT CONTRACT: `search-crawl-go/internal/crawler/crawler.go`'s `Report` — the crawler is SM-07's
// upstream and is NOT owned here. Its Report is intentionally minimal (no job/report id, no
// severity data of its own):
//   { startUrl: string, pages: [{ url, statusCode?, title?, skipped?: 'robots'|'off-host'|'max-pages', error? }], startedAt, finishedAt }
// Everything below the raw page list — severity, category, message, grouping — is this adapter's
// own heuristic reading of that shape; SEONaut/Unlighthouse adapters (their own report shapes) are
// a later ticket's job to add alongside this one (source is already a column, not hard-coded to
// 'crawler').
//
// IDEMPOTENCY KEY (MUST HOLD — a re-run is normal operation, not an error): the crawler emits no
// stable id of its own, so the key is a content hash of the canonicalised report JSON. Two ingests
// of byte-for-byte-different-but-semantically-identical JSON (key order, whitespace) still hash
// identically because `canonicalize` sorts object keys recursively before stringifying.
import { createHash } from "node:crypto";

export const AUDIT_KINDS = ["technical", "cwv", "content", "links", "geo"] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

export const AUDIT_SOURCES = ["seonaut", "crawler", "unlighthouse", "ai"] as const;
export type AuditSource = (typeof AUDIT_SOURCES)[number];

export const FINDING_SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

// Manual triage transitions only (design §04: `status ('open','fixed','ignored','regressed')`).
// 'regressed' is system-derived by the diff pass, never a caller-supplied triage target — see
// `AUDIT_TRIAGE_STATUSES` vs. the full `status` domain.
export const AUDIT_TRIAGE_STATUSES = ["open", "fixed", "ignored"] as const;
export type AuditTriageStatus = (typeof AUDIT_TRIAGE_STATUSES)[number];

// Hostile-input guard: the crawler's own default MaxPages is 25; 10,000 is generous headroom for
// a deliberately-configured large crawl while still refusing a malformed/oversized payload with a
// 400 instead of hanging the request or attempting a giant partial write.
export const MAX_REPORT_PAGES = 10_000;

export interface CrawlerPageResult {
  url: string;
  statusCode?: number;
  title?: string;
  skipped?: "robots" | "off-host" | "max-pages";
  error?: string;
}

export interface CrawlerReport {
  startUrl: string;
  pages: CrawlerPageResult[];
  startedAt?: string;
  finishedAt?: string;
}

export interface FindingDraft {
  code: string;
  severity: FindingSeverity;
  category: string;
  message: string;
  urlCount: number;
  sampleUrls: string[];
}

const MAX_SAMPLE_URLS = 20;

/** Deep, key-sorted JSON stringify — the canonical form the idempotency hash is computed over. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function hashReport(kind: string, source: string, report: unknown): string {
  const canonical = JSON.stringify(canonicalize({ kind, source, report }));
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Validates a raw report body against the crawler's Report shape. Throws a plain Error with a
 * human-readable reason on any structural problem (malformed/partial/oversized) — the caller
 * (search.controller.ts) wraps this in a BadRequestException so hostile input is always a 400,
 * never a 500 or a partial write (validation runs fully BEFORE any DB write starts).
 */
export function validateCrawlerReport(report: unknown): CrawlerReport {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("report must be a JSON object");
  }
  const r = report as Record<string, unknown>;
  if (typeof r.startUrl !== "string" || !r.startUrl) throw new Error("report.startUrl must be a non-empty string");
  if (!Array.isArray(r.pages)) throw new Error("report.pages must be an array");
  if (r.pages.length === 0) throw new Error("report.pages must not be empty");
  if (r.pages.length > MAX_REPORT_PAGES) throw new Error(`report.pages exceeds the ${MAX_REPORT_PAGES}-page ingest limit`);

  const pages: CrawlerPageResult[] = r.pages.map((p, i) => {
    if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error(`report.pages[${i}] must be an object`);
    const page = p as Record<string, unknown>;
    if (typeof page.url !== "string" || !page.url) throw new Error(`report.pages[${i}].url must be a non-empty string`);
    if (page.statusCode !== undefined && typeof page.statusCode !== "number") {
      throw new Error(`report.pages[${i}].statusCode must be a number`);
    }
    if (page.title !== undefined && typeof page.title !== "string") throw new Error(`report.pages[${i}].title must be a string`);
    if (page.skipped !== undefined && !["robots", "off-host", "max-pages"].includes(page.skipped as string)) {
      throw new Error(`report.pages[${i}].skipped must be robots|off-host|max-pages`);
    }
    if (page.error !== undefined && typeof page.error !== "string") throw new Error(`report.pages[${i}].error must be a string`);
    return {
      url: page.url,
      statusCode: page.statusCode as number | undefined,
      title: page.title as string | undefined,
      skipped: page.skipped as CrawlerPageResult["skipped"],
      error: page.error as string | undefined,
    };
  });
  if (r.startedAt !== undefined && typeof r.startedAt !== "string") throw new Error("report.startedAt must be a string");
  if (r.finishedAt !== undefined && typeof r.finishedAt !== "string") throw new Error("report.finishedAt must be a string");

  return { startUrl: r.startUrl, pages, startedAt: r.startedAt as string | undefined, finishedAt: r.finishedAt as string | undefined };
}

interface Bucket {
  severity: FindingSeverity;
  category: string;
  message: string;
  urls: string[];
}

/**
 * Turns a validated crawler Report into findings grouped by a stable `code` (design §04:
 * `search_audit_findings(code, severity, category, message, url_count, sample_urls)`). Heuristics
 * are this adapter's own — the crawler contract has no severity/category of its own to carry
 * forward (see file header). 'off-host' skips are expected crawl behaviour, not a defect, so they
 * are not surfaced as findings.
 */
export function deriveFindings(report: CrawlerReport): FindingDraft[] {
  const buckets = new Map<string, Bucket>();
  const bump = (code: string, severity: FindingSeverity, category: string, message: string, url: string) => {
    let b = buckets.get(code);
    if (!b) { b = { severity, category, message, urls: [] }; buckets.set(code, b); }
    b.urls.push(url);
  };

  for (const page of report.pages) {
    if (page.error) {
      bump("fetch_error", "high", "crawlability", "Page could not be fetched", page.url);
      continue;
    }
    if (page.skipped === "robots") {
      bump("blocked_by_robots", "low", "crawlability", "Page is disallowed by robots.txt", page.url);
      continue;
    }
    if (page.skipped === "max-pages") {
      bump("crawl_truncated", "medium", "crawlability", "Crawl hit the max-pages cap before reaching this URL", page.url);
      continue;
    }
    if (page.skipped === "off-host") continue; // expected behaviour, not a finding

    const status = page.statusCode;
    if (status !== undefined && status >= 500) {
      bump("server_error", "critical", "availability", `Server error (${status})`, page.url);
    } else if (status === 404) {
      bump("broken_link", "medium", "availability", "Page not found (404)", page.url);
    } else if (status !== undefined && status >= 400) {
      bump("client_error", "high", "availability", `Client error (${status})`, page.url);
    } else if (!page.title || !page.title.trim()) {
      bump("missing_title", "medium", "content", "Page has no <title>", page.url);
    }
  }

  return [...buckets.entries()].map(([code, b]) => ({
    code,
    severity: b.severity,
    category: b.category,
    message: b.message,
    urlCount: b.urls.length,
    sampleUrls: b.urls.slice(0, MAX_SAMPLE_URLS),
  }));
}

/** Severity-count summary persisted on `search_audits.summary` (design §04). */
export function severitySummary(findings: FindingDraft[]): Record<FindingSeverity, number> {
  const out: Record<FindingSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) out[f.severity] += 1;
  return out;
}

// A simple, documented-as-ours scoring heuristic (the design doc specifies `score numeric` but not
// a formula) — 100 minus a per-severity weighted deduction, floored at 0. Not a spec requirement to
// verify precisely; it exists so the audit row carries SOME at-a-glance signal.
const SEVERITY_WEIGHT: Record<FindingSeverity, number> = { critical: 20, high: 10, medium: 5, low: 1, info: 0 };
export function computeScore(findings: FindingDraft[]): number {
  const deduction = findings.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0);
  return Math.max(0, 100 - deduction);
}

// ─────────────────────────────────────────── Regression diff (design §04) ───────────────────────
// "Regression = diff of consecutive completed audits of the same kind; emits
// search.audit.regression." Pure function: the controller resolves the previous completed audit's
// finding rows from the DB, hands them here, and applies the returned plan. Kept pure (no PoolClient
// param) so the diff logic itself is unit-testable without a live Postgres connection.
export interface PrevFindingRow {
  id: string;
  code: string;
  status: string;
  firstSeenAuditId: string | null;
}

export interface DiffInsertPlan {
  code: string;
  status: "open" | "regressed";
  firstSeenAuditId: string | null; // null => this ingest's own new audit id is the first sighting
}

export interface DiffPlan {
  toInsert: DiffInsertPlan[]; // one per new finding code, in the same order as the input findings
  toFix: string[]; // prev finding row ids whose issue is no longer present -> flip to 'fixed'
  regressedCodes: string[]; // codes that reappeared after having been fixed/ignored
}

export function diffAudits(newFindings: FindingDraft[], prevFindings: PrevFindingRow[], prevAuditId: string | null): DiffPlan {
  const prevByCode = new Map(prevFindings.map((p) => [p.code, p]));
  const newCodes = new Set(newFindings.map((f) => f.code));
  const regressedCodes: string[] = [];

  const toInsert: DiffInsertPlan[] = newFindings.map((f) => {
    const prev = prevByCode.get(f.code);
    if (!prev) return { code: f.code, status: "open", firstSeenAuditId: null };
    if (prev.status === "fixed" || prev.status === "ignored") {
      regressedCodes.push(f.code);
      return { code: f.code, status: "regressed", firstSeenAuditId: prev.firstSeenAuditId ?? prevAuditId };
    }
    // prev.status is 'open' or 'regressed' — the issue is still present, carry it forward as 'open'.
    return { code: f.code, status: "open", firstSeenAuditId: prev.firstSeenAuditId ?? prevAuditId };
  });

  const toFix = prevFindings
    .filter((p) => !newCodes.has(p.code) && (p.status === "open" || p.status === "regressed"))
    .map((p) => p.id);

  return { toInsert, toFix, regressedCodes };
}
