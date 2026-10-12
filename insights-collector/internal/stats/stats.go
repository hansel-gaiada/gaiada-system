// Package stats holds the collector's process counters. They carry counts only: no address, user agent,
// website id or visitor id ever appears in a counter name or value.
package stats

import "sync/atomic"

// Counters are monotonically increasing since process start.
type Counters struct {
	Forwarded        atomic.Int64 // hits forwarded to Umami (any status)
	UmamiFailed      atomic.Int64 // forwards that got no answer (timeout, refused)
	BotUA            atomic.Int64
	BotASN           atomic.Int64
	DroppedType      atomic.Int64 // identify and every other non-event type
	RejectedWebsite  atomic.Int64 // website not in INSIGHTS_WEBSITES
	RejectedRequest  atomic.Int64 // malformed body, bad method, no usable client address
	BotFlushFailures atomic.Int64 // bot-count flushes to vdb that failed (counts are kept and retried)

	// Consented channel (V3-b).
	ConsentStored      atomic.Int64 // events written to the buffer
	ConsentRejected    atomic.Int64 // batches refused as malformed (400/403/413)
	ConsentEventsDrop  atomic.Int64 // single events dropped inside an accepted batch
	ConsentBot         atomic.Int64 // batches from a bot, dropped silently
	ConsentGone        atomic.Int64 // batches answered 410 (tombstoned id)
	ConsentRateLimited atomic.Int64 // batches answered 429
	ConsentStoreDown   atomic.Int64 // batches answered 503
	ForgetBrowser      atomic.Int64 // /lib/kestrel/f calls applied
	ForgetOps          atomic.Int64 // /ops/v1/forget calls applied
	PurgedEvents       atomic.Int64 // buffer rows deleted by the 72 h purge
	PurgedTombstones   atomic.Int64
	PurgeFailures      atomic.Int64
}

// Snapshot is the JSON form served on /healthz.
type Snapshot struct {
	Forwarded        int64 `json:"forwarded"`
	UmamiFailed      int64 `json:"umami_failed"`
	BotUA            int64 `json:"bot_ua"`
	BotASN           int64 `json:"bot_asn"`
	DroppedType      int64 `json:"dropped_type"`
	RejectedWebsite  int64 `json:"rejected_website"`
	RejectedRequest  int64 `json:"rejected_request"`
	BotFlushFailures int64 `json:"bot_flush_failures"`

	ConsentStored      int64 `json:"consent_stored"`
	ConsentRejected    int64 `json:"consent_rejected"`
	ConsentEventsDrop  int64 `json:"consent_events_dropped"`
	ConsentBot         int64 `json:"consent_bot"`
	ConsentGone        int64 `json:"consent_gone"`
	ConsentRateLimited int64 `json:"consent_rate_limited"`
	ConsentStoreDown   int64 `json:"consent_store_down"`
	ForgetBrowser      int64 `json:"forget_browser"`
	ForgetOps          int64 `json:"forget_ops"`
	PurgedEvents       int64 `json:"purged_events"`
	PurgedTombstones   int64 `json:"purged_tombstones"`
	PurgeFailures      int64 `json:"purge_failures"`
}

// Snapshot reads all counters.
func (c *Counters) Snapshot() Snapshot {
	return Snapshot{
		Forwarded:        c.Forwarded.Load(),
		UmamiFailed:      c.UmamiFailed.Load(),
		BotUA:            c.BotUA.Load(),
		BotASN:           c.BotASN.Load(),
		DroppedType:      c.DroppedType.Load(),
		RejectedWebsite:  c.RejectedWebsite.Load(),
		RejectedRequest:  c.RejectedRequest.Load(),
		BotFlushFailures: c.BotFlushFailures.Load(),

		ConsentStored:      c.ConsentStored.Load(),
		ConsentRejected:    c.ConsentRejected.Load(),
		ConsentEventsDrop:  c.ConsentEventsDrop.Load(),
		ConsentBot:         c.ConsentBot.Load(),
		ConsentGone:        c.ConsentGone.Load(),
		ConsentRateLimited: c.ConsentRateLimited.Load(),
		ConsentStoreDown:   c.ConsentStoreDown.Load(),
		ForgetBrowser:      c.ForgetBrowser.Load(),
		ForgetOps:          c.ForgetOps.Load(),
		PurgedEvents:       c.PurgedEvents.Load(),
		PurgedTombstones:   c.PurgedTombstones.Load(),
		PurgeFailures:      c.PurgeFailures.Load(),
	}
}
