// AIP-03b — fire-and-forget AI usage reporter. This service has no platform database, so each gateway call it makes is queued here and
// POSTed in batches to platform-nest `POST /api/internal/ai-usage` (service token), which writes the `ai_usage_events` row.
// The same file is copied into mcp-hub and wa-chat-bot (no shared library); keep the three identical.
//
// Rules: NEVER awaited on the call path and NEVER throws. Flush every 5 s or at 50 events. A batch is retried once, then dropped with one
// warning that carries counts only (never event content). The queue holds 1000: when full the OLDEST event is dropped and counted. An event with
// no company uuid is not queued (logged once). Off (one log line at boot) unless PLATFORM_URL and PLATFORM_SERVICE_TOKEN are both set.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One call, ids/counts/labels/money only: no text field exists. `occurredAt` is stamped when the event is reported. */
export interface UsageEvent {
  tenantId: string | null | undefined;
  userId?: string | null;
  surface: "agent" | "knowledge" | "bot" | "other";
  capability: "llm" | "chat" | "embed" | "media";
  task?: string | null;
  provider?: string | null;
  model?: string | null;
  /** The tier the gateway applied (AIP-06/07): fast, standard or strong; absent when none was applied. */
  tier?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  tokensSource: "provider" | "estimate" | "none";
  costUsd?: number | null;
  costSource?: "provider" | null;
  outcome: "ok" | "blocked_dlp" | "blocked_budget" | "error";
  runId?: string | null;
}

export interface ReporterOptions {
  url?: string; token?: string; fetchImpl?: typeof fetch; flushMs?: number; batchSize?: number; maxQueue?: number; log?: (line: string) => void;
}

export interface UsageReporter {
  readonly enabled: boolean; report(event: UsageEvent): void; flush(): Promise<void>; stop(): void; dropped(): number;
}

export function createUsageReporter(o: ReporterOptions = {}): UsageReporter {
  const log = o.log ?? ((l: string) => console.warn(l));
  const url = (o.url ?? process.env.PLATFORM_URL ?? "").replace(/\/+$/, "");
  const token = o.token ?? process.env.PLATFORM_SERVICE_TOKEN ?? "";
  const doFetch = o.fetchImpl ?? fetch;
  const flushMs = o.flushMs ?? 5000, batchSize = o.batchSize ?? 50, maxQueue = o.maxQueue ?? 1000;
  const enabled = url !== "" && token !== "";
  let queue: Array<Record<string, unknown>> = [], droppedTotal = 0, noTenantLogged = false, flushing: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (!enabled) safely(() => log("[ai-usage] reporter off: PLATFORM_URL and PLATFORM_SERVICE_TOKEN are not both set, so AI calls here are not recorded"));

  function safely(fn: () => void): void { try { fn(); } catch { /* a reporter never throws */ } }
  async function post(batch: Array<Record<string, unknown>>): Promise<boolean> {
    try {
      const res = await doFetch(`${url}/api/internal/ai-usage`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ events: batch }), signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch { return false; }
  }
  async function drain(): Promise<void> {
    while (queue.length > 0) {
      const batch = queue.splice(0, batchSize);
      if (!(await post(batch)) && !(await post(batch))) safely(() => log(`[ai-usage] platform unreachable: dropped a batch of ${batch.length} usage events after one retry`));
    }
  }
  function flush(): Promise<void> {
    if (timer) { clearTimeout(timer); timer = undefined; }
    flushing ??= drain().catch(() => undefined).finally(() => { flushing = null; if (queue.length > 0) schedule(); });
    return flushing;
  }
  function schedule(): void {
    if (timer || !enabled) return;
    timer = setTimeout(() => { timer = undefined; void flush(); }, flushMs);
    timer.unref?.();
  }
  return {
    enabled,
    report(event) {
      safely(() => {
        if (!enabled) return;
        if (typeof event.tenantId !== "string" || !UUID.test(event.tenantId)) {
          if (!noTenantLogged) { noTenantLogged = true; log("[ai-usage] a gateway call had no company id: no usage event for it (logged once)"); }
          return;
        }
        if (queue.length >= maxQueue) { queue.shift(); droppedTotal++; }
        queue.push({ ...event, occurredAt: new Date().toISOString() });
        if (queue.length >= batchSize) void flush(); else schedule();
      });
    },
    flush: () => flush().catch(() => undefined),
    stop() { if (timer) clearTimeout(timer); timer = undefined; queue = []; },
    dropped: () => droppedTotal,
  };
}

/** The process-wide reporter, built from PLATFORM_URL and PLATFORM_SERVICE_TOKEN when this module first loads (at boot). */
export const usageReporter: UsageReporter = createUsageReporter();
