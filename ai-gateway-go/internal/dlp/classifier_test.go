// ai-gateway-go/internal/dlp/classifier_test.go
package dlp

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestClassifierFailsClosedWhenOllamaUnreachable(t *testing.T) {
	c := NewClassifier("http://127.0.0.1:1", "test-model", 200, http.DefaultClient)
	allowed, err := c.Classify(context.Background(), "hello")
	if err == nil {
		t.Fatal("expected an error (fail-closed) when Ollama is unreachable")
	}
	if allowed {
		t.Fatal("expected allowed=false on classifier failure")
	}
}

func TestClassifierAllowsOnLowConfidenceSafeResponse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"response": "SAFE"}`))
	}))
	defer srv.Close()
	c := NewClassifier(srv.URL, "test-model", 2000, http.DefaultClient)
	allowed, err := c.Classify(context.Background(), "hello world")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !allowed {
		t.Fatal("expected allowed=true for a SAFE classification")
	}
}

func TestClassifierBlocksOnUnsureOrUnparseableResponse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"response": "not-a-recognized-verdict"}`))
	}))
	defer srv.Close()
	c := NewClassifier(srv.URL, "test-model", 2000, http.DefaultClient)
	allowed, err := c.Classify(context.Background(), "hello world")
	if err == nil {
		t.Fatal("expected an error for an unparseable/unsure verdict (fail-closed)")
	}
	if allowed {
		t.Fatal("expected allowed=false")
	}
}

func TestClassifierTimesOutFastOnSlowOllama(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(500 * time.Millisecond)
		w.Write([]byte(`{"response": "SAFE"}`))
	}))
	defer srv.Close()
	c := NewClassifier(srv.URL, "test-model", 50, http.DefaultClient)
	_, err := c.Classify(context.Background(), "hello")
	if err == nil {
		t.Fatal("expected a timeout error")
	}
}
