package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// sessionState is what AddReplayChunk reads of an existing recording while holding its row lock.
type sessionState struct {
	website, visitor, consent string
	startedAt                 time.Time
	bytes                     int64
	chunks                    int
}

// AddReplayChunk implements ReplayStore. Lock order: the shared insert/forget advisory lock first (so a forget, which
// takes it exclusive, waits for this transaction and then deletes what it wrote), then the recording's row.
func (p *Postgres) AddReplayChunk(ctx context.Context, c ReplayChunk, lim ReplayLimits) (ReplayChunkResult, error) {
	if err := p.ensure(ctx); err != nil {
		return ReplayChunkResult{}, err
	}
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return ReplayChunkResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock_shared($1)`, int64(forgetLockKey)); err != nil {
		return ReplayChunkResult{}, err
	}
	var gone bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1 FROM tombstones WHERE website = $1::text::uuid
		  AND ((kind = 'visitor' AND id_hash = $2) OR (kind = 'consent' AND id_hash = $3)))`,
		c.Website, IDHash(c.VisitorID), IDHash(c.ConsentID)).Scan(&gone); err != nil {
		return ReplayChunkResult{}, err
	}
	if gone {
		return ReplayChunkResult{Outcome: ChunkGone}, nil
	}

	size := int64(len(c.Data))
	budgetRefused := func() (bool, error) {
		var used int64
		if err := tx.QueryRow(ctx, `SELECT COALESCE(sum(bytes), 0)::bigint FROM replay_sessions WHERE website = $1::text::uuid`, c.Website).Scan(&used); err != nil {
			return false, err
		}
		return used+size > lim.BudgetBytes, nil
	}

	// Find the recording and lock it; if it is new, create it (after the daily caps and the budget). Two chunks racing to
	// create the same id: the loser's insert does nothing and it goes round once more to find the winner's row.
	var st sessionState
	for attempt := 0; ; attempt++ {
		err := tx.QueryRow(ctx, `SELECT website::text, visitor_id::text, consent_id::text, started_at, bytes, chunks
			FROM replay_sessions WHERE id = $1::text::uuid FOR UPDATE`, c.RecordingID).
			Scan(&st.website, &st.visitor, &st.consent, &st.startedAt, &st.bytes, &st.chunks)
		if err == nil {
			break
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return ReplayChunkResult{}, err
		}
		if attempt > 0 {
			return ReplayChunkResult{}, errors.New("replay: recording row vanished")
		}
		since := c.ReceivedAt.UTC().Add(-ReplayDailyWindow)
		var site, visitor int
		if err := tx.QueryRow(ctx, `SELECT count(*), count(*) FILTER (WHERE visitor_id = $3::text::uuid)
			FROM replay_sessions WHERE website = $1::text::uuid AND started_at >= $2`, c.Website, since, c.VisitorID).Scan(&site, &visitor); err != nil {
			return ReplayChunkResult{}, err
		}
		switch {
		case site >= lim.SiteDaily:
			return ReplayChunkResult{Outcome: ChunkRefused, Refusal: RefusedSiteDaily}, nil
		case visitor >= lim.VisitorDaily:
			return ReplayChunkResult{Outcome: ChunkRefused, Refusal: RefusedVisitorDaily}, nil
		}
		if over, err := budgetRefused(); err != nil {
			return ReplayChunkResult{}, err
		} else if over {
			return ReplayChunkResult{Outcome: ChunkRefused, Refusal: RefusedBudget}, nil
		}
		if _, err := tx.Exec(ctx, `INSERT INTO replay_sessions (id, website, visitor_id, consent_id, started_at, last_chunk_at)
			VALUES ($1::text::uuid, $2::text::uuid, $3::text::uuid, $4::text::uuid, $5, $5) ON CONFLICT (id) DO NOTHING`,
			c.RecordingID, c.Website, c.VisitorID, c.ConsentID, c.ReceivedAt.UTC()); err != nil {
			return ReplayChunkResult{}, err
		}
	}

	if st.website != c.Website || st.visitor != c.VisitorID || st.consent != c.ConsentID {
		return ReplayChunkResult{Outcome: ChunkMismatch}, nil
	}
	if st.chunks > 0 || st.bytes > 0 { // not the row this call just created: a retry may be a duplicate, and caps apply
		var dup bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM replay_chunks WHERE session_id = $1::text::uuid AND seq = $2)`, c.RecordingID, c.Seq).Scan(&dup); err != nil {
			return ReplayChunkResult{}, err
		}
		if dup {
			return ReplayChunkResult{Outcome: ChunkDuplicate}, nil
		}
		switch {
		case c.ReceivedAt.Sub(st.startedAt) > ReplaySessionMaxDuration:
			return ReplayChunkResult{Outcome: ChunkRefused, Refusal: RefusedSessionDuration}, nil
		case st.bytes+size > ReplaySessionMaxBytes:
			return ReplayChunkResult{Outcome: ChunkRefused, Refusal: RefusedSessionBytes}, nil
		case st.chunks >= ReplaySessionMaxChunks:
			return ReplayChunkResult{Outcome: ChunkRefused, Refusal: RefusedSessionChunks}, nil
		}
		if over, err := budgetRefused(); err != nil {
			return ReplayChunkResult{}, err
		} else if over {
			return ReplayChunkResult{Outcome: ChunkRefused, Refusal: RefusedBudget}, nil
		}
	} else if size > ReplaySessionMaxBytes {
		return ReplayChunkResult{Outcome: ChunkRefused, Refusal: RefusedSessionBytes}, nil
	}

	tag, err := tx.Exec(ctx, `INSERT INTO replay_chunks (session_id, seq, received_at, bytes, data)
		VALUES ($1::text::uuid, $2, $3, $4, $5) ON CONFLICT (session_id, seq) DO NOTHING`,
		c.RecordingID, c.Seq, c.ReceivedAt.UTC(), len(c.Data), c.Data)
	if err != nil {
		return ReplayChunkResult{}, err
	}
	if tag.RowsAffected() == 0 {
		return ReplayChunkResult{Outcome: ChunkDuplicate}, nil
	}
	pages := c.Pages
	if pages == nil {
		pages = []string{}
	}
	if _, err := tx.Exec(ctx, `UPDATE replay_sessions SET
		  last_chunk_at = GREATEST(last_chunk_at, $2), chunks = chunks + 1, bytes = bytes + $3,
		  pages = COALESCE((SELECT array_agg(p ORDER BY o) FROM (
		      SELECT p, min(o) AS o FROM unnest(pages || $4::text[]) WITH ORDINALITY AS t(p, o) GROUP BY p ORDER BY min(o) LIMIT 50) s), '{}')
		WHERE id = $1::text::uuid`, c.RecordingID, c.ReceivedAt.UTC(), size, pages); err != nil {
		return ReplayChunkResult{}, err
	}
	return ReplayChunkResult{Outcome: ChunkStored}, tx.Commit(ctx)
}

// ReplaySessions implements ReplayStore.
func (p *Postgres) ReplaySessions(ctx context.Context, website, visitorID string, limit int) ([]ReplaySession, error) {
	if err := p.ensure(ctx); err != nil {
		return nil, err
	}
	rows, err := p.pool.Query(ctx, `SELECT id::text, website::text, visitor_id::text, consent_id::text, started_at, last_chunk_at, chunks, bytes, pages
		FROM replay_sessions WHERE website = $1::text::uuid AND visitor_id = $2::text::uuid
		ORDER BY started_at DESC, id LIMIT $3`, website, visitorID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ReplaySession
	for rows.Next() {
		var s ReplaySession
		if err := rows.Scan(&s.ID, &s.Website, &s.VisitorID, &s.ConsentID, &s.StartedAt, &s.LastChunkAt, &s.Chunks, &s.Bytes, &s.Pages); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// ReplayChunksAfter implements ReplayStore.
func (p *Postgres) ReplayChunksAfter(ctx context.Context, website, recordingID string, after, limit int) (ReplaySession, []StoredChunk, bool, error) {
	var s ReplaySession
	if err := p.ensure(ctx); err != nil {
		return s, nil, false, err
	}
	err := p.pool.QueryRow(ctx, `SELECT id::text, website::text, visitor_id::text, consent_id::text, started_at, last_chunk_at, chunks, bytes, pages
		FROM replay_sessions WHERE id = $1::text::uuid AND website = $2::text::uuid`, recordingID, website).
		Scan(&s.ID, &s.Website, &s.VisitorID, &s.ConsentID, &s.StartedAt, &s.LastChunkAt, &s.Chunks, &s.Bytes, &s.Pages)
	if errors.Is(err, pgx.ErrNoRows) {
		return s, nil, false, nil
	}
	if err != nil {
		return s, nil, false, err
	}
	rows, err := p.pool.Query(ctx, `SELECT seq, received_at, bytes, data FROM replay_chunks
		WHERE session_id = $1::text::uuid AND seq > $2 ORDER BY seq LIMIT $3`, recordingID, after, limit)
	if err != nil {
		return s, nil, false, err
	}
	defer rows.Close()
	var out []StoredChunk
	for rows.Next() {
		var c StoredChunk
		if err := rows.Scan(&c.Seq, &c.ReceivedAt, &c.Bytes, &c.Data); err != nil {
			return s, nil, false, err
		}
		out = append(out, c)
	}
	return s, out, true, rows.Err()
}

// PurgeReplay implements ReplayStore. Deleting the recording cascades to its chunks.
func (p *Postgres) PurgeReplay(ctx context.Context, startedBefore time.Time) (int64, error) {
	if err := p.ensure(ctx); err != nil {
		return 0, err
	}
	tag, err := p.pool.Exec(ctx, `DELETE FROM replay_sessions WHERE started_at < $1`, startedBefore.UTC())
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
