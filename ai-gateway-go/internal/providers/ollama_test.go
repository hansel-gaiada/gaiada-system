package providers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

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
