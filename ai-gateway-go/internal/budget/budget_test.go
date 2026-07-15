package budget

import (
	"testing"
	"time"
)

func TestTakeBudgetRefusesAtGlobalCap(t *testing.T) {
	b := NewBudget(2, 10)
	now := time.Now()
	ok1, _ := b.Take("", now)
	ok2, _ := b.Take("", now)
	ok3, scope3 := b.Take("", now)
	if !ok1 || !ok2 {
		t.Fatal("expected first two calls to succeed")
	}
	if ok3 || scope3 != "global" {
		t.Fatalf("expected third call to be refused at global scope, got ok=%v scope=%q", ok3, scope3)
	}
}

func TestTakeBudgetRefusesAtTenantCapBeforeGlobal(t *testing.T) {
	b := NewBudget(100, 1)
	now := time.Now()
	ok1, _ := b.Take("tenant-a", now)
	ok2, scope2 := b.Take("tenant-a", now)
	if !ok1 {
		t.Fatal("expected first call to succeed")
	}
	if ok2 || scope2 != "tenant" {
		t.Fatalf("expected second call for the same tenant to be refused at tenant scope, got ok=%v scope=%q", ok2, scope2)
	}
}

func TestDRBurstRaisesGlobalCapWhileActiveThenExpires(t *testing.T) {
	b := NewBudget(1, 100)
	now := time.Now()
	// Steady cap is 1; spend it.
	if ok, _ := b.Take("", now); !ok {
		t.Fatal("first steady call should succeed")
	}
	if ok, scope := b.Take("", now); ok || scope != "global" {
		t.Fatalf("steady cap should be exhausted, got ok=%v scope=%q", ok, scope)
	}
	// Declare failover: +5 burst for 1h. Now more calls are allowed, but still bounded.
	b.EnableDR(now, time.Hour, 5)
	if !b.DRModeActive(now) {
		t.Fatal("DR mode should be active")
	}
	got := 0
	for i := 0; i < 10; i++ {
		if ok, _ := b.Take("", now); ok {
			got++
		}
	}
	if got != 5 {
		t.Fatalf("DR burst should allow exactly the burst cap (5) more calls, got %d", got)
	}
	// After the window, DR is inactive again (time-boxed, no runaway).
	later := now.Add(2 * time.Hour)
	if b.DRModeActive(later) {
		t.Fatal("DR mode should have expired")
	}
}

func TestDisableDREndsBurstImmediately(t *testing.T) {
	b := NewBudget(0, 100)
	now := time.Now()
	b.EnableDR(now, time.Hour, 3)
	if ok, _ := b.Take("", now); !ok {
		t.Fatal("DR burst should allow a call above the zero steady cap")
	}
	b.DisableDR()
	if b.DRModeActive(now) {
		t.Fatal("DR mode should be off after DisableDR")
	}
	if ok, scope := b.Take("", now); ok || scope != "global" {
		t.Fatalf("with DR off and steady cap 0, calls must be refused, got ok=%v scope=%q", ok, scope)
	}
}

func TestBudgetRollsOverAtDayBoundary(t *testing.T) {
	b := NewBudget(1, 10)
	day1 := time.Date(2026, 7, 6, 23, 59, 0, 0, time.UTC)
	day2 := day1.Add(2 * time.Minute)
	ok1, _ := b.Take("", day1)
	ok2, _ := b.Take("", day2)
	if !ok1 || !ok2 {
		t.Fatal("expected both calls to succeed across the day boundary")
	}
}
