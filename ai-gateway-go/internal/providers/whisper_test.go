package providers

import (
	"context"
	"encoding/base64"
	"io"
	"mime"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWhisperAvailable(t *testing.T) {
	if (&WhisperProvider{URL: ""}).Available() {
		t.Fatal("expected unavailable with empty url")
	}
	if !(&WhisperProvider{URL: "http://x"}).Available() {
		t.Fatal("expected available with url")
	}
}

func TestWhisperCompleteNotSupported(t *testing.T) {
	p := &WhisperProvider{URL: "http://x", Model: "whisper-1", Client: http.DefaultClient}
	_, err := p.Complete(context.Background(), "hi")
	if err == nil {
		t.Fatal("expected error: whisper text completion is not supported")
	}
}

func TestWhisperMediaRejectsNonAudio(t *testing.T) {
	p := &WhisperProvider{URL: "http://x", Model: "whisper-1", Client: http.DefaultClient}
	_, err := p.Media(context.Background(), "YmFzZTY0", "image/png")
	if err == nil {
		t.Fatal("expected error for non-audio media type")
	}
	want := "whisper: image/png not supported — failing over"
	if err.Error() != want {
		t.Fatalf("expected error %q, got %q", want, err.Error())
	}
}

func TestWhisperMediaTrimsWhitespaceAndSendsMultipart(t *testing.T) {
	raw := []byte("fake-audio-bytes")
	b64 := base64.StdEncoding.EncodeToString(raw)

	var gotModel, gotResponseFormat, gotFilename string
	var gotFileBytes []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mediaType, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || mediaType != "multipart/form-data" {
			t.Fatalf("expected multipart/form-data content-type, got %q (%v)", r.Header.Get("Content-Type"), err)
		}
		if err := r.ParseMultipartForm(10 << 20); err != nil {
			t.Fatalf("failed to parse multipart form: %v", err)
		}
		gotModel = r.FormValue("model")
		gotResponseFormat = r.FormValue("response_format")
		file, header, err := r.FormFile("file")
		if err != nil {
			t.Fatalf("failed to read file field: %v", err)
		}
		defer file.Close()
		gotFilename = header.Filename
		gotFileBytes, _ = io.ReadAll(file)
		_ = params

		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"text":"  hello transcript  \n"}`))
	}))
	defer srv.Close()

	p := &WhisperProvider{URL: srv.URL, Model: "whisper-1", Client: srv.Client()}
	text, err := p.Media(context.Background(), b64, "audio/ogg; codecs=opus")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if text != "hello transcript" {
		t.Fatalf("expected trimmed transcript %q, got %q", "hello transcript", text)
	}
	if gotModel != "whisper-1" {
		t.Fatalf("expected model %q, got %q", "whisper-1", gotModel)
	}
	if gotResponseFormat != "json" {
		t.Fatalf("expected response_format %q, got %q", "json", gotResponseFormat)
	}
	if gotFilename != "audio.ogg" {
		t.Fatalf("expected filename %q, got %q", "audio.ogg", gotFilename)
	}
	if string(gotFileBytes) != string(raw) {
		t.Fatalf("expected file bytes %q, got %q", raw, gotFileBytes)
	}
}

func TestWhisperMediaAllowsEmptyButPresentText(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"text":""}`))
	}))
	defer srv.Close()

	p := &WhisperProvider{URL: srv.URL, Model: "whisper-1", Client: srv.Client()}
	text, err := p.Media(context.Background(), base64.StdEncoding.EncodeToString([]byte("x")), "audio/ogg")
	if err != nil {
		t.Fatalf("expected no error for legitimately-empty transcript, got: %v", err)
	}
	if text != "" {
		t.Fatalf("expected empty string, got %q", text)
	}
}

func TestWhisperMediaErrorsOnMissingTextField(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{}`))
	}))
	defer srv.Close()

	p := &WhisperProvider{URL: srv.URL, Model: "whisper-1", Client: srv.Client()}
	if _, err := p.Media(context.Background(), base64.StdEncoding.EncodeToString([]byte("x")), "audio/ogg"); err == nil {
		t.Fatal("expected error when text field is absent")
	}
}

func TestWhisperMediaErrorsOnHTTPStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	p := &WhisperProvider{URL: srv.URL, Model: "whisper-1", Client: srv.Client()}
	if _, err := p.Media(context.Background(), base64.StdEncoding.EncodeToString([]byte("x")), "audio/ogg"); err == nil {
		t.Fatal("expected error on non-2xx status")
	}
}

func TestWhisperEmbedNotSupported(t *testing.T) {
	p := &WhisperProvider{URL: "http://x", Model: "whisper-1", Client: http.DefaultClient}
	if _, err := p.Embed(context.Background(), "hi"); err == nil {
		t.Fatal("expected error: whisper embeddings are not supported")
	}
}
