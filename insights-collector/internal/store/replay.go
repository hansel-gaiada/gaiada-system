package store

import (
	"context"
	"time"
)

// Fixed caps of one recording (design 6.2). The others (the site's and the visitor's daily counts, the budget)
// come from the environment through ReplayLimits.
const (
	ReplaySessionMaxBytes    = 5 * 1024 * 1024  // stored (compressed) bytes of one recording
	ReplaySessionMaxDuration = 30 * time.Minute // from the first chunk's receipt
	ReplaySessionMaxChunks   = 1000             // keeps a recording of many tiny chunks from becoming many rows
	ReplayDailyWindow        = 24 * time.Hour   // "a day" for the new-recording counts is a rolling 24 hours
)

// Why a chunk was refused with {record:false}. Counters and tests use these; the browser is told nothing more
// than record:false.
const (
	RefusedSessionBytes    = "session-bytes"
	RefusedSessionDuration = "session-duration"
	RefusedSessionChunks   = "session-chunks"
	RefusedSiteDaily       = "site-daily"
	RefusedVisitorDaily    = "visitor-daily"
	RefusedBudget          = "budget"
)

// ReplayLimits are the caps AddReplayChunk enforces, atomically with the write.
type ReplayLimits struct {
	BudgetBytes  int64 // all stored recording bytes of the website; a chunk that would pass it is refused (a hard cap)
	SiteDaily    int   // new recordings of the website in the last 24 h
	VisitorDaily int   // new recordings of the visitor id in the last 24 h
}

// ReplayChunk is one chunk to store. There is no field for an address or a user agent.
type ReplayChunk struct {
	Website     string
	VisitorID   string
	ConsentID   string
	RecordingID string
	Seq         int
	Data        []byte   // gzip of the JSON array of events, already checked and rewritten
	Pages       []string // distinct paths found in this chunk's meta events
	ReceivedAt  time.Time
}

// ChunkOutcome is what AddReplayChunk did.
type ChunkOutcome int

const (
	ChunkStored    ChunkOutcome = iota // written
	ChunkDuplicate                     // this (recording, seq) already existed: nothing changed (a retry)
	ChunkGone                          // visitor id or consent id tombstoned: nothing stored
	ChunkMismatch                      // the recording id exists for another website, visitor or consent id: nothing stored
	ChunkRefused                       // over a cap or the budget: nothing stored; Refusal says which
)

// ReplayChunkResult carries the outcome and, for ChunkRefused, the reason.
type ReplayChunkResult struct {
	Outcome ChunkOutcome
	Refusal string
}

// ReplaySession is a recording's metadata (design 6.3: date, length, pages). No content.
type ReplaySession struct {
	ID          string
	Website     string
	VisitorID   string
	ConsentID   string
	StartedAt   time.Time
	LastChunkAt time.Time
	Chunks      int
	Bytes       int64
	Pages       []string
}

// StoredChunk is one stored chunk: gzip of the JSON array of events.
type StoredChunk struct {
	Seq        int
	ReceivedAt time.Time
	Bytes      int
	Data       []byte
}

// ReplayStore is the replay channel's part of the Store (design 6.2, 6.3).
type ReplayStore interface {
	// AddReplayChunk stores one chunk and its recording row in one transaction, under the same insert/forget lock as
	// InsertEvents (shared), so a chunk can never land after a forget deleted that visitor's recordings. The tombstone
	// check, the caps and the write are atomic with respect to a forget. A repeated (recording, seq) is ChunkDuplicate
	// and changes nothing, even when the recording is at a cap.
	AddReplayChunk(ctx context.Context, c ReplayChunk, lim ReplayLimits) (ReplayChunkResult, error)
	// ReplaySessions lists a visitor's recordings of one website, newest first. Metadata only.
	ReplaySessions(ctx context.Context, website, visitorID string, limit int) ([]ReplaySession, error)
	// ReplayChunksAfter returns the recording (found is false when no recording has this id on this website) and up to
	// limit of its chunks with seq > after, in seq order. Content.
	ReplayChunksAfter(ctx context.Context, website, recordingID string, after, limit int) (sess ReplaySession, chunks []StoredChunk, found bool, err error)
	// PurgeReplay deletes recordings (and their chunks) whose started_at is before the cutoff.
	PurgeReplay(ctx context.Context, startedBefore time.Time) (int64, error)
}
