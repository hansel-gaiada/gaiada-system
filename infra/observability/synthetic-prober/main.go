// WS9 synthetic journey prober. Blackbox covers HTTP *liveness*; this covers functional *journeys* —
// it actually drives an authenticated request end-to-end (e.g. an AI completion through the Gateway's
// provider chain) and reports whether the journey succeeded with the expected status, plus its
// latency, as OTel metrics (`synthetic_journey_up`, `synthetic_journey_duration_ms`). The WS9 SLOs
// alert on `synthetic_journey_up == 0`.
//
// Journeys are declared as JSON (env PROBER_JOURNEYS or file PROBER_JOURNEYS_FILE), so adding a new
// user-journey probe is config, not code. Secrets (bearer tokens) are injected via ${ENV} expansion
// in the header value so they never sit in the journey file.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/metric"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

type Journey struct {
	Name         string            `json:"name"`
	Method       string            `json:"method"`
	URL          string            `json:"url"`
	Headers      map[string]string `json:"headers"`
	Body         string            `json:"body"`
	ExpectStatus int               `json:"expectStatus"`
	// Optional substring the response body must contain for the journey to count as a success.
	ExpectBody string `json:"expectBody"`
}

type result struct {
	up    float64
	durMs float64
}

var (
	mu      sync.Mutex
	results = map[string]result{}
	log     = slog.New(slog.NewJSONHandler(os.Stdout, nil)).With("service", "synthetic-prober")
)

// expandEnv replaces ${VAR} in a string with the environment value — used so bearer tokens are
// injected from env, not stored in the journey spec.
func expandEnv(s string) string { return os.Expand(s, os.Getenv) }

func runJourney(ctx context.Context, client *http.Client, j Journey) result {
	start := time.Now()
	method := j.Method
	if method == "" {
		method = http.MethodGet
	}
	var body *bytes.Reader
	if j.Body != "" {
		body = bytes.NewReader([]byte(j.Body))
	} else {
		body = bytes.NewReader(nil)
	}
	req, err := http.NewRequestWithContext(ctx, method, expandEnv(j.URL), body)
	if err != nil {
		log.Error("journey build failed", "journey", j.Name, "err", err.Error())
		return result{up: 0, durMs: float64(time.Since(start).Milliseconds())}
	}
	for k, v := range j.Headers {
		req.Header.Set(k, expandEnv(v))
	}
	resp, err := client.Do(req)
	dur := float64(time.Since(start).Milliseconds())
	if err != nil {
		log.Warn("journey request failed", "journey", j.Name, "err", err.Error())
		return result{up: 0, durMs: dur}
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	want := j.ExpectStatus
	if want == 0 {
		want = 200
	}
	ok := resp.StatusCode == want && (j.ExpectBody == "" || strings.Contains(string(respBody), j.ExpectBody))
	up := 0.0
	if ok {
		up = 1.0
	}
	log.Info("journey", "name", j.Name, "status", resp.StatusCode, "ok", ok, "ms", dur)
	return result{up: up, durMs: dur}
}

func loadJourneys() []Journey {
	raw := os.Getenv("PROBER_JOURNEYS")
	if f := os.Getenv("PROBER_JOURNEYS_FILE"); f != "" && raw == "" {
		b, err := os.ReadFile(f)
		if err != nil {
			log.Error("cannot read PROBER_JOURNEYS_FILE", "err", err.Error())
		} else {
			raw = string(b)
		}
	}
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	var js []Journey
	if err := json.Unmarshal([]byte(raw), &js); err != nil {
		log.Error("bad PROBER_JOURNEYS JSON", "err", err.Error())
		return nil
	}
	return js
}

func main() {
	journeys := loadJourneys()
	if len(journeys) == 0 {
		log.Warn("no journeys configured — set PROBER_JOURNEYS or PROBER_JOURNEYS_FILE. Idling.")
	}

	ctx := context.Background()
	exp, err := otlpmetrichttp.New(ctx)
	if err != nil {
		log.Error("otlp metric exporter init failed", "err", err.Error())
		os.Exit(1)
	}
	res, _ := resource.Merge(resource.Default(), resource.NewSchemaless(semconv.ServiceName("synthetic-prober")))
	mp := sdkmetric.NewMeterProvider(
		sdkmetric.WithReader(sdkmetric.NewPeriodicReader(exp, sdkmetric.WithInterval(15*time.Second))),
		sdkmetric.WithResource(res),
	)
	otel.SetMeterProvider(mp)
	defer func() { _ = mp.Shutdown(ctx) }()

	m := otel.Meter("gaiada/synthetic-prober")
	upG, _ := m.Float64ObservableGauge("synthetic_journey_up",
		metric.WithDescription("1 if the synthetic journey's last run met its expected status/body, else 0"))
	durG, _ := m.Float64ObservableGauge("synthetic_journey_duration_ms",
		metric.WithDescription("Last synthetic journey run duration"), metric.WithUnit("ms"))
	_, _ = m.RegisterCallback(func(ctx context.Context, o metric.Observer) error {
		mu.Lock()
		defer mu.Unlock()
		for name, r := range results {
			o.ObserveFloat64(upG, r.up, metric.WithAttributes(attribute.String("journey", name)))
			o.ObserveFloat64(durG, r.durMs, metric.WithAttributes(attribute.String("journey", name)))
		}
		return nil
	}, upG, durG)

	intervalMs := 30000
	if v := os.Getenv("PROBE_INTERVAL_MS"); v != "" {
		if n, e := strconv.Atoi(v); e == nil && n > 0 {
			intervalMs = n
		}
	}
	client := &http.Client{Timeout: 10 * time.Second}
	log.Info("synthetic prober started", "journeys", len(journeys), "intervalMs", intervalMs)

	ticker := time.NewTicker(time.Duration(intervalMs) * time.Millisecond)
	defer ticker.Stop()
	run := func() {
		for _, j := range journeys {
			r := runJourney(ctx, client, j)
			mu.Lock()
			results[j.Name] = r
			mu.Unlock()
		}
	}
	run()
	for range ticker.C {
		run()
	}
}
