package config

import (
	"strings"
	"testing"
	"time"
)

const (
	site1   = "11111111-2222-3333-4444-555555555555"
	keyHash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	// forgetHash differs from keyHash: the read key must not be able to forget.
	forgetHash = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
)

// baseEnv is the smallest valid environment: only the variables that have no safe default.
func baseEnv() map[string]string {
	return map[string]string{
		"COLLECT_API_ENDPOINT":  "/lib/kestrel/e",
		"INSIGHTS_WEBSITES":     site1,
		"DATABASE_URL":          "postgres://collector:s3cret-pw@vdb:5432/vdb",
		"OPS_READ_KEY_SHA256":   keyHash,
		"OPS_FORGET_KEY_SHA256": forgetHash,
	}
}

func load(env map[string]string) (Config, error) {
	return Load(func(k string) string { return env[k] })
}

func TestDefaultsWhenOptionalEnvIsEmptyOrBlank(t *testing.T) {
	// Every optional variable is present but EMPTY or blank: each must take its default, never 0.
	env := baseEnv()
	for _, k := range []string{
		"LISTEN_ADDR", "OPS_ADDR", "UMAMI_URL", "UMAMI_TIMEOUT_MS", "MAX_BODY_BYTES", "GEO_DIR", "GEO_CITY_FILE",
		"GEO_ASN_FILE", "GEO_REQUIRED", "FORWARD_IP_MODE", "COMPANY_RESOLVER", "BOT_FLUSH_SECONDS", "LOG_LEVEL", "BUILD_VERSION",
	} {
		env[k] = ""
	}
	env["UMAMI_TIMEOUT_MS"] = "   " // blank behaves like empty
	c, err := load(env)
	if err != nil {
		t.Fatalf("empty optional env must load: %v", err)
	}
	if c.PublicAddr != ":8080" || c.OpsAddr != ":8081" {
		t.Errorf("addr defaults wrong: %q %q", c.PublicAddr, c.OpsAddr)
	}
	if c.UmamiTimeout != 3*time.Second {
		t.Errorf("UMAMI_TIMEOUT_MS empty must default to 3s, got %v", c.UmamiTimeout)
	}
	if c.MaxBodyBytes != 32*1024 {
		t.Errorf("MAX_BODY_BYTES empty must default to 32 KB, got %d", c.MaxBodyBytes)
	}
	if c.BotFlushInterval != 30*time.Second {
		t.Errorf("BOT_FLUSH_SECONDS empty must default to 30s, got %v", c.BotFlushInterval)
	}
	if c.UmamiURL != "http://app:3000" || c.GeoDir != "/geo" || c.CityFile != "dbip-city-lite.mmdb" || c.ASNFile != "dbip-asn-lite.mmdb" {
		t.Errorf("string defaults wrong: %+v", c)
	}
	if c.IPMode != IPModePseudonym {
		t.Errorf("FORWARD_IP_MODE empty must be pseudonym, got %q", c.IPMode)
	}
	if c.CompanyResolver != "network-only" {
		t.Errorf("COMPANY_RESOLVER empty must select network-only, got %q", c.CompanyResolver)
	}
	if c.GeoRequired {
		t.Errorf("GEO_REQUIRED empty must be off")
	}
	if c.CollectPath != "/lib/kestrel/e" {
		t.Errorf("collect path: %q", c.CollectPath)
	}
	if _, ok := c.Websites[site1]; !ok || len(c.Websites) != 1 {
		t.Errorf("websites: %v", c.Websites)
	}
}

func TestExplicitZeroRefusesToStartAndNamesTheVariable(t *testing.T) {
	for _, name := range []string{"UMAMI_TIMEOUT_MS", "MAX_BODY_BYTES", "BOT_FLUSH_SECONDS"} {
		t.Run(name, func(t *testing.T) {
			env := baseEnv()
			env[name] = "0"
			_, err := load(env)
			if err == nil {
				t.Fatalf("%s=0 must refuse to start", name)
			}
			if !strings.Contains(err.Error(), name) {
				t.Errorf("error must name %s: %v", name, err)
			}
		})
	}
}

func TestOutOfRangeAndGarbageRefuse(t *testing.T) {
	cases := map[string]string{
		"UMAMI_TIMEOUT_MS":  "50",
		"MAX_BODY_BYTES":    "-5",
		"BOT_FLUSH_SECONDS": "99999",
		"LISTEN_ADDR":       "8080", // no colon
		"OPS_ADDR":          ":0",
		"UMAMI_URL":         "http://app:3000/api",
		"FORWARD_IP_MODE":   "off",
		"LOG_LEVEL":         "loud",
		"GEO_CITY_FILE":     "../etc/passwd",
	}
	for name, val := range cases {
		env := baseEnv()
		env[name] = val
		_, err := load(env)
		if err == nil {
			t.Errorf("%s=%q must refuse to start", name, val)
			continue
		}
		if !strings.Contains(err.Error(), name) {
			t.Errorf("%s=%q: error must name the variable: %v", name, val, err)
		}
	}
	env := baseEnv()
	env["UMAMI_TIMEOUT_MS"] = "abc"
	if _, err := load(env); err == nil || !strings.Contains(err.Error(), "UMAMI_TIMEOUT_MS") {
		t.Errorf("non-numeric must refuse and name the variable: %v", err)
	}
}

func TestRequiredVariablesRefuseWhenEmpty(t *testing.T) {
	for _, name := range []string{"COLLECT_API_ENDPOINT", "INSIGHTS_WEBSITES", "DATABASE_URL", "OPS_READ_KEY_SHA256"} {
		env := baseEnv()
		env[name] = ""
		_, err := load(env)
		if err == nil || !strings.Contains(err.Error(), name) {
			t.Errorf("%s empty must refuse to start and name itself: %v", name, err)
		}
	}
}

func TestPortsMustDiffer(t *testing.T) {
	env := baseEnv()
	env["LISTEN_ADDR"] = ":9000"
	env["OPS_ADDR"] = ":9000"
	if _, err := load(env); err == nil {
		t.Fatal("same port for both listeners must refuse")
	}
}

func TestSwitchIsOnOnlyForExactlyOne(t *testing.T) {
	for val, want := range map[string]bool{"1": true, "true": false, "yes": false, "0": false, "": false, " 1": false, "11": false} {
		env := baseEnv()
		env["GEO_REQUIRED"] = val
		c, err := load(env)
		if err != nil {
			t.Fatalf("GEO_REQUIRED=%q: %v", val, err)
		}
		if c.GeoRequired != want {
			t.Errorf("GEO_REQUIRED=%q: got %v want %v", val, c.GeoRequired, want)
		}
	}
}

func TestWebsiteListAndKeyValidation(t *testing.T) {
	env := baseEnv()
	env["INSIGHTS_WEBSITES"] = site1 + ", AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE ,"
	c, err := load(env)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := c.Websites["aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"]; !ok || len(c.Websites) != 2 {
		t.Errorf("websites not normalised: %v", c.Websites)
	}
	env["INSIGHTS_WEBSITES"] = "not-a-uuid"
	if _, err := load(env); err == nil {
		t.Error("a non-UUID website must refuse")
	}
	env = baseEnv()
	env["INSIGHTS_WEBSITES"] = " , "
	if _, err := load(env); err == nil {
		t.Error("a list with no website must refuse (it cannot silently admit or block everything)")
	}
	env = baseEnv()
	env["OPS_READ_KEY_SHA256"] = "abc"
	if _, err := load(env); err == nil {
		t.Error("a short key hash must refuse")
	}
}

func TestCollectPathRules(t *testing.T) {
	for _, bad := range []string{"lib/kestrel/e", "/a?b=1", "/a b", "/ops/v1/bots", "/healthz"} {
		env := baseEnv()
		env["COLLECT_API_ENDPOINT"] = bad
		if _, err := load(env); err == nil {
			t.Errorf("COLLECT_API_ENDPOINT=%q must refuse", bad)
		}
	}
}

func TestErrorNeverEchoesSecrets(t *testing.T) {
	env := baseEnv()
	env["UMAMI_TIMEOUT_MS"] = "0" // force an error while the password-bearing URL is set
	_, err := load(env)
	if err == nil {
		t.Fatal("expected an error")
	}
	if strings.Contains(err.Error(), "s3cret-pw") {
		t.Fatalf("config error leaked DATABASE_URL: %v", err)
	}
}

func TestConsentedChannelDefaultsWhenEmpty(t *testing.T) {
	env := baseEnv()
	for _, k := range []string{"CONSENT_EVENT_NAMES", "CONSENT_RATE_PER_SECOND", "BUFFER_RETENTION_HOURS", "PURGE_INTERVAL_MINUTES"} {
		env[k] = "  "
	}
	c, err := load(env)
	if err != nil {
		t.Fatal(err)
	}
	if c.BufferRetention != 72*time.Hour || c.PurgeInterval != 15*time.Minute || c.ConsentRatePerSec != 100 {
		t.Errorf("defaults: %v %v %d", c.BufferRetention, c.PurgeInterval, c.ConsentRatePerSec)
	}
	if _, ok := c.ConsentEventNames["cta_click"]; !ok || len(c.ConsentEventNames) != 10 {
		t.Errorf("event names: %v", c.ConsentEventNames)
	}
}

func TestConsentedChannelExplicitZeroAndOutOfRangeRefuse(t *testing.T) {
	for name, vals := range map[string][]string{
		"CONSENT_RATE_PER_SECOND": {"0", "-1", "10001", "x"},
		"BUFFER_RETENTION_HOURS":  {"0", "73", "-5", "x"}, // 72 h is a promise in the notice: never lengthened
		"PURGE_INTERVAL_MINUTES":  {"0", "1441", "x"},
	} {
		for _, v := range vals {
			env := baseEnv()
			env[name] = v
			_, err := load(env)
			if err == nil || !strings.Contains(err.Error(), name) {
				t.Errorf("%s=%q must refuse and name the variable: %v", name, v, err)
			}
		}
	}
	env := baseEnv()
	env["BUFFER_RETENTION_HOURS"] = "24"
	if c, err := load(env); err != nil || c.BufferRetention != 24*time.Hour {
		t.Errorf("a shorter retention is allowed: %v %v", c.BufferRetention, err)
	}
}

func TestForgetKeyIsRequiredSeparateAndValidated(t *testing.T) {
	env := baseEnv()
	env["OPS_FORGET_KEY_SHA256"] = ""
	if _, err := load(env); err == nil || !strings.Contains(err.Error(), "OPS_FORGET_KEY_SHA256") {
		t.Errorf("empty forget key must refuse: %v", err)
	}
	env["OPS_FORGET_KEY_SHA256"] = "abc"
	if _, err := load(env); err == nil {
		t.Error("a short forget key hash must refuse")
	}
	env["OPS_FORGET_KEY_SHA256"] = keyHash // same as the read key: the separation would be void
	if _, err := load(env); err == nil || !strings.Contains(err.Error(), "must differ") {
		t.Errorf("forget key equal to the read key must refuse: %v", err)
	}
	c, err := load(baseEnv())
	if err != nil || c.OpsForgetKeySHA256 == c.OpsReadKeySHA256 || c.OpsForgetKeySHA256 == [32]byte{} {
		t.Errorf("distinct hashes expected: %v", err)
	}
}

func TestConsentEventNamesAndPathCollisions(t *testing.T) {
	for _, bad := range []string{"Cta_Click", "1abc", "a-b", "a b", strings.Repeat("a", 51), " , "} {
		env := baseEnv()
		env["CONSENT_EVENT_NAMES"] = bad
		if _, err := load(env); err == nil {
			t.Errorf("CONSENT_EVENT_NAMES=%q must refuse", bad)
		}
	}
	env := baseEnv()
	env["CONSENT_EVENT_NAMES"] = "cta_click, section_view,"
	if c, err := load(env); err != nil || len(c.ConsentEventNames) != 2 {
		t.Errorf("%v %v", c.ConsentEventNames, err)
	}
	for _, p := range []string{ConsentPath, ForgetPath, ReplayPath} {
		env := baseEnv()
		env["COLLECT_API_ENDPOINT"] = p
		if _, err := load(env); err == nil {
			t.Errorf("COLLECT_API_ENDPOINT=%q collides with the consented channel and must refuse", p)
		}
	}
}

// V6-a: REPLAY_ENABLED is on only for exactly "1"; empty (and every near miss) is off.
func TestReplayEnabledIsOnOnlyForExactlyOne(t *testing.T) {
	for val, want := range map[string]bool{"1": true, "": false, "  ": false, "0": false, "true": false, "yes": false, "11": false, " 1": false, "on": false} {
		env := baseEnv()
		env["REPLAY_ENABLED"] = val
		c, err := load(env)
		if err != nil {
			t.Fatalf("REPLAY_ENABLED=%q: %v", val, err)
		}
		if c.ReplayEnabled != want {
			t.Errorf("REPLAY_ENABLED=%q: got %v want %v", val, c.ReplayEnabled, want)
		}
	}
	c, err := load(baseEnv()) // absent
	if err != nil || c.ReplayEnabled {
		t.Errorf("absent REPLAY_ENABLED must be off: %v %v", c.ReplayEnabled, err)
	}
}

func TestReplayDefaultsWhenEmptyOrBlank(t *testing.T) {
	env := baseEnv()
	for _, k := range []string{"REPLAY_ENABLED", "REPLAY_BUDGET_MB", "REPLAY_RETENTION_DAYS", "REPLAY_SITE_DAILY_RECORDINGS", "REPLAY_VISITOR_DAILY_RECORDINGS"} {
		env[k] = ""
	}
	env["REPLAY_BUDGET_MB"] = "   "
	c, err := load(env)
	if err != nil {
		t.Fatalf("empty replay env must load: %v", err)
	}
	if c.ReplayEnabled || c.ReplayBudgetBytes != 2048<<20 || c.ReplayRetention != 30*24*time.Hour ||
		c.ReplaySiteDailyMax != 500 || c.ReplayVisitorDailyMax != 10 {
		t.Errorf("defaults: %+v", c)
	}
}

func TestReplayExplicitZeroAndOutOfRangeRefuseAndNameTheVariable(t *testing.T) {
	for name, vals := range map[string][]string{
		"REPLAY_BUDGET_MB":                {"0", "-1", "1048577", "x", "1.5"},
		"REPLAY_RETENTION_DAYS":           {"0", "31", "-3", "x"}, // 30 days is a promise in the notice: never lengthened
		"REPLAY_SITE_DAILY_RECORDINGS":    {"0", "100001", "x"},
		"REPLAY_VISITOR_DAILY_RECORDINGS": {"0", "1001", "x"},
	} {
		for _, v := range vals {
			env := baseEnv()
			env[name] = v
			_, err := load(env)
			if err == nil || !strings.Contains(err.Error(), name) {
				t.Errorf("%s=%q must refuse and name the variable: %v", name, v, err)
			}
		}
	}
	env := baseEnv()
	env["REPLAY_BUDGET_MB"] = "512"
	env["REPLAY_RETENTION_DAYS"] = "7"
	env["REPLAY_SITE_DAILY_RECORDINGS"] = "50"
	env["REPLAY_VISITOR_DAILY_RECORDINGS"] = "3"
	c, err := load(env)
	if err != nil || c.ReplayBudgetBytes != 512<<20 || c.ReplayRetention != 7*24*time.Hour || c.ReplaySiteDailyMax != 50 || c.ReplayVisitorDailyMax != 3 {
		t.Errorf("explicit values: %+v %v", c, err)
	}
	// An error message never echoes a value.
	env["REPLAY_BUDGET_MB"] = "secret-looking-value"
	if _, err := load(env); err == nil || strings.Contains(err.Error(), "secret-looking-value") {
		t.Errorf("the error must name the variable and not its value: %v", err)
	}
}
