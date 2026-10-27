package server

// AIP-02: OPENAI_NATIVE_STREAM is OFF by default. With it off, /complete/stream with the openai
// provider is the single-chunk fallback through Complete exactly as before the ticket, plus the
// `usage` event the call reported. These tests pin the frames byte for byte.

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// jsonChatAnswer is a non-stream chat-completions answer long enough to clear the scrubber window.
func jsonChatAnswer(usage string) string {
	u := ""
	if usage != "" {
		u = `,"usage":` + usage
	}
	return `{"choices":[{"message":{"role":"assistant","content":" The quarterly summary is ready and it is long enough. "},"finish_reason":"stop"}]` + u + `}`
}

const fallbackText = "The quarterly summary is ready and it is long enough."

// The frames of the old fallback (before AIP-02): meta, ONE text frame, done.
const oldFallbackFrames = "event: meta\n" +
	`data: {"provider":"openai","model":"z-ai/glm-5.3-flash"}` + "\n\n" +
	`data: "` + fallbackText + `"` + "\n\n" +
	"event: done\ndata: {}\n\n"

func TestCompleteStreamOpenAIDefaultOffIsTheOldFallbackByteForByte(t *testing.T) {
	for _, setting := range []string{"", "0", "false", "off", "nonsense"} {
		base, _ := usageGatewayWith(t, stubUpstream(t, "application/json", jsonChatAnswer("")), setting)
		status, got := postBody(t, base, "/complete/stream", `{"prompt":"x"}`)
		if status != 200 || got != oldFallbackFrames {
			t.Fatalf("OPENAI_NATIVE_STREAM=%q: frames drifted from the old fallback:\n got  %q\n want %q", setting, got, oldFallbackFrames)
		}
	}
}

func TestCompleteStreamOpenAIDefaultOffAddsOnlyTheUsageEvent(t *testing.T) {
	usage := `{"prompt_tokens":12,"completion_tokens":34,"total_tokens":46,"cost":0.00042}`
	base, auditPath := usageGatewayWith(t, stubUpstream(t, "application/json", jsonChatAnswer(usage)), "")
	_, got := postBody(t, base, "/complete/stream", `{"prompt":"x"}`)
	want := "event: meta\n" +
		`data: {"provider":"openai","model":"z-ai/glm-5.3-flash"}` + "\n\n" +
		`data: "` + fallbackText + `"` + "\n\n" +
		"event: usage\n" +
		`data: {"promptTokens":12,"completionTokens":34,"costUsd":0.00042,"source":"provider"}` + "\n\n" +
		"event: done\ndata: {}\n\n"
	if got != want {
		t.Fatalf("fallback + usage:\n got  %q\n want %q", got, want)
	}
	// removing the usage event gives back exactly the old frames
	var kept []string
	for _, blk := range strings.Split(strings.TrimSuffix(got, "\n\n"), "\n\n") {
		if !strings.HasPrefix(blk, "event: usage") {
			kept = append(kept, blk)
		}
	}
	if strings.Join(kept, "\n\n")+"\n\n" != oldFallbackFrames {
		t.Fatalf("apart from usage the frames must equal the old fallback: %q", kept)
	}
	rows := waitForAuditRows(t, auditPath, 1, 2*time.Second)
	if rows[0].PromptTokens != 12 || rows[0].CompletionTokens != 34 || rows[0].CostUSD != 0.00042 {
		t.Fatalf("row %+v", rows[0])
	}
}

func TestCompleteStreamOpenAIDefaultOffMalformedUsageEmitsNoUsage(t *testing.T) {
	base, _ := usageGatewayWith(t, stubUpstream(t, "application/json", jsonChatAnswer(`{"prompt_tokens":"x"}`)), "")
	_, got := postBody(t, base, "/complete/stream", `{"prompt":"x"}`)
	if got != oldFallbackFrames {
		t.Fatalf("malformed usage must leave the old frames: %q", got)
	}
}

func TestCompleteStreamOpenAIDefaultOffUsesANonStreamRequest(t *testing.T) {
	var sawStream any = "unset"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var m map[string]any
		_ = json.Unmarshal(b, &m)
		sawStream = m["stream"]
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(jsonChatAnswer("")))
	}))
	defer srv.Close()
	base, _ := usageGatewayWith(t, srv, "")
	postBody(t, base, "/complete/stream", `{"prompt":"x"}`)
	if sawStream != false {
		t.Fatalf("native stream is off: the upstream must get stream:false, got %v", sawStream)
	}
}

func TestCompleteStreamOpenAINativeOnUsesAStreamRequest(t *testing.T) {
	var sawStream any = "unset"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var m map[string]any
		_ = json.Unmarshal(b, &m)
		sawStream = m["stream"]
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(streamWithUsage))
	}))
	defer srv.Close()
	for _, setting := range []string{"1", "true", "on"} {
		sawStream = "unset"
		base, _ := usageGatewayWith(t, srv, setting)
		postBody(t, base, "/complete/stream", `{"prompt":"x"}`)
		if sawStream != true {
			t.Fatalf("OPENAI_NATIVE_STREAM=%q must stream upstream, got %v", setting, sawStream)
		}
	}
}
