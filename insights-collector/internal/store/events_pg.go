package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// Advisory lock key for the forget/insert race ('INS\x02'). Inserts take it SHARED (they never block each
// other); a forget takes it EXCLUSIVE, so it waits for in-flight inserts to commit and its DELETE then sees
// them, and any insert that starts after it sees the tombstone. Without it a batch could be stored a moment
// after a forget deleted that visitor's rows.
const forgetLockKey = 1229933314

// InsertEvents implements EventStore.
func (p *Postgres) InsertEvents(ctx context.Context, website, visitorID, consentID string, evs []ConsentedEvent) (bool, error) {
	if len(evs) == 0 {
		return false, nil
	}
	if err := p.ensure(ctx); err != nil {
		return false, err
	}
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock_shared($1)`, int64(forgetLockKey)); err != nil {
		return false, err
	}
	var gone bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1 FROM tombstones WHERE website = $1::text::uuid
		  AND ((kind = 'visitor' AND id_hash = $2) OR (kind = 'consent' AND id_hash = $3)))`,
		website, IDHash(visitorID), IDHash(consentID)).Scan(&gone); err != nil {
		return false, err
	}
	if gone {
		return true, nil
	}
	batch := &pgx.Batch{}
	for _, e := range evs {
		batch.Queue(`INSERT INTO consented_events
			(website, visitor_id, consent_id, received_at, occurred_at, kind, path, name, data, device, country, city, asn, network_name, company)
			VALUES ($1::text::uuid, $2::text::uuid, $3::text::uuid, $4, $5, $6, $7, NULLIF($8::text, ''), NULLIF($9::text, '')::jsonb,
			        $10, NULLIF($11::text, ''), NULLIF($12::text, ''), NULLIF($13::bigint, 0), NULLIF($14::text, ''), NULLIF($15::text, '')::jsonb)`,
			website, visitorID, consentID, e.ReceivedAt.UTC(), e.OccurredAt.UTC(), e.Kind, e.Path, e.Name, e.Data,
			e.Device, e.Country, e.City, int64(e.ASN), e.NetworkName, e.Company)
	}
	br := tx.SendBatch(ctx, batch)
	for range evs {
		if _, err := br.Exec(); err != nil {
			_ = br.Close()
			return false, err
		}
	}
	if err := br.Close(); err != nil {
		return false, err
	}
	return false, tx.Commit(ctx)
}

// EventsAfter implements EventStore.
func (p *Postgres) EventsAfter(ctx context.Context, website string, after int64, limit int, cutoff time.Time) ([]ConsentedEvent, error) {
	if err := p.ensure(ctx); err != nil {
		return nil, err
	}
	// The read takes the insert/forget lock EXCLUSIVE for the length of one page. Every insert holds it SHARED from before it
	// takes its ids until it commits, so under this lock every id below the newest visible one is committed: a batch that took
	// a lower id but committed later (it queued behind a forget, say) can never be passed by the cursor and skipped. The 15 s
	// lag below still applies; this makes "never skipped" hold whatever the timing. Ingest waits for one page query.
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, int64(forgetLockKey)); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `SELECT id, visitor_id::text, consent_id::text, received_at, occurred_at, kind, path,
			COALESCE(name, ''), COALESCE(data::text, ''), device, COALESCE(country, ''), COALESCE(city, ''),
			COALESCE(asn, 0), COALESCE(network_name, ''), COALESCE(company::text, '')
		FROM consented_events
		WHERE website = $1::text::uuid AND id > $2
		  AND id < COALESCE((SELECT min(id) FROM consented_events WHERE received_at >= $3), 9223372036854775807)
		ORDER BY id LIMIT $4`, website, after, cutoff.UTC(), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ConsentedEvent
	for rows.Next() {
		var e ConsentedEvent
		var asn int64
		if err := rows.Scan(&e.ID, &e.VisitorID, &e.ConsentID, &e.ReceivedAt, &e.OccurredAt, &e.Kind, &e.Path,
			&e.Name, &e.Data, &e.Device, &e.Country, &e.City, &asn, &e.NetworkName, &e.Company); err != nil {
			return nil, err
		}
		e.Website, e.ASN = website, uint32(asn)
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	return out, tx.Commit(ctx)
}

const tombstoneUpsert = `INSERT INTO tombstones (website, kind, id_hash, reason)
	SELECT $1::text::uuid, $2::text, h, $3::text FROM unnest($4::bytea[]) AS h
	ON CONFLICT (website, kind, id_hash) DO UPDATE
	  SET reason = CASE WHEN EXCLUDED.reason = 'erase' THEN 'erase' ELSE tombstones.reason END`

func hashes(ids []string) [][]byte {
	out := make([][]byte, 0, len(ids))
	for _, id := range ids {
		out = append(out, IDHash(id))
	}
	return out
}

// Forget implements EventStore.
func (p *Postgres) Forget(ctx context.Context, req ForgetRequest) (ForgetResult, error) {
	var res ForgetResult
	if err := p.ensure(ctx); err != nil {
		return res, err
	}
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return res, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, int64(forgetLockKey)); err != nil {
		return res, err
	}
	if len(req.VisitorIDs) > 0 {
		if _, err := tx.Exec(ctx, tombstoneUpsert, req.Website, KindVisitor, req.Reason, hashes(req.VisitorIDs)); err != nil {
			return res, err
		}
	}
	if len(req.ConsentIDs) > 0 {
		if _, err := tx.Exec(ctx, tombstoneUpsert, req.Website, KindConsent, req.Reason, hashes(req.ConsentIDs)); err != nil {
			return res, err
		}
	}
	tag, err := tx.Exec(ctx, `DELETE FROM consented_events WHERE website = $1::text::uuid
		AND (visitor_id = ANY($2::text[]::uuid[]) OR consent_id = ANY($3::text[]::uuid[]))`,
		req.Website, nonNil(req.VisitorIDs), nonNil(req.ConsentIDs))
	if err != nil {
		return res, err
	}
	rec, err := tx.Exec(ctx, `DELETE FROM replay_sessions WHERE website = $1::text::uuid
		AND (visitor_id = ANY($2::text[]::uuid[]) OR consent_id = ANY($3::text[]::uuid[]))`,
		req.Website, nonNil(req.VisitorIDs), nonNil(req.ConsentIDs))
	if err != nil {
		return res, err
	}
	if err := tx.Commit(ctx); err != nil {
		return res, err
	}
	return ForgetResult{DeletedEvents: tag.RowsAffected(), DeletedRecordings: rec.RowsAffected(), TombstonedVisitors: len(req.VisitorIDs), TombstonedConsents: len(req.ConsentIDs)}, nil
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// ForgetPair implements EventStore.
func (p *Postgres) ForgetPair(ctx context.Context, website, visitorID, consentID string) (int64, error) {
	if err := p.ensure(ctx); err != nil {
		return 0, err
	}
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, int64(forgetLockKey)); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, tombstoneUpsert, website, KindVisitor, ReasonWithdraw, hashes([]string{visitorID})); err != nil {
		return 0, err
	}
	tag, err := tx.Exec(ctx, `DELETE FROM consented_events WHERE website = $1::text::uuid
		AND visitor_id = $2::text::uuid AND consent_id = $3::text::uuid`, website, visitorID, consentID)
	if err != nil {
		return 0, err
	}
	// The pair's recordings go too (their chunks cascade). The returned count stays the buffer rows, as before.
	if _, err := tx.Exec(ctx, `DELETE FROM replay_sessions WHERE website = $1::text::uuid
		AND visitor_id = $2::text::uuid AND consent_id = $3::text::uuid`, website, visitorID, consentID); err != nil {
		return 0, err
	}
	return tag.RowsAffected(), tx.Commit(ctx)
}

// Purge implements EventStore.
func (p *Postgres) Purge(ctx context.Context, eventsBefore, tombstonesBefore time.Time) (int64, int64, error) {
	if err := p.ensure(ctx); err != nil {
		return 0, 0, err
	}
	ev, err := p.pool.Exec(ctx, `DELETE FROM consented_events WHERE received_at < $1`, eventsBefore.UTC())
	if err != nil {
		return 0, 0, err
	}
	tb, err := p.pool.Exec(ctx, `DELETE FROM tombstones WHERE created_at < $1`, tombstonesBefore.UTC())
	if err != nil {
		return ev.RowsAffected(), 0, err
	}
	return ev.RowsAffected(), tb.RowsAffected(), nil
}
