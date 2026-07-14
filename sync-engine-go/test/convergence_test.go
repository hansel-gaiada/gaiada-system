package test

import (
	"testing"

	"github.com/google/uuid"

	"gaiada/sync-engine-go/internal/hlc"
	"gaiada/sync-engine-go/internal/protocol"
)

// TestConvergenceUnderRandomInterleaving is the spec §4 close-condition for D3: the same set of
// concurrent writes applied to two nodes in DIFFERENT random orders must converge to the same
// final state, and nothing may be silently lost. Covers both policy classes actually in use:
// conflict-queue (status) and lww (name).
func TestConvergenceUnderRandomInterleaving(t *testing.T) {
	a, c := twoPools(t)
	defer a.Close()
	defer c.Close()

	tenant := uuid.NewString()
	project := uuid.NewString()
	deliverable := uuid.NewString()
	seedRow(t, a, tenant, project, deliverable)
	seedRow(t, c, tenant, project, deliverable)

	statuses := []string{"draft", "in_review", "approved", "on_hold", "rejected"}
	names := []string{"n0", "n1", "n2", "n3", "n4"}
	rgen := newRNG(0x9e3779b97f4a7c15)

	var events []protocol.IncomingEvent
	var maxStatusHLC, maxNameHLC hlc.HLC
	var winningStatus, winningName string
	for i := 0; i < 24; i++ {
		origin := "site-a"
		if i%2 == 0 {
			origin = "central"
		}
		h := hlc.HLC{WallMs: int64((i + 1) * 100), Counter: int32(rgen.intn(3))}
		if i%2 == 0 {
			s := statuses[rgen.intn(len(statuses))]
			events = append(events, statusEvent(tenant, deliverable, origin, s, h))
			if h.Compare(maxStatusHLC) > 0 {
				maxStatusHLC, winningStatus = h, s
			}
		} else {
			n := names[rgen.intn(len(names))]
			events = append(events, nameEvent(tenant, deliverable, origin, n, h))
			if h.Compare(maxNameHLC) > 0 {
				maxNameHLC, winningName = h, n
			}
		}
	}

	// Apply to node A in one shuffled order.
	ordA := append([]protocol.IncomingEvent(nil), events...)
	rgen.shuffle(len(ordA), func(i, j int) { ordA[i], ordA[j] = ordA[j], ordA[i] })
	applyAll(t, a, ordA)

	// Apply to node C in a different shuffled order.
	ordC := append([]protocol.IncomingEvent(nil), events...)
	rgen.shuffle(len(ordC), func(i, j int) { ordC[i], ordC[j] = ordC[j], ordC[i] })
	applyAll(t, c, ordC)

	// Convergence: both nodes reached the SAME final state, independent of arrival order...
	if statusOf(t, a, tenant, deliverable) != statusOf(t, c, tenant, deliverable) {
		t.Fatalf("status diverged: A=%q C=%q", statusOf(t, a, tenant, deliverable), statusOf(t, c, tenant, deliverable))
	}
	if nameOf(t, a, tenant, deliverable) != nameOf(t, c, tenant, deliverable) {
		t.Fatalf("name diverged: A=%q C=%q", nameOf(t, a, tenant, deliverable), nameOf(t, c, tenant, deliverable))
	}
	// ...and that state is the highest-HLC value for each field (deterministic winner).
	if got := statusOf(t, a, tenant, deliverable); got != winningStatus {
		t.Fatalf("status did not converge to the max-HLC winner %q, got %q", winningStatus, got)
	}
	if got := nameOf(t, a, tenant, deliverable); got != winningName {
		t.Fatalf("name did not converge to the max-HLC winner %q, got %q", winningName, got)
	}

	// No silent loss: the divergent conflict-queue field (status) recorded conflicts on both nodes.
	if conflictCount(t, a, tenant, deliverable) == 0 || conflictCount(t, c, tenant, deliverable) == 0 {
		t.Fatal("expected conflict-queue divergences to be recorded on both nodes (no silent loss)")
	}
}
