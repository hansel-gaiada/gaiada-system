package consent

import (
	"sync"
	"time"
)

// bucket is a token bucket; the clock is passed in so tests do not sleep.
type bucket struct {
	tokens float64
	last   time.Time
}

func (b *bucket) take(now time.Time, rate, burst float64) bool {
	if b.last.IsZero() {
		b.tokens = burst
	} else if d := now.Sub(b.last).Seconds(); d > 0 {
		b.tokens += d * rate
		if b.tokens > burst {
			b.tokens = burst
		}
	}
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// limiter is the 429 of design 4.4. It holds no address (the collector keeps none in memory beyond a request):
// one global bucket stops a flood from any number of forged ids, and a per-visitor-id bucket stops one client
// hammering with a single id. The per-id map is bounded: past maxKeys it is emptied rather than grown.
type limiter struct {
	mu       sync.Mutex
	global   bucket
	perKey   map[string]*bucket
	rate     float64 // global tokens per second (also the global burst)
	keyRate  float64
	keyBurst float64
	maxKeys  int
}

func newLimiter(globalPerSec int) *limiter {
	return &limiter{
		perKey: map[string]*bucket{}, rate: float64(globalPerSec),
		keyRate: 0.5, keyBurst: 10, maxKeys: 50000,
	}
}

// allowGlobal takes one token from the global bucket.
func (l *limiter) allowGlobal(now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.global.take(now, l.rate, l.rate)
}

// allowKey takes one token from the visitor id's own bucket.
func (l *limiter) allowKey(now time.Time, key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.perKey[key]
	if b == nil {
		if len(l.perKey) >= l.maxKeys {
			l.perKey = map[string]*bucket{}
		}
		b = &bucket{}
		l.perKey[key] = b
	}
	return b.take(now, l.keyRate, l.keyBurst)
}
