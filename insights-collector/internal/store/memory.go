package store

import (
	"context"
	"errors"
	"sort"
	"strings"
	"sync"
	"time"
)

// Memory is an in-process Store for tests and for running the collector without a database in unit tests.
// It records exactly what a real Store would be given, so tests can assert that nothing personal reaches it.
type Memory struct {
	mu     sync.Mutex
	counts map[string]int64 // website|day|reason
	// Down makes every call fail, to simulate vdb being unavailable.
	Down bool
	// Calls is every row ever passed to AddBotCounts, in order.
	Calls []BotCount
	// Now is the clock for tombstone creation times; time.Now when nil.
	Now func() time.Time

	events []ConsentedEvent
	nextID int64
	tombs  map[tombKey]tomb
}

type tomb struct {
	reason  string
	created time.Time
}

// NewMemory returns an empty Memory store.
func NewMemory() *Memory { return &Memory{counts: map[string]int64{}, tombs: map[tombKey]tomb{}} }

// ErrDown is returned while Memory.Down is set.
var ErrDown = errors.New("store down")

// AddBotCounts implements Store.
func (m *Memory) AddBotCounts(_ context.Context, rows []BotCount) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.Down {
		return ErrDown
	}
	for _, r := range rows {
		m.counts[r.Website+"|"+r.Day.UTC().Format("2006-01-02")+"|"+r.Reason] += r.Count
		m.Calls = append(m.Calls, r)
	}
	return nil
}

// BotCounts implements Store.
func (m *Memory) BotCounts(_ context.Context, website string, from, to time.Time) ([]BotCount, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.Down {
		return nil, ErrDown
	}
	var out []BotCount
	for k, n := range m.counts {
		var w, d, r string
		parts := strings.SplitN(k, "|", 3)
		w, d, r = parts[0], parts[1], parts[2]
		day, _ := time.Parse("2006-01-02", d)
		if w == website && !day.Before(from.UTC().Truncate(24*time.Hour)) && !day.After(to.UTC().Truncate(24*time.Hour)) {
			out = append(out, BotCount{Website: w, Day: day, Reason: r, Count: n})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].Day.Equal(out[j].Day) {
			return out[i].Day.Before(out[j].Day)
		}
		return out[i].Reason < out[j].Reason
	})
	return out, nil
}

// Ping implements Store.
func (m *Memory) Ping(context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.Down {
		return ErrDown
	}
	return nil
}

// Close implements Store.
func (m *Memory) Close() {}
