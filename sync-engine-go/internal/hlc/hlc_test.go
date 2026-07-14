package hlc

import "testing"

func TestClockIsMonotonicUnderSameWallTime(t *testing.T) {
	wall := int64(1000)
	c := NewClock(func() int64 { return wall })
	h1 := c.Next()
	h2 := c.Next()
	if h2.Compare(h1) <= 0 {
		t.Fatalf("expected h2 > h1 even under identical wall time, got h1=%v h2=%v", h1, h2)
	}
}

func TestClockAdvancesWithWallTime(t *testing.T) {
	wall := int64(1000)
	c := NewClock(func() int64 { return wall })
	h1 := c.Next()
	wall = 2000
	h2 := c.Next()
	if h2.WallMs != 2000 || h2.Counter != 0 {
		t.Fatalf("expected wall-time jump to reset counter, got %+v", h2)
	}
	if h2.Compare(h1) <= 0 {
		t.Fatal("expected h2 > h1")
	}
}

func TestSeedFromPersistedRejectsRegression(t *testing.T) {
	wall := int64(500) // simulates a clock-skewed/regressed node on failover
	c := NewClock(func() int64 { return wall })
	c.SeedFromPersisted(HLC{WallMs: 9000, Counter: 3})
	h := c.Next()
	if h.Compare(HLC{WallMs: 9000, Counter: 3}) <= 0 {
		t.Fatalf("expected seeded clock never to regress below the last persisted HLC, got %+v", h)
	}
}

func TestStringIsPaddedSoTextOrderMatchesLogicalOrder(t *testing.T) {
	// The bug this guards: unpadded "1000.0" < "999.0" lexicographically.
	if !(HLC{WallMs: 1000}.String() > HLC{WallMs: 999}.String()) {
		t.Fatal("padded text ordering must match logical ordering across digit widths")
	}
	if !(HLC{WallMs: 1000, Counter: 10}.String() > HLC{WallMs: 1000, Counter: 9}.String()) {
		t.Fatal("counter must be padded too")
	}
}

func TestParseRoundTrips(t *testing.T) {
	h := HLC{WallMs: 123456789, Counter: 7}
	parsed, err := Parse(h.String())
	if err != nil {
		t.Fatalf("Parse failed: %v", err)
	}
	if parsed != h {
		t.Fatalf("round-trip mismatch: %+v != %+v", parsed, h)
	}
}

// Interop guard: the Go padded form must equal what platform-nest's formatHlc emits.
func TestPaddedFormatMatchesTypeScriptContract(t *testing.T) {
	if got := (HLC{WallMs: 1700000000000, Counter: 0}).String(); got != "1700000000000.0000000000" {
		t.Fatalf("format drift vs platform-nest hlc.ts: got %q", got)
	}
}
