// Package store is the collector's only database access: vdb, holding aggregate bot counts (and, from V3-b,
// the buffer and tombstones). No row holds an IP address or a user agent.
package store

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"gaiada/insights-collector/migrations"
)

// BotCount is one aggregate row.
type BotCount struct {
	Website string    // UUID
	Day     time.Time // UTC date
	Reason  string    // "ua" | "asn"
	Count   int64
}

// Store is what the rest of the collector needs from vdb.
type Store interface {
	// AddBotCounts adds the given counts to bot_counts, all or nothing.
	AddBotCounts(ctx context.Context, rows []BotCount) error
	// BotCounts returns daily counts for one website in [from, to] (UTC dates, inclusive), oldest first.
	BotCounts(ctx context.Context, website string, from, to time.Time) ([]BotCount, error)
	// Ping reports whether vdb answers and the schema is current.
	Ping(ctx context.Context) error
	Close()
}

// Postgres is the vdb-backed Store.
type Postgres struct {
	pool *pgxpool.Pool

	mu       sync.Mutex
	migrated bool
}

// OpenPostgres creates the pool. It does not connect: vdb being down at start must not stop the aggregate
// channel (design 3.4). The schema is applied on first use and retried until it succeeds.
func OpenPostgres(ctx context.Context, url string) (*Postgres, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		// pgx errors can echo the connection string; do not pass them on.
		return nil, errors.New("DATABASE_URL is not a valid PostgreSQL connection URL")
	}
	cfg.MaxConns = 4
	cfg.MinConns = 0
	cfg.MaxConnLifetime = time.Hour
	cfg.ConnConfig.ConnectTimeout = 3 * time.Second
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, errors.New("could not create the database pool")
	}
	return &Postgres{pool: pool}, nil
}

// Close releases the pool.
func (p *Postgres) Close() { p.pool.Close() }

// ensure applies pending migrations once. Safe to call on every operation.
func (p *Postgres) ensure(ctx context.Context) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.migrated {
		return nil
	}
	if err := Migrate(ctx, p.pool); err != nil {
		return err
	}
	p.migrated = true
	return nil
}

// Migrate applies the embedded migrations in file-name order, each once, under an advisory lock.
func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("migrate: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(1229933313)`); err != nil { // 'INS\x01'
		return fmt.Errorf("migrate: lock: %w", err)
	}
	if _, err := tx.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
		return fmt.Errorf("migrate: ledger: %w", err)
	}
	entries, err := fs.ReadDir(migrations.FS, ".")
	if err != nil {
		return fmt.Errorf("migrate: read: %w", err)
	}
	var names []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".sql") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	for _, name := range names {
		var done bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = $1)`, name).Scan(&done); err != nil {
			return fmt.Errorf("migrate: ledger read: %w", err)
		}
		if done {
			continue
		}
		sqlText, err := fs.ReadFile(migrations.FS, name)
		if err != nil {
			return fmt.Errorf("migrate: read %s: %w", name, err)
		}
		if _, err := tx.Exec(ctx, string(sqlText)); err != nil {
			return fmt.Errorf("migrate: %s: %w", name, err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO schema_migrations (version) VALUES ($1)`, name); err != nil {
			return fmt.Errorf("migrate: ledger write: %w", err)
		}
	}
	return tx.Commit(ctx)
}

// AddBotCounts implements Store.
func (p *Postgres) AddBotCounts(ctx context.Context, rows []BotCount) error {
	if len(rows) == 0 {
		return nil
	}
	if err := p.ensure(ctx); err != nil {
		return err
	}
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	batch := &pgx.Batch{}
	for _, r := range rows {
		batch.Queue(`INSERT INTO bot_counts (website, day, reason, count) VALUES ($1, $2, $3, $4)
			ON CONFLICT (website, day, reason) DO UPDATE SET count = bot_counts.count + EXCLUDED.count`,
			r.Website, r.Day.UTC().Format("2006-01-02"), r.Reason, r.Count)
	}
	br := tx.SendBatch(ctx, batch)
	for range rows {
		if _, err := br.Exec(); err != nil {
			_ = br.Close()
			return err
		}
	}
	if err := br.Close(); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// BotCounts implements Store.
func (p *Postgres) BotCounts(ctx context.Context, website string, from, to time.Time) ([]BotCount, error) {
	if err := p.ensure(ctx); err != nil {
		return nil, err
	}
	rows, err := p.pool.Query(ctx,
		`SELECT website::text, day, reason, count FROM bot_counts WHERE website = $1 AND day BETWEEN $2 AND $3 ORDER BY day, reason`,
		website, from.UTC().Format("2006-01-02"), to.UTC().Format("2006-01-02"))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []BotCount
	for rows.Next() {
		var r BotCount
		if err := rows.Scan(&r.Website, &r.Day, &r.Reason, &r.Count); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// Ping implements Store.
func (p *Postgres) Ping(ctx context.Context) error {
	if err := p.pool.Ping(ctx); err != nil {
		return err
	}
	return p.ensure(ctx)
}
