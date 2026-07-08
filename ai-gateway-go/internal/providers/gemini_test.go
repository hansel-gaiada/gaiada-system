package providers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func decodeJSONBody(t *testing.T, r *http.Request, v any) {
	t.Helper()
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		t.Fatalf("failed to decode request body: %v", err)
	}
}

func TestGeminiAvailable(t *testing.T) {
	if (&GeminiProvider{APIKey: ""}).Available() {
		t.Fatal("expected unavailable with empty key")
	}
	if !(&GeminiProvider{APIKey: "k"}).Available() {
		t.Fatal("expected available with key")
	}
}

func TestGeminiCompleteTrimsWhitespace(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"candidates":[{"content":{"parts":[{"text":"  hello world  \n"}]}}]}`))
	}))
	defer srv.Close()

	p := &GeminiProvider{APIKey: "k", Model: "gemini-1.5-flash", Client: srv.Client()}
	p.baseURL = srv.URL
	text, err := p.Complete(context.Background(), "hi")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if text != "hello world" {
		t.Fatalf("expected trimmed response %q, got %q", "hello world", text)
	}
}

func TestGeminiCompleteAllowsEmptyButPresentText(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"candidates":[{"content":{"parts":[{"text":""}]}}]}`))
	}))
	defer srv.Close()

	p := &GeminiProvider{APIKey: "k", Model: "gemini-1.5-flash", Client: srv.Client()}
	p.baseURL = srv.URL
	text, err := p.Complete(context.Background(), "hi")
	if err != nil {
		t.Fatalf("expected no error for legitimately-empty text, got: %v", err)
	}
	if text != "" {
		t.Fatalf("expected empty string, got %q", text)
	}
}

func TestGeminiCompleteNoCandidatesNoPromptFeedbackReturnsEmpty(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"candidates":[]}`))
	}))
	defer srv.Close()

	p := &GeminiProvider{APIKey: "k", Model: "gemini-1.5-flash", Client: srv.Client()}
	p.baseURL = srv.URL
	text, err := p.Complete(context.Background(), "hi")
	if err != nil {
		t.Fatalf("expected no error when candidates are empty and no promptFeedback, got: %v", err)
	}
	if text != "" {
		t.Fatalf("expected empty string, got %q", text)
	}
}

func TestGeminiCompleteErrorsOnPromptFeedbackWithNoCandidates(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"candidates":[],"promptFeedback":{"blockReason":"SAFETY"}}`))
	}))
	defer srv.Close()

	p := &GeminiProvider{APIKey: "k", Model: "gemini-1.5-flash", Client: srv.Client()}
	p.baseURL = srv.URL
	if _, err := p.Complete(context.Background(), "hi"); err == nil {
		t.Fatal("expected error when prompt was blocked (promptFeedback present, no candidates)")
	}
}

func TestGeminiCompleteErrorsOnBadFinishReasonEvenWithStrayText(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"candidates":[{"finishReason":"SAFETY","content":{"parts":[{"text":"partial"}]}}]}`))
	}))
	defer srv.Close()

	p := &GeminiProvider{APIKey: "k", Model: "gemini-1.5-flash", Client: srv.Client()}
	p.baseURL = srv.URL
	if _, err := p.Complete(context.Background(), "hi"); err == nil {
		t.Fatal("expected error on bad finish reason (SAFETY) even with stray text parts present")
	}
}

func TestGeminiCompleteCandidateWithNoPartsReturnsEmpty(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"candidates":[{"content":{"parts":[]}}]}`))
	}))
	defer srv.Close()

	p := &GeminiProvider{APIKey: "k", Model: "gemini-1.5-flash", Client: srv.Client()}
	p.baseURL = srv.URL
	text, err := p.Complete(context.Background(), "hi")
	if err != nil {
		t.Fatalf("expected no error for candidate with empty parts, got: %v", err)
	}
	if text != "" {
		t.Fatalf("expected empty string, got %q", text)
	}
}

func TestGeminiCompleteErrorsOnHTTPStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	p := &GeminiProvider{APIKey: "k", Model: "gemini-1.5-flash", Client: srv.Client()}
	p.baseURL = srv.URL
	if _, err := p.Complete(context.Background(), "hi"); err == nil {
		t.Fatal("expected error on non-2xx status")
	}
}

func TestGeminiMediaSendsInlineDataAndInstruction(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		decodeJSONBody(t, r, &gotBody)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"candidates":[{"content":{"parts":[{"text":"a description"}]}}]}`))
	}))
	defer srv.Close()

	p := &GeminiProvider{APIKey: "k", Model: "gemini-1.5-flash", Client: srv.Client()}
	p.baseURL = srv.URL
	text, err := p.Media(context.Background(), "YmFzZTY0", "image/png")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if text != "a description" {
		t.Fatalf("expected %q, got %q", "a description", text)
	}
	contents, _ := gotBody["contents"].([]any)
	if len(contents) != 1 {
		t.Fatalf("expected one content entry, got %v", gotBody)
	}
}

func TestGeminiEmbedAllowsEmptyButPresentValues(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"embedding":{"values":[]}}`))
	}))
	defer srv.Close()

	p := &GeminiProvider{APIKey: "k", Model: "gemini-1.5-flash", Client: srv.Client()}
	p.baseURL = srv.URL
	v, err := p.Embed(context.Background(), "hi")
	if err != nil {
		t.Fatalf("expected no error for legitimately-empty embedding, got: %v", err)
	}
	if len(v) != 0 {
		t.Fatalf("expected empty slice, got %v", v)
	}
}

func TestGeminiEmbedErrorsOnMissingEmbeddingField(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{}`))
	}))
	defer srv.Close()

	p := &GeminiProvider{APIKey: "k", Model: "gemini-1.5-flash", Client: srv.Client()}
	p.baseURL = srv.URL
	if _, err := p.Embed(context.Background(), "hi"); err == nil {
		t.Fatal("expected error when embedding field is absent")
	}
}

func TestGeminiEmbedReturnsValues(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"embedding":{"values":[0.1,0.2,0.3]}}`))
	}))
	defer srv.Close()

	p := &GeminiProvider{APIKey: "k", Model: "gemini-1.5-flash", Client: srv.Client()}
	p.baseURL = srv.URL
	v, err := p.Embed(context.Background(), "hi")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(v) != 3 || v[0] != 0.1 {
		t.Fatalf("unexpected values: %v", v)
	}
}

func TestMediaInstructionByMimeClass(t *testing.T) {
	cases := map[string]string{
		"audio/ogg":       "Transcribe this audio verbatim. Output only the transcript.",
		"image/png":       "Describe this image for a work-group digest: what it shows, and transcribe any visible text (signs, documents, screens). Be factual and brief.",
		"application/pdf": "Extract the text content of this document. Output only the text.",
		"video/mp4":       "Describe what happens in this video and transcribe any speech.",
		"text/plain":      "Describe the content of this file for a work-group digest.",
	}
	for mime, want := range cases {
		if got := mediaInstruction(mime); got != want {
			t.Errorf("mediaInstruction(%q) = %q, want %q", mime, got, want)
		}
	}
}
