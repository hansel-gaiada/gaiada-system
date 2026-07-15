// WS9 domain metrics for the MCP hub. HTTP spans/latency come free from auto-instrumentation; this
// adds the tool-call signal the SLOs/dashboards read — every allow/deny decision and handler
// outcome, mirrored from the audit log (which stays the source of truth). No-op when OTEL is off.
import { metrics } from "@opentelemetry/api";
import type { ToolAudit } from "./audit";

const meter = metrics.getMeter("gaiada/mcp-hub");

const toolCalls = meter.createCounter("hub_tool_calls_total", {
  description: "MCP tool-call decisions, by tool, decision (allow/deny) and handler outcome",
});

// recordToolAudit mirrors one audit row as a metric. `ok` is only meaningful when allowed.
export function recordToolAudit(e: ToolAudit): void {
  toolCalls.add(1, {
    tool: e.tool,
    decision: e.decision,
    ok: e.decision === "allow" ? String(e.ok ?? true) : "n/a",
    reason: e.reason ?? "",
  });
}
