package bot

import (
	"strings"
	"testing"

	"gaiada/insights-collector/data"
)

func newDetector(t *testing.T) *Detector {
	t.Helper()
	d, err := New(data.IsbotPatterns, data.DatacenterASNs)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

const chrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"

func TestRealBrowsersAreNotBots(t *testing.T) {
	d := newDetector(t)
	for _, ua := range []string{
		chrome,
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
		"Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
		"Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
		"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
	} {
		if v := d.Check(ua, 64500); v.Bot {
			t.Errorf("real browser flagged as bot (%s): %s", v.Reason, ua)
		}
	}
}

func TestUserAgentBotsAreCaught(t *testing.T) {
	d := newDetector(t)
	for _, ua := range []string{
		"Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
		"curl/8.5.0",
		"python-requests/2.31.0",
		"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/126.0.0.0 Safari/537.36",
		"Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
		"Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)",
		"Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/119.0 Safari/537.36 Chrome-Lighthouse",
	} {
		v := d.Check(ua, 64500)
		if !v.Bot || v.Reason != ReasonUA {
			t.Errorf("expected a UA bot: %s -> %+v", ua, v)
		}
	}
}

func TestEmptyOrAbsurdUserAgentIsABot(t *testing.T) {
	d := newDetector(t)
	for _, ua := range []string{"", "   ", strings.Repeat("a", 2000)} {
		if v := d.Check(ua, 0); !v.Bot || v.Reason != ReasonUA {
			t.Errorf("ua len %d: %+v", len(ua), v)
		}
	}
}

func TestListedASNIsABotWithReasonASN(t *testing.T) {
	d := newDetector(t)
	if v := d.Check(chrome, 16509); !v.Bot || v.Reason != ReasonASN {
		t.Errorf("AWS ASN: %+v", v)
	}
	if v := d.Check(chrome, 0); v.Bot {
		t.Errorf("unknown ASN must not be a bot: %+v", v)
	}
	if v := d.Check(chrome, 64500); v.Bot {
		t.Errorf("unlisted ASN must not be a bot: %+v", v)
	}
	// A UA bot on a listed ASN is reported as the UA (the first signal).
	if v := d.Check("curl/8.5.0", 16509); v.Reason != ReasonUA {
		t.Errorf("UA wins: %+v", v)
	}
}

func TestVendoredDataFilesParse(t *testing.T) {
	asns, err := ParseASNList(data.DatacenterASNs)
	if err != nil {
		t.Fatal(err)
	}
	if len(asns) < 10 {
		t.Errorf("datacenter list suspiciously short: %d", len(asns))
	}
	// Corporate-gateway / relay / transit ASNs stay OUT (design section 9 trap 1): real visitors egress there.
	for _, forbidden := range []uint32{13335 /* Cloudflare (WARP) */, 22616 /* Zscaler */, 714 /* Apple */, 3356 /* Lumen */} {
		if _, bad := asns[forbidden]; bad {
			t.Errorf("AS%d must not be on the datacenter list", forbidden)
		}
	}
}

func TestParseASNListRejectsGarbage(t *testing.T) {
	for _, bad := range []string{"abc", "0", "-5", "99999999999", "16509 16510"} {
		if _, err := ParseASNList(bad); err == nil {
			t.Errorf("%q must be rejected", bad)
		}
	}
	m, err := ParseASNList("# c\n\n  64500   # x\r\n64501\n")
	if err != nil || len(m) != 2 {
		t.Errorf("comments, blanks, CRLF: %v %v", m, err)
	}
}

func TestNewRejectsBadLists(t *testing.T) {
	if _, err := New([]byte("not json"), ""); err == nil {
		t.Error("bad json must fail")
	}
	if _, err := New([]byte("[]"), ""); err == nil {
		t.Error("empty pattern list must fail")
	}
	if _, err := New([]byte(`["("]`), ""); err == nil {
		t.Error("a pattern that does not compile must fail")
	}
}
