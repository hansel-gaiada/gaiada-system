package providers

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// B5: a 429 must yield a typed *RateLimitError with the parsed Retry-After window.
func TestOllamaCompleteReturnsRateLimitErrorOn429(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "5")
		w.WriteHeader(http.StatusTooManyRequests)
		w.Write([]byte(`{"error":"rate limited"}`))
	}))
	defer srv.Close()

	p := NewOllamaProvider(srv.URL, "llama3.2", "llama3.2", srv.Client())
	_, err := p.Complete(context.Background(), "hi")
	if err == nil {
		t.Fatal("expected an error on 429")
	}
	var rl *RateLimitError
	if !errors.As(err, &rl) {
		t.Fatalf("expected *RateLimitError, got %T: %v", err, err)
	}
	if rl.RetryAfter != 5*time.Second {
		t.Fatalf("expected RetryAfter=5s, got %s", rl.RetryAfter)
	}
}

func TestOllamaCompleteTrimsWhitespace(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"response":"  hello world  \n"}`))
	}))
	defer srv.Close()

	p := NewOllamaProvider(srv.URL, "llama3.2", "llama3.2", srv.Client())
	text, err := p.Complete(context.Background(), "hi")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if text != "hello world" {
		t.Fatalf("expected trimmed response %q, got %q", "hello world", text)
	}
}

func TestOllamaCompleteAllowsEmptyButPresentResponse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"response":""}`))
	}))
	defer srv.Close()

	p := NewOllamaProvider(srv.URL, "llama3.2", "llama3.2", srv.Client())
	text, err := p.Complete(context.Background(), "hi")
	if err != nil {
		t.Fatalf("expected no error for legitimately-empty response, got: %v", err)
	}
	if text != "" {
		t.Fatalf("expected empty string, got %q", text)
	}
}

func TestOllamaCompleteErrorsOnMissingResponseField(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{}`))
	}))
	defer srv.Close()

	p := NewOllamaProvider(srv.URL, "llama3.2", "llama3.2", srv.Client())
	if _, err := p.Complete(context.Background(), "hi"); err == nil {
		t.Fatal("expected error when response field is absent")
	}
}

func TestOllamaEmbedAllowsEmptyButPresentSlice(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"embedding":[]}`))
	}))
	defer srv.Close()

	p := NewOllamaProvider(srv.URL, "llama3.2", "llama3.2", srv.Client())
	v, err := p.Embed(context.Background(), "hi")
	if err != nil {
		t.Fatalf("expected no error for legitimately-empty embedding, got: %v", err)
	}
	if len(v) != 0 {
		t.Fatalf("expected empty slice, got %v", v)
	}
}

func TestOllamaEmbedErrorsOnMissingEmbeddingField(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{}`))
	}))
	defer srv.Close()

	p := NewOllamaProvider(srv.URL, "llama3.2", "llama3.2", srv.Client())
	if _, err := p.Embed(context.Background(), "hi"); err == nil {
		t.Fatal("expected error when embedding field is absent")
	}
}

// --- ASST-03: CompleteStream (real NDJSON streaming) ------------------------------------

// Real Ollama /api/generate with "stream":true returns one NDJSON line per token, flushed as
// each is generated — not the whole body at once. Flushing between writes here proves onToken
// fires incrementally as lines arrive rather than only after a naive implementation buffered
// the whole body and replayed it in pieces (which would pass a test that only checked the
// final joined text, but deliver nothing incrementally to a real client).
func TestOllamaCompleteStreamEmitsIncrementalTokens(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/x-ndjson")
		flusher, _ := w.(http.Flusher)
		lines := []string{
			`{"response":"hello","done":false}`,
			`{"response":" world","done":false}`,
			`{"response":"!","done":false}`,
			`{"response":"","done":true,"total_duration":123}`,
		}
		for _, l := range lines {
			fmt.Fprintln(w, l)
			if flusher != nil {
				flusher.Flush()
			}
		}
	}))
	defer srv.Close()

	p := NewOllamaProvider(srv.URL, "llama3.2", "llama3.2", srv.Client())
	var got []string
	err := p.CompleteStream(context.Background(), "hi", func(tok string) {
		got = append(got, tok)
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) < 3 {
		t.Fatalf("expected >=3 discrete onToken calls (proving real incrementality), got %d: %v", len(got), got)
	}
	if joined := strings.Join(got, ""); joined != "hello world!" {
		t.Fatalf("expected accumulated tokens %q, got %q", "hello world!", joined)
	}
	// The done:true chunk carries an empty "response" — must not be emitted as a 5th, empty token.
	for _, tok := range got {
		if tok == "" {
			t.Fatalf("expected no empty tokens among %v", got)
		}
	}
}

// A provider-side failure mid-generation (Ollama's own NDJSON line shape for it: an "error"
// key instead of "response") must surface as an error AFTER the tokens seen before it — proving
// the decoder doesn't buffer/discard prior output when the stream ends in failure.
func TestOllamaCompleteStreamMidStreamErrorStopsAfterPriorTokens(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		flusher, _ := w.(http.Flusher)
		lines := []string{
			`{"response":"hello","done":false}`,
			`{"response":" world","done":false}`,
			`{"error":"model crashed"}`,
		}
		for _, l := range lines {
			fmt.Fprintln(w, l)
			if flusher != nil {
				flusher.Flush()
			}
		}
	}))
	defer srv.Close()

	p := NewOllamaProvider(srv.URL, "llama3.2", "llama3.2", srv.Client())
	var got []string
	err := p.CompleteStream(context.Background(), "hi", func(tok string) {
		got = append(got, tok)
	})
	if err == nil {
		t.Fatal("expected an error from the mid-stream error line")
	}
	if joined := strings.Join(got, ""); joined != "hello world" {
		t.Fatalf("expected exactly the 2 tokens emitted before the error line, got %q", joined)
	}
}

// A partial/truncated final NDJSON line (e.g. the upstream connection dropped mid-write,
// leaving an unterminated JSON object with no closing brace and no trailing newline) must not
// panic the decoder and must not be emitted as a garbage token — the valid lines before it are
// still delivered.
func TestOllamaCompleteStreamIgnoresTruncatedTrailingLine(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		flusher, _ := w.(http.Flusher)
		fmt.Fprintln(w, `{"response":"hello","done":false}`)
		if flusher != nil {
			flusher.Flush()
		}
		fmt.Fprintln(w, `{"response":" world","done":false}`)
		if flusher != nil {
			flusher.Flush()
		}
		// No trailing newline, no closing brace: simulates a dropped connection mid-write.
		fmt.Fprint(w, `{"response":"crash`)
	}))
	defer srv.Close()

	p := NewOllamaProvider(srv.URL, "llama3.2", "llama3.2", srv.Client())
	var got []string
	func() {
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("CompleteStream panicked on a truncated trailing line: %v", r)
			}
		}()
		if err := p.CompleteStream(context.Background(), "hi", func(tok string) {
			got = append(got, tok)
		}); err != nil {
			t.Fatalf("unexpected error from a truncated trailing line: %v", err)
		}
	}()
	if joined := strings.Join(got, ""); joined != "hello world" {
		t.Fatalf("expected only the 2 valid tokens (no garbage from the truncated line), got %q", joined)
	}
}
