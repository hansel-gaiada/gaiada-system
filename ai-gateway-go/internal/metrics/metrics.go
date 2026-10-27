// Package metrics exposes the gateway's WS9 domain metrics via the OTel meter. It WRAPS the
// gateway's existing telemetry sources (the egress audit and the cost budget) rather than adding a
// parallel accounting path — the audit/budget remain the source of truth, this just mirrors them as
// metrics. All instruments are no-ops when OTEL is disabled (the global meter is a no-op provider),
// so callers record unconditionally with no branching.
package metrics

import (
	"context"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

// BudgetSnapshot is the typed shape the budget exposes to the observable gauges (decoupled from the
// budget package's map return so metrics has no import cycle risk).
type BudgetSnapshot struct {
	Used, Cap, Tenants, PerTenantCap int
	DRMode                           bool // WS9 D15 DR-burst mode active
}

// Instruments holds the gateway's metric instruments. Nil-safe: a failed instrument creation leaves
// the field nil and the corresponding recorder becomes a no-op.
type Instruments struct {
	meter         metric.Meter
	egressTotal   metric.Int64Counter
	egressLatency metric.Float64Histogram
	agentTotal    metric.Int64Counter // AIP-00a-4: agent calls by agent + outcome
	agentTokens   metric.Int64Counter // AIP-00a-4: agent tokens by agent + kind
}

// New builds the instruments from the global meter. Instrument-creation errors are non-fatal (the
// field stays nil); telemetry must never take down the data plane.
func New() *Instruments { return NewWithMeter(otel.Meter("gaiada/ai-gateway-go")) }

// NewWithMeter is New against an explicit meter (tests read it back through a manual reader).
func NewWithMeter(m metric.Meter) *Instruments {
	in := &Instruments{meter: m}
	in.egressTotal, _ = m.Int64Counter("gateway_egress_requests_total",
		metric.WithDescription("AI egress attempts by capability, served provider, outcome and block reason"))
	in.egressLatency, _ = m.Float64Histogram("gateway_egress_latency_ms",
		metric.WithDescription("AI egress request latency in milliseconds"),
		metric.WithUnit("ms"))
	in.agentTotal, _ = m.Int64Counter("gateway_agent_requests_total",
		metric.WithDescription("Agent-listener calls by registered agent (or unknown) and outcome: ok or the audit's blocked value"))
	in.agentTokens, _ = m.Int64Counter("gateway_agent_tokens_total",
		metric.WithDescription("Provider-reported tokens on agent-listener calls, by agent and kind (prompt|completion)"))
	return in
}

// UnknownAgent is the label for an agent call that did not authenticate: the presented token (or
// any part of it) is never a label, so cardinality stays at the registered names plus this one.
const UnknownAgent = "unknown"

// RecordAgentCall records one agent-listener call. agent is "" for an unauthenticated call (recorded
// as agent="unknown"); blocked is "" on success (outcome "ok"), else the audit's blocked value.
// Token counts are only the provider-reported ones (0 = none reported, nothing recorded).
func (in *Instruments) RecordAgentCall(ctx context.Context, agent, blocked string, promptTokens, completionTokens int) {
	if in == nil {
		return
	}
	if agent == "" {
		agent = UnknownAgent
	}
	outcome := blocked
	if outcome == "" {
		outcome = "ok"
	}
	if in.agentTotal != nil {
		in.agentTotal.Add(ctx, 1, metric.WithAttributes(
			attribute.String("agent", agent), attribute.String("outcome", outcome)))
	}
	if in.agentTokens != nil {
		if promptTokens > 0 {
			in.agentTokens.Add(ctx, int64(promptTokens), metric.WithAttributes(
				attribute.String("agent", agent), attribute.String("kind", "prompt")))
		}
		if completionTokens > 0 {
			in.agentTokens.Add(ctx, int64(completionTokens), metric.WithAttributes(
				attribute.String("agent", agent), attribute.String("kind", "completion")))
		}
	}
}

// RegisterAgentBudget installs the observable gauge gateway_agent_budget_used_ratio{agent}: each
// named agent's calls today divided by its effective daily cap. It is read on EVERY collect, so it
// is current at each scrape and drops to 0 after the UTC day rolls even when the agent is idle
// (the budget reports stale-day counters as zero). read returns (used, cap); cap <= 0 emits nothing
// for that agent. names is the registered set, which bounds the label's cardinality.
func (in *Instruments) RegisterAgentBudget(names []string, read func(agent string) (used, cap int)) {
	if in == nil || in.meter == nil || len(names) == 0 {
		return
	}
	g, err := in.meter.Float64ObservableGauge("gateway_agent_budget_used_ratio",
		metric.WithDescription("An agent's calls today divided by its effective daily cap (0 after the UTC day rolls)"))
	if err != nil || g == nil {
		return
	}
	list := append([]string(nil), names...)
	_, _ = in.meter.RegisterCallback(func(_ context.Context, o metric.Observer) error {
		for _, a := range list {
			used, cap := read(a)
			if cap <= 0 {
				continue
			}
			o.ObserveFloat64(g, float64(used)/float64(cap), metric.WithAttributes(attribute.String("agent", a)))
		}
		return nil
	}, g)
}

// RecordEgress mirrors one egress-audit row as metrics. blocked is "" on success.
func (in *Instruments) RecordEgress(ctx context.Context, capability, provider string, ok bool, blocked string, latencyMs int64) {
	if in == nil {
		return
	}
	attrs := []attribute.KeyValue{
		attribute.String("capability", capability),
		attribute.Bool("ok", ok),
	}
	if provider != "" {
		attrs = append(attrs, attribute.String("provider", provider))
	}
	if blocked != "" {
		attrs = append(attrs, attribute.String("blocked", blocked))
	}
	if in.egressTotal != nil {
		in.egressTotal.Add(ctx, 1, metric.WithAttributes(attrs...))
	}
	// Only time requests that reached a provider decision (latency is meaningless for auth denials).
	if in.egressLatency != nil && latencyMs > 0 {
		in.egressLatency.Record(ctx, float64(latencyMs), metric.WithAttributes(
			attribute.String("capability", capability)))
	}
}

// RegisterBudgetGauges installs observable gauges that read the live budget snapshot on each collect.
// read is the budget's snapshot accessor. Registration errors are non-fatal.
func RegisterBudgetGauges(read func() BudgetSnapshot) {
	m := otel.Meter("gaiada/ai-gateway-go")
	used, _ := m.Int64ObservableGauge("gateway_budget_calls_used",
		metric.WithDescription("AI calls spent against the daily cap today"))
	capg, _ := m.Int64ObservableGauge("gateway_budget_calls_cap",
		metric.WithDescription("Daily AI call cap"))
	tenants, _ := m.Int64ObservableGauge("gateway_budget_active_tenants",
		metric.WithDescription("Distinct tenants that spent against the budget today"))
	drMode, _ := m.Int64ObservableGauge("gateway_dr_mode",
		metric.WithDescription("1 while the WS9 D15 DR-burst budget is unlocked, else 0"))
	if used == nil || capg == nil || tenants == nil || drMode == nil {
		return
	}
	_, _ = m.RegisterCallback(func(ctx context.Context, o metric.Observer) error {
		s := read()
		o.ObserveInt64(used, int64(s.Used))
		o.ObserveInt64(capg, int64(s.Cap))
		o.ObserveInt64(tenants, int64(s.Tenants))
		if s.DRMode {
			o.ObserveInt64(drMode, 1)
		} else {
			o.ObserveInt64(drMode, 0)
		}
		return nil
	}, used, capg, tenants, drMode)
}
