// Package bot decides whether a hit is automated traffic: by user agent (the vendored isbot pattern list)
// or by network (a reviewed list of compute-cloud ASNs). A bot is not forwarded to Umami; it is counted.
package bot

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/dlclark/regexp2"
)

// Reasons, also the values allowed by bot_counts.reason.
const (
	ReasonUA  = "ua"
	ReasonASN = "asn"
)

// maxUALen: a longer user agent is not a browser's. It is also what bounds the regex work per request.
const maxUALen = 1024

// matchTimeout caps one pattern match (the isbot list uses lookaround, so the engine can backtrack).
const matchTimeout = 50 * time.Millisecond

// Verdict is the result of one check.
type Verdict struct {
	Bot    bool
	Reason string // ReasonUA or ReasonASN when Bot
}

// Detector holds the compiled pattern list and the ASN set. Safe for concurrent use.
type Detector struct {
	re   *regexp2.Regexp
	asns map[uint32]struct{}
}

// New compiles the isbot list (a JSON array of JavaScript-flavoured patterns, matched case-insensitively)
// and parses the datacenter ASN list.
func New(isbotPatternsJSON []byte, datacenterASNs string) (*Detector, error) {
	var patterns []string
	if err := json.Unmarshal(isbotPatternsJSON, &patterns); err != nil {
		return nil, fmt.Errorf("isbot patterns: %w", err)
	}
	if len(patterns) == 0 {
		return nil, fmt.Errorf("isbot patterns: the list is empty")
	}
	re, err := regexp2.Compile(strings.Join(patterns, "|"), regexp2.IgnoreCase)
	if err != nil {
		return nil, fmt.Errorf("isbot patterns: %w", err)
	}
	re.MatchTimeout = matchTimeout
	asns, err := ParseASNList(datacenterASNs)
	if err != nil {
		return nil, err
	}
	return &Detector{re: re, asns: asns}, nil
}

// ParseASNList parses data/datacenter-asns.txt: one number per line, optional `# comment`, blank lines and
// whole-line comments ignored. A malformed line is an error that names the line.
func ParseASNList(text string) (map[uint32]struct{}, error) {
	out := map[uint32]struct{}{}
	for i, line := range strings.Split(text, "\n") {
		if h := strings.IndexByte(line, '#'); h >= 0 {
			line = line[:h]
		}
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		n, err := strconv.ParseUint(line, 10, 32)
		if err != nil || n == 0 {
			return nil, fmt.Errorf("datacenter-asns.txt line %d: not an AS number", i+1)
		}
		out[uint32(n)] = struct{}{}
	}
	return out, nil
}

// Check classifies one hit. An empty user agent counts as a bot (a browser always sends one); so does one
// longer than 1024 bytes, and one the pattern engine could not finish in time. asn 0 means unknown.
func (d *Detector) Check(userAgent string, asn uint32) Verdict {
	ua := strings.TrimSpace(userAgent)
	if ua == "" || len(ua) > maxUALen {
		return Verdict{Bot: true, Reason: ReasonUA}
	}
	matched, err := d.re.MatchString(ua)
	if err != nil || matched {
		return Verdict{Bot: true, Reason: ReasonUA}
	}
	if asn != 0 {
		if _, ok := d.asns[asn]; ok {
			return Verdict{Bot: true, Reason: ReasonASN}
		}
	}
	return Verdict{}
}

// ASNCount is the number of listed ASNs (for the startup log).
func (d *Detector) ASNCount() int { return len(d.asns) }
