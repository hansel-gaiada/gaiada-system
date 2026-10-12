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
	}
}
