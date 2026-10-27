package server

// AIP-02: /complete and /complete/stream report the openai provider's own token counts and cost.
// These tests drive the real handlers with the REAL OpenAIProvider against a stub upstream, so the
// wire shapes (usage event, additive `usage` object, audit row) are the ones callers see.

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"gaiada/ai-gateway-go/internal/chain"
	"gaiada/ai-gateway-go/internal/config"
	"gaiada/ai-gateway-go/internal/providers"
)

func stubUpstream(t *testing.T, contentType string, body string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", contentType)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func sse(lines ...string) string { return strings.Join(lines, "\n\n") + "\n\n" }

// usageGateway starts the gateway around one real openai provider and returns its base URL and
// the audit file path.
func usageGateway(t *testing.T, upstream *httptest.Server) (string, string) {
	t.Helper()
	return usageGatewayWith(t, upstream, "on")
}

// usageGatewayWith is usageGateway with OPENAI_NATIVE_STREAM set to the given value ("" = default off).
func usageGatewayWith(t *testing.T, upstream *httptest.Server, nativeStream string) (string, string) {
	t.Helper()
	p := providers.NewOpenAIProvider(upstream.URL, "k", "z-ai/glm-5.3-flash", "", 256, upstream.Client()).WithNativeStream(nativeStream)
	c := chain.NewChain([]providers.Provider{p}, 3, 60_000, time.Now)
	cfg := config.Config{GatewayToken: "secret", AuditFile: t.TempDir() + "/audit.jsonl", DailyCallCap: 1000, PerTenantDailyCallCap: 1000}
	srv := newTestServer(t, cfg, c)
	t.Cleanup(srv.Close)
	return srv.URL, cfg.AuditFile
}

func postBody(t *testing.T, base, path, body string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest("POST", base+path, bytes.NewReader([]byte(body)))
	req.Header.Set("Authorization", "Bearer secret")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

// usageDataLine returns the raw `data:` line of the `event: usage` block ("" if none).
func usageDataLine(body string) string {
	for _, block := range strings.Split(body, "\n\n") {
		if strings.HasPrefix(block, "event: usage\n") {
			return strings.TrimPrefix(strings.Split(block, "\n")[1], "data: ")
		}
	}
	return ""
}

const streamWithUsage = `data: {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}` + "\n\n" +
	`data: {"choices":[{"delta":{"content":"The quarterly summary is ready and it is long enough to clear the hold window."},"finish_reason":null}]}` + "\n\n" +
	`data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}]}` + "\n\n" +
	`data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":34,"total_tokens":46,"cost":0.00042}}` + "\n\n" +
	`data: [DONE]` + "\n\n"

func TestCompleteStreamOpenAIEmitsUsageEventWithCostAndSource(t *testing.T) {
	base, _ := usageGateway(t, stubUpstream(t, "text/event-stream", streamWithUsage))
	status, got := postBody(t, base, "/complete/stream", `{"prompt":"summarise"}`)
	if status != 200 {
		t.Fatalf("status %d: %s", status, got)
	}
	assertNoUnprefixedLines(t, got)
	if n := strings.Count(got, "event: usage"); n != 1 {
		t.Fatalf("expected exactly one usage event, got %d in %q", n, got)
	}
	if line := usageDataLine(got); line != `{"promptTokens":12,"completionTokens":34,"costUsd":0.00042,"source":"provider"}` {
		t.Fatalf("usage frame %q", line)
	}
	// the platform's parser reads promptTokens and completionTokens: both present and numeric.
	u := extractUsagePayload(t, got)
	if u.PromptTokens != 12 || u.CompletionTokens != 34 || u.CostUSD == nil || *u.CostUSD != 0.00042 || u.Source != "provider" {
		t.Fatalf("usage %+v", u)
	}
	// terminal order: meta ... tokens ... usage, done
	meta, usage, done := strings.Index(got, "event: meta"), strings.Index(got, "event: usage"), strings.Index(got, "event: done")
	if !(meta >= 0 && meta < usage && usage < done) {
		t.Fatalf("order meta<usage<done violated: %d %d %d in %q", meta, usage, done, got)
	}
	if !strings.Contains(got, `"model":"z-ai/glm-5.3-flash"`) || !strings.Contains(got, `"provider":"openai"`) {
		t.Fatalf("meta frame missing: %q", got)
	}
	if !strings.Contains(decodeDataLines(t, got), "The quarterly summary is ready") {
		t.Fatalf("answer text missing: %q", got)
	}
}

func TestCompleteStreamOpenAIWithoutCostOmitsCostUsd(t *testing.T) {
	body := sse(
		`data: {"choices":[{"delta":{"content":"This answer is comfortably longer than the scrubber hold window."},"finish_reason":"stop"}]}`,
		`data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":8}}`,
		`data: [DONE]`)
	base, _ := usageGateway(t, stubUpstream(t, "text/event-stream", body))
	_, got := postBody(t, base, "/complete/stream", `{"prompt":"x"}`)
	if line := usageDataLine(got); line != `{"promptTokens":5,"completionTokens":8,"source":"provider"}` {
		t.Fatalf("usage frame %q", line)
	}
}

func TestCompleteStreamOpenAINoUsageEmitsNoUsageEvent(t *testing.T) {
	body := sse(
		`data: {"choices":[{"delta":{"content":"An answer the upstream never counted, longer than the hold window."},"finish_reason":"stop"}]}`,
		`data: [DONE]`)
	base, auditPath := usageGateway(t, stubUpstream(t, "text/event-stream", body))
	_, got := postBody(t, base, "/complete/stream", `{"prompt":"x"}`)
	if strings.Contains(got, "event: usage") {
		t.Fatalf("no upstream usage must mean no usage event, got %q", got)
	}
	if !strings.Contains(got, "event: done") {
		t.Fatalf("stream must still finish: %q", got)
	}
	raw := waitForAuditLine(t, auditPath)
	for _, k := range []string{"promptTokens", "completionTokens", "costUsd"} {
		if strings.Contains(raw, k) {
			t.Fatalf("a row without usage must stay byte-identical (no %s): %s", k, raw)
		}
	}
}

func TestCompleteStreamOpenAIMalformedUsageChunkIsIgnored(t *testing.T) {
	body := sse(
		`data: {"choices":[{"delta":{"content":"A long enough answer that survives a broken usage chunk at the end."},"finish_reason":"stop"}]}`,
		`data: {"choices":[],"usage":{"prompt_tokens":"lots","completion_tokens":null}}`,
		`data: [DONE]`)
	base, _ := usageGateway(t, stubUpstream(t, "text/event-stream", body))
	status, got := postBody(t, base, "/complete/stream", `{"prompt":"x"}`)
	if status != 200 || strings.Contains(got, "event: usage") || strings.Contains(got, "event: error") || !strings.Contains(got, "event: done") {
		t.Fatalf("malformed usage must be ignored without breaking the stream: %d %q", status, got)
	}
}

func TestCompleteStreamOpenAIAuditRowCarriesCountsAndNoText(t *testing.T) {
	base, auditPath := usageGateway(t, stubUpstream(t, "text/event-stream", streamWithUsage))
	postBody(t, base, "/complete/stream", `{"prompt":"a distinctive prompt sentinel"}`)
	rows := waitForAuditRows(t, auditPath, 1, 2*time.Second)
	row := rows[0]
	if !row.OK || row.PromptTokens != 12 || row.CompletionTokens != 34 || row.CostUSD != 0.00042 || mustStr(row.Provider) != "openai" {
		t.Fatalf("row %+v", row)
	}
	raw, _ := os.ReadFile(auditPath)
	for _, leak := range []string{"quarterly", "sentinel", "summary"} {
		if strings.Contains(string(raw), leak) {
			t.Fatalf("audit row leaked text %q: %s", leak, raw)
		}
	}
}

func TestCompleteStreamOpenAIFailureAuditRowHasNoUsage(t *testing.T) {
	// the upstream sends usage but the generation ends in an error finish: no counts on the row.
	body := sse(
		`data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"error"}]}`,
		`data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}`,
		`data: [DONE]`)
	base, auditPath := usageGateway(t, stubUpstream(t, "text/event-stream", body))
	_, got := postBody(t, base, "/complete/stream", `{"prompt":"x"}`)
	if strings.Contains(got, "event: usage") {
		t.Fatalf("a failed stream must not emit usage: %q", got)
	}
	raw := waitForAuditLine(t, auditPath)
	if strings.Contains(raw, "promptTokens") {
		t.Fatalf("failed row must not carry counts: %s", raw)
	}
}

// --- POST /complete ------------------------------------------------------------------------------

const orAnswer = `{"choices":[{"message":{"role":"assistant","content":"  the answer "},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18,"cost":0.000123}}`

func TestCompleteOpenAIAddsUsageObject(t *testing.T) {
	base, auditPath := usageGateway(t, stubUpstream(t, "application/json", orAnswer))
	status, got := postBody(t, base, "/complete", `{"prompt":"hi"}`)
	if status != 200 {
		t.Fatalf("status %d %s", status, got)
	}
	want := `{"provider":"openai","text":"the answer","usage":{"promptTokens":11,"completionTokens":7,"costUsd":0.000123,"source":"provider"}}` + "\n"
	if got != want {
		t.Fatalf("answer\n got  %q\n want %q", got, want)
	}
	rows := waitForAuditRows(t, auditPath, 1, 2*time.Second)
	if rows[0].PromptTokens != 11 || rows[0].CompletionTokens != 7 || rows[0].CostUSD != 0.000123 {
		t.Fatalf("row %+v", rows[0])
	}
}

func TestCompleteOpenAIWithoutUsageIsByteForByteTheOldAnswer(t *testing.T) {
	noUsage := `{"choices":[{"message":{"content":"the answer"},"finish_reason":"stop"}]}`
	base, auditPath := usageGateway(t, stubUpstream(t, "application/json", noUsage))
	_, got := postBody(t, base, "/complete", `{"prompt":"hi"}`)
	if got != `{"provider":"openai","text":"the answer"}`+"\n" {
		t.Fatalf("answer drifted: %q", got)
	}
	raw := waitForAuditLine(t, auditPath)
	if strings.Contains(raw, "promptTokens") || strings.Contains(raw, "costUsd") {
		t.Fatalf("row without usage must stay byte-identical: %s", raw)
	}
}

func TestCompleteNonUsageProviderIsUntouched(t *testing.T) {
	// a provider with no UsageCompleter keeps exactly {provider,text}.
	c := chain.NewChain([]providers.Provider{&rateLimitedProvider{name: "plain"}}, 3, 60_000, time.Now)
	cfg := config.Config{GatewayToken: "secret", DailyCallCap: 1000, PerTenantDailyCallCap: 1000}
	srv := newTestServer(t, cfg, c)
	defer srv.Close()
	status, got := postBody(t, srv.URL, "/complete", `{"prompt":"hi"}`)
	if status != 200 || got != `{"provider":"plain","text":"ok from plain"}`+"\n" {
		t.Fatalf("%d %q", status, got)
	}
}

func waitForAuditLine(t *testing.T, path string) string {
	t.Helper()
	waitForAuditRows(t, path, 1, 2*time.Second)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	return lines[len(lines)-1]
}
