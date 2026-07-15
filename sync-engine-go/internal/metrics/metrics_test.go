package metrics

import (
	"context"
	"testing"
	"time"
)

// A successful cycle must advance the freshness clock; a failed one must not. This is the signal the
// sync_seconds_since_last_success SLI reads, so it has to move only on real success.
func TestRecordCycleAdvancesFreshnessOnlyOnSuccess(t *testing.T) {
	in := New()
	fixed := time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC)
	in.now = func() time.Time { return fixed }

	if in.lastSuccessUnix.Load() != 0 {
		t.Fatal("freshness clock should start unset")
	}
	in.RecordCycle(context.Background(), "pull", false, 0)
	if in.lastSuccessUnix.Load() != 0 {
		t.Fatal("a failed cycle must not advance the freshness clock")
	}
	in.RecordCycle(context.Background(), "pull", true, 3)
	if got := in.lastSuccessUnix.Load(); got != fixed.Unix() {
		t.Fatalf("a successful cycle must set the freshness clock to now, got %d want %d", got, fixed.Unix())
	}
}

// Recorders must be nil-safe so instrumentation never panics the data plane.
func TestRecordersNilSafe(t *testing.T) {
	var in *Instruments
	in.RecordApplied(context.Background(), 1)
	in.RecordRejected(context.Background(), "acl")
	in.RecordConflict(context.Background(), "lww")
	in.RecordCycle(context.Background(), "push", true, 1)
}
