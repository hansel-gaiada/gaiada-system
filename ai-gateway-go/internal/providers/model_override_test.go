package providers

// AIP-06: WithModel returns a shallow copy that uses another TEXT model for one attempt. For every
// provider that implements it these tests pin: the copy's request carries the override, the original
// is never mutated (it is shared between requests), Name() is unchanged (the breaker is keyed by it),
// and the copy keeps everything else. The providers that bake no model in per call (hermes, echo,
// central-forward, whisper) must not implement ModelOverrider at all.

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// captureUpstream records every request body and path it receives and answers with `reply`.
type captureUpstream struct {
	mu     sync.Mutex
	bodies []string
	paths  []string
}

func (c *captureUpstream) serve(t *testing.T, reply string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		c.mu.Lock()
		c.bodies = append(c.bodies, string(b))
		c.paths = append(c.paths, r.URL.Path)
		c.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(reply))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func (c *captureUpstream) last() (body, path string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.bodies[len(c.bodies)-1], c.paths[len(c.paths)-1]
}

func TestModelOverriderOpenAI(t *testing.T) {
	var up captureUpstream
	srv := up.serve(t, `{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}`)
	orig := NewOpenAIProvider(srv.URL, "k", "base-model", "vision-model", 64, srv.Client())

	cp, ok := Provider(orig).(ModelOverrider)
	if !ok {
		t.Fatal("openai must implement ModelOverrider")
	}
	over := cp.WithModel("tier/model:free")

	if got := orig.ModelName(); got != "base-model" {
		t.Fatalf("WithModel mutated the shared provider: ModelName()=%q", got)
	}
	if over == Provider(orig) {
		t.Fatal("WithModel must return a copy, not the receiver")
	}
	if over.Name() != "openai" {
		t.Fatalf("Name() must not change (breaker key), got %q", over.Name())
	}
	mr, ok := over.(ModelReporter)
	if !ok || mr.ModelName() != "tier/model:free" {
		t.Fatalf("the copy must report the override, got %v", over)
	}
	oc := over.(*OpenAIProvider)
	if oc.VisionModel != "vision-model" || oc.MaxTokens != 64 || oc.APIKey != "k" || oc.BaseURL != orig.BaseURL {
		t.Fatalf("the copy must keep every other field, got %+v", oc)
	}

	if _, err := over.Complete(context.Background(), "hi"); err != nil {
		t.Fatal(err)
	}
	if body, _ := up.last(); !strings.Contains(body, `"model":"tier/model:free"`) {
		t.Fatalf("override not sent upstream: %s", body)
	}
	// The ORIGINAL still calls its own model afterwards.
	if _, err := orig.Complete(context.Background(), "hi"); err != nil {
		t.Fatal(err)
	}
	if body, _ := up.last(); !strings.Contains(body, `"model":"base-model"`) {
		t.Fatalf("original lost its model: %s", body)
	}
	// The usage form the /complete route prefers rides the same copy.
	if _, _, err := over.(UsageCompleter).CompleteWithUsage(context.Background(), "hi"); err != nil {
		t.Fatal(err)
	}
	if body, _ := up.last(); !strings.Contains(body, `"model":"tier/model:free"`) {
		t.Fatalf("CompleteWithUsage ignored the override: %s", body)
	}
}

func TestModelOverriderOpenAINativeStreamUsesOverride(t *testing.T) {
	var up captureUpstream
	srv := up.serve(t, "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	orig := NewOpenAIProvider(srv.URL, "k", "base-model", "", 64, srv.Client()).WithNativeStream("on")
	over := orig.WithModel("tier-model").(*OpenAIProvider)
	if !over.NativeStreamEnabled() {
		t.Fatal("the copy must keep the native-stream gate")
	}
	if err := over.CompleteStream(context.Background(), "hi", func(string) {}); err != nil {
		t.Fatal(err)
	}
	if body, _ := up.last(); !strings.Contains(body, `"model":"tier-model"`) {
		t.Fatalf("stream did not use the override: %s", body)
	}
	if orig.ModelName() != "base-model" {
		t.Fatal("stream override mutated the original")
	}
}

func TestModelOverriderOllama(t *testing.T) {
	var up captureUpstream
	srv := up.serve(t, `{"response":"ok","done":true}`)
	orig := NewOllamaProvider(srv.URL, "base-chat", "embed-model", srv.Client())

	over := Provider(orig).(ModelOverrider).WithModel("tier-chat")
	if orig.ModelName() != "base-chat" {
		t.Fatalf("WithModel mutated the shared provider: %q", orig.ModelName())
	}
	if over.Name() != "ollama" || over.(ModelReporter).ModelName() != "tier-chat" {
		t.Fatalf("copy: name %q model %q", over.Name(), over.(ModelReporter).ModelName())
	}
	if over.(*OllamaProvider).EmbedModel != "embed-model" {
		t.Fatal("the embed model must be untouched")
	}
	if _, err := over.Complete(context.Background(), "hi"); err != nil {
		t.Fatal(err)
	}
	if body, _ := up.last(); !strings.Contains(body, `"model":"tier-chat"`) {
		t.Fatalf("override not sent: %s", body)
	}
	// The stream path reads the model per call as well.
	if err := over.(StreamingProvider).CompleteStream(context.Background(), "hi", func(string) {}); err != nil {
		t.Fatal(err)
	}
	if body, _ := up.last(); !strings.Contains(body, `"model":"tier-chat"`) {
		t.Fatalf("stream override not sent: %s", body)
	}
}

func TestModelOverriderGemini(t *testing.T) {
	var up captureUpstream
	srv := up.serve(t, `{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}`)
	orig := &GeminiProvider{APIKey: "k", Model: "gemini-base", Client: srv.Client(), baseURL: srv.URL}

	over := Provider(orig).(ModelOverrider).WithModel("gemini-tier")
	if orig.ModelName() != "gemini-base" {
		t.Fatalf("WithModel mutated the shared provider: %q", orig.ModelName())
	}
	if over.Name() != "gemini" || over.(ModelReporter).ModelName() != "gemini-tier" {
		t.Fatalf("copy: name %q model %q", over.Name(), over.(ModelReporter).ModelName())
	}
	if _, err := over.Complete(context.Background(), "hi"); err != nil {
		t.Fatal(err)
	}
	// The model is a URL segment, read per call (not baked in at construction).
	if _, path := up.last(); path != "/models/gemini-tier:generateContent" {
		t.Fatalf("override not in the request URL: %s", path)
	}
	if _, err := orig.Complete(context.Background(), "hi"); err != nil {
		t.Fatal(err)
	}
	if _, path := up.last(); path != "/models/gemini-base:generateContent" {
		t.Fatalf("original lost its model: %s", path)
	}
}

func TestModelOverriderClaude(t *testing.T) {
	var up captureUpstream
	srv := up.serve(t, `{"content":[{"type":"text","text":"ok"}]}`)
	orig := &ClaudeProvider{APIKey: "k", Model: "claude-base", Client: srv.Client(), baseURL: srv.URL}

	over := Provider(orig).(ModelOverrider).WithModel("claude-tier")
	if orig.ModelName() != "claude-base" {
		t.Fatalf("WithModel mutated the shared provider: %q", orig.ModelName())
	}
	if over.Name() != "claude" || over.(ModelReporter).ModelName() != "claude-tier" {
		t.Fatalf("copy: name %q model %q", over.Name(), over.(ModelReporter).ModelName())
	}
	if _, err := over.Complete(context.Background(), "hi"); err != nil {
		t.Fatal(err)
	}
	if body, _ := up.last(); !strings.Contains(body, `"model":"claude-tier"`) {
		t.Fatalf("override not sent: %s", body)
	}
	if _, err := orig.Complete(context.Background(), "hi"); err != nil {
		t.Fatal(err)
	}
	if body, _ := up.last(); !strings.Contains(body, `"model":"claude-base"`) {
		t.Fatalf("original lost its model: %s", body)
	}
}

// WithModel is called concurrently on a SHARED provider by every routed request: it must only read it.
func TestModelOverriderConcurrentCopiesNeverMutateTheShared(t *testing.T) {
	orig := NewOpenAIProvider("http://x", "k", "base", "", 1, http.DefaultClient)
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 200; j++ {
				c := orig.WithModel("m").(*OpenAIProvider)
				_ = c.ModelName()
				_ = orig.ModelName()
			}
		}()
	}
	wg.Wait()
	if orig.ModelName() != "base" {
		t.Fatalf("shared provider mutated: %q", orig.ModelName())
	}
}

// Providers that do not read a text model per call must NOT claim the capability: a tier entry with a
// model for them is refused at validation, and routedProvider would otherwise pretend to override.
func TestProvidersWithoutAModelOverrideDoNotImplementIt(t *testing.T) {
	for name, p := range map[string]Provider{
		"echo":            NewEchoProvider(),
		"hermes":          NewHermesProvider("http://x", "m", "t", http.DefaultClient),
		"whisper":         NewWhisperProvider("http://x", "m", http.DefaultClient),
		"central-forward": NewCentralForwardProvider("http://x", "t", http.DefaultClient),
	} {
		if _, ok := p.(ModelOverrider); ok {
			t.Errorf("%s must not implement ModelOverrider", name)
		}
	}
}
