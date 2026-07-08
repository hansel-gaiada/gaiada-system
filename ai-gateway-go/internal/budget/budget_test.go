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
