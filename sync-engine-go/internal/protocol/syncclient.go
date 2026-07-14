// Node-side push/pull drivers. A node PUSHes its own events to central and PULLs everyone
// else's from central, advancing its per-peer cursor on success. Dedup + conflict handling live
// in Apply; these just move batches over mTLS and move the cursor.
package protocol

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"

	"github.com/jackc/pgx/v5/pgxpool"

	"gaiada/sync-engine-go/internal/conflict"
)

const batchLimit = 500

// PushOnce sends this node's unsynced events to central. Returns the number sent.
func PushOnce(ctx context.Context, pool *pgxpool.Pool, client *http.Client, centralURL, nodeID, originSite string, tenants []string) (int, error) {
	lastPushed, _, err := GetCursor(ctx, pool, nodeID, "central")
	if err != nil {
		return 0, err
	}
	events, err := CollectForPush(ctx, pool, originSite, tenants, lastPushed, batchLimit)
	if err != nil {
		return 0, err
	}
	if len(events) == 0 {
		return 0, nil
	}
	body, _ := json.Marshal(Batch{Events: events})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, centralURL+"/sync/push", bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("push rejected: HTTP %d", resp.StatusCode)
	}
	// Advance the cursor to the max hlc sent (events are hlc-ascending).
	if err := SetPushCursor(ctx, pool, nodeID, "central", events[len(events)-1].HLC); err != nil {
		return 0, err
	}
	return len(events), nil
}

// PullOnce fetches events from central for this node's authorized scope and applies them.
// Returns the number applied.
func PullOnce(ctx context.Context, pool *pgxpool.Pool, client *http.Client, centralURL, nodeID string) (int, error) {
	_, lastPulled, err := GetCursor(ctx, pool, nodeID, "central")
	if err != nil {
		return 0, err
	}
	u := centralURL + "/sync/pull?after=" + url.QueryEscape(lastPulled)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return 0, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("pull failed: HTTP %d", resp.StatusCode)
	}
	var batch Batch
	if err := json.NewDecoder(resp.Body).Decode(&batch); err != nil {
		return 0, err
	}
	maxHLC := lastPulled
	applied := 0
	for _, w := range batch.Events {
		ev, err := ToIncoming(w)
		if err != nil {
			return applied, err
		}
		if err := Apply(ctx, pool, ev, conflict.DefaultPolicyFor(ev.EntityType)); err != nil {
			return applied, err
		}
		applied++
		if w.HLC > maxHLC {
			maxHLC = w.HLC
		}
	}
	if maxHLC != lastPulled {
		if err := SetPullCursor(ctx, pool, nodeID, "central", maxHLC); err != nil {
			return applied, err
		}
	}
	return applied, nil
}
