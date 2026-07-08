// Package dlp is the pattern/Luhn DLP scrubber — a Go port of ai-gateway/src/scrub.ts
// (itself a verbatim mirror of wa-chat-bot/src/scrub.ts). Keep ScrubRulesetVersion in sync
// across all three copies. This port covers the day-one categories that server.ts actually
// invokes (dlp(prompt) is called with no options); the TS file's opt-in PHONE/EMAIL
// categories (ScrubOptions{phone, email}) are not exercised by the gateway and are not
// ported here — see the task report for the fidelity note.
package dlp

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// ScrubRulesetVersion mirrors SCRUB_RULESET_VERSION in the TS copies. Bump in lockstep.
const ScrubRulesetVersion = 2

// Redaction records the type of PII that was found and replaced.
type Redaction struct {
	Type string
}

// ScrubResult is the cleaned text plus a record of what was redacted.
type ScrubResult struct {
	Clean      string
	Redactions []Redaction
}

// luhnValid mirrors scrub.ts's luhnValid: standard mod-10 check over a digit string.
func luhnValid(digits string) bool {
	if len(digits) < 13 {
		return false
	}
	sum := 0
	alt := false
	for i := len(digits) - 1; i >= 0; i-- {
		d, err := strconv.Atoi(string(digits[i]))
		if err != nil {
			return false
		}
		if alt {
			d *= 2
			if d > 9 {
				d -= 9
			}
		}
		sum += d
		alt = !alt
	}
	return sum%10 == 0
}

// looksLikeNik mirrors scrub.ts's looksLikeNik: Indonesian NIK province-code range check
// (11-96) plus a DDMMYY birth-date sanity check (females encode DD+40).
func looksLikeNik(d string) bool {
	if len(d) != 16 {
		return false
	}
	prov, err := strconv.Atoi(d[0:2])
	if err != nil || prov < 11 || prov > 96 {
		return false
	}
	day, err := strconv.Atoi(d[6:8])
	if err != nil {
		return false
	}
	if day > 40 {
		day -= 40 // females: DD + 40
	}
	month, err := strconv.Atoi(d[8:10])
	if err != nil {
		return false
	}
	return day >= 1 && day <= 31 && month >= 1 && month <= 12
}

// All patterns below use only RE2-supported constructs (character classes, \b word
// boundaries, alternation, bounded quantifiers, inline case-insensitivity). The TS
// originals use none of the JS-only regex features (lookahead/lookbehind, backreferences),
// so no RE2 workaround was needed — verified pattern-by-pattern against scrub.ts.
var (
	// 1) PAN: 13-19 digit runs (spaces/dashes allowed) that pass Luhn.
	panRe = regexp.MustCompile(`\b\d(?:[ -]?\d){12,18}\b`)

	// 2) NPWP (Indonesian tax id): 99.999.999.9-999.999, or 15 bare digits when labelled.
	npwpFmt  = regexp.MustCompile(`\b\d{2}\.\d{3}\.\d{3}\.\d-\d{3}\.\d{3}\b`)
	npwpBare = regexp.MustCompile(`(?i)\bNPWP\b\D{0,10}(\d{15})\b`)

	// 3) KTP/NIK: labelled 16-digit, OR unlabelled 16-digit that validates as a real NIK.
	nikLbl = regexp.MustCompile(`(?i)\b(NIK|KTP)\b\D{0,12}(\d{16})\b`)
	nik16  = regexp.MustCompile(`\b\d{16}\b`)

	// 4) Bank account: only when labelled (rek/rekening/account/acct/a.n + digit run).
	bankAcct = regexp.MustCompile(`(?i)\b(rek(?:ening)?|acc(?:ount|t)?|a[./]?n)\b\s*[:.]?\s*(\d[\d -]{6,18}\d)`)

	// 5) Passport: 1-2 uppercase letters + 6-8 digits.
	passport = regexp.MustCompile(`\b[A-Z]{1,2}\d{6,8}\b`)
)

// Scrub redacts PII from input in the same order as scrub.ts. Order matters: earlier
// redactions replace substrings with sentinel tokens ("[REDACTED-...]") before later
// patterns scan the text, which is how the original avoids double-counting/overlapping
// matches (e.g. a PAN redacted first can no longer be mistaken for a bare NPWP/NIK digit
// run downstream).
func Scrub(input string) ScrubResult {
	var redactions []Redaction
	text := input

	// 1) PAN
	text = panRe.ReplaceAllStringFunc(text, func(match string) string {
		digits := strings.NewReplacer(" ", "", "-", "").Replace(match)
		if len(digits) >= 13 && len(digits) <= 19 && luhnValid(digits) {
			redactions = append(redactions, Redaction{Type: "PAN"})
			return "[REDACTED-CARD]"
		}
		return match
	})

	// 2) NPWP — formatted, then labelled-bare.
	text = npwpFmt.ReplaceAllStringFunc(text, func(string) string {
		redactions = append(redactions, Redaction{Type: "NPWP"})
		return "[REDACTED-ID]"
	})
	text = npwpBare.ReplaceAllStringFunc(text, func(string) string {
		redactions = append(redactions, Redaction{Type: "NPWP"})
		return "NPWP [REDACTED-ID]"
	})

	// 3) KTP/NIK — labelled, then unlabelled-but-validated.
	text = nikLbl.ReplaceAllStringFunc(text, func(match string) string {
		redactions = append(redactions, Redaction{Type: "KTP"})
		sub := nikLbl.FindStringSubmatch(match)
		return sub[1] + " [REDACTED-ID]"
	})
	text = nik16.ReplaceAllStringFunc(text, func(match string) string {
		if looksLikeNik(match) {
			redactions = append(redactions, Redaction{Type: "KTP"})
			return "[REDACTED-ID]"
		}
		return match
	})

	// 4) Bank account — only when labelled.
	text = bankAcct.ReplaceAllStringFunc(text, func(match string) string {
		redactions = append(redactions, Redaction{Type: "BANK_ACCT"})
		sub := bankAcct.FindStringSubmatch(match)
		return sub[1] + " [REDACTED-ACCT]"
	})

	// 5) Passport.
	text = passport.ReplaceAllStringFunc(text, func(string) string {
		redactions = append(redactions, Redaction{Type: "PASSPORT"})
		return "[REDACTED-ID]"
	})

	return ScrubResult{Clean: text, Redactions: redactions}
}

// DLP is the fail-closed wrapper (port of scrub.ts's dlp()): any internal scrubber panic
// is recovered into an error rather than ever passing raw input through.
func DLP(input string) (result ScrubResult, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("DLP unavailable — egress blocked (fail-closed): %v", r)
		}
	}()
	return Scrub(input), nil
}
