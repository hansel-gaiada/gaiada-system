// On-the-wire representation of a sync batch and cursor helpers. HLC travels as its padded text
// form so both Go sides parse it identically.
package protocol

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"gaiada/sync-engine-go/internal/hlc"
)

type WireEvent struct {
	OutboxID   string         `json:"outbox_id"`
	TenantID   string         `json:"tenant_id"`
	EntityType string         `json:"entity_type"`
	EntityID   string         `json:"entity_id"`
	EventType  string         `json:"event_type"`
	OriginSite string         `json:"origin_site"`
	HLC        string         `json:"hlc"`
	Payload    map[string]any `json:"payload"`
}

type Batch struct {
	Events []WireEvent `json:"events"`
}

// PushResult / PullResult are the JSON bodies exchanged with the central server.
type PushResult struct {
	Applied  int      `json:"applied"`
	Rejected []string `json:"rejected"` // outbox ids rejected by the ACL (anomaly-logged server-side)
}

// ToIncoming converts a wire event into the apply-layer event (parses the HLC text).
func ToIncoming(w WireEvent) (IncomingEvent, error) {
	h, err := hlc.Parse(w.HLC)
	if err != nil {
		return IncomingEvent{}, err
	}
	return IncomingEvent{
		OutboxID: w.OutboxID, TenantID: w.TenantID, EntityType: w.EntityType, EntityID: w.EntityID,
		EventType: w.EventType, Payload: w.Payload, HLC: h, OriginSite: w.OriginSite,
	}, nil
}

// ---- sync_cursors (no RLS; a per-peer progress row) ----

func GetCursor(ctx context.Context, pool *pgxpool.Pool, nodeID, peerID string) (lastPushed, lastPulled string, err error) {
	var pushed, pulled *string
	err = pool.QueryRow(ctx,
		`SELECT last_pushed_hlc, last_pulled_hlc FROM sync_cursors WHERE node_id = $1 AND peer_id = $2`,
		nodeID, peerID).Scan(&pushed, &pulled)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", "", nil // no cursor yet — start from the beginning
		}
		return "", "", err
	}
	if pushed != nil {
		lastPushed = *pushed
	}
	if pulled != nil {
		lastPulled = *pulled
	}
	return lastPushed, lastPulled, nil
}

func SetPushCursor(ctx context.Context, pool *pgxpool.Pool, nodeID, peerID, hlcStr string) error {
	_, err := pool.Exec(ctx,
		`INSERT INTO sync_cursors (node_id, peer_id, last_pushed_hlc, updated_at)
		 VALUES ($1, $2, $3, now())
		 ON CONFLICT (node_id, peer_id) DO UPDATE SET last_pushed_hlc = EXCLUDED.last_pushed_hlc, updated_at = now()`,
		nodeID, peerID, hlcStr)
	return err
}

func SetPullCursor(ctx context.Context, pool *pgxpool.Pool, nodeID, peerID, hlcStr string) error {
	_, err := pool.Exec(ctx,
		`INSERT INTO sync_cursors (node_id, peer_id, last_pulled_hlc, updated_at)
		 VALUES ($1, $2, $3, now())
		 ON CONFLICT (node_id, peer_id) DO UPDATE SET last_pulled_hlc = EXCLUDED.last_pulled_hlc, updated_at = now()`,
		nodeID, peerID, hlcStr)
	return err
}
