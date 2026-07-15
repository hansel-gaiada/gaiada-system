// slog.go — structured JSON logging correlated to traces. WS9 pillar 3: every log line carries
// trace_id/span_id when emitted inside a span, so Loki logs join Tempo traces in Grafana. Logs go
// to stdout as JSON; the OTel Collector's filelog receiver ships them — the service stays decoupled
// from Loki.
package telemetry

import (
	"context"
	"log/slog"
	"os"

	"go.opentelemetry.io/otel/trace"
)

// traceHandler wraps a slog.Handler and, for records emitted within an active span, appends
// trace_id and span_id so the log correlates to the distributed trace.
type traceHandler struct{ slog.Handler }

func (h traceHandler) Handle(ctx context.Context, r slog.Record) error {
	if sc := trace.SpanContextFromContext(ctx); sc.IsValid() {
		r.AddAttrs(
			slog.String("trace_id", sc.TraceID().String()),
			slog.String("span_id", sc.SpanID().String()),
		)
	}
	return h.Handler.Handle(ctx, r)
}

func (h traceHandler) WithAttrs(as []slog.Attr) slog.Handler {
	return traceHandler{h.Handler.WithAttrs(as)}
}
func (h traceHandler) WithGroup(name string) slog.Handler {
	return traceHandler{h.Handler.WithGroup(name)}
}

// NewLogger returns a JSON slog.Logger with trace correlation, and also installs it as the process
// default so stdlib-style logging is structured too. service is added as a static field.
func NewLogger(service string) *slog.Logger {
	base := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})
	l := slog.New(traceHandler{base}).With(slog.String("service", service))
	slog.SetDefault(l)
	return l
}
