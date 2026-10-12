// Command collector is the Gaiada insights enrichment collector: it sits between the nginx edge and Umami,
// resolves each tracker hit once (country, city, network, bot), and forwards it with a pseudonym in place of
// the visitor's address. See insights-collector/CLAUDE.md and docs/plans/2026-10-12-m5-phase5-design.md section 3.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"gaiada/insights-collector/data"
	"gaiada/insights-collector/internal/bot"
	"gaiada/insights-collector/internal/company"
	"gaiada/insights-collector/internal/config"
	"gaiada/insights-collector/internal/consent"
	"gaiada/insights-collector/internal/geo"
	"gaiada/insights-collector/internal/ingest"
	"gaiada/insights-collector/internal/ops"
	"gaiada/insights-collector/internal/stats"
	"gaiada/insights-collector/internal/store"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "-healthcheck" {
		os.Exit(healthcheck(os.Getenv))
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Getenv, os.Stdout, nil); err != nil {
		// Configuration errors name variables, never values; nothing else here can carry an address.
		fmt.Fprintln(os.Stderr, "collector: "+err.Error())
		os.Exit(1)
	}
}

// healthcheck is the Docker HEALTHCHECK (the image is distroless: no curl, no wget). Exit 0 when the ops port
// answers /healthz with 200.
func healthcheck(getenv func(string) string) int {
	addr := getenv("OPS_ADDR")
	if addr == "" {
		addr = ":8081"
	}
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		return 1
	}
	c := http.Client{Timeout: 3 * time.Second}
	resp, err := c.Get("http://127.0.0.1:" + port + "/healthz")
	if err != nil {
		return 1
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

// run starts both listeners and blocks until ctx ends. ready, when non-nil, receives the two bound addresses
// (public, ops) once both are listening (tests use this with port 0 style addresses).
func run(ctx context.Context, getenv func(string) string, stdout io.Writer, ready chan<- [2]string) error {
	cfg, err := config.Load(getenv)
	if err != nil {
		return err
	}
	log := slog.New(slog.NewJSONHandler(stdout, &slog.HandlerOptions{Level: cfg.LogLevel}))

	resolver, err := company.NewRegistry().Select(cfg.CompanyResolver, company.Options{})
	if err != nil {
		return err
	}
	detector, err := bot.New(data.IsbotPatterns, data.DatacenterASNs)
	if err != nil {
		return err
	}

	geodb := geo.Open(cfg.GeoDir, cfg.CityFile, cfg.ASNFile)
	defer geodb.Close()
	gs := geodb.Status()
	if gs.City.Problem != "" {
		log.Warn("geo file not loaded", "file", cfg.CityFile, "edition", "city", "problem", gs.City.Problem)
	}
	if gs.ASN.Problem != "" {
		log.Warn("geo file not loaded", "file", cfg.ASNFile, "edition", "asn", "problem", gs.ASN.Problem)
	}
	if gs.Degraded() && cfg.GeoRequired {
		return errors.New("GEO_REQUIRED=1 but a geo file is not loaded (" + gs.String() + ")")
	}
	// Re-select with the ASN file version now that it is known (a label on results; no behaviour).
	if resolver, err = company.NewRegistry().Select(cfg.CompanyResolver, company.Options{ASNVersion: gs.ASN.Version}); err != nil {
		return err
	}

	st, err := store.OpenPostgres(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	return serve(ctx, cfg, log, geodb, detector, resolver, st, ready)
}

// serve wires the handlers around a Store. Split from run so tests can supply a Memory store.
func serve(ctx context.Context, cfg config.Config, log *slog.Logger, geodb *geo.DB, detector *bot.Detector,
	resolver company.Resolver, st store.Store, ready chan<- [2]string) error {
	defer st.Close()
	counters := &stats.Counters{}
	botCounter := store.NewBotCounter(st, log, counters)

	pub := ingest.New(ingest.Options{Config: cfg, Geo: geodb, Bots: detector, Counter: botCounter, Stats: counters, Log: log})
	consented := consent.New(consent.Options{
		Config: cfg, Geo: geodb, Bots: detector, Resolver: resolver, Store: st, Stats: counters, Log: log,
	})
	opsH := ops.New(ops.Options{
		Config: cfg, GeoStatus: geodb.Status, Store: st, Counter: botCounter, Stats: counters, Resolver: resolver.Name(),
	})

	pubLn, err := net.Listen("tcp", cfg.PublicAddr)
	if err != nil {
		return errors.New("cannot listen on LISTEN_ADDR")
	}
	opsLn, err := net.Listen("tcp", cfg.OpsAddr)
	if err != nil {
		_ = pubLn.Close()
		return errors.New("cannot listen on OPS_ADDR")
	}

	// The server's own error log (TLS or protocol noise) can name a remote address: route it to a typed line.
	quiet := slog.NewLogLogger(&typedHandler{log: log}, slog.LevelWarn)
	newServer := func(h http.Handler) *http.Server {
		return &http.Server{
			Handler:           recoverTyped(log, h),
			ReadHeaderTimeout: 5 * time.Second,
			ReadTimeout:       10 * time.Second,
			WriteTimeout:      10 * time.Second,
			IdleTimeout:       30 * time.Second,
			MaxHeaderBytes:    16 << 10,
			ErrorLog:          quiet,
		}
	}
	// The public port serves exactly three paths: the aggregate channel and the consented channel's two routes.
	root := http.NewServeMux()
	root.Handle(cfg.CollectPath, pub.Routes())
	consentRoutes := consented.Routes()
	root.Handle(config.ConsentPath, consentRoutes)
	root.Handle(config.ForgetPath, consentRoutes)
	pubSrv, opsSrv := newServer(root), newServer(opsH.Routes())

	log.Info("collector starting",
		"version", cfg.Version, "geo", geodb.Status().String(), "resolver", resolver.Name(), "ip_mode", cfg.IPMode,
		"datacenter_asns", detector.ASNCount(), "websites", len(cfg.Websites),
		"buffer_retention_hours", int(cfg.BufferRetention.Hours()), "purge_interval_minutes", int(cfg.PurgeInterval.Minutes()))
	if cfg.IPMode == config.IPModeReal {
		log.Warn("FORWARD_IP_MODE=real: the visitor address is passed to Umami (documented fallback, not the default)")
	}

	errc := make(chan error, 2)
	go func() { errc <- pubSrv.Serve(pubLn) }()
	go func() { errc <- opsSrv.Serve(opsLn) }()
	bg, cancelBg := context.WithCancel(ctx)
	flushed := make(chan struct{})
	go func() { botCounter.Run(bg, cfg.BotFlushInterval); close(flushed) }()
	purger := &store.Purger{St: st, Log: log, Stats: counters, Retention: cfg.BufferRetention, TombstoneMonths: config.TombstoneRetention}
	purged := make(chan struct{})
	go func() { purger.Run(bg, cfg.PurgeInterval); close(purged) }()
	if ready != nil {
		ready <- [2]string{pubLn.Addr().String(), opsLn.Addr().String()}
	}

	var serveErr error
	select {
	case <-ctx.Done():
	case serveErr = <-errc:
		if errors.Is(serveErr, http.ErrServerClosed) {
			serveErr = nil
		}
	}
	cancelBg()
	sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = pubSrv.Shutdown(sctx)
	_ = opsSrv.Shutdown(sctx)
	<-flushed
	<-purged
	log.Info("collector stopped")
	return serveErr
}

// recoverTyped turns a handler panic into a 500 and a value-free log line.
func recoverTyped(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				log.Error("handler panic", "outcome", "panic")
				w.WriteHeader(http.StatusInternalServerError)
			}
		}()
		next.ServeHTTP(w, r)
	})
}
