// Cost governance — port of ai-gateway/src/budget.ts. The counters live in memory; since AIP-17a a
// Persister (persist.go) writes them to a state file and reloads them at boot, so a restart no
// longer hands out a fresh daily allowance.
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

// SetCaps retunes the steady caps at runtime (admin config write). A non-positive value leaves that
// cap untouched so a caller can change one without restating the other. Today's COUNTERS are
// deliberately preserved: lowering the cap below current spend must degrade immediately rather than
// hand out a fresh allowance, and raising it must not retroactively forgive spend.
func (b *Budget) SetCaps(dailyCap, perTenantCap int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if dailyCap > 0 {
		b.dailyCap = dailyCap
	}
	if perTenantCap > 0 {
		b.perTenantCap = perTenantCap
	}
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

// TakeAgent (AIP-00a-1) spends one call for a registered agent, atomically under the same lock as
// Take, against three limits, checked in this order:
//
//  1. "global": the effective global cap is spent (the same rule Take applies).
//  2. "reserve": the remaining share of the effective global cap is at or below reservePct
//     percent. That last share is kept for the ERP's own traffic, which goes through Take and is
//     never refused by this rule. reservePct is clamped to 0..100; 0 leaves only rule 1.
//  3. "tenant": the scope's own count has reached scopeCap (<= 0 means the per-tenant cap, so the
//     console's per-tenant setting also bounds agents unless a separate agent cap is set).
//
// scope is the caller's budget key ("agent:<name>"); it shares the per-tenant counter map, so an
// agent's spend shows in Breakdown().Tenants next to the tenants'.
func (b *Budget) TakeAgent(scope string, scopeCap, reservePct int, now time.Time) (bool, string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.rollDay(now)
	eff := b.effectiveCap(now)
	if b.globalCount >= eff {
		return false, "global"
	}
	if reservePct < 0 {
		reservePct = 0
	}
	if reservePct > 100 {
		reservePct = 100
	}
	remaining := eff - b.globalCount
	if remaining*100 <= reservePct*eff {
		return false, "reserve"
	}
	if scopeCap <= 0 {
		scopeCap = b.perTenantCap
	}
	used := b.tenantCounts[scope]
	if used >= scopeCap {
		return false, "tenant"
	}
	b.tenantCounts[scope] = used + 1
	b.globalCount++
	return true, ""
}

// AgentUsage (AIP-00a-4) reports an agent scope's calls today and the daily cap TakeAgent enforces
// for it (scopeCap, or the per-tenant cap when scopeCap <= 0). Once the UTC day has rolled the
// stored counters are stale and read as zero, without waiting for the next call to reset them.
func (b *Budget) AgentUsage(scope string, scopeCap int, now time.Time) (used, cap int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	cap = scopeCap
	if cap <= 0 {
		cap = b.perTenantCap
	}
	if today(now) == b.day {
		used = b.tenantCounts[scope]
	}
	return used, cap
}

func (b *Budget) State(now time.Time) map[string]any {
	used, cap, tenants, perTenantCap := b.Snapshot(now)
	return map[string]any{"used": used, "cap": cap, "tenants": tenants, "perTenantCap": perTenantCap}
}

// Breakdown is the admin-console view of the budget: the same numbers State() reports plus the
// per-tenant spend map and the DR-burst window, so the console can show WHO is burning the cap
// and whether a failover burst is currently unlocked. Read-only; never mutates counters.
type Breakdown struct {
	Day          string         `json:"day"`
	Used         int            `json:"used"`
	Cap          int            `json:"cap"`
	EffectiveCap int            `json:"effectiveCap"`
	PerTenantCap int            `json:"perTenantCap"`
	Tenants      map[string]int `json:"tenants"`
	DRActive     bool           `json:"drActive"`
	DRBurstCap   int            `json:"drBurstCap"`
	DRUntil      string         `json:"drUntil,omitempty"`
}

func (b *Budget) Breakdown(now time.Time) Breakdown {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := Breakdown{
		Day:          today(now),
		Cap:          b.dailyCap,
		EffectiveCap: b.effectiveCap(now),
		PerTenantCap: b.perTenantCap,
		Tenants:      map[string]int{},
		DRActive:     b.drActive(now),
		DRBurstCap:   b.drBurstCap,
	}
	// Counters belong to b.day; once the day has rolled they are stale and read as zero (same
	// rule Snapshot uses) rather than being attributed to today.
	if today(now) == b.day {
		out.Used = b.globalCount
		for t, n := range b.tenantCounts {
			out.Tenants[t] = n
		}
	}
	if !b.drUntil.IsZero() {
		out.DRUntil = b.drUntil.UTC().Format(time.RFC3339)
	}
	return out
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
