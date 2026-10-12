package store

import (
	"context"
	"sort"
	"time"
)

type memRecording struct {
	s      ReplaySession
	chunks map[int]StoredChunk
}

// deleteRecordings removes every recording the predicate selects; the caller holds m.mu.
func (m *Memory) deleteRecordings(pred func(*memRecording) bool) int64 {
	var n int64
	for id, r := range m.replay {
		if pred(r) {
			delete(m.replay, id)
			n++
		}
	}
	return n
}

// ReplaySessionsAll returns every recording's metadata, oldest first (tests).
func (m *Memory) ReplaySessionsAll() []ReplaySession {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]ReplaySession, 0, len(m.replay))
	for _, r := range m.replay {
		out = append(out, r.s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].StartedAt.Before(out[j].StartedAt) })
	return out
}

// ReplayChunkCount is the number of stored chunks over all recordings (tests).
func (m *Memory) ReplayChunkCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := 0
	for _, r := range m.replay {
		n += len(r.chunks)
	}
	return n
}

// AddReplayChunk implements ReplayStore. It mirrors the Postgres version rule for rule.
func (m *Memory) AddReplayChunk(_ context.Context, c ReplayChunk, lim ReplayLimits) (ReplayChunkResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.Down {
		return ReplayChunkResult{}, ErrDown
	}
	if m.tombstoned(c.Website, KindVisitor, c.VisitorID) || m.tombstoned(c.Website, KindConsent, c.ConsentID) {
		return ReplayChunkResult{Outcome: ChunkGone}, nil
	}
	size := int64(len(c.Data))
	used := func() int64 {
		var n int64
		for _, r := range m.replay {
			if r.s.Website == c.Website {
				n += r.s.Bytes
			}
		}
		return n
	}
	refuse := func(why string) (ReplayChunkResult, error) {
		return ReplayChunkResult{Outcome: ChunkRefused, Refusal: why}, nil
	}
	rec := m.replay[c.RecordingID]
	if rec == nil {
		since := c.ReceivedAt.Add(-ReplayDailyWindow)
		var site, visitor int
		for _, r := range m.replay {
			if r.s.Website == c.Website && !r.s.StartedAt.Before(since) {
				site++
				if r.s.VisitorID == c.VisitorID {
					visitor++
				}
			}
		}
		switch {
		case site >= lim.SiteDaily:
			return refuse(RefusedSiteDaily)
		case visitor >= lim.VisitorDaily:
			return refuse(RefusedVisitorDaily)
		case used()+size > lim.BudgetBytes:
			return refuse(RefusedBudget)
		case size > ReplaySessionMaxBytes:
			return refuse(RefusedSessionBytes)
		}
		rec = &memRecording{s: ReplaySession{ID: c.RecordingID, Website: c.Website, VisitorID: c.VisitorID, ConsentID: c.ConsentID,
			StartedAt: c.ReceivedAt, LastChunkAt: c.ReceivedAt}, chunks: map[int]StoredChunk{}}
	} else {
		if rec.s.Website != c.Website || rec.s.VisitorID != c.VisitorID || rec.s.ConsentID != c.ConsentID {
			return ReplayChunkResult{Outcome: ChunkMismatch}, nil
		}
		if _, dup := rec.chunks[c.Seq]; dup {
			return ReplayChunkResult{Outcome: ChunkDuplicate}, nil
		}
		switch {
		case c.ReceivedAt.Sub(rec.s.StartedAt) > ReplaySessionMaxDuration:
			return refuse(RefusedSessionDuration)
		case rec.s.Bytes+size > ReplaySessionMaxBytes:
			return refuse(RefusedSessionBytes)
		case rec.s.Chunks >= ReplaySessionMaxChunks:
			return refuse(RefusedSessionChunks)
		case used()+size > lim.BudgetBytes:
			return refuse(RefusedBudget)
		}
	}
	rec.chunks[c.Seq] = StoredChunk{Seq: c.Seq, ReceivedAt: c.ReceivedAt, Bytes: len(c.Data), Data: append([]byte(nil), c.Data...)}
	rec.s.Chunks++
	rec.s.Bytes += size
	if c.ReceivedAt.After(rec.s.LastChunkAt) {
		rec.s.LastChunkAt = c.ReceivedAt
	}
	seen := map[string]bool{}
	for _, p := range rec.s.Pages {
		seen[p] = true
	}
	for _, p := range c.Pages {
		if !seen[p] && len(rec.s.Pages) < 50 {
			seen[p] = true
			rec.s.Pages = append(rec.s.Pages, p)
		}
	}
	m.replay[c.RecordingID] = rec
	return ReplayChunkResult{Outcome: ChunkStored}, nil
}

// ReplaySessions implements ReplayStore.
func (m *Memory) ReplaySessions(_ context.Context, website, visitorID string, limit int) ([]ReplaySession, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.Down {
		return nil, ErrDown
	}
	var out []ReplaySession
	for _, r := range m.replay {
		if r.s.Website == website && r.s.VisitorID == visitorID {
			out = append(out, r.s)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].StartedAt.Equal(out[j].StartedAt) {
			return out[i].StartedAt.After(out[j].StartedAt)
		}
		return out[i].ID < out[j].ID
	})
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// ReplayChunksAfter implements ReplayStore.
func (m *Memory) ReplayChunksAfter(_ context.Context, website, recordingID string, after, limit int) (ReplaySession, []StoredChunk, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.Down {
		return ReplaySession{}, nil, false, ErrDown
	}
	rec := m.replay[recordingID]
	if rec == nil || rec.s.Website != website {
		return ReplaySession{}, nil, false, nil
	}
	var out []StoredChunk
	for _, c := range rec.chunks {
		if c.Seq > after {
			out = append(out, c)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Seq < out[j].Seq })
	if len(out) > limit {
		out = out[:limit]
	}
	return rec.s, out, true, nil
}

// PurgeReplay implements ReplayStore.
func (m *Memory) PurgeReplay(_ context.Context, startedBefore time.Time) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.Down {
		return 0, ErrDown
	}
	return m.deleteRecordings(func(r *memRecording) bool { return r.s.StartedAt.Before(startedBefore) }), nil
}
