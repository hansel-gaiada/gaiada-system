// Cost governance — port of ai-gateway/src/budget.ts. In-memory; a restart resets the
// day's counts (same accepted tradeoff as the TS version at this cap size).
package budget

import (
	"sync"
	"time"
)

type Budget struct {
	mu           sync.Mutex
	dailyCap     int
	perTenantCap int
	day          string
	globalCount  int
	tenantCounts map[string]int

	// WS9 D15 DR-burst budget: a bounded, time-boxed extra global allowance unlocked ONLY on a
	// declared failover, so a real multi-day outage doesn't instantly degrade AI to placeholders —
	// yet it can't run away (drBurstCap is finite and drUntil expires). Separate from the steady cap.
	drBurstCap int
	drUntil    time.Time
}

func NewBudget(dailyCap, perTenantCap int) *Budget {
	return &Budget{dailyCap: dailyCap, perTenantCap: perTenantCap, tenantCounts: map[string]int{}}
}

// EnableDR unlocks the DR-burst allowance for dur, adding burstCap to the effective daily global cap.
// Idempotent: re-declaring extends the window. now is injected (same clock the rest of Budget uses).
func (b *Budget) EnableDR(now time.Time, dur time.Duration, burstCap int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.drBurstCap = burstCap
	b.drUntil = now.Add(dur)
}

// DisableDR ends DR mode immediately (failover resolved).
func (b *Budget) DisableDR() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.drUntil = time.Time{}
	b.drBurstCap = 0
}

// DRModeActive reports whether the DR-burst window is currently open.
func (b *Budget) DRModeActive(now time.Time) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.drActive(now)
}

func (b *Budget) drActive(now time.Time) bool {
	return !b.drUntil.IsZero() && now.Before(b.drUntil)
}

// effectiveCap is the global cap in force right now — the steady cap, plus the DR burst while a
// declared failover window is open.
func (b *Budget) effectiveCap(now time.Time) int {
	if b.drActive(now) {
		return b.dailyCap + b.drBurstCap
	}
	return b.dailyCap
}

// today mirrors the TS `new Date(now).toISOString().slice(0, 10)`: the UTC calendar date,
// not the local one, so the day boundary is identical across the two implementations.
func today(t time.Time) string { return t.UTC().Format("2006-01-02") }

func (b *Budget) rollDay(now time.Time) {
	d := today(now)
	if d != b.day {
		b.day = d
		b.globalCount = 0
		b.tenantCounts = map[string]int{}
	}
}

// Take attempts to spend one call. Returns (false, "global") or (false, "tenant") on refusal.
func (b *Budget) Take(tenant string, now time.Time) (bool, string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.rollDay(now)
	if b.globalCount >= b.effectiveCap(now) {
		return false, "global"
	}
	if tenant != "" {
		used := b.tenantCounts[tenant]
		if used >= b.perTenantCap {
			return false, "tenant"
		}
		b.tenantCounts[tenant] = used + 1
	}
	b.globalCount++
	return true, ""
}

func (b *Budget) State(now time.Time) map[string]any {
	used, cap, tenants, perTenantCap := b.Snapshot(now)
	return map[string]any{"used": used, "cap": cap, "tenants": tenants, "perTenantCap": perTenantCap}
}

// Snapshot is the typed view of State — WS9 metrics read this to mirror the budget as gauges
// without re-marshaling the map. Returns zeros for used/tenants once the day has rolled.
func (b *Budget) Snapshot(now time.Time) (used, cap, tenants, perTenantCap int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	perTenantCap = b.perTenantCap
	cap = b.dailyCap
	if today(now) == b.day {
		used, tenants = b.globalCount, len(b.tenantCounts)
	}
	return used, cap, tenants, perTenantCap
}
