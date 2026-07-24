package providers

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestOpenAICompleteTrimsAndSendsAuth(t *testing.T) {
	var gotAuth, gotPath, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"  hello world  \n"}}]}`))
	}))
	defer srv.Close()

	p := NewOpenAIProvider(srv.URL, "secret-key", "deepseek-v4-flash", "qwen3.5:397b", 1024, srv.Client())
	text, err := p.Complete(context.Background(), "hi")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if text != "hello world" {
		t.Fatalf("expected trimmed %q, got %q", "hello world", text)
	}
	if gotAuth != "Bearer secret-key" {
		t.Fatalf("expected bearer auth header, got %q", gotAuth)
	}
	if gotPath != "/chat/completions" {
		t.Fatalf("expected /chat/completions path, got %q", gotPath)
	}
	if !strings.Contains(gotBody, `"deepseek-v4-flash"`) {
		t.Fatalf("expected model in request body, got %q", gotBody)
	}
}

func TestOpenAIProviderTrimsTrailingSlashInBaseURL(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"choices":[{"message":{"content":"ok"}}]}`))
	}))
	defer srv.Close()

	p := NewOpenAIProvider(srv.URL+"/", "k", "m", "", 512, srv.Client())
	if _, err := p.Complete(context.Background(), "hi"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotPath != "/chat/completions" {
		t.Fatalf("expected single-slash path, got %q", gotPath)
	}
}

func TestOpenAICompleteAllowsEmptyButPresentContent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"choices":[{"message":{"content":""}}]}`))
	}))
	defer srv.Close()

	p := NewOpenAIProvider(srv.URL, "k", "m", "", 512, srv.Client())
	text, err := p.Complete(context.Background(), "hi")
	if err != nil {
		t.Fatalf("expected no error for legitimately-empty content, got: %v", err)
	}
	if text != "" {
		t.Fatalf("expected empty string, got %q", text)
	}
}

func TestOpenAICompleteErrorsOnNoChoices(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"choices":[]}`))
	}))
	defer srv.Close()

	p := NewOpenAIProvider(srv.URL, "k", "m", "", 512, srv.Client())
	if _, err := p.Complete(context.Background(), "hi"); err == nil {
		t.Fatal("expected error when choices array is empty")
	}
}

func TestOpenAICompleteErrorsOnNon2xx(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte(`{"error":{"code":"1000","message":"Authentication Failed"}}`))
	}))
	defer srv.Close()

	p := NewOpenAIProvider(srv.URL, "k", "m", "", 512, srv.Client())
	if _, err := p.Complete(context.Background(), "hi"); err == nil {
		t.Fatal("expected error on 401 response")
	}
}

// B5: a 429 must yield a typed *RateLimitError (not a generic fmt.Errorf), carrying the
// upstream's Retry-After window, so chain.Run can open the breaker for exactly that window
// instead of counting it as a normal consecutive failure.
func TestOpenAICompleteReturnsRateLimitErrorOn429(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "17")
		w.WriteHeader(http.StatusTooManyRequests)
		w.Write([]byte(`{"error":{"message":"rate limited"}}`))
	}))
	defer srv.Close()

	p := NewOpenAIProvider(srv.URL, "k", "m", "", 512, srv.Client())
	_, err := p.Complete(context.Background(), "hi")
	if err == nil {
		t.Fatal("expected an error on 429")
	}
	var rl *RateLimitError
	if !errors.As(err, &rl) {
		t.Fatalf("expected *RateLimitError, got %T: %v", err, err)
	}
	if rl.RetryAfter != 17*time.Second {
		t.Fatalf("expected RetryAfter=17s, got %s", rl.RetryAfter)
	}
}

func TestOpenAIAvailableRequiresKeyAndURL(t *testing.T) {
	cases := []struct {
		url, key string
		want     bool
	}{
		{"https://ollama.com/v1", "k", true},
		{"https://ollama.com/v1", "", false},
		{"", "k", false},
		{"", "", false},
	}
	for _, c := range cases {
		p := NewOpenAIProvider(c.url, c.key, "m", "", 512, http.DefaultClient)
		if got := p.Available(); got != c.want {
			t.Fatalf("Available(url=%q,key=%q)=%v, want %v", c.url, c.key, got, c.want)
		}
	}
}

func TestOpenAIImageMediaUsesVisionModel(t *testing.T) {
	var gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"choices":[{"message":{"content":"a red square"}}]}`))
	}))
	defer srv.Close()

	p := NewOpenAIProvider(srv.URL, "k", "deepseek-v4-flash", "qwen3.5:397b", 512, srv.Client())
	text, err := p.Media(context.Background(), "QUJD", "image/png")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if text != "a red square" {
		t.Fatalf("expected vision description, got %q", text)
	}
	if !strings.Contains(gotBody, `"qwen3.5:397b"`) {
		t.Fatalf("expected vision model in request, got %q", gotBody)
	}
	if !strings.Contains(gotBody, `"image_url"`) || !strings.Contains(gotBody, "data:image/png;base64,QUJD") {
		t.Fatalf("expected image_url data URI in request, got %q", gotBody)
	}
}

func TestOpenAINonImageMediaFailsOver(t *testing.T) {
	p := NewOpenAIProvider("https://ollama.com/v1", "k", "m", "qwen3.5:397b", 512, http.DefaultClient)
	// Audio/PDF are not vision-handled → fail over to whisper/gemini.
	if _, err := p.Media(context.Background(), "data", "audio/ogg"); err == nil {
		t.Fatal("expected audio media to fail over")
	}
	if _, err := p.Media(context.Background(), "data", "application/pdf"); err == nil {
		t.Fatal("expected pdf media to fail over")
	}
}

func TestOpenAIImageMediaFailsOverWithoutVisionModel(t *testing.T) {
	p := NewOpenAIProvider("https://ollama.com/v1", "k", "m", "", 512, http.DefaultClient)
	if _, err := p.Media(context.Background(), "data", "image/png"); err == nil {
		t.Fatal("expected image media to fail over when no vision model configured")
	}
}

func TestOpenAIEmbedFailsOver(t *testing.T) {
	p := NewOpenAIProvider("https://ollama.com/v1", "k", "m", "qwen3.5:397b", 512, http.DefaultClient)
	if _, err := p.Embed(context.Background(), "text"); err == nil {
		t.Fatal("expected embed to be unsupported (fail over)")
	}
}
