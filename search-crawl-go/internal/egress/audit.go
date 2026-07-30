package egress

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Decision reasons. "" (empty) is never written — every audit line names a reason (SM-07 AC).
const (
	ReasonNotAllowlisted  = "not_allowlisted" // host is not a registered+verified property domain for this tenant
	ReasonDNSError        = "dns_resolve_failed"
	ReasonPrivateIP       = "private_ip"       // the resolved (or redirect-target) IP is private/reserved
	ReasonRobotsDisallow  = "robots_disallow"  // robots.txt forbids the UA on this path
	ReasonRateLimited     = "rate_limited"     // per-host rate cap exceeded
	ReasonUnknownProperty = "unknown_property" // tenant+propertyId does not resolve to a search_properties row
	ReasonNotVerified     = "not_verified"     // property exists but verified_at is unset (activation checklist)
)

// Line is one append-only audit record. Metadata only — never page content.
type Line struct {
	TS         int64  `json:"ts"`
	TenantID   string `json:"tenantId"`
	PropertyID string `json:"propertyId,omitempty"`
	Host       string `json:"host"`
	IP         string `json:"ip,omitempty"`
	URL        string `json:"url,omitempty"`
	Allowed    bool   `json:"allowed"`
	Reason     string `json:"reason,omitempty"` // required when Allowed==false
}

// Sink is an append-only JSONL audit log, safe for concurrent writers (a crawl job dials many
// hosts/paths concurrently). Same shape as ai-gateway-go/internal/audit (metadata-only JSONL) —
// deliberately not a DB table: a refused dial must be recordable even before the job has resolved
// enough context to safely take a tenant-scoped DB transaction (fail-closed logging must never
// itself depend on the thing it is guarding).
type Sink struct {
	mu   sync.Mutex
	path string
}

func NewSink(path string) *Sink {
	return &Sink{path: path}
}

func (s *Sink) Write(l Line) error {
	if l.TS == 0 {
		l.TS = time.Now().UnixMilli()
	}
	if !l.Allowed && l.Reason == "" {
		// Refuse to emit an unnamed refusal — every refusal line must name the reason (AC).
		l.Reason = "unknown"
	}
	line, err := json.Marshal(l)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return fmt.Errorf("audit mkdir: %w", err)
	}
	f, err := os.OpenFile(s.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return fmt.Errorf("audit open: %w", err)
	}
	defer f.Close()
	_, err = f.Write(append(line, '\n'))
	return err
}

// ReadAll parses every well-formed line back (used by tests + the e2e verification run).
func ReadAll(path string) ([]Line, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var out []Line
	dec := json.NewDecoder(bytes.NewReader(data))
	for {
		var l Line
		if err := dec.Decode(&l); err != nil {
			break
		}
		out = append(out, l)
	}
	return out, nil
}
