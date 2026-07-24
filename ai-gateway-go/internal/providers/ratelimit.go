// ai-gateway-go/internal/providers/ratelimit.go
// B5 (gateway reliability): a typed rate-limit signal distinct from a generic provider
// error. Providers that hit an upstream HTTP 429 return *RateLimitError instead of a plain
// fmt.Errorf so chain.Run can open that provider's breaker for exactly the advertised
// Retry-After window — instead of counting it toward the normal consecutive-failure
// threshold, which would either under- or over-react to a well-behaved rate limiter.
package providers

import (
	"fmt"
	"net/http"
	"strconv"
	"time"
)

// RateLimitError signals an upstream HTTP 429. RetryAfter is already parsed and capped —
// callers (chain.Run) use it directly as the breaker's open-window duration.
type RateLimitError struct {
	RetryAfter time.Duration
}

func (e *RateLimitError) Error() string {
	return fmt.Sprintf("rate limited, retry after %s", e.RetryAfter)
}

const (
	// defaultRetryAfter is used when a 429 doesn't carry a (parseable) Retry-After header.
	defaultRetryAfter = 30 * time.Second
	// maxRetryAfter caps a huge/malformed Retry-After value so one upstream can't wedge its
	// breaker open indefinitely (design doc §3.5: "cap at e.g. 5m").
	maxRetryAfter = 5 * time.Minute
)

// parseRetryAfter reads the standard Retry-After response header. Only the seconds form is
// parsed (none of the four providers here send the HTTP-date form); anything absent or
// unparseable falls back to defaultRetryAfter, and anything huge is capped at maxRetryAfter.
func parseRetryAfter(h http.Header) time.Duration {
	v := h.Get("Retry-After")
	if v == "" {
		return defaultRetryAfter
	}
	secs, err := strconv.Atoi(v)
	if err != nil || secs <= 0 {
		return defaultRetryAfter
	}
	d := time.Duration(secs) * time.Second
	if d > maxRetryAfter {
		return maxRetryAfter
	}
	return d
}

// newRateLimitError builds a *RateLimitError from a 429 response's headers. Shared by every
// provider's HTTP call site.
func newRateLimitError(res *http.Response) *RateLimitError {
	return &RateLimitError{RetryAfter: parseRetryAfter(res.Header)}
}
