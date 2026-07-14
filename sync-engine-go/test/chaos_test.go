package test

import (
	"testing"

	"github.com/google/uuid"

	"gaiada/sync-engine-go/internal/hlc"
	"gaiada/sync-engine-go/internal/protocol"
)

// TestPartitionThenHealConverges: a node sees only half the events during a partition, then the
// rest after healing (in reverse order). It must still converge to the other node's state.
func TestPartitionThenHealConverges(t *testing.T) {
	a, c := twoPools(t)
	defer a.Close()
	defer c.Close()

	tenant, project, deliverable := uuid.NewString(), uuid.NewString(), uuid.NewString()
	seedRow(t, a, tenant, project, deliverable)
	seedRow(t, c, tenant, project, deliverable)

	var events []protocol.IncomingEvent
	statuses := []string{"draft", "in_review", "approved", "on_hold"}
	var winner string
	var maxH hlc.HLC
	for i := 0; i < 8; i++ {
		origin := "site-a"
		if i%2 == 0 {
			origin = "central"
		}
		h := hlc.HLC{WallMs: int64((i + 1) * 100)}
		s := statuses[i%len(statuses)]
		events = append(events, statusEvent(tenant, deliverable, origin, s, h))
		if h.Compare(maxH) > 0 {
			maxH, winner = h, s
		}
	}

	// Node A gets everything.
	applyAll(t, a, events)
	// Node C is partitioned: first half now, second half (reversed) after "healing".
	applyAll(t, c, events[:4])
	reversed := append([]protocol.IncomingEvent(nil), events[4:]...)
	for i, j := 0, len(reversed)-1; i < j; i, j = i+1, j-1 {
		reversed[i], reversed[j] = reversed[j], reversed[i]
	}
	applyAll(t, c, reversed)

	if statusOf(t, a, tenant, deliverable) != statusOf(t, c, tenant, deliverable) {
		t.Fatalf("partition heal diverged: A=%q C=%q", statusOf(t, a, tenant, deliverable), statusOf(t, c, tenant, deliverable))
	}
	if statusOf(t, c, tenant, deliverable) != winner {
		t.Fatalf("expected convergence to max-HLC winner %q, got %q", winner, statusOf(t, c, tenant, deliverable))
	}
}

// TestReapplyIsIdempotent: redelivering the same events (crash-and-resume, duplicate pull) must
// not reprocess them — no new conflicts, same final state.
func TestReapplyIsIdempotent(t *testing.T) {
	a, _ := twoPools(t)
	defer a.Close()

	tenant, project, deliverable := uuid.NewString(), uuid.NewString(), uuid.NewString()
	seedRow(t, a, tenant, project, deliverable)

	events := []protocol.IncomingEvent{
		statusEvent(tenant, deliverable, "site-a", "approved", hlc.HLC{WallMs: 100}),
		statusEvent(tenant, deliverable, "central", "rejected", hlc.HLC{WallMs: 200}),
	}
	applyAll(t, a, events)
	firstStatus := statusOf(t, a, tenant, deliverable)
	firstConflicts := conflictCount(t, a, tenant, deliverable)

	applyAll(t, a, events) // redeliver the exact same events
	if statusOf(t, a, tenant, deliverable) != firstStatus {
		t.Fatal("re-applying the same events changed the state (not idempotent)")
	}
	if conflictCount(t, a, tenant, deliverable) != firstConflicts {
		t.Fatal("re-applying the same events recorded new conflicts (dedup ledger not honored)")
	}
}

// TestDeleteWinsNoResurrection: once deleted, a later update event must not resurrect the row.
func TestDeleteWinsNoResurrection(t *testing.T) {
	a, _ := twoPools(t)
	defer a.Close()

	tenant, project, deliverable := uuid.NewString(), uuid.NewString(), uuid.NewString()
	seedRow(t, a, tenant, project, deliverable)

	del := protocol.IncomingEvent{
		OutboxID: uuid.NewString(), TenantID: tenant, EntityType: "deliverable", EntityID: deliverable,
		EventType: "deliverable.deleted", Payload: map[string]any{"_deleted": true}, HLC: hlc.HLC{WallMs: 1000}, OriginSite: "site-a",
	}
	// A later (higher-HLC) update arriving after the delete must not bring the row back.
	upd := statusEvent(tenant, deliverable, "central", "approved", hlc.HLC{WallMs: 2000})

	applyAll(t, a, []protocol.IncomingEvent{del, upd})
	if !deletedAtSet(t, a, tenant, deliverable) {
		t.Fatal("delete-wins violated: a post-delete update resurrected the row")
	}
	// And order-independence: apply in the other order to a fresh entity.
	deliverable2 := uuid.NewString()
	seedRow(t, a, tenant, project, deliverable2)
	del2 := del
	del2.OutboxID = uuid.NewString()
	del2.EntityID = deliverable2
	upd2 := statusEvent(tenant, deliverable2, "central", "approved", hlc.HLC{WallMs: 2000})
	applyAll(t, a, []protocol.IncomingEvent{upd2, del2})
	if !deletedAtSet(t, a, tenant, deliverable2) {
		t.Fatal("delete-wins violated in reverse order")
	}
}
