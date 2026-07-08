// Egress audit — port of ai-gateway/src/audit.ts. Append-only JSONL, metadata only, never
// payload content.
package audit

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
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
