// ASST-04: response-side DLP on POST /complete/stream, end to end over the real SSE wire.
//
// Before ASST-04 this route had NO response-side DLP: dlp.DLP covered the prompt only, and both
// sinks — the streamed tokens and the single-chunk `emit(text)` fallback — went to the client
// raw. The tests here drive the actual HTTP route, not the scrubber in isolation, because the
// leak was in the wiring.
package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"gaiada/ai-gateway-go/internal/chain"
	"gaiada/ai-gateway-go/internal/config"
	"gaiada/ai-gateway-go/internal/providers"
)

// sseContent reassembles the response CONTENT from an SSE body: every `data:` line belonging
// to a default (message) event — i.e. any block that does NOT carry an `event:` line, which
// excludes both `event: error` and the ASST-10 `event: done` terminal — JSON-decoded (v2 wire
// grammar: each `data:` line is one line of JSON-encoded token text) and concatenated in order.
// The DLP scrubber emits at safe boundaries rather than once per provider token, so tests must
// assert over the reassembled payload rather than over individual events.
func sseContent(body string) string {
	var out strings.Builder
	for _, block := range strings.Split(body, "\n\n") {
		if block == "" || strings.HasPrefix(block, "event:") {
			continue
		}
		for _, line := range strings.Split(block, "\n") {
			if rest, ok := strings.CutPrefix(line, "data: "); ok {
				var tok string
				if err := json.Unmarshal([]byte(rest), &tok); err == nil {
					out.WriteString(tok)
				}
			}
		}
	}
	return out.String()
}

// contentDataEventCount counts default (message) events on the wire — blocks with a data:
// line and no event: line. Excludes `event: error` and the ASST-10 `event: done` terminal, so
// a test asserting "exactly one content event" is not thrown off by the new terminal frame.
func contentDataEventCount(body string) int {
	n := 0
	for _, block := range strings.Split(body, "\n\n") {
		if block == "" || strings.HasPrefix(block, "event:") {
			continue
		}
		if strings.Contains(block, "data: ") {
			n++
		}
	}
	return n
}

// streamOnce drives the SSE route once and returns the raw body.
func streamOnce(t *testing.T, ps []providers.Provider) string {
	t.Helper()
	c := chain.NewChain(ps, 3, 60_000, time.Now)
	cfg := config.Config{GatewayToken: "secret", DailyCallCap: 1000, PerTenantDailyCallCap: 1000}
	srv := newTestServer(t, cfg, c)
	defer srv.Close()

	req, _ := http.NewRequest("POST", srv.URL+"/complete/stream", bytes.NewReader([]byte(`{"prompt":"hi"}`)))
	req.Header.Set("Authorization", "Bearer secret")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return string(b)
}

// piiProvider is a NON-streaming provider (Provider only, no CompleteStream) whose answer
// contains PII — it drives the single-chunk fallback sink.
type piiProvider struct {
	name string
	text string
}

func (p *piiProvider) Name() string    { return p.name }
func (p *piiProvider) Available() bool { return true }
func (p *piiProvider) Complete(_ context.Context, _ string) (string, error) {
	return p.text, nil
}
func (p *piiProvider) Media(_ context.Context, _, _ string) (string, error) { return "", nil }
func (p *piiProvider) Embed(_ context.Context, _ string) ([]float64, error) { return nil, nil }

// THE headline end-to-end test. A Luhn-valid PAN is split across two provider tokens so that
// neither fragment holds enough digits for the PAN pattern to fire — the exact case a per-token
// scrub would pass through while every happy-path assertion stayed green.
func TestCompleteStreamRedactsPanSplitAcrossProviderTokens(t *testing.T) {
	const pan = "4111 1111 1111 1111"
	p := &fakeStreamingProvider{name: "leaky", tokens: []string{
		"Sure — the payment method we have on file for that invoice is card ",
		"4111 1111 ", // 8 digits: matches nothing on its own
		"1111 1111",  // 8 digits: matches nothing on its own
		", expiring next year.",
	}}
	got := streamOnce(t, []providers.Provider{p})
	payload := sseContent(got)

	if strings.Contains(payload, pan) {
		t.Fatalf("PII LEAK on the SSE wire: the split PAN arrived in full: %q", payload)
	}
	if strings.Contains(payload, "4111") || strings.Contains(payload, "1111") {
		t.Fatalf("PII LEAK on the SSE wire: card digits arrived: %q", payload)
	}
	if !strings.Contains(payload, "[REDACTED-CARD]") {
		t.Fatalf("expected the redaction sentinel on the wire, got %q", payload)
	}
	// Nothing may be lost either: the prose around the PAN must arrive complete, and the tail
	// the scrubber holds back until stream end must actually be flushed.
	if !strings.Contains(payload, "Sure — the payment method") || !strings.Contains(payload, "expiring next year.") {
		t.Fatalf("expected the surrounding prose to arrive intact (no truncation), got %q", payload)
	}
	if strings.Contains(got, "event: error") {
		t.Fatalf("expected no error event, got %q", got)
	}
}

// A national ID split across token boundaries. nik16 requires all 16 digits between word
// boundaries, so any split at all defeats a per-token scrub.
func TestCompleteStreamRedactsKtpSplitAcrossProviderTokens(t *testing.T) {
	p := &fakeStreamingProvider{name: "leaky", tokens: []string{
		"Data karyawan yang kamu minta sudah saya cek, NIK-nya ",
		"32011508", "12001234", " dan alamatnya menyusul.",
	}}
	payload := sseContent(streamOnce(t, []providers.Provider{p}))

	if strings.Contains(payload, "3201150812001234") {
		t.Fatalf("PII LEAK on the SSE wire: the NIK arrived in full: %q", payload)
	}
	if !strings.Contains(payload, "[REDACTED-ID]") {
		t.Fatalf("expected [REDACTED-ID] on the wire, got %q", payload)
	}
	if !strings.Contains(payload, "dan alamatnya menyusul.") {
		t.Fatalf("expected the held tail to be flushed, got %q", payload)
	}
}

// The single-chunk fallback: a provider WITHOUT CompleteStream returns its whole answer at once
// and the route emits it as one SSE event. That sink was equally unscrubbed before ASST-04.
func TestCompleteStreamSingleChunkFallbackIsScrubbed(t *testing.T) {
	p := &piiProvider{name: "nonstreaming", text: "Detail klien: rekening 1234567890, NIK 3201150812001234, kartu 4111111111111111."}
	got := streamOnce(t, []providers.Provider{p})
	payload := sseContent(got)

	for _, pii := range []string{"1234567890", "3201150812001234", "4111111111111111"} {
		if strings.Contains(payload, pii) {
			t.Fatalf("PII LEAK on the non-streaming fallback path (%s): %q", pii, payload)
		}
	}
	for _, sentinel := range []string{"[REDACTED-ACCT]", "[REDACTED-ID]", "[REDACTED-CARD]"} {
		if !strings.Contains(payload, sentinel) {
			t.Fatalf("expected %s on the fallback path, got %q", sentinel, payload)
		}
	}
	// Still exactly one content event — ASST-04 must not fragment the fallback wire contract.
	// (Counted via contentDataEventCount, not a raw "data: " substring count, because ASST-10's
	// event: done terminal adds a second data: line that is not part of the content.)
	if n := contentDataEventCount(got); n != 1 {
		t.Fatalf("expected the fallback to stay a single SSE data event, got %d in %q", n, got)
	}
}

// A clean response must arrive byte-identical: response-side DLP that mangles ordinary answers
// is worse than none.
func TestCompleteStreamCleanResponseIsByteIdentical(t *testing.T) {
	tokens := []string{
		"Project Alpha ", "is behind schedule; ", "PO 2024-00123 ", "and PO 2024-00124 ",
		"are ready, the meeting is at 08.30 ", "in room 12, budget is 15000000 rupiah ",
		"for Q3. Order 1234567890123456 shipped, SKU ABC12345 restocked.",
	}
	p := &fakeStreamingProvider{name: "clean", tokens: tokens}
	if got, want := sseContent(streamOnce(t, []providers.Provider{p})), strings.Join(tokens, ""); got != want {
		t.Fatalf("clean response was not byte-identical:\n  got  %q\n  want %q", got, want)
	}
}

// ASST-04 × ASST-03: the case the original two-word mid-stream fixture became. When a provider
// dies while ALL of its output is still inside the DLP trailing buffer, nothing has reached the
// client, so failover is still correct — and the buffered bytes must be DISCARDED. Flushing them
// instead would prefix the dead provider's partial answer onto the second provider's full
// answer: exactly the duplicated/corrupt output ASST-03 closed.
func TestCompleteStreamShortBufferedOutputStillFailsOverCleanly(t *testing.T) {
	first := &fakeStreamingProvider{
		name:      "first",
		tokens:    []string{"hello", "world"}, // 10 bytes — entirely inside the 37-byte hold window
		failAfter: errors.New("upstream died mid-generation"),
	}
	second := &fakeStreamingProvider{name: "second", tokens: []string{"the complete fallback answer arrives alone"}}
	got := streamOnce(t, []providers.Provider{first, second})
	payload := sseContent(got)

	// The load-bearing assertion: the discarded attempt's output must NOT be prefixed onto the
	// winning provider's answer.
	if want := "the complete fallback answer arrives alone"; payload != want {
		t.Fatalf("buffered output from the failed attempt contaminated the response:\n  got  %q\n  want %q", payload, want)
	}
	if strings.Contains(got, "event: error") {
		t.Fatalf("nothing had reached the client, so this must be a clean failover with no error event, got %q", got)
	}
	if first.calls != 1 || second.calls != 1 {
		t.Fatalf("expected one attempt each, got first=%d second=%d", first.calls, second.calls)
	}
}
