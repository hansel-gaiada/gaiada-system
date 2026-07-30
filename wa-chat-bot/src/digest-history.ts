// Digest run history (1b): append-only record of each digest run (scheduled or manual),
// counts/status only — no message text, no digest body — so a long-lived file never
// becomes a PII sink. Same atomic-persist pattern as groups.ts's discovered-groups.json
// (tmp + rename, lazy load, bounded size, corrupt file starts empty).
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config";
import type { Slot } from "./window";

export type DigestTrigger = "scheduled" | "manual";

export interface DigestRecord {
  ts: number;
  slot: Slot;
  trigger: DigestTrigger;
  groupsCovered: number;
  delivered: number;
  failed: number;
  managementDelivered: boolean;
  error?: string;
}

/** Cap on the persisted run history — the ERP only ever shows recent runs. */
const MAX_HISTORY = 50;

let cache: DigestRecord[] | null = null;

function path(): string {
  return config.digestHistoryFile;
}

function normalize(r: Record<string, unknown>): DigestRecord {
  const slot = r.slot === "evening" ? "evening" : "noon";
  return {
    ts: Number(r.ts) || 0,
    slot,
    trigger: r.trigger === "manual" ? "manual" : "scheduled",
    groupsCovered: Number(r.groupsCovered) || 0,
    delivered: Number(r.delivered) || 0,
    failed: Number(r.failed) || 0,
    managementDelivered: Boolean(r.managementDelivered),
    ...(typeof r.error === "string" ? { error: r.error } : {}),
  };
}

/** Lazy-load from disk, newest-first. A missing or corrupt file is not an error — history
 *  simply starts empty and the next record rewrites it. */
function load(): DigestRecord[] {
  if (cache) return cache;
  if (!existsSync(path())) {
    cache = [];
    return cache;
  }
  try {
    const raw = JSON.parse(readFileSync(path(), "utf8")) as { history?: unknown[] };
    cache = Array.isArray(raw?.history)
      ? raw.history
          .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
          .map((r) => normalize(r))
      : [];
  } catch {
    cache = [];
  }
  return cache;
}

/** Atomically persist (tmp + rename). Best-effort: a read-only volume degrades to
 *  in-memory-only history rather than breaking the digest run it's recording. */
function persist(): void {
  const p = path();
  try {
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    writeFileSync(tmp, `${JSON.stringify({ history: cache ?? [] }, null, 2)}\n`, "utf8");
    renameSync(tmp, p);
  } catch (err) {
    console.warn(`[digest-history] could not persist to ${p}: ${(err as Error).message}`);
  }
}

/** Append one record (newest-first), keeping only the last MAX_HISTORY. */
export function recordDigestRun(entry: DigestRecord): void {
  const history = load();
  history.unshift(entry);
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  persist();
}

/** Newest-first, capped to `limit` (which is itself capped to MAX_HISTORY — there is
 *  never more than that persisted). */
export function digestHistory(limit: number = MAX_HISTORY): DigestRecord[] {
  return load().slice(0, Math.max(0, Math.min(limit, MAX_HISTORY)));
}

/** Test-only: drop the in-memory cache so the next call re-hydrates from disk (or starts
 *  empty), mirroring resetRegistryCache()'s role for groups.ts. */
export function resetDigestHistoryCache(): void {
  cache = null;
}
