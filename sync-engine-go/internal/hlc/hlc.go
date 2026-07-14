// Hybrid Logical Clock — THE only clock for cross-site ordering (sync-engine-revision §2,
// D3 fix #2: never updated_at). Byte-for-byte interoperable with platform-nest/src/events/hlc.ts.
//
// Canonical text format is ZERO-PADDED "%013d.%010d" (wallMs.counter). Padding makes plain text
// ordering equal logical ordering, so SQL `hlc > cursor` and `MAX(hlc)` are correct as text
// comparisons (unpadded "%d.%d" sorts "1000..." before "999..."). Compare() still uses the
// numeric fields; only the string form is padded.
//
// SeedFromPersisted implements D3 fix #4: on startup/promotion, lift the clock to at least the
// last HLC persisted for this origin_site so a promoted standby with a lagging wall clock can
// never mint an HLC that regresses behind what is already committed.
package hlc

import (
	"fmt"
	"strconv"
	"strings"
	"sync"
)

const (
	wallWidth = 13
	ctrWidth  = 10
)

type HLC struct {
	WallMs  int64
	Counter int32
}

func (h HLC) Compare(other HLC) int {
	if h.WallMs != other.WallMs {
		if h.WallMs < other.WallMs {
			return -1
		}
		return 1
	}
	if h.Counter != other.Counter {
		if h.Counter < other.Counter {
			return -1
		}
		return 1
	}
	return 0
}

func (h HLC) String() string {
	return fmt.Sprintf("%0*d.%0*d", wallWidth, h.WallMs, ctrWidth, h.Counter)
}

func Parse(s string) (HLC, error) {
	parts := strings.SplitN(s, ".", 2)
	if len(parts) != 2 {
		return HLC{}, fmt.Errorf("invalid HLC string: %q", s)
	}
	wall, err := strconv.ParseInt(parts[0], 10, 64) // ParseInt tolerates leading zeros
	if err != nil {
		return HLC{}, err
	}
	counter, err := strconv.ParseInt(parts[1], 10, 32)
	if err != nil {
		return HLC{}, err
	}
	return HLC{WallMs: wall, Counter: int32(counter)}, nil
}

type Clock struct {
	mu      sync.Mutex
	now     func() int64
	lastMs  int64
	counter int32
}

func NewClock(now func() int64) *Clock {
	return &Clock{now: now}
}

func (c *Clock) Next() HLC {
	c.mu.Lock()
	defer c.mu.Unlock()
	wall := c.now()
	if wall > c.lastMs {
		c.lastMs = wall
		c.counter = 0
	} else {
		c.counter++
	}
	return HLC{WallMs: c.lastMs, Counter: c.counter}
}

// SeedFromPersisted enforces the startup guard: the clock never issues an HLC <= lastKnown.
func (c *Clock) SeedFromPersisted(lastKnown HLC) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if lastKnown.WallMs > c.lastMs || (lastKnown.WallMs == c.lastMs && lastKnown.Counter > c.counter) {
		c.lastMs = lastKnown.WallMs
		c.counter = lastKnown.Counter
	}
}
