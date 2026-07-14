// sync — the Gaiada cross-site reconciliation engine (WS1 T2). One binary runs at each site and
// at central. Central serves push/pull over mTLS; a site drives push→pull→GC on a ticker. Dedup,
// conflict resolution, per-tenant RLS, and the central ACL live in internal/protocol.
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"gaiada/sync-engine-go/internal/config"
	"gaiada/sync-engine-go/internal/db"
	"gaiada/sync-engine-go/internal/gc"
	"gaiada/sync-engine-go/internal/mtls"
	"gaiada/sync-engine-go/internal/protocol"
	"gaiada/sync-engine-go/internal/server"
)

func main() {
	cfg := config.Load()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := db.NewPool(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("db pool: %v", err)
	}
	defer pool.Close()

	log.Printf("sync-engine mode=%s node=%s origin=%s central=%s", cfg.Mode, cfg.NodeID, cfg.OriginSite, cfg.CentralURL)

	switch cfg.Mode {
	case "central":
		runCentral(ctx, cfg, pool)
	default:
		runSite(ctx, cfg, pool)
	}
}

func runCentral(ctx context.Context, cfg config.Config, pool *pgxpool.Pool) {
	tlsCfg, err := mtls.ServerTLSConfig(cfg.CACertPath, cfg.CertPath, cfg.KeyPath, cfg.AllowedCNs)
	if err != nil {
		log.Fatalf("server TLS: %v", err)
	}
	srv := &http.Server{Addr: cfg.ListenAddr, Handler: server.New(pool, nil).Handler(), TLSConfig: tlsCfg}

	// Central also runs the tombstone GC sweep on the ticker (it holds every subscriber's cursor).
	go tickerLoop(ctx, cfg, func() {
		if cfg.GCEveryTicks > 0 {
			if _, err := gc.Sweep(ctx, pool); err != nil {
				log.Printf("gc sweep: %v", err)
			}
		}
	})

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()

	log.Printf("central sync server listening on %s (mTLS)", cfg.ListenAddr)
	if err := srv.ListenAndServeTLS("", ""); err != nil && err != http.ErrServerClosed {
		log.Fatalf("serve: %v", err)
	}
}

func runSite(ctx context.Context, cfg config.Config, pool *pgxpool.Pool) {
	client, err := mtls.NewClient(cfg.CACertPath, cfg.CertPath, cfg.KeyPath)
	if err != nil {
		log.Fatalf("mTLS client: %v", err)
	}
	tick := 0
	tickerLoop(ctx, cfg, func() {
		tick++
		tenants, err := protocol.LocalTenants(ctx, pool)
		if err != nil {
			log.Printf("local tenants: %v", err)
			return
		}
		if n, err := protocol.PushOnce(ctx, pool, client, cfg.CentralURL, cfg.NodeID, cfg.OriginSite, tenants); err != nil {
			log.Printf("push: %v", err)
		} else if n > 0 {
			log.Printf("pushed %d events", n)
		}
		if n, err := protocol.PullOnce(ctx, pool, client, cfg.CentralURL, cfg.NodeID); err != nil {
			log.Printf("pull: %v", err)
		} else if n > 0 {
			log.Printf("pulled+applied %d events", n)
		}
		if cfg.GCEveryTicks > 0 && tick%cfg.GCEveryTicks == 0 {
			if _, err := gc.Sweep(ctx, pool); err != nil {
				log.Printf("gc sweep: %v", err)
			}
		}
	})
}

// tickerLoop runs fn immediately and then every TickIntervalMs until ctx is cancelled.
func tickerLoop(ctx context.Context, cfg config.Config, fn func()) {
	interval := time.Duration(cfg.TickIntervalMs) * time.Millisecond
	t := time.NewTicker(interval)
	defer t.Stop()
	fn()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			fn()
		}
	}
}
