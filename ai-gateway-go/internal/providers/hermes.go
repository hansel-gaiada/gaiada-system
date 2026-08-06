// HermesProvider forwards to hermes-gateway (ASST-14/15) — a separate, standalone shim service
// (zero-runtime-dependency Node) that runs the local Hermes agent as the "brain" and speaks the
// SAME SSE wire grammar v2 this gateway does on /complete/stream (ASST-10/11, plus ASST-15's
// `event: session`). This is the provider ASST-14's own header comment predicted: "A future
// ai-gateway-go 'hermes' provider (ASST-15) re-times this at the relay layer" — except no
// re-timing happens HERE, because the actual fix was making hermes-gateway itself emit `meta`
// pre-first-token like every other provider (see docs/FRONTEND-BFF-CONTRACT.md §18's "ASST-15 —
// one grammar for `meta`" addendum for the full resolution). This file's only job is to relay
// hermes-gateway's tokens through onToken and its `providerSession` through onSession, verbatim
// and opaquely.
package providers

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// HermesProvider is an HTTP client for hermes-gateway's own /complete and /complete/stream
// endpoints. Model is reported (providers.ModelReporter) but is whatever hermes-gateway's own
// HERMES_MODEL config says — this gateway never picks Hermes' model itself.
type HermesProvider struct {
	URL, Model string
	Client     *http.Client
}

func NewHermesProvider(url, model string, client *http.Client) *HermesProvider {
	return &HermesProvider{URL: url, Model: model, Client: client}
}

var _ StreamingProvider = (*HermesProvider)(nil)
var _ SessionStreamingProvider = (*HermesProvider)(nil)
var _ ModelReporter = (*HermesProvider)(nil)

func (p *HermesProvider) Name() string    { return "hermes" }
func (p *HermesProvider) Available() bool { return p.URL != "" }

// ModelName implements providers.ModelReporter (ASST-11/15): reports whatever this instance is
// configured with. Empty ("") is truthful when HERMES_MODEL is unset — hermes-gateway itself
// defaults to "whatever Hermes is configured for" rather than guessing, and this provider mirrors
// that rather than inventing a name.
func (p *HermesProvider) ModelName() string { return p.Model }

// Complete: the non-streaming path, calling hermes-gateway's own buffered /complete — for parity
// only, if an operator ever puts "hermes" into a non-streaming chain. /complete/stream (below) is
// this provider's real purpose. hermes-gateway's /complete is byte-for-byte untouched by ASST-14/
// 15 (wa-chat-bot depends on it) — this client call is just an ordinary consumer of that same
// stable contract.
func (p *HermesProvider) Complete(ctx context.Context, prompt string) (string, error) {
	body, _ := json.Marshal(map[string]string{"prompt": prompt})
	req, err := http.NewRequestWithContext(ctx, "POST", p.URL+"/complete", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := p.Client.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusTooManyRequests {
		return "", newRateLimitError(res)
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return "", fmt.Errorf("hermes %d", res.StatusCode)
	}
	var data struct {
		Text *string `json:"text"`
	}
	if err := json.NewDecoder(res.Body).Decode(&data); err != nil || data.Text == nil {
		return "", fmt.Errorf("hermes returned no text")
	}
	return *data.Text, nil
}

// Media/Embed: hermes-gateway has a separate /media endpoint (image/audio description) but no
// /embed at all. Neither is this ticket's scope (ASST-15 is /complete/stream only) — honest
// failover, same pattern as ollama.go's Media() for a capability it genuinely lacks, rather than a
// silent stub.
func (p *HermesProvider) Media(_ context.Context, _, mime string) (string, error) {
	return "", fmt.Errorf("hermes: media %s not routed through this provider — failing over", mime)
}

func (p *HermesProvider) Embed(_ context.Context, _ string) ([]float64, error) {
	return nil, fmt.Errorf("hermes: embed not supported — failing over")
}

// CompleteStream implements providers.StreamingProvider for a caller with no session to pass —
// e.g. the non-hinted, non-session-aware chain.Run path.
func (p *HermesProvider) CompleteStream(ctx context.Context, prompt string, onToken func(string)) error {
	return p.CompleteStreamSession(ctx, prompt, "", onToken, func(string, bool, string) {})
}

// CompleteStreamSession implements providers.SessionStreamingProvider (ASST-15, widened by
// ASST-24). `session` is the OPAQUE caller-supplied continuation token — forwarded verbatim as the
// outgoing request body's `providerSession` field when non-empty, omitted otherwise (never sent as
// an empty string). onSession reports whatever hermes-gateway's `event: session` frame carries
// back, at most once, only when present, INCLUDING the ASST-24 `resumed`/`requestedSession` fields
// hermes-gateway's own fix (server.mjs's `writeSSESession`) now always sends alongside it.
func (p *HermesProvider) CompleteStreamSession(ctx context.Context, prompt, session string, onToken func(string), onSession func(session string, resumed bool, requestedSession string)) error {
	reqBody := map[string]string{"prompt": prompt}
	if session != "" {
		reqBody["providerSession"] = session
	}
	body, _ := json.Marshal(reqBody)
	req, err := http.NewRequestWithContext(ctx, "POST", p.URL+"/complete/stream", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	res, err := p.Client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusTooManyRequests {
		return newRateLimitError(res)
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("hermes %d", res.StatusCode)
	}
	return parseHermesSSE(res.Body, onToken, onSession)
}

// parseHermesSSE reads hermes-gateway's own wire grammar v2 — identical single-line-JSON `data:`
// framing to this gateway's own (ASST-10), `event:` lines naming meta/session/error/done (ASST-11/
// 15/24) — and relays it: default (unnamed) events -> onToken, `event: session` -> onSession,
// `event: error` -> returned as this call's error (which chain.Run then treats exactly like any
// other provider failure — normal failover/error-event handling, no special case needed),
// `event: done` -> clean return.
//
// ASST-24: `event: session`'s payload now carries `resumed`/`requestedSession` alongside
// `providerSession` — parsed here with `resumed` as a `*bool` so a genuinely ABSENT field (an
// older hermes-gateway build that predates the fix) is distinguishable from an explicit `false`;
// absent defaults to `true` ("assume fine, never assume failed" — the same discipline the ticket
// mandates all the way up the chain). `requestedSession` defaults to "" when absent, mirroring
// `providerSession`'s own never-invented convention.
//
// `event: meta` is deliberately NOT relayed: hermes-gateway's copy of it carries exactly
// {provider:"hermes", model}, which THIS gateway's own emit()/writeSSEMeta already knows
// statically via Name()/ModelName() before this call even starts — relaying it would be redundant,
// not informative, and would risk a second, contradictory meta reaching the real client.
func parseHermesSSE(r io.Reader, onToken func(string), onSession func(session string, resumed bool, requestedSession string)) error {
	scanner := bufio.NewScanner(r)
	// hermes-gateway's tokens are Hermes chat-box lines, not large media — 4MB is generous
	// headroom over the default 64KB scanner buffer without being unbounded.
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	var event string
	sawDone := false
	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case line == "":
			event = ""
			continue
		case strings.HasPrefix(line, "event: "):
			event = strings.TrimPrefix(line, "event: ")
			continue
		case strings.HasPrefix(line, "data: "):
			data := strings.TrimPrefix(line, "data: ")
			switch event {
			case "error":
				var payload struct {
					Error string `json:"error"`
				}
				if err := json.Unmarshal([]byte(data), &payload); err == nil && payload.Error != "" {
					return fmt.Errorf("hermes: %s", payload.Error)
				}
				return fmt.Errorf("hermes: stream error")
			case "done":
				sawDone = true
			case "session":
				var payload struct {
					ProviderSession  string `json:"providerSession"`
					Resumed          *bool  `json:"resumed"`
					RequestedSession string `json:"requestedSession"`
				}
				if err := json.Unmarshal([]byte(data), &payload); err == nil && payload.ProviderSession != "" {
					resumed := true // absent-tolerant default: "assume fine", never "assume failed"
					if payload.Resumed != nil {
						resumed = *payload.Resumed
					}
					onSession(payload.ProviderSession, resumed, payload.RequestedSession)
				}
			case "meta":
				// Deliberately ignored — see the doc comment above this function.
			case "":
				var tok string
				if err := json.Unmarshal([]byte(data), &tok); err == nil {
					onToken(tok)
				}
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	if !sawDone {
		return fmt.Errorf("hermes: stream ended without a clean completion (abnormal drop)")
	}
	return nil
}
