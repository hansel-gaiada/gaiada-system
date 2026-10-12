package config

import (
	"strings"
	"testing"
	"time"
)

const (
	site1   = "11111111-2222-3333-4444-555555555555"
	keyHash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
)

// baseEnv is the smallest valid environment: only the variables that have no safe default.
func baseEnv() map[string]string {
	return map[string]string{
		"COLLECT_API_ENDPOINT": "/lib/kestrel/e",
		"INSIGHTS_WEBSITES":    site1,
		"DATABASE_URL":         "postgres://collector:s3cret-pw@vdb:5432/vdb",
		"OPS_READ_KEY_SHA256":  keyHash,
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
