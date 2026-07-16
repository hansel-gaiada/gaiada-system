// Package telemetry is the gateway's WS9 OpenTelemetry bootstrap. It is deliberately its OWN
// per-service module (components are separate standalone projects — no shared telemetry package),
// mirroring how each Go service already carries its own tls/config packages.
//
// Design contract (identical across every WS9-instrumented service):
//   - FAIL-SOFT: the SDK starts only when OTEL_ENABLED is truthy. Unset ⇒ Init is a no-op that
//     returns a no-op shutdown, so the service still runs bare (dev, tests, air-gapped) with global
//     no-op providers. A telemetry backend is never a hard dependency of the data plane.
//   - Standard OTLP/HTTP exporters that honor OTEL_EXPORTER_OTLP_ENDPOINT (default
//     http://localhost:4318) + OTEL_SERVICE_NAME, so wiring is env-only.
//   - W3C trace-context propagation is set globally so traceparent flows across HTTP hops
//     (surface → Gateway → MCP → platform → sync) once every service runs this.
package telemetry

import (
	"context"
	"errors"
	"os"
	"strings"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

// Enabled reports whether OTel export is switched on for this process.
func Enabled() bool {
	v := os.Getenv("OTEL_ENABLED")
	return v == "1" || strings.EqualFold(v, "true") || strings.EqualFold(v, "yes")
}

// noop is returned as the shutdown function whenever telemetry is disabled or partly fails.
func noop(context.Context) error { return nil }

// Init wires trace + metric providers and the W3C propagator, returning a shutdown func that
// flushes and closes them. When OTEL_ENABLED is unset it is a no-op — never an error, never fatal.
// serviceName is the default; OTEL_SERVICE_NAME (if set) wins, matching OTel convention.
func Init(ctx context.Context, serviceName string) (func(context.Context) error, error) {
	// Propagator is always safe to install; with no provider it just means inbound traceparent
	// is honored for context but no new spans are recorded.
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{}, propagation.Baggage{},
	))
	if !Enabled() {
		return noop, nil
	}

	if n := os.Getenv("OTEL_SERVICE_NAME"); n != "" {
		serviceName = n
	}
	// NewSchemaless (no schema URL) so merging with resource.Default() — whose bundled semconv
	// schema may differ from ours — never errors with a "conflicting Schema URL". service.name is a
	// stable attribute key across semconv versions.
	res, err := resource.Merge(resource.Default(), resource.NewSchemaless(
		semconv.ServiceName(serviceName),
	))
	if err != nil {
		return noop, err
	}

	traceExp, err := otlptracehttp.New(ctx)
	if err != nil {
		return noop, err
	}
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(traceExp),
		sdktrace.WithResource(res),
	)
	otel.SetTracerProvider(tp)

	metricExp, err := otlpmetrichttp.New(ctx)
	if err != nil {
		// Traces are up; don't lose them because metrics failed. Shut trace down on the way out.
		_ = tp.Shutdown(ctx)
		return noop, err
	}
	mp := sdkmetric.NewMeterProvider(
		sdkmetric.WithReader(sdkmetric.NewPeriodicReader(metricExp, sdkmetric.WithInterval(15*time.Second))),
		sdkmetric.WithResource(res),
	)
	otel.SetMeterProvider(mp)

	shutdown := func(c context.Context) error {
		return errors.Join(tp.Shutdown(c), mp.Shutdown(c))
	}
	return shutdown, nil
}
