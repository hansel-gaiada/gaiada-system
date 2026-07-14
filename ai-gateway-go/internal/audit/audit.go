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
	Capability string  `json:"capability"` // llm | media | embed
	Provider   *string `json:"provider"`   // nil when blocked before egress
	OK         bool    `json:"ok"`
	Blocked    string  `json:"blocked,omitempty"` // auth | budget | dlp | provider
	Redactions int     `json:"redactions"`
	LatencyMs  int64   `json:"latencyMs"`
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
