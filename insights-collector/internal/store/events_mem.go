package store

import (
	"context"
	"encoding/hex"
	"sort"
	"time"
)

type tombKey struct{ website, kind, hash string }

// Tombstone is a stored forgotten-id marker as the Memory store keeps it (tests read it).
type Tombstone struct {
	Website, Kind, HashHex, Reason string
	CreatedAt                      time.Time
}

// Events returns a copy of every buffered row (tests).
func (m *Memory) Events() []ConsentedEvent {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]ConsentedEvent(nil), m.events...)
}

// Tombstones returns a copy of every tombstone (tests).
func (m *Memory) Tombstones() []Tombstone {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Tombstone, 0, len(m.tombs))
	for k, t := range m.tombs {
		out = append(out, Tombstone{Website: k.website, Kind: k.kind, HashHex: k.hash, Reason: t.reason, CreatedAt: t.created})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].HashHex < out[j].HashHex })
	return out
}

func (m *Memory) tombstoned(website, kind, id string) bool {
	_, ok := m.tombs[tombKey{website, kind, hex.EncodeToString(IDHash(id))}]
	return ok
}

func (m *Memory) tombstone(website, kind, id, reason string) {
	k := tombKey{website, kind, hex.EncodeToString(IDHash(id))}
	if t, ok := m.tombs[k]; ok {
		if reason == ReasonErase {
			t.reason = ReasonErase
			m.tombs[k] = t
		}
		return
	}
	m.tombs[k] = tomb{reason: reason, created: m.now()}
}

func (m *Memory) now() time.Time {
	if m.Now != nil {
		return m.Now()
	}
	return time.Now()
}

// InsertEvents implements EventStore.
func (m *Memory) InsertEvents(_ context.Context, website, visitorID, consentID string, evs []ConsentedEvent) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.Down {
		return false, ErrDown
	}
	if len(evs) == 0 {
		return false, nil
	}
	if m.tombstoned(website, KindVisitor, visitorID) || m.tombstoned(website, KindConsent, consentID) {
		return true, nil
	}
	for _, e := range evs {
		m.nextID++
		e.ID = m.nextID
		e.Website, e.VisitorID, e.ConsentID = website, visitorID, consentID
		m.events = append(m.events, e)
	}
	return false, nil
}

// EventsAfter implements EventStore.
func (m *Memory) EventsAfter(_ context.Context, website string, after int64, limit int, cutoff time.Time) ([]ConsentedEvent, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.Down {
		return nil, ErrDown
	}
	minYoung := int64(1<<63 - 1)
	for _, e := range m.events {
		if !e.ReceivedAt.Before(cutoff) && e.ID < minYoung {
			minYoung = e.ID
		}
	}
	var out []ConsentedEvent
	for _, e := range m.events { // ids ascend with insertion order
		if e.Website == website && e.ID > after && e.ID < minYoung {
			out = append(out, e)
			if len(out) >= limit {
				break
			}
		}
	}
	return out, nil
}

// Forget implements EventStore.
func (m *Memory) Forget(_ context.Context, req ForgetRequest) (ForgetResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.Down {
		return ForgetResult{}, ErrDown
	}
	vis, con := map[string]bool{}, map[string]bool{}
	for _, id := range req.VisitorIDs {
		vis[id] = true
		m.tombstone(req.Website, KindVisitor, id, req.Reason)
	}
	for _, id := range req.ConsentIDs {
		con[id] = true
		m.tombstone(req.Website, KindConsent, id, req.Reason)
	}
	var kept []ConsentedEvent
	var deleted int64
	for _, e := range m.events {
		if e.Website == req.Website && (vis[e.VisitorID] || con[e.ConsentID]) {
			deleted++
			continue
		}
		kept = append(kept, e)
	}
	m.events = kept
	return ForgetResult{DeletedEvents: deleted, TombstonedVisitors: len(req.VisitorIDs), TombstonedConsents: len(req.ConsentIDs)}, nil
}

// ForgetPair implements EventStore.
func (m *Memory) ForgetPair(_ context.Context, website, visitorID, consentID string) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.Down {
		return 0, ErrDown
	}
	m.tombstone(website, KindVisitor, visitorID, ReasonWithdraw)
	var kept []ConsentedEvent
	var deleted int64
	for _, e := range m.events {
		if e.Website == website && e.VisitorID == visitorID && e.ConsentID == consentID {
			deleted++
			continue
		}
		kept = append(kept, e)
	}
	m.events = kept
	return deleted, nil
}

// Purge implements EventStore.
func (m *Memory) Purge(_ context.Context, eventsBefore, tombstonesBefore time.Time) (int64, int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.Down {
		return 0, 0, ErrDown
	}
	var kept []ConsentedEvent
	var ev, tb int64
	for _, e := range m.events {
		if e.ReceivedAt.Before(eventsBefore) {
			ev++
			continue
		}
		kept = append(kept, e)
	}
	m.events = kept
	for k, t := range m.tombs {
		if t.created.Before(tombstonesBefore) {
			delete(m.tombs, k)
			tb++
		}
	}
	return ev, tb, nil
}
