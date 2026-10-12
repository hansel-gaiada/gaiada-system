// Package config reads the collector's settings from the environment.
//
// Rules (design 2026-10-12-m5-phase5-design.md 3.4 and 9 trap 3; memory "empty env var becomes zero"):
//   - An EMPTY (or blank) value means "use the default", never 0.
//   - A value that is set but invalid, including an explicit 0 where 0 is out of range, refuses to start,
//     and the error names the variable (never its value: DATABASE_URL carries a password).
//   - A switch is on only for exactly "1".
//   - Variables with no safe default (the website allow-list, the collect path, the database, the ops key)
//     are required: empty refuses to start.
package config

import (
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

// IP modes for what Umami is told about the visitor's address.
const (
	// IPModePseudonym (default): Umami receives a 2001:db8::/32 address derived with a daily in-memory key.
	IPModePseudonym = "pseudonym"
	// IPModeReal is the documented fallback if V2-d shows Umami 3.4.0 mishandles the pseudonym: the real
	// address goes to Umami over the internal network, as before the collector existed. Never the default.
	IPModeReal = "real"
)

// DefaultCompanyResolver is the resolver used when COMPANY_RESOLVER is empty (design 3.3).
const DefaultCompanyResolver = "network-only"

// The consented channel's two browser routes (design 4.4). Fixed: the edge routes and the site name these exact paths.
const (
	ConsentPath = "/lib/kestrel/v"
	ForgetPath  = "/lib/kestrel/f"
	// ReplayPath is the session replay channel (V6-a, design 6.2). Off unless REPLAY_ENABLED is exactly 1.
	ReplayPath = "/lib/kestrel/r"
)

// MaxBufferRetention is the longest the consented buffer may keep a row (design 4.7: 72 hours). It is a
// promise in the privacy notice, so the variable can shorten it but never lengthen it.
const MaxBufferRetention = 72 * time.Hour

// TombstoneRetention is how long a forgotten id's hash is kept (design 4.7: 14 months, like the ERP's).
const TombstoneRetention = 14 // months

// MaxReplayRetention is the longest a recording may be kept (design 6.2: 30 days from started_at). Like the buffer's 72 hours it
// is a promise in the notice, so REPLAY_RETENTION_DAYS can shorten it but never lengthen it.
const MaxReplayRetention = 30 * 24 * time.Hour

// DefaultConsentEventNames are the event names the consented channel accepts when CONSENT_EVENT_NAMES is empty.
// CONFIRMED by M5-V3-j (2026-10-13): exactly the site's `EventName` union (gaiada-web-revamp
// src/scripts/tracking/events.ts) minus `web_vitals`, whose parameters are measurements, not allowed data keys. The
// first guess here said `language_switch`; the site's name is `switch_language`, so language switches were dropped.
const DefaultConsentEventNames = "section_view,cta_click,click_whatsapp,click_phone,click_email,click_directions,save_contact,switch_language,lead_form_start,lead_form_step,lead_form_send,generate_lead,page_not_found"

// Config is the validated configuration.
type Config struct {
	PublicAddr       string // aggregate channel; trusts X-Real-IP (set by the nginx edge)
	OpsAddr          string // /healthz and /ops/v1/*; never reads X-Real-IP
	CollectPath      string // path the tracker posts to, and the path used towards Umami
	UmamiURL         string // scheme://host[:port], no path
	UmamiTimeout     time.Duration
	MaxBodyBytes     int64
	Websites         map[string]struct{} // lower-case UUIDs
	GeoDir           string
	CityFile         string
	ASNFile          string
	GeoRequired      bool
	DatabaseURL      string
	OpsReadKeySHA256 [32]byte // the ERP's read key: /ops/v1/events and /ops/v1/bots
	// OpsForgetKeySHA256 is the SEPARATE key for /ops/v1/forget (design 4.4, O1): the read key cannot forget.
	OpsForgetKeySHA256 [32]byte
	ConsentEventNames  map[string]struct{} // accepted event names on the consented channel
	ConsentRatePerSec  int                 // global ceiling for /lib/kestrel/v and /f batches per second
	BufferRetention    time.Duration       // age at which a consented row is purged (default and maximum 72 h)
	PurgeInterval      time.Duration       // how often the purge loop runs

	// Session replay (V6-a). All off or at the design's values unless set.
	ReplayEnabled         bool          // REPLAY_ENABLED exactly "1"
	ReplayBudgetBytes     int64         // REPLAY_BUDGET_MB, per website, a hard cap on stored recording bytes
	ReplayRetention       time.Duration // REPLAY_RETENTION_DAYS, from started_at (default and maximum 30 days)
	ReplaySiteDailyMax    int           // new recordings per website per rolling 24 h
	ReplayVisitorDailyMax int           // new recordings per visitor id per rolling 24 h
	IPMode                string
	CompanyResolver       string
	BotFlushInterval      time.Duration
	LogLevel              slog.Level
	Version               string
}

type loader struct {
	get  func(string) string
	errs []string
}

func (l *loader) fail(name, why string) { l.errs = append(l.errs, name+": "+why) }

// str returns the trimmed value, or def when it is empty.
func (l *loader) str(name, def string) string {
	if v := strings.TrimSpace(l.get(name)); v != "" {
		return v
	}
	return def
}

// required returns the trimmed value; empty is an error.
func (l *loader) required(name string) string {
	v := strings.TrimSpace(l.get(name))
	if v == "" {
		l.fail(name, "required, must not be empty")
	}
	return v
}

// intRange reads an integer in [min,max]; empty means def.
func (l *loader) intRange(name string, def, min, max int64) int64 {
	raw := strings.TrimSpace(l.get(name))
	if raw == "" {
		return def
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		l.fail(name, "must be a whole number")
		return def
	}
	if n < min || n > max {
		l.fail(name, fmt.Sprintf("must be between %d and %d (empty uses the default %d)", min, max, def))
		return def
	}
	return n
}

// keyHash reads a required 64-hex SHA-256 into dst and reports whether it is valid.
func (l *loader) keyHash(name, what string, dst *[32]byte) bool {
	raw := l.required(name)
	if raw == "" {
		return false
	}
	b, err := hex.DecodeString(strings.ToLower(raw))
	if err != nil || len(b) != 32 {
		l.fail(name, "must be the 64-hex-character SHA-256 of the "+what+" key")
		return false
	}
	copy(dst[:], b)
	return true
}

// validEventName: the same shape the ERP's column accepts (<= 50) and the site uses (snake_case).
func validEventName(s string) bool {
	if len(s) == 0 || len(s) > 50 || s[0] < 'a' || s[0] > 'z' {
		return false
	}
	for i := 1; i < len(s); i++ {
		c := s[i]
		if !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_') {
			return false
		}
	}
	return true
}

// onlyOne is the switch rule: on for exactly "1", off for everything else.
func onlyOne(v string) bool { return v == "1" }

func (l *loader) addr(name, def string) string {
	v := l.str(name, def)
	host, port, err := net.SplitHostPort(v)
	if err != nil {
		l.fail(name, "must be host:port, for example :8080")
		return def
	}
	_ = host
	p, err := strconv.Atoi(port)
	if err != nil || p < 1 || p > 65535 {
		l.fail(name, "port must be between 1 and 65535")
		return def
	}
	return v
}

// Load reads and validates the configuration. All problems are reported together.
func Load(get func(string) string) (Config, error) {
	l := &loader{get: get}
	var c Config

	c.PublicAddr = l.addr("LISTEN_ADDR", ":8080")
	c.OpsAddr = l.addr("OPS_ADDR", ":8081")
	if c.PublicAddr == c.OpsAddr {
		l.fail("OPS_ADDR", "must differ from LISTEN_ADDR")
	}

	c.CollectPath = l.required("COLLECT_API_ENDPOINT")
	if c.CollectPath != "" {
		switch {
		case !strings.HasPrefix(c.CollectPath, "/"), strings.ContainsAny(c.CollectPath, "?# \t"), len(c.CollectPath) > 200:
			l.fail("COLLECT_API_ENDPOINT", "must be one absolute path with no query, fragment or spaces")
		case c.CollectPath == "/healthz", strings.HasPrefix(c.CollectPath, "/ops/"):
			l.fail("COLLECT_API_ENDPOINT", "must not collide with /healthz or /ops/")
		case c.CollectPath == ConsentPath || c.CollectPath == ForgetPath || c.CollectPath == ReplayPath:
			l.fail("COLLECT_API_ENDPOINT", "must not collide with the consented channel paths "+ConsentPath+", "+ForgetPath+" and "+ReplayPath)
		}
	}

	c.UmamiURL = l.str("UMAMI_URL", "http://app:3000")
	if u, err := url.Parse(c.UmamiURL); err != nil || (u.Scheme != "http" && u.Scheme != "https") ||
		u.Host == "" || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.User != nil {
		l.fail("UMAMI_URL", "must be http(s)://host[:port] with no path, query or credentials")
		c.UmamiURL = "http://app:3000"
	}
	c.UmamiURL = strings.TrimSuffix(c.UmamiURL, "/")
	c.UmamiTimeout = time.Duration(l.intRange("UMAMI_TIMEOUT_MS", 3000, 100, 30000)) * time.Millisecond
	c.MaxBodyBytes = l.intRange("MAX_BODY_BYTES", 32*1024, 1024, 1<<20)

	c.Websites = map[string]struct{}{}
	if raw := l.required("INSIGHTS_WEBSITES"); raw != "" {
		for _, part := range strings.Split(raw, ",") {
			id := strings.ToLower(strings.TrimSpace(part))
			if id == "" {
				continue
			}
			if !IsUUID(id) {
				l.fail("INSIGHTS_WEBSITES", "every entry must be a UUID (comma separated)")
				break
			}
			c.Websites[id] = struct{}{}
		}
		if len(c.Websites) == 0 && !hasErr(l.errs, "INSIGHTS_WEBSITES") {
			l.fail("INSIGHTS_WEBSITES", "lists no website")
		}
	}

	c.GeoDir = l.str("GEO_DIR", "/geo")
	c.CityFile = l.str("GEO_CITY_FILE", "dbip-city-lite.mmdb")
	c.ASNFile = l.str("GEO_ASN_FILE", "dbip-asn-lite.mmdb")
	for _, f := range []struct{ n, v string }{{"GEO_CITY_FILE", c.CityFile}, {"GEO_ASN_FILE", c.ASNFile}} {
		if strings.ContainsAny(f.v, `/\`) {
			l.fail(f.n, "must be a file name inside GEO_DIR, not a path")
		}
	}
	c.GeoRequired = onlyOne(l.get("GEO_REQUIRED"))

	c.DatabaseURL = l.required("DATABASE_URL")

	readOK := l.keyHash("OPS_READ_KEY_SHA256", "read", &c.OpsReadKeySHA256)
	forgetOK := l.keyHash("OPS_FORGET_KEY_SHA256", "forget", &c.OpsForgetKeySHA256)
	if readOK && forgetOK && c.OpsReadKeySHA256 == c.OpsForgetKeySHA256 {
		l.fail("OPS_FORGET_KEY_SHA256", "must differ from OPS_READ_KEY_SHA256 (the read key must not be able to forget)")
	}

	c.ConsentEventNames = map[string]struct{}{}
	for _, part := range strings.Split(l.str("CONSENT_EVENT_NAMES", DefaultConsentEventNames), ",") {
		name := strings.TrimSpace(part)
		if name == "" {
			continue
		}
		if !validEventName(name) {
			l.fail("CONSENT_EVENT_NAMES", "every name must be lower-case letters, digits and underscores, starting with a letter, at most 50 characters")
			break
		}
		c.ConsentEventNames[name] = struct{}{}
	}
	if len(c.ConsentEventNames) == 0 && !hasErr(l.errs, "CONSENT_EVENT_NAMES") {
		l.fail("CONSENT_EVENT_NAMES", "lists no event name")
	}
	c.ConsentRatePerSec = int(l.intRange("CONSENT_RATE_PER_SECOND", 100, 1, 10000))
	c.BufferRetention = time.Duration(l.intRange("BUFFER_RETENTION_HOURS", 72, 1, 72)) * time.Hour
	c.PurgeInterval = time.Duration(l.intRange("PURGE_INTERVAL_MINUTES", 15, 1, 1440)) * time.Minute

	c.ReplayEnabled = onlyOne(l.get("REPLAY_ENABLED"))
	c.ReplayBudgetBytes = l.intRange("REPLAY_BUDGET_MB", 2048, 1, 1<<20) << 20 // up to 1 TB
	c.ReplayRetention = time.Duration(l.intRange("REPLAY_RETENTION_DAYS", 30, 1, 30)) * 24 * time.Hour
	c.ReplaySiteDailyMax = int(l.intRange("REPLAY_SITE_DAILY_RECORDINGS", 500, 1, 100000))
	c.ReplayVisitorDailyMax = int(l.intRange("REPLAY_VISITOR_DAILY_RECORDINGS", 10, 1, 1000))

	c.IPMode = l.str("FORWARD_IP_MODE", IPModePseudonym)
	if c.IPMode != IPModePseudonym && c.IPMode != IPModeReal {
		l.fail("FORWARD_IP_MODE", "must be pseudonym or real")
	}

	c.CompanyResolver = l.str("COMPANY_RESOLVER", DefaultCompanyResolver)
	c.BotFlushInterval = time.Duration(l.intRange("BOT_FLUSH_SECONDS", 30, 1, 3600)) * time.Second

	switch strings.ToLower(l.str("LOG_LEVEL", "info")) {
	case "debug":
		c.LogLevel = slog.LevelDebug
	case "info":
		c.LogLevel = slog.LevelInfo
	case "warn":
		c.LogLevel = slog.LevelWarn
	case "error":
		c.LogLevel = slog.LevelError
	default:
		l.fail("LOG_LEVEL", "must be debug, info, warn or error")
	}
	c.Version = l.str("BUILD_VERSION", "dev")

	if len(l.errs) > 0 {
		sort.Strings(l.errs)
		return Config{}, errors.New("invalid configuration: " + strings.Join(l.errs, "; "))
	}
	return c, nil
}

func hasErr(errs []string, name string) bool {
	for _, e := range errs {
		if strings.HasPrefix(e, name+":") {
			return true
		}
	}
	return false
}

// IsUUID reports whether s is a lower- or upper-case 8-4-4-4-12 hex UUID.
func IsUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i := 0; i < len(s); i++ {
		switch i {
		case 8, 13, 18, 23:
			if s[i] != '-' {
				return false
			}
		default:
			c := s[i]
			isHex := (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
			if !isHex {
				return false
			}
		}
	}
	return true
}
