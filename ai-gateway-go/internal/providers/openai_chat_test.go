package providers

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func chatUpstream(t *testing.T, h func(w http.ResponseWriter, body map[string]any)) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		h(w, body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func chatReq() ChatRequest {
	return ChatRequest{Fields: map[string]json.RawMessage{
		"messages": json.RawMessage(`[{"role":"user","content":"hi"}]`),
		// The server never puts these in Fields; the provider must still refuse to forward them.
		"model":     json.RawMessage(`"caller-model"`),
		"reasoning": json.RawMessage(`{"max_tokens":999999}`),
	}}
}

func TestOpenAIChatSetsItsOwnModelAndReasoningCap(t *testing.T) {
	var got map[string]any
	srv := chatUpstream(t, func(w http.ResponseWriter, body map[string]any) {
		got = body
		io.WriteString(w, `{"model":"served","choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":3,"completion_tokens":2}}`)
	})
	p := NewOpenAIProvider(srv.URL, "k", "configured", "", 1024, srv.Client()).WithReasoningMaxTokens(256)
	resp, err := p.Chat(context.Background(), chatReq())
	if err != nil {
		t.Fatal(err)
	}
	if got["model"] != "configured" || got["stream"] != false {
		t.Fatalf("the provider sets model and stream, got %v", got)
	}
	if r, _ := got["reasoning"].(map[string]any); r["max_tokens"] != float64(256) {
		t.Fatalf("the gateway's reasoning cap wins over the caller's, got %v", got["reasoning"])
	}
	if _, has := got["max_tokens"]; has {
		t.Fatal("no max_tokens is injected when the caller sent none")
	}
	if resp.Model != "served" || resp.Usage == nil || resp.Usage.PromptTokens != 3 || resp.Usage.CompletionTokens != 2 {
		t.Fatalf("model and usage come from the upstream, got %+v %+v", resp, resp.Usage)
	}
}

func TestOpenAIChatStatusMapping(t *testing.T) {
	for status, check := range map[int]func(error) bool{
		400: func(err error) bool {
			var ce *CallerError
			return errors.As(err, &ce) && ce.Status == 400 && ce.Message == "schema bad"
		},
		422: func(err error) bool { var ce *CallerError; return errors.As(err, &ce) && ce.Status == 422 },
		429: func(err error) bool { var rl *RateLimitError; return errors.As(err, &rl) },
		401: func(err error) bool { var ce *CallerError; return err != nil && !errors.As(err, &ce) },
		404: func(err error) bool { var ce *CallerError; return err != nil && !errors.As(err, &ce) },
		500: func(err error) bool { var ce *CallerError; return err != nil && !errors.As(err, &ce) },
	} {
		srv := chatUpstream(t, func(w http.ResponseWriter, _ map[string]any) {
			w.WriteHeader(status)
			io.WriteString(w, `{"error":{"message":"schema bad"}}`)
		})
		p := NewOpenAIProvider(srv.URL, "k", "m", "", 1024, srv.Client())
		_, err := p.Chat(context.Background(), chatReq())
		if !check(err) {
			t.Fatalf("HTTP %d mapped wrongly: %T %v", status, err, err)
		}
		serr := p.ChatStream(context.Background(), chatReq(), func(map[string]json.RawMessage) error { return nil })
		if !check(serr) {
			t.Fatalf("stream HTTP %d mapped wrongly: %T %v", status, serr, serr)
		}
	}
}

func TestOpenAIChatFailsOverOnEmptyOrTruncatedAnswers(t *testing.T) {
	for name, body := range map[string]string{
		"no choices":         `{"choices":[]}`,
		"error object":       `{"error":{"message":"x"},"choices":[{"message":{"content":"x"}}]}`,
		"length, no content": `{"choices":[{"message":{"content":""},"finish_reason":"length"}]}`,
	} {
		srv := chatUpstream(t, func(w http.ResponseWriter, _ map[string]any) { io.WriteString(w, body) })
		p := NewOpenAIProvider(srv.URL, "k", "m", "", 1024, srv.Client())
		if _, err := p.Chat(context.Background(), chatReq()); err == nil {
			t.Fatalf("%s: want an error so the chain fails over", name)
		}
	}
	srv := chatUpstream(t, func(w http.ResponseWriter, _ map[string]any) {
		io.WriteString(w, `{"choices":[{"message":{"content":null,"tool_calls":[{"id":"c","type":"function","function":{"name":"f","arguments":"{}"}}]},"finish_reason":"length"}]}`)
	})
	p := NewOpenAIProvider(srv.URL, "k", "m", "", 1024, srv.Client())
	if _, err := p.Chat(context.Background(), chatReq()); err != nil {
		t.Fatalf("a tool call with no content is a real answer: %v", err)
	}
}

func TestOpenAIChatStreamRequiresDoneAndRefusesErrorChunks(t *testing.T) {
	cases := map[string]struct {
		sse     string
		wantErr bool
		chunks  int
	}{
		"clean":        {": keepalive\n\ndata: {\"choices\":[]}\n\nevent: x\ndata: {\"choices\":[]}\n\ndata: [DONE]\n\n", false, 2},
		"no done":      {"data: {\"choices\":[]}\n\n", true, 1},
		"error chunk":  {"data: {\"error\":{\"message\":\"boom\"}}\n\ndata: [DONE]\n\n", true, 0},
		"unparseable":  {"data: {not json\n\n", true, 0},
		"compact data": {"data:{\"choices\":[]}\n\ndata:[DONE]\n\n", false, 1},
	}
	for name, c := range cases {
		var got map[string]any
		srv := chatUpstream(t, func(w http.ResponseWriter, body map[string]any) {
			got = body
			w.Header().Set("Content-Type", "text/event-stream")
			io.WriteString(w, c.sse)
		})
		p := NewOpenAIProvider(srv.URL, "k", "m", "", 1024, srv.Client())
		n := 0
		err := p.ChatStream(context.Background(), chatReq(), func(map[string]json.RawMessage) error { n++; return nil })
		if (err != nil) != c.wantErr || n != c.chunks {
			t.Fatalf("%s: err=%v chunks=%d", name, err, n)
		}
		if so, _ := got["stream_options"].(map[string]any); got["stream"] != true || so["include_usage"] != true {
			t.Fatalf("%s: a stream asks for usage, got %v", name, got)
		}
	}
	// An onChunk error stops the stream and is returned as-is.
	srv := chatUpstream(t, func(w http.ResponseWriter, _ map[string]any) {
		io.WriteString(w, strings.Repeat("data: {\"choices\":[]}\n\n", 3)+"data: [DONE]\n\n")
	})
	p := NewOpenAIProvider(srv.URL, "k", "m", "", 1024, srv.Client())
	stop := errors.New("stop")
	n := 0
	if err := p.ChatStream(context.Background(), chatReq(), func(map[string]json.RawMessage) error { n++; return stop }); !errors.Is(err, stop) || n != 1 {
		t.Fatalf("onChunk error: got %v after %d chunks", err, n)
	}
}

func TestOnlyTheOpenAIProviderIsChatCapable(t *testing.T) {
	var _ ChatProvider = (*OpenAIProvider)(nil)
	for _, p := range []Provider{NewEchoProvider(), NewOllamaProvider("", "", "", nil), NewGeminiProvider("", "", nil),
		NewClaudeProvider("", "", nil), NewHermesProvider("", "", "", nil), NewCentralForwardProvider("", "", nil)} {
		if _, ok := p.(ChatProvider); ok {
			t.Fatalf("%s must not implement ChatProvider", p.Name())
		}
	}
}
