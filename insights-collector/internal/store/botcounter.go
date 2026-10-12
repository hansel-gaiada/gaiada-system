package store

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"gaiada/insights-collector/internal/stats"
)

type botKey struct {
	website string
	day     string // YYYY-MM-DD, UTC
	reason  string
}

// BotCounter aggregates bot hits in memory and flushes them to the Store, so a request never waits on vdb and
// vdb being down never touches the aggregate channel (design 3.4). A failed flush keeps its counts and retries
// on the next tick; the key space (website x day x reason) is tiny, so memory stays bounded.
type BotCounter struct {
	st    Store
	log   *slog.Logger
	stats *stats.Counters

	mu      sync.Mutex
	pending map[botKey]int64
}

// NewBotCounter returns a counter that flushes to st.
func NewBotCounter(st Store, log *slog.Logger, c *stats.Counters) *BotCounter {
	return &BotCounter{st: st, log: log, stats: c, pending: map[botKey]int64{}}
}

// Record counts one dropped bot hit. now is the time of receipt.
func (b *BotCounter) Record(website, reason string, now time.Time) {
	k := botKey{website: website, day: now.UTC().Format("2006-01-02"), reason: reason}
	b.mu.Lock()
	b.pending[k]++
	b.mu.Unlock()
}

// Pending is the number of unflushed hits (tests and /healthz).
func (b *BotCounter) Pending() int64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	var n int64
	for _, v := range b.pending {
		n += v
	}
	return n
}

// Flush writes everything pending. On failure the counts are put back.
func (b *BotCounter) Flush(ctx context.Context) error {
	b.mu.Lock()
	taken := b.pending
	b.pending = map[botKey]int64{}
	b.mu.Unlock()
	if len(taken) == 0 {
		return nil
	}
	rows := make([]BotCount, 0, len(taken))
	for k, n := range taken {
		day, _ := time.Parse("2006-01-02", k.day)
		rows = append(rows, BotCount{Website: k.website, Day: day, Reason: k.reason, Count: n})
	}
	if err := b.st.AddBotCounts(ctx, rows); err != nil {
		b.mu.Lock()
		for k, n := range taken {
			b.pending[k] += n
		}
		b.mu.Unlock()
		b.stats.BotFlushFailures.Add(1)
		return err
	}
	return nil
}

// Run flushes every interval until ctx ends, then makes one last attempt. Errors are logged as a typed
// outcome only (the error text of a database driver may carry connection details).
func (b *BotCounter) Run(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			fctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			_ = b.Flush(fctx)
			cancel()
			return
		case <-t.C:
			fctx, cancel := context.WithTimeout(ctx, 5*time.Second)
			if err := b.Flush(fctx); err != nil {
				b.log.Warn("bot count flush failed, counts kept for retry", "outcome", "vdb_unavailable")
			}
			cancel()
		}
	}
}
