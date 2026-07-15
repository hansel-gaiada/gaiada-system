// Package metrics exposes the sync engine's WS9 domain metrics. These are the signals the WS9 SLOs
// and dashboards read: how many events reconcile, how many get rejected to the anomaly path (the D5
// ACL boundary), conflict volume, and — the freshness SLI — how long since the last successful sync
// cycle. All instruments are no-ops when OTEL is disabled, so callers record unconditionally.
package metrics

import (
	"context"
	"sync/atomic"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

type Instruments struct {
	applied   metric.Int64Counter
	rejected  metric.Int64Counter
	conflicts metric.Int64Counter
	cycles    metric.Int64Counter
	events    metric.Int64Counter

	// lastSuccessUnix drives the sync_seconds_since_last_success freshness gauge. 0 = never yet.
	lastSuccessUnix atomic.Int64
	// now is injectable for tests; defaults to time.Now.
	now func() time.Time
}

func New() *Instruments {
	m := otel.Meter("gaiada/sync-engine-go")
	in := &Instruments{now: time.Now}
	in.applied, _ = m.Int64Counter("sync_events_applied_total",
		metric.WithDescription("Cross-site events successfully reconciled/applied"))
	in.rejected, _ = m.Int64Counter("sync_events_rejected_total",
		metric.WithDescription("Events rejected to the anomaly path, by reason (D5 ACL / malformed)"))
	in.conflicts, _ = m.Int64Counter("sync_conflicts_total",
		metric.WithDescription("Field-level conflicts recorded during apply, by resolution"))
	in.cycles, _ = m.Int64Counter("sync_cycles_total",
		metric.WithDescription("Sync push/pull cycles, by op and result"))
	in.events, _ = m.Int64Counter("sync_events_transferred_total",
		metric.WithDescription("Events moved by a sync cycle, by op (push/pull)"))

	secondsSince, _ := m.Float64ObservableGauge("sync_seconds_since_last_success",
		metric.WithDescription("Seconds since the last successful sync cycle — the freshness SLI"),
		metric.WithUnit("s"))
	if secondsSince != nil {
		_, _ = m.RegisterCallback(func(ctx context.Context, o metric.Observer) error {
			last := in.lastSuccessUnix.Load()
			if last == 0 {
				return nil // never synced yet — don't emit a misleading huge age
			}
			o.ObserveFloat64(secondsSince, in.now().Sub(time.Unix(last, 0)).Seconds())
			return nil
		}, secondsSince)
	}
	return in
}

func (in *Instruments) RecordApplied(ctx context.Context, n int) {
	if in == nil || in.applied == nil || n <= 0 {
		return
	}
	in.applied.Add(ctx, int64(n))
}

func (in *Instruments) RecordRejected(ctx context.Context, reason string) {
	if in == nil || in.rejected == nil {
		return
	}
	in.rejected.Add(ctx, 1, metric.WithAttributes(attribute.String("reason", reason)))
}

func (in *Instruments) RecordConflict(ctx context.Context, resolution string) {
	if in == nil || in.conflicts == nil {
		return
	}
	in.conflicts.Add(ctx, 1, metric.WithAttributes(attribute.String("resolution", resolution)))
}

// RecordCycle logs one push/pull cycle outcome and, on success, advances the freshness clock and
// counts the events moved.
func (in *Instruments) RecordCycle(ctx context.Context, op string, ok bool, events int) {
	if in == nil {
		return
	}
	result := "ok"
	if !ok {
		result = "err"
	}
	if in.cycles != nil {
		in.cycles.Add(ctx, 1, metric.WithAttributes(attribute.String("op", op), attribute.String("result", result)))
	}
	if ok {
		in.lastSuccessUnix.Store(in.now().Unix())
		if in.events != nil && events > 0 {
			in.events.Add(ctx, int64(events), metric.WithAttributes(attribute.String("op", op)))
		}
	}
}
