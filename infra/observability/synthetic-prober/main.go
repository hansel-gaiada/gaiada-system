// WS9 synthetic journey prober. Blackbox covers HTTP *liveness*; this covers functional *journeys* —
// it actually drives an authenticated request end-to-end (e.g. an AI completion through the Gateway's
// provider chain) and reports whether the journey succeeded with the expected status, plus its
// latency, as OTel metrics (`synthetic_journey_up`, `synthetic_journey_duration_ms`). The WS9 SLOs
// alert on `synthetic_journey_up == 0`.
//
// Journeys are declared as JSON (env PROBER_JOURNEYS or file PROBER_JOURNEYS_FILE), so adding a new
// user-journey probe is config, not code. Secrets (bearer tokens) are injected via ${ENV} expansion
// in the header value so they never sit in the journey file.
//
// ── 2026-08-23: THE BLIND SPOT THIS FILE USED TO HAVE (tracker B16) ───────────────────────────────
// A journey asserting only `expectStatus: 200` + a body substring CANNOT SEE A PRIMARY-PROVIDER
// OUTAGE, because the Gateway fails over and still returns 200 with text. That is not theoretical:
// Hermes was wedged for 24h while `gateway-complete` reported ok=true the entire time, and the
// estate only found out by reading the shim's journal by hand.
//
// The fix is `recordJSON`: named top-level response fields become METRIC ATTRIBUTES, so
// `synthetic_journey_up{journey="gateway-complete",provider="gemini"}` makes WHICH provider served
// visible to alerting. Failover stops being silent without being treated as an outage — a working
// fallback should be *visible*, not page-worthy, and `expectJSON` is there for the cases that truly
// must fail.
//
// `intervalMs`/`timeoutMs` are PER-JOURNEY (tracker H0d2). One global interval forced a real
// tradeoff: the LLM journey ran at health-check cadence (30s = 2,880 calls/day) and exhausted the
// Gateway's 2,000/day cap, which then 429'd REAL USER TRAFFIC for the rest of every day. Cheap
// liveness probes and expensive functional probes do not belong on the same clock.
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
	// Top-level JSON response fields that MUST equal these values, else the journey fails. Use for
	// invariants, not for things that are allowed to vary (a working failover is not a failure).
	ExpectJSON map[string]string `json:"expectJSON"`
	// Top-level JSON response fields whose VALUE becomes a metric attribute. This is how a silent
	// degradation becomes visible: record `provider` and failover shows up as a label change.
	RecordJSON []string `json:"recordJSON"`
	// Per-journey overrides. Zero = fall back to the global PROBE_INTERVAL_MS / 10s client timeout.
	IntervalMs int `json:"intervalMs"`
	TimeoutMs  int `json:"timeoutMs"`
}

type result struct {
	up    float64
	durMs float64
	// Recorded response fields, surfaced as metric attributes (see recordJSON).
	attrs []attribute.KeyValue
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

	// Decode once for both expectJSON and recordJSON. A body that is not an object simply yields no
	// fields — it must not turn a healthy journey into a failure, so the error is deliberately
	// ignored and only DECLARED expectations can fail below.
	var fields map[string]any
	if len(j.ExpectJSON) > 0 || len(j.RecordJSON) > 0 {
		_ = json.Unmarshal(respBody, &fields)
	}

	for k, wantVal := range j.ExpectJSON {
		got, _ := fields[k].(string)
		if got != wantVal {
			ok = false
			log.Warn("journey field mismatch", "journey", j.Name, "field", k, "want", wantVal, "got", got)
		}
	}

	// Attributes are recorded even when the journey FAILED — knowing which provider served a bad
	// response is exactly the diagnostic that was missing before.
	attrs := make([]attribute.KeyValue, 0, len(j.RecordJSON))
	for _, k := range j.RecordJSON {
		v, _ := fields[k].(string)
		if v == "" {
			v = "unknown" // never emit an empty label — an absent value is itself a signal
		}
		attrs = append(attrs, attribute.String(k, v))
	}

	up := 0.0
	if ok {
		up = 1.0
	}
	logArgs := []any{"name", j.Name, "status", resp.StatusCode, "ok", ok, "ms", dur}
	for _, a := range attrs {
		logArgs = append(logArgs, string(a.Key), a.Value.AsString())
	}
	log.Info("journey", logArgs...)
	return result{up: up, durMs: dur, attrs: attrs}
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
			a := append([]attribute.KeyValue{attribute.String("journey", name)}, r.attrs...)
			o.ObserveFloat64(upG, r.up, metric.WithAttributes(a...))
			o.ObserveFloat64(durG, r.durMs, metric.WithAttributes(a...))
		}
		return nil
	}, upG, durG)

	intervalMs := 30000
	if v := os.Getenv("PROBE_INTERVAL_MS"); v != "" {
		if n, e := strconv.Atoi(v); e == nil && n > 0 {
			intervalMs = n
		}
	}
	log.Info("synthetic prober started", "journeys", len(journeys), "intervalMs", intervalMs)

	// One goroutine per journey, each on its OWN clock. A single shared ticker meant the slowest and
	// most expensive journey dictated the cadence of the cheapest — see the header note on the cap.
	var wg sync.WaitGroup
	for _, j := range journeys {
		wg.Add(1)
		go func(j Journey) {
			defer wg.Done()

			every := intervalMs
			if j.IntervalMs > 0 {
				every = j.IntervalMs
			}
			timeout := 10 * time.Second
			if j.TimeoutMs > 0 {
				timeout = time.Duration(j.TimeoutMs) * time.Millisecond
			}
			// Per-journey client: a shared 10s timeout was cutting off real LLM completions that
			// legitimately take 5–10s, producing "outages" that were only ever client-side.
			client := &http.Client{Timeout: timeout}
			log.Info("journey scheduled", "name", j.Name, "intervalMs", every, "timeoutMs", int(timeout/time.Millisecond))

			step := func() {
				r := runJourney(ctx, client, j)
				mu.Lock()
				results[j.Name] = r
				mu.Unlock()
			}
			step()
			t := time.NewTicker(time.Duration(every) * time.Millisecond)
			defer t.Stop()
			for range t.C {
				step()
			}
		}(j)
	}
	wg.Wait()
}
