package consent

import (
	"regexp"
	"strings"

	"gaiada/insights-collector/internal/store"
)

var (
	botUA    = regexp.MustCompile(`bot|crawl|spider|slurp|headless|lighthouse|python-requests|curl/|wget/|facebookexternalhit|preview`)
	tabletUA = regexp.MustCompile(`ipad|tablet|kindle|silk/|playbook`)
	mobileUA = regexp.MustCompile(`mobi|iphone|ipod|android|windows phone|blackberry|opera mini`)
)

// deviceClass is WebDesk's classifyUserAgent (webdesk/api/src/consent/consent-body.ts) ported to Go, so the
// two systems bucket a user agent identically. It returns "bot" in addition to the stored classes; the caller
// drops a bot instead of storing it. The UA itself is never kept: only this bucket leaves the request.
//
// JavaScript's /(android(?!.*mobile))/ has no RE2 equivalent, so it is written out: some "android" with no
// "mobile" anywhere after it is a tablet.
func deviceClass(userAgent string) string {
	if strings.TrimSpace(userAgent) == "" {
		return store.DeviceUnknown
	}
	ua := strings.ToLower(userAgent)
	if botUA.MatchString(ua) {
		return "bot"
	}
	if tabletUA.MatchString(ua) || androidWithoutMobile(ua) {
		return store.DeviceTablet
	}
	if mobileUA.MatchString(ua) {
		return store.DeviceMobile
	}
	return store.DeviceDesktop
}

func androidWithoutMobile(ua string) bool {
	i := strings.LastIndex(ua, "android")
	return i >= 0 && !strings.Contains(ua[i+len("android"):], "mobile")
}
