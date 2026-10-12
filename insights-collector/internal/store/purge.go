package store

import (
	"context"
	"log/slog"
	"time"

	"gaiada/insights-collector/internal/stats"
)

// Purger deletes what has outlived its retention (design 4.7): consented rows 72 hours after receipt, and
// tombstones after 14 months. It is the second half of the retention promise (the first half is that the ERP
// pulls within minutes), so it runs at start, not only after the first interval.
type Purger struct {
	St              Store
	Log             *slog.Logger
	Stats           *stats.Counters
	Retention       time.Duration // events; the configured value is already capped at 72 h
	TombstoneMonths int
	Now             func() time.Time
}

// Once runs one purge pass and returns what it deleted.
func (p *Purger) Once(ctx context.Context) (events, tombstones int64, err error) {
	now := time.Now
	if p.Now != nil {
		now = p.Now
	}
	t := now().UTC()
	events, tombstones, err = p.St.Purge(ctx, t.Add(-p.Retention), t.AddDate(0, -p.TombstoneMonths, 0))
	if p.Stats != nil {
		p.Stats.PurgedEvents.Add(events)
		p.Stats.PurgedTombstones.Add(tombstones)
		if err != nil {
			p.Stats.PurgeFailures.Add(1)
		}
	}
	return events, tombstones, err
}

// Run purges now and then every interval until ctx ends. Errors are logged as a typed outcome only.
func (p *Purger) Run(ctx context.Context, interval time.Duration) {
	pass := func() {
		pctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		ev, tb, err := p.Once(pctx)
		switch {
		case err != nil:
			p.Log.Warn("purge failed, retried next interval", "outcome", "vdb_unavailable")
		case ev > 0 || tb > 0:
			p.Log.Info("purged expired rows", "outcome", "purged", "events", ev, "tombstones", tb)
		}
	}
	pass()
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			pass()
		}
	}
}
