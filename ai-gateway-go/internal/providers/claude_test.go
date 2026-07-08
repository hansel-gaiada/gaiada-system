package providers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestClaudeAvailable(t *testing.T) {
	if (&ClaudeProvider{APIKey: ""}).Available() {
		t.Fatal("expected unavailable with empty key")
	}
	if !(&ClaudeProvider{APIKey: "k"}).Available() {
		t.Fatal("expected available with key")
	}
}

func TestClaudeCompleteTrimsWhitespace(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("x-api-key"); got != "k" {
			t.Errorf("expected x-api-key header %q, got %q", "k", got)
		}
		if got := r.Header.Get("anthropic-version"); got != "2023-06-01" {
			t.Errorf("expected anthropic-version header, got %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"content":[{"type":"text","text":"  hello world  \n"}]}`))
	}))
	defer srv.Close()

	p := &ClaudeProvider{APIKey: "k", Model: "claude-3-5-sonnet", Client: srv.Client()}
	p.baseURL = srv.URL
	text, err := p.Complete(context.Background(), "hi")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if text != "hello world" {
		t.Fatalf("expected trimmed response %q, got %q", "hello world", text)
	}
}

func TestClaudeCompleteReturnsEmptyWhenNoTextBlock(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"content":[{"type":"tool_use"}]}`))
	}))
	defer srv.Close()

	p := &ClaudeProvider{APIKey: "k", Model: "claude-3-5-sonnet", Client: srv.Client()}
	p.baseURL = srv.URL
	text, err := p.Complete(context.Background(), "hi")
	if err != nil {
		t.Fatalf("expected no error when no text block is present, got: %v", err)
	}
	if text != "" {
		t.Fatalf("expected empty string, got %q", text)
	}
}

func TestClaudeCompleteAllowsEmptyButPresentText(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"content":[{"type":"text","text":""}]}`))
	}))
	defer srv.Close()

	p := &ClaudeProvider{APIKey: "k", Model: "claude-3-5-sonnet", Client: srv.Client()}
	p.baseURL = srv.URL
	text, err := p.Complete(context.Background(), "hi")
	if err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
	if text != "" {
		t.Fatalf("expected empty string, got %q", text)
	}
}

func TestClaudeCompleteErrorsOnHTTPStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	p := &ClaudeProvider{APIKey: "k", Model: "claude-3-5-sonnet", Client: srv.Client()}
	p.baseURL = srv.URL
	if _, err := p.Complete(context.Background(), "hi"); err == nil {
		t.Fatal("expected error on non-2xx status")
	}
}

func TestClaudeMediaRejectsUnsupportedMimeType(t *testing.T) {
	p := &ClaudeProvider{APIKey: "k", Model: "claude-3-5-sonnet", Client: http.DefaultClient}
	_, err := p.Media(context.Background(), "YmFzZTY0", "video/mp4")
	if err == nil {
		t.Fatal("expected error for unsupported media type")
	}
	want := "claude: unsupported media type video/mp4"
	if err.Error() != want {
		t.Fatalf("expected error %q, got %q", want, err.Error())
	}
}

func TestClaudeMediaSendsDocumentBlockForPDF(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		decodeJSONBody(t, r, &gotBody)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"content":[{"type":"text","text":"extracted text"}]}`))
	}))
	defer srv.Close()

	p := &ClaudeProvider{APIKey: "k", Model: "claude-3-5-sonnet", Client: srv.Client()}
	p.baseURL = srv.URL
	text, err := p.Media(context.Background(), "YmFzZTY0", "application/pdf")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if text != "extracted text" {
		t.Fatalf("expected %q, got %q", "extracted text", text)
	}

	messages, _ := gotBody["messages"].([]any)
	msg, _ := messages[0].(map[string]any)
	content, _ := msg["content"].([]any)
	block, _ := content[0].(map[string]any)
	if block["type"] != "document" {
		t.Fatalf("expected document block, got %v", block)
	}
}

func TestClaudeMediaSendsImageBlockForImage(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		decodeJSONBody(t, r, &gotBody)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"content":[{"type":"text","text":"a photo"}]}`))
	}))
	defer srv.Close()

	p := &ClaudeProvider{APIKey: "k", Model: "claude-3-5-sonnet", Client: srv.Client()}
	p.baseURL = srv.URL
	if _, err := p.Media(context.Background(), "YmFzZTY0", "image/png"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	messages, _ := gotBody["messages"].([]any)
	msg, _ := messages[0].(map[string]any)
	content, _ := msg["content"].([]any)
	block, _ := content[0].(map[string]any)
	if block["type"] != "image" {
		t.Fatalf("expected image block, got %v", block)
	}
}

func TestClaudeEmbedNotSupported(t *testing.T) {
	p := &ClaudeProvider{APIKey: "k", Model: "claude-3-5-sonnet", Client: http.DefaultClient}
	if _, err := p.Embed(context.Background(), "hi"); err == nil {
		t.Fatal("expected error: claude embeddings are not supported")
	}
}
