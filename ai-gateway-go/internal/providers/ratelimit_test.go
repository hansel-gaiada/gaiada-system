package providers

import (
	"net/http"
	"testing"
	"time"
)

func TestParseRetryAfterUsesHeaderSeconds(t *testing.T) {
	h := http.Header{}
	h.Set("Retry-After", "12")
	if got := parseRetryAfter(h); got != 12*time.Second {
		t.Fatalf("expected 12s, got %s", got)
	}
}

func TestParseRetryAfterFallsBackWhenMissing(t *testing.T) {
	if got := parseRetryAfter(http.Header{}); got != defaultRetryAfter {
		t.Fatalf("expected default %s, got %s", defaultRetryAfter, got)
	}
}

func TestParseRetryAfterFallsBackWhenUnparseable(t *testing.T) {
	h := http.Header{}
	// The HTTP-date form (not seconds) is deliberately not parsed by any of our providers.
	h.Set("Retry-After", "Wed, 21 Oct 2099 07:28:00 GMT")
	if got := parseRetryAfter(h); got != defaultRetryAfter {
		t.Fatalf("expected default %s for unparseable header, got %s", defaultRetryAfter, got)
	}
}

func TestParseRetryAfterCapsHugeValues(t *testing.T) {
	h := http.Header{}
	h.Set("Retry-After", "3600") // 1h — well past the 5m cap
	if got := parseRetryAfter(h); got != maxRetryAfter {
		t.Fatalf("expected capped %s, got %s", maxRetryAfter, got)
	}
}

func TestRateLimitErrorMessage(t *testing.T) {
	err := &RateLimitError{RetryAfter: 30 * time.Second}
	if err.Error() != "rate limited, retry after 30s" {
		t.Fatalf("unexpected message: %q", err.Error())
	}
}
