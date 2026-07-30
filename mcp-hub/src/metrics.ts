// WS9 domain metrics for the MCP hub. HTTP spans/latency come free from auto-instrumentation; this
// adds the tool-call signal the SLOs/dashboards read — every allow/deny decision and handler
// outcome, mirrored from the audit log (which stays the source of truth). No-op when OTEL is off.
import { metrics } from "@opentelemetry/api";
import type { ToolAudit } from "./audit";
import { moduleToolsStatus } from "./module-tools";

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

// SM-45: the module-tools bootstrap (WS2 §6 aggregation from the platform's /mcp/tool-defs) is
// fail-soft by design and previously froze at zero with no alarm past one boot-time log line. This
// makes the live state a first-class signal for the SLO/alerting dashboards, mirroring the
// hub_tool_calls_total pattern above (read from moduleToolsStatus(), which stays the source of
// truth for /health and /admin/info).
meter
  .createObservableGauge("hub_module_tools_registered", {
    description: "Module-contributed MCP tools currently registered from the platform's /mcp/tool-defs (sustained 0 after boot indicates the aggregation is stuck, not merely cold)",
  })
  .addCallback((result) => result.observe(moduleToolsStatus().registered));

meter
  .createObservableGauge("hub_module_tools_consecutive_failures", {
    description: "Consecutive failed /mcp/tool-defs fetch attempts since the last success (alert on sustained > 0)",
  })
  .addCallback((result) => result.observe(moduleToolsStatus().consecutiveFailures));
