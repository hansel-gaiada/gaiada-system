// Egress audit — port of ai-gateway/src/audit.ts. Append-only JSONL, metadata only, never
// payload content.
package audit

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type EgressAudit struct {
	TS         int64   `json:"ts"`
	Capability string  `json:"capability"` // llm | media | embed | chat (AIP-00a-1, the agent listener)
	Provider   *string `json:"provider"`   // nil when blocked before egress
	OK         bool    `json:"ok"`
	// auth | budget | dlp | timeout | rate_limit | provider_error. The last three are the B5
	// provider-failure taxonomy (chain.TaxonomyTimeout/TaxonomyRateLimit/TaxonomyProviderError):
	// which one is recorded depends on how every attempted provider in the chain failed —
	// see chain.overallTaxonomy.
	Blocked    string `json:"blocked,omitempty"`
	Redactions int    `json:"redactions"`
	// ForcedBoundaries (ASST-13) is dlp.StreamScrubber.ForcedBoundaries() — a count of
	// cap-triggered response-side flushes that skipped the split-transparency check (see
	// internal/dlp/stream.go). Zero on every non-streaming route (/complete, /media, /embed
	// never construct a StreamScrubber) and omitted from their JSON, so those rows stay
	// byte-identical to before this field existed. Non-zero only means /complete/stream hit
	// its buffer cap under adversarial/pathological input — see the dlp package comment for
	// the exact cost.
	ForcedBoundaries int   `json:"forcedBoundaries,omitempty"`
	LatencyMs        int64 `json:"latencyMs"`
	// Agent (AIP-00a-1) is the registered agent's name on a `chat` row (the name half of its
	// GATEWAY_AGENT_TOKENS entry); empty, and omitted, on every other route and on a chat 401.
	// Model is the upstream model that served a chat call. PromptTokens/CompletionTokens are the
	// provider-reported usage, omitted when the provider reported none (never estimated). All four
	// are omitempty, so rows from the existing routes stay byte-identical. A row NEVER holds message
	// text, tool arguments or tool results.
	Agent            string `json:"agent,omitempty"`
	Model            string `json:"model,omitempty"`
	PromptTokens     int    `json:"promptTokens,omitempty"`
	CompletionTokens int    `json:"completionTokens,omitempty"`
	// CostUSD (AIP-02) is the upstream's own cost figure for the call (OpenRouter's usage.cost),
	// set only on a successful `llm` row whose provider reported one. PromptTokens/CompletionTokens
	// are likewise set on `llm` rows when the provider reported usage. All omitempty: a row
	// without usage stays byte-identical, and a row NEVER holds text.
	CostUSD float64 `json:"costUsd,omitempty"`
	// Task and Tier (AIP-06). Task is the validated `task` the caller sent (even when routing did not
	// use it); Tier is the tier that was actually APPLIED (the serving provider was the tier's
	// provider), never the one merely requested. Both omitempty, so a row for a request with neither
	// stays byte-identical. A routed success also sets Model to the served model. Never text.
	Task string `json:"task,omitempty"`
	Tier string `json:"tier,omitempty"`
}

func WriteAudit(path string, e EgressAudit) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("audit mkdir: %w", err)
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return fmt.Errorf("audit open: %w", err)
	}
	defer f.Close()
	line, err := json.Marshal(e)
	if err != nil {
		return err
	}
	_, err = f.Write(append(line, '\n'))
	return err
}

// ReadRecent returns up to `limit` most-recent audit entries (newest first). A missing
// file is not an error — it yields an empty slice. Malformed lines are skipped.
func ReadRecent(path string, limit int) ([]EgressAudit, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return []EgressAudit{}, nil
		}
		return nil, err
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	out := make([]EgressAudit, 0, limit)
	// Walk from the end so we collect the newest entries first.
	for i := len(lines) - 1; i >= 0 && len(out) < limit; i-- {
		line := strings.TrimSpace(lines[i])
		if line == "" {
			continue
		}
		var e EgressAudit
		if json.Unmarshal([]byte(line), &e) == nil {
			out = append(out, e)
		}
	}
	return out, nil
}
