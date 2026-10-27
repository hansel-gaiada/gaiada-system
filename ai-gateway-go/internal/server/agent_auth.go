// agent_auth.go: per-agent bearer tokens for the agent listener (AIP-00a-1).
//
// The gateway stores only SHA-256 hashes (GATEWAY_AGENT_TOKENS=name:sha256hex,...). A presented
// bearer is hashed and compared in constant time against every entry. The set is all-or-nothing:
// an empty variable, or ANY malformed entry, leaves it empty, so every agent call is 401 (fail
// closed) rather than half the agents silently working.
//
// Isolation is structural. The main mux's authorized() reads only GATEWAY_TOKEN and never sees
// this set, so an agent token opens nothing on the main listener. The agent mux reads only this
// set, and additionally refuses the shared GATEWAY_TOKEN outright, so the ERP's token cannot open
// the agent routes even if an operator hashed it into the set by mistake.
package server

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"net/http"
	"regexp"
	"strings"
)

type agentToken struct {
	name string
	hash [sha256.Size]byte
}

// AgentTokens is the parsed GATEWAY_AGENT_TOKENS set. The zero value admits nobody.
type AgentTokens struct {
	entries []agentToken
}

// agentNameRe bounds an agent name: it becomes the audit identity and the budget key, so it must
// be short and plain.
var agentNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,62}$`)

// ParseAgentTokens parses "name:sha256hex[,name:sha256hex...]". It returns an empty set with a nil
// error for an empty value (listener effectively closed), and an empty set with an error for any
// malformed entry, a duplicate name, or a duplicate hash. The error never contains a hash.
func ParseAgentTokens(raw string) (AgentTokens, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return AgentTokens{}, nil
	}
	var out AgentTokens
	names := map[string]bool{}
	hashes := map[[sha256.Size]byte]bool{}
	for i, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		name, hx, ok := strings.Cut(part, ":")
		if !ok {
			return AgentTokens{}, fmt.Errorf("GATEWAY_AGENT_TOKENS entry %d: want name:sha256hex", i+1)
		}
		name = strings.TrimSpace(name)
		hx = strings.ToLower(strings.TrimSpace(hx))
		if !agentNameRe.MatchString(name) {
			return AgentTokens{}, fmt.Errorf("GATEWAY_AGENT_TOKENS entry %d: name must match %s", i+1, agentNameRe)
		}
		if len(hx) != 2*sha256.Size {
			return AgentTokens{}, fmt.Errorf("GATEWAY_AGENT_TOKENS entry %d (%s): hash must be 64 hex characters", i+1, name)
		}
		b, err := hex.DecodeString(hx)
		if err != nil {
			return AgentTokens{}, fmt.Errorf("GATEWAY_AGENT_TOKENS entry %d (%s): hash is not hex", i+1, name)
		}
		var h [sha256.Size]byte
		copy(h[:], b)
		if names[name] {
			return AgentTokens{}, fmt.Errorf("GATEWAY_AGENT_TOKENS: duplicate name %s", name)
		}
		if hashes[h] {
			return AgentTokens{}, fmt.Errorf("GATEWAY_AGENT_TOKENS entry %d (%s): duplicate hash (two agents would share one identity)", i+1, name)
		}
		names[name], hashes[h] = true, true
		out.entries = append(out.entries, agentToken{name: name, hash: h})
	}
	return out, nil
}

// Names lists the registered agent names (for the boot log). Never the hashes.
func (a AgentTokens) Names() []string {
	out := make([]string, 0, len(a.entries))
	for _, e := range a.entries {
		out = append(out, e.name)
	}
	return out
}

// Len is the number of registered agents.
func (a AgentTokens) Len() int { return len(a.entries) }

// without drops every entry whose hash equals sha256(token): used to make sure the shared
// GATEWAY_TOKEN can never be an agent token. Reports whether anything was dropped.
func (a AgentTokens) without(token string) (AgentTokens, bool) {
	if token == "" {
		return a, false
	}
	h := sha256.Sum256([]byte(token))
	out := AgentTokens{}
	dropped := false
	for _, e := range a.entries {
		if subtle.ConstantTimeCompare(e.hash[:], h[:]) == 1 {
			dropped = true
			continue
		}
		out.entries = append(out.entries, e)
	}
	return out, dropped
}

// match returns the agent whose hash equals sha256(presented). It walks EVERY entry with no early
// exit, so the time taken does not reveal which entry (if any) matched.
func (a AgentTokens) match(presented string) (string, bool) {
	if presented == "" || len(a.entries) == 0 {
		return "", false
	}
	h := sha256.Sum256([]byte(presented))
	found := -1
	for i, e := range a.entries {
		if subtle.ConstantTimeCompare(e.hash[:], h[:]) == 1 {
			found = i
		}
	}
	if found < 0 {
		return "", false
	}
	return a.entries[found].name, true
}

// bearerOf returns the token from "Authorization: Bearer <token>", or "".
func bearerOf(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(h, "Bearer ") {
		return ""
	}
	return strings.TrimSpace(strings.TrimPrefix(h, "Bearer "))
}

// agentOf authenticates an agent-listener request: the agent's name, or ok=false. The shared
// GATEWAY_TOKEN is refused explicitly, in constant time, before the set is consulted.
func agentOf(r *http.Request, set AgentTokens, gatewayToken string) (string, bool) {
	presented := bearerOf(r)
	if presented == "" {
		return "", false
	}
	if gatewayToken != "" && subtle.ConstantTimeCompare([]byte(presented), []byte(gatewayToken)) == 1 {
		return "", false
	}
	return set.match(presented)
}
