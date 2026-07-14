// Central sync server: the mTLS-fronted endpoints nodes push to and pull from. The client CN
// (proven by mTLS) is the node_id; every batch is gated by the site_subscriptions ACL before any
// event is applied (D5). Out-of-scope events are rejected to the anomaly path, never silently
// applied or silently dropped.
package server

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"

	"gaiada/sync-engine-go/internal/conflict"
	"gaiada/sync-engine-go/internal/mtls"
	"gaiada/sync-engine-go/internal/protocol"
)

// AnomalyFunc is called for every ACL-rejected event (same path as the bot's cost-cap alert in
// the wider system). Wired by main; defaults to a log line.
type AnomalyFunc func(nodeID, tenantID, outboxID, reason string)

type Server struct {
	pool    *pgxpool.Pool
	anomaly AnomalyFunc
}

func New(pool *pgxpool.Pool, anomaly AnomalyFunc) *Server {
	if anomaly == nil {
		anomaly = func(nodeID, tenantID, outboxID, reason string) {
			log.Printf("sync anomaly: node=%s tenant=%s event=%s reason=%s", nodeID, tenantID, outboxID, reason)
		}
	}
	return &Server{pool: pool, anomaly: anomaly}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/sync/push", s.handlePush)
	mux.HandleFunc("/sync/pull", s.handlePull)
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) })
	return mux
}

func (s *Server) handlePush(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	nodeID, ok := mtls.PeerCN(r)
	if !ok {
		http.Error(w, "no client identity", http.StatusUnauthorized)
		return
	}
	var batch protocol.Batch
	if err := json.NewDecoder(r.Body).Decode(&batch); err != nil {
		http.Error(w, "bad batch", http.StatusBadRequest)
		return
	}
	res := protocol.PushResult{}
	for _, wev := range batch.Events {
		authorized, err := protocol.CheckAuthorized(r.Context(), s.pool, nodeID, wev.TenantID)
		if err != nil {
			http.Error(w, "acl check failed", http.StatusInternalServerError)
			return
		}
		if !authorized {
			// D5: reject out-of-scope to the anomaly path — not silent.
			s.anomaly(nodeID, wev.TenantID, wev.OutboxID, "tenant not in site_subscriptions")
			res.Rejected = append(res.Rejected, wev.OutboxID)
			continue
		}
		ev, err := protocol.ToIncoming(wev)
		if err != nil {
			s.anomaly(nodeID, wev.TenantID, wev.OutboxID, "malformed hlc")
			res.Rejected = append(res.Rejected, wev.OutboxID)
			continue
		}
		if err := protocol.Apply(r.Context(), s.pool, ev, conflict.DefaultPolicyFor(ev.EntityType)); err != nil {
			http.Error(w, "apply failed", http.StatusInternalServerError)
			return
		}
		res.Applied++
	}
	writeJSON(w, res)
}

func (s *Server) handlePull(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	nodeID, ok := mtls.PeerCN(r)
	if !ok {
		http.Error(w, "no client identity", http.StatusUnauthorized)
		return
	}
	tenants, err := protocol.AuthorizedTenants(r.Context(), s.pool, nodeID)
	if err != nil {
		http.Error(w, "acl lookup failed", http.StatusInternalServerError)
		return
	}
	after := r.URL.Query().Get("after")
	// Exclude the requesting node's own events (origin_site == node_id by convention) so it never
	// pulls back what it pushed.
	events, err := protocol.CollectForPull(r.Context(), s.pool, tenants, after, nodeID, 500)
	if err != nil {
		http.Error(w, "collect failed", http.StatusInternalServerError)
		return
	}
	writeJSON(w, protocol.Batch{Events: events})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
