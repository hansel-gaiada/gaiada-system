// Engine configuration, env-driven, mirroring the gateway's config style. SYNC_MODE selects
// central (serves push/pull over mTLS) vs site (drives push/pull to central on a ticker).
package config

import (
	"os"
	"strconv"
	"strings"
)

type Config struct {
	Mode        string // "site" | "central"
	NodeID      string // = mTLS CN; the ACL keys on this
	OriginSite  string // this node's origin_site stamp (defaults to NodeID)
	CentralURL  string // site mode: https://central-host
	DatabaseURL string

	CACertPath string
	CertPath   string // this node's cert (client on site, server on central; issued dual-use)
	KeyPath    string

	ListenAddr string   // central mode
	AllowedCNs []string // central mode peer allowlist; empty = any CA-signed node

	TickIntervalMs int
	GCEveryTicks   int // run tombstone GC every N ticks (0 disables)
}

func Load() Config {
	c := Config{
		Mode:           env("SYNC_MODE", "site"),
		NodeID:         env("NODE_ID", "site-1"),
		OriginSite:     os.Getenv("ORIGIN_SITE"),
		CentralURL:     env("CENTRAL_URL", "https://sync-central:3013"),
		DatabaseURL:    os.Getenv("DATABASE_URL"),
		CACertPath:     env("SYNC_CA_CERT", "data/ca-cert.pem"),
		CertPath:       env("SYNC_CERT", "data/sync.crt"),
		KeyPath:        env("SYNC_KEY", "data/sync.key"),
		ListenAddr:     env("SYNC_LISTEN_ADDR", "0.0.0.0:3013"),
		AllowedCNs:     splitNonEmpty(os.Getenv("SYNC_ALLOWED_CNS")),
		TickIntervalMs: envInt("SYNC_TICK_INTERVAL_MS", 5000),
		GCEveryTicks:   envInt("SYNC_GC_EVERY_TICKS", 60),
	}
	if c.OriginSite == "" {
		c.OriginSite = c.NodeID // by convention a node's origin_site == its mTLS CN
	}
	return c
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func splitNonEmpty(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}
