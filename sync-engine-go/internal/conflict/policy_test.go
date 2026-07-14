package conflict

import (
	"testing"

	"gaiada/sync-engine-go/internal/hlc"
)

func TestLWWResolvesByHLC(t *testing.T) {
	older := FieldValue{HLC: hlc.HLC{WallMs: 100}, Value: "old"}
	newer := FieldValue{HLC: hlc.HLC{WallMs: 200}, Value: "new"}
	winner, needsReview := Resolve(PolicyLWW, older, newer)
	if winner.Value != "new" || needsReview {
		t.Fatalf("expected LWW to pick the newer value without review, got %+v needsReview=%v", winner, needsReview)
	}
}

func TestConflictQueueAlwaysNeedsReviewOnDivergence(t *testing.T) {
	a := FieldValue{HLC: hlc.HLC{WallMs: 100}, Value: "approved"}
	b := FieldValue{HLC: hlc.HLC{WallMs: 200}, Value: "rejected"}
	_, needsReview := Resolve(PolicyConflictQueue, a, b)
	if !needsReview {
		t.Fatal("expected conflict-queue policy to flag divergent values for review")
	}
}

func TestConflictQueueNoReviewWhenValuesEqual(t *testing.T) {
	a := FieldValue{HLC: hlc.HLC{WallMs: 100}, Value: "approved"}
	b := FieldValue{HLC: hlc.HLC{WallMs: 200}, Value: "approved"}
	_, needsReview := Resolve(PolicyConflictQueue, a, b)
	if needsReview {
		t.Fatal("identical values are not a divergence")
	}
}

func TestNumericMergeSumsValues(t *testing.T) {
	a := FieldValue{HLC: hlc.HLC{WallMs: 100}, Value: 5.0}
	b := FieldValue{HLC: hlc.HLC{WallMs: 200}, Value: 3.0}
	winner, needsReview := Resolve(PolicyNumericMerge, a, b)
	if needsReview {
		t.Fatal("numeric-merge should not require review")
	}
	if winner.Value.(float64) != 8.0 {
		t.Fatalf("expected merged sum 8.0, got %v", winner.Value)
	}
}

func TestMaxPicksLarger(t *testing.T) {
	a := FieldValue{HLC: hlc.HLC{WallMs: 200}, Value: 5.0}
	b := FieldValue{HLC: hlc.HLC{WallMs: 100}, Value: 9.0}
	winner, _ := Resolve(PolicyMax, a, b)
	if winner.Value.(float64) != 9.0 {
		t.Fatalf("expected max 9.0, got %v", winner.Value)
	}
}

func TestDefaultPolicyPutsSensitiveFieldsOnConflictQueue(t *testing.T) {
	// Field names track the live entity columns (0001/0002): deliverable.status,
	// campaign.status/budget_minor, time_entry.minutes → conflict-queue; everything else → lww.
	if DefaultPolicyFor("deliverable").PolicyFor("status") != PolicyConflictQueue {
		t.Fatal("expected deliverable.status to default to conflict-queue")
	}
	campaign := DefaultPolicyFor("campaign")
	for _, field := range []string{"status", "budget_minor"} {
		if campaign.PolicyFor(field) != PolicyConflictQueue {
			t.Fatalf("expected campaign.%s to default to conflict-queue, got %q", field, campaign.PolicyFor(field))
		}
	}
	if DefaultPolicyFor("time_entry").PolicyFor("minutes") != PolicyConflictQueue {
		t.Fatal("expected time_entry.minutes to default to conflict-queue")
	}
	if DefaultPolicyFor("deliverable").PolicyFor("name") != PolicyLWW {
		t.Fatal("expected a non-sensitive field to be lww")
	}
}
