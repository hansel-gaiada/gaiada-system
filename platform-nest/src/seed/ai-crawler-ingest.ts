// M5-P5b2 — the operator script behind the PULL job (infra/scripts/ai-crawler-pull.sh; runbook infra/runbooks/ai-crawler-log.md).
// It reads access-log text on STDIN (already filtered to AI-crawler lines on the web host), stores it through the same
// `ingestAiCrawlerChunk` the HTTP route uses, and writes one `ai_crawler_ingest` activity (actor null) per non-empty run.
//   node dist/seed/ai-crawler-ingest.js --tenant <uuid> --property <uuid>      < filtered.log
//   node dist/seed/ai-crawler-ingest.js --grep-pattern                          prints the bots' UA tokens as one `grep -E` alternation
//
// It prints exactly ONE JSON line on stdout: {chunks, new, duplicate, rows, stats}, and never a log line, IP or User-Agent.
// Exit codes: 0 ok (empty stdin is ok: chunks 0, no activity row) · 2 bad or missing arguments · 3 no_property · 1 anything else.
// Verification stays whatever `verifierFromEnv()` says (off unless AI_CRAWLER_RANGES_FILE is set on the platform container).
import { AI_CRAWLERS } from "../modules/search/ai-crawler-bots";
import type { AggregateStats } from "../modules/search/ai-crawler-log";
import { MAX_CHUNK_CHARS, ingestAiCrawlerChunk, type IngestOutcome } from "../modules/search/ai-crawler-store";
import { verifierFromEnv } from "../modules/search/ai-crawler-verify";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ParsedArgs =
  | { mode: "grep" }
  | { mode: "ingest"; tenantId: string; propertyId: string }
  | { mode: "error"; message: string };

export function parseArgs(argv: readonly string[]): ParsedArgs {
  if (argv.length === 1 && argv[0] === "--grep-pattern") return { mode: "grep" };
  let tenantId = "";
  let propertyId = "";
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k !== "--tenant" && k !== "--property") return { mode: "error", message: `unknown argument ${k}` };
    if (v === undefined || v.startsWith("--")) return { mode: "error", message: `${k} needs a value` };
    if (k === "--tenant") tenantId = v; else propertyId = v;
  }
  if (!UUID_RE.test(tenantId)) return { mode: "error", message: "--tenant must be a uuid" };
  if (!UUID_RE.test(propertyId)) return { mode: "error", message: "--property must be a uuid" };
  return { mode: "ingest", tenantId, propertyId };
}

/** One extended-regex alternation of every UA token the parser knows (robots-only bots have none), for `grep -aiE`. */
export function grepPattern(): string {
  const tokens = AI_CRAWLERS.map((b) => b.uaToken).filter((t): t is string => t !== null);
  return [...new Set(tokens)].map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
}

/** Splits text into chunks of at most `max` characters on line boundaries. Blank lines are dropped. A single line longer
 *  than `max` cannot be sent whole and is dropped (no real access-log line is that long). */
export function chunkLines(text: string, max: number = MAX_CHUNK_CHARS): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let len = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.length > max) continue;
    if (len + line.length + 1 > max && cur.length) { out.push(cur.join("\n")); cur = []; len = 0; }
    cur.push(line);
    len += line.length + 1;
  }
  if (cur.length) out.push(cur.join("\n"));
  return out;
}

export interface RunSummary {
  chunks: number; new: number; duplicate: number; rows: number; stats: Record<string, number>;
}
export type RunResult = { ok: true; summary: RunSummary } | { ok: false; code: 3; reason: "no_property" };

export interface RunDeps {
  ingest: (p: { tenantId: string; propertyId: string; chunk: string; userId: null; verifier: ReturnType<typeof verifierFromEnv> }) => Promise<IngestOutcome | "no_property">;
  activity: (tenantId: string, propertyId: string, summary: RunSummary, verification: string) => Promise<void>;
  verifier: () => ReturnType<typeof verifierFromEnv>;
}

const sumStats = (into: Record<string, number>, s: AggregateStats | null): void => {
  if (!s) return;
  for (const [k, v] of Object.entries(s as unknown as Record<string, unknown>)) if (typeof v === "number") into[k] = (into[k] ?? 0) + v;
};

/** Ingests the text chunk by chunk. A non-empty run writes one activity row with the summed counts. */
export async function runIngest(text: string, a: { tenantId: string; propertyId: string }, deps: RunDeps): Promise<RunResult> {
  const chunks = chunkLines(text);
  const summary: RunSummary = { chunks: chunks.length, new: 0, duplicate: 0, rows: 0, stats: {} };
  if (chunks.length === 0) return { ok: true, summary };
  const verifier = deps.verifier();
  let verification = verifier ? "ranges" : "claimed";
  for (const chunk of chunks) {
    const out = await deps.ingest({ tenantId: a.tenantId, propertyId: a.propertyId, chunk, userId: null, verifier });
    if (out === "no_property") return { ok: false, code: 3, reason: "no_property" };
    verification = out.verification;
    if (out.chunk === "new") summary.new += 1; else summary.duplicate += 1;
    summary.rows += out.rows;
    sumStats(summary.stats, out.stats);
  }
  await deps.activity(a.tenantId, a.propertyId, summary, verification);
  return { ok: true, summary };
}

async function readStdin(): Promise<string> {
  const parts: Buffer[] = [];
  for await (const p of process.stdin) parts.push(p as Buffer);
  return Buffer.concat(parts).toString("utf8");
}

/** The real dependencies. Imported lazily so `--grep-pattern` and the unit tests never open a database pool. */
async function realDeps(): Promise<RunDeps> {
  const { writeActivity } = await import("../core/http");
  return {
    ingest: ingestAiCrawlerChunk,
    verifier: verifierFromEnv,
    activity: async (tenantId, propertyId, s, verification) => {
      await writeActivity(tenantId, null, "ai_crawler_ingest", "search_property", propertyId, {
        chunks: s.chunks, new: s.new, duplicate: s.duplicate, rows: s.rows, verification, source: "pull", ...s.stats,
      });
    },
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.mode === "error") { console.error(`ai-crawler-ingest: ${args.message}`); return 2; }
  if (args.mode === "grep") { process.stdout.write(`${grepPattern()}\n`); return 0; }
  const { closePool } = await import("../db");
  try {
    const text = await readStdin();
    const r = await runIngest(text, args, await realDeps());
    if (!r.ok) { console.error(`ai-crawler-ingest: ${r.reason}`); return r.code; }
    process.stdout.write(`${JSON.stringify(r.summary)}\n`);
    return 0;
  } catch (e) {
    console.error(`ai-crawler-ingest: failed (${e instanceof Error ? e.name : "error"})`);
    return 1;
  } finally {
    await closePool();
  }
}

if (require.main === module) void main(process.argv.slice(2)).then((code) => process.exit(code));
