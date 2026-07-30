// cmd/crawl is the job-mode entrypoint (SM-07): one process = one crawl of one registered,
// verified search_properties row for one tenant, then exit. No server, no long-running mode —
// matches the design's "one crawl = one stateless job" verdict for the crawler tools it adapts.
//
// This binary is the ticket's ONE delivered crawler path (see internal/crawler's package doc for
// the explicit scope cut: SEONaut/MySQL-sidecar and the upstream open-seo-crawler are deferred).
// Its whole reason to exist is to prove internal/egress end-to-end against a real target.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"gaiada/search-crawl-go/internal/crawler"
	"gaiada/search-crawl-go/internal/db"
	"gaiada/search-crawl-go/internal/egress"
	"gaiada/search-crawl-go/internal/robots"
)

func main() {
	if err := run(); err != nil {
		log.Fatalf("crawl job failed: %v", err)
	}
}

func run() error {
	databaseURL := requireEnv("DATABASE_URL")
	tenantID := requireEnv("TENANT_ID")
	propertyID := requireEnv("PROPERTY_ID")
	auditPath := envOr("AUDIT_LOG_PATH", "/app/data/egress-audit.jsonl")
	reportPath := envOr("REPORT_PATH", "/app/data/report.json")
	userAgent := envOr("USER_AGENT", "GaiadaSearchCrawler/1.0 (+https://gaiada.example/crawler)")
	maxPages := envInt("MAX_PAGES", 25)
	minHostGap := time.Duration(envInt("MIN_HOST_GAP_MS", 1000)) * time.Millisecond
	// Optional pre-flight assertion: if set, the job refuses (BEFORE ever dialing anything) unless
	// this exactly matches the resolved property's registered domain. Lets a dispatcher (n8n / a
	// future console "run crawl" action) assert what it INTENDS to crawl and get a fail-closed
	// audit line if that intent doesn't match what's actually registered — belt-and-braces on top
	// of the DB-resolved allowlist the Guard itself enforces.
	targetURL := os.Getenv("TARGET_URL")

	sink := egress.NewSink(auditPath)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	pool, err := db.Connect(ctx, databaseURL)
	if err != nil {
		return fmt.Errorf("db connect: %w", err)
	}
	defer pool.Close()

	prop, err := db.ResolveProperty(ctx, pool, tenantID, propertyID)
	if err != nil {
		return fmt.Errorf("resolve property: %w", err)
	}
	if prop == nil {
		_ = sink.Write(egress.Line{TenantID: tenantID, PropertyID: propertyID, Allowed: false, Reason: egress.ReasonUnknownProperty})
		return fmt.Errorf("refused: tenant %s has no registered search_properties row %s", tenantID, propertyID)
	}
	if prop.VerifiedAt == nil {
		_ = sink.Write(egress.Line{TenantID: tenantID, PropertyID: propertyID, Host: prop.Domain, Allowed: false, Reason: egress.ReasonNotVerified})
		return fmt.Errorf("refused: property %s (%s) is not yet verified (activation checklist)", propertyID, prop.Domain)
	}

	registeredDomain := strings.ToLower(prop.Domain)
	startURL := prop.SiteURL
	if targetURL != "" {
		if hostOf(targetURL) != registeredDomain && hostOf(targetURL) != "www."+registeredDomain {
			_ = sink.Write(egress.Line{TenantID: tenantID, PropertyID: propertyID, Host: hostOf(targetURL), URL: targetURL, Allowed: false, Reason: egress.ReasonNotAllowlisted})
			return fmt.Errorf("refused: TARGET_URL host %q does not match registered domain %q", hostOf(targetURL), registeredDomain)
		}
		startURL = targetURL
	}

	// Allowlist = exactly the registered domain plus its www.-prefixed form (same registrable
	// domain, the common apex<->www redirect pair) — never any other host, including ones a page
	// on the target site might link to.
	allowedHosts := []string{registeredDomain, "www." + registeredDomain}

	guard := egress.New(allowedHosts, func(d egress.Decision) {
		reason := d.Reason
		if d.Allowed {
			reason = ""
		}
		_ = sink.Write(egress.Line{TenantID: tenantID, PropertyID: propertyID, Host: d.Host, IP: d.IP, Allowed: d.Allowed, Reason: reason})
	})

	rateLimited := egress.NewRateLimitedTransport(guard.Transport(), minHostGap, func(d egress.Decision) {
		_ = sink.Write(egress.Line{TenantID: tenantID, PropertyID: propertyID, Host: d.Host, Allowed: false, Reason: d.Reason})
	})

	client := &http.Client{Transport: rateLimited, Timeout: 30 * time.Second}

	rules, robotsErr := robots.Fetch(ctx, client, startURL, userAgent)
	if robotsErr != nil {
		// Fetch failure (incl. a guard refusal on robots.txt itself) is not fatal — RFC 9309
		// default is "no robots.txt = everything allowed" and rules is already the empty Rules{}.
		log.Printf("robots.txt fetch: %v (continuing with no robots rules)", robotsErr)
	}

	report, err := crawler.Run(ctx, client, startURL, rules.Allowed, crawler.Options{
		MaxPages:  maxPages,
		UserAgent: userAgent,
	})
	if err != nil {
		return fmt.Errorf("crawl run: %w", err)
	}

	out, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(reportPath, out, 0o644); err != nil {
		return fmt.Errorf("write report: %w", err)
	}
	log.Printf("crawl complete: %d pages fetched, report at %s", len(report.Pages), reportPath)
	return nil
}

func hostOf(rawURL string) string {
	// Deliberately not net/url here: a malformed URL should just fail to match rather than panic.
	s := strings.TrimPrefix(strings.TrimPrefix(rawURL, "https://"), "http://")
	if i := strings.IndexAny(s, "/:"); i >= 0 {
		s = s[:i]
	}
	return strings.ToLower(s)
}

func requireEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		log.Fatalf("missing required env %s", key)
	}
	return v
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}
