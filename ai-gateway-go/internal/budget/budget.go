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
}

func NewBudget(dailyCap, perTenantCap int) *Budget {
	return &Budget{dailyCap: dailyCap, perTenantCap: perTenantCap, tenantCounts: map[string]int{}}
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
	if b.globalCount >= b.dailyCap {
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
	b.mu.Lock()
	defer b.mu.Unlock()
	sameDay := today(now) == b.day
	used, tenants := 0, 0
	if sameDay {
		used, tenants = b.globalCount, len(b.tenantCounts)
	}
	return map[string]any{"used": used, "cap": b.dailyCap, "tenants": tenants, "perTenantCap": b.perTenantCap}
}
