package store

import (
	"context"
	"crypto/sha256"
	"strings"
	"time"
)

// Device classes (WebDesk's classifyUserAgent buckets, minus "bot": bots are dropped, never stored).
const (
	DeviceDesktop = "desktop"
	DeviceMobile  = "mobile"
	DeviceTablet  = "tablet"
	DeviceUnknown = "unknown"
)

// Tombstone kinds and reasons (the columns' CHECK values in 0001).
const (
	KindVisitor = "visitor"
	KindConsent = "consent"

	ReasonWithdraw = "withdraw"
	ReasonErase    = "erase"
)

// ConsentedEvent is one buffered row. There is deliberately no field for an address or a user agent: what the
// request carried is reduced to device class, country, city, ASN and network name before it gets here.
type ConsentedEvent struct {
	ID          int64 // assigned by the store; 0 on insert
	Website     string
	VisitorID   string
	ConsentID   string
	ReceivedAt  time.Time
	OccurredAt  time.Time
	Kind        string // "pageview" | "event"
	Path        string
	Name        string // "" for a pageview
	Data        string // a JSON object (already filtered to the allowed keys), "" for none
	Device      string
	Country     string // ISO 3166-1 alpha-2 or ""
	City        string
	ASN         uint32 // 0 when unknown
	NetworkName string
	Company     string // the CompanyResolver result as a JSON object, "" when nothing is known
}

// ForgetRequest is an ops forget (design 4.4): delete the ids' rows and tombstone the ids.
type ForgetRequest struct {
	Website    string
	VisitorIDs []string
	ConsentIDs []string
	Reason     string // ReasonWithdraw | ReasonErase
}

// ForgetResult counts what a forget did. Deleted counts change on a repeat; the tombstoned counts do not.
type ForgetResult struct {
	DeletedEvents      int64
	TombstonedVisitors int
	TombstonedConsents int
}

// IDHash is the tombstone hash contract shared with the ERP (platform-nest/migrations/202610131600_search_visitor_profiles.sql):
// sha256 of the UTF-8 bytes of the id in lower-case canonical text form. The id itself is never stored.
func IDHash(id string) []byte {
	sum := sha256.Sum256([]byte(strings.ToLower(id)))
	return sum[:]
}

// EventStore is the consented channel's part of the Store (design 4.4, 4.7).
type EventStore interface {
	// InsertEvents stores the batch in one transaction, unless the visitor id or the consent id is tombstoned:
	// then nothing is stored and gone is true. The check and the insert are atomic with respect to a forget.
	InsertEvents(ctx context.Context, website, visitorID, consentID string, evs []ConsentedEvent) (gone bool, err error)
	// EventsAfter returns up to limit rows of one website with id > after, oldest first, that are at least as
	// old as the cutoff: a row with received_at >= cutoff, and every row after the first such row, is left out,
	// so a row that commits late can never be skipped by a cursor that has moved past it.
	EventsAfter(ctx context.Context, website string, after int64, limit int, cutoff time.Time) ([]ConsentedEvent, error)
	// Forget deletes the rows of the given ids and tombstones the ids. Idempotent.
	Forget(ctx context.Context, req ForgetRequest) (ForgetResult, error)
	// ForgetPair is the browser's /lib/kestrel/f: rows are deleted only where BOTH ids match; the visitor id
	// is tombstoned (reason withdraw).
	ForgetPair(ctx context.Context, website, visitorID, consentID string) (deleted int64, err error)
	// Purge deletes rows received before eventsBefore and tombstones created before tombstonesBefore.
	Purge(ctx context.Context, eventsBefore, tombstonesBefore time.Time) (events, tombstones int64, err error)
}
