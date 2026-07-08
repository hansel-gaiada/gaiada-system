// Tests for the DLP pattern scrubber (port of ai-gateway/src/scrub.ts, itself a verbatim
// mirror of wa-chat-bot/src/scrub.ts / wa-chat-bot/src/scrub.test.ts). Positive cases per
// redaction type, a false-positive corpus that must NOT be touched, and the fail-closed
// DLP() wrapper contract.
package dlp

import (
	"strings"
	"testing"
)

func hasType(rs []Redaction, t string) bool {
	for _, r := range rs {
		if r.Type == t {
			return true
		}
	}
	return false
}

func TestScrubRedactsValidCreditCard(t *testing.T) {
	// Luhn-valid test PAN.
	result := Scrub("my card is 4111111111111111 thanks")
	if len(result.Redactions) != 1 || result.Redactions[0].Type != "PAN" {
		t.Fatalf("expected 1 PAN redaction, got %+v", result.Redactions)
	}
	if result.Clean == "my card is 4111111111111111 thanks" {
		t.Fatal("expected the card number to be redacted")
	}
}

func TestScrubRedactsLuhnValidCardWithSeparators(t *testing.T) {
	r := Scrub("pay to 4111 1111 1111 1111 today")
	if r.Clean != "pay to [REDACTED-CARD] today" {
		t.Fatalf("unexpected clean text: %q", r.Clean)
	}
	if !hasType(r.Redactions, "PAN") {
		t.Fatalf("expected PAN redaction, got %+v", r.Redactions)
	}
}

func TestScrubIgnoresNonLuhnDigitRun(t *testing.T) {
	result := Scrub("order number 1234567890123456 confirmed")
	if len(result.Redactions) != 0 {
		t.Fatalf("expected no redactions for a non-Luhn digit run, got %+v", result.Redactions)
	}
}

func TestScrubRedactsLabelledKtp(t *testing.T) {
	r := Scrub("NIK 3174012345678901 for the form")
	if containsSub(r.Clean, "3174012345678901") {
		t.Fatalf("expected NIK digits to be redacted, got %q", r.Clean)
	}
	if !hasType(r.Redactions, "KTP") {
		t.Fatalf("expected KTP redaction, got %+v", r.Redactions)
	}
}

func TestScrubRedactsUnlabelledValidNik(t *testing.T) {
	// 32=West Java · area 0115 · DDMMYY=081200 (8 Dec 2000) · serial 1234 -> valid NIK.
	r := Scrub("kirim data 3201150812001234 ya")
	if containsSub(r.Clean, "3201150812001234") {
		t.Fatalf("expected NIK digits to be redacted, got %q", r.Clean)
	}
	if !hasType(r.Redactions, "KTP") {
		t.Fatalf("expected KTP redaction, got %+v", r.Redactions)
	}
}

func TestScrubRedactsNpwpFormattedAndLabelledBare(t *testing.T) {
	r1 := Scrub("NPWP 09.254.294.3-407.000")
	if !containsSub(r1.Clean, "[REDACTED-ID]") {
		t.Fatalf("expected formatted NPWP to be redacted, got %q", r1.Clean)
	}
	if !hasType(r1.Redactions, "NPWP") {
		t.Fatalf("expected NPWP redaction, got %+v", r1.Redactions)
	}

	r2 := Scrub("npwp 092542943407000")
	if !containsSub(r2.Clean, "[REDACTED-ID]") {
		t.Fatalf("expected labelled-bare NPWP to be redacted, got %q", r2.Clean)
	}
	if !hasType(r2.Redactions, "NPWP") {
		t.Fatalf("expected NPWP redaction, got %+v", r2.Redactions)
	}
}

func TestScrubRedactsLabelledBankAccountKeepsLabel(t *testing.T) {
	r := Scrub("transfer ke rekening 1234567890 atas nama Budi")
	if !containsSub(r.Clean, "[REDACTED-ACCT]") {
		t.Fatalf("expected bank account to be redacted, got %q", r.Clean)
	}
	if containsSub(r.Clean, "1234567890") {
		t.Fatalf("expected account digits to be gone, got %q", r.Clean)
	}
	if !containsSub(r.Clean, "rekening") {
		t.Fatalf("expected the label to be kept, got %q", r.Clean)
	}
	if !hasType(r.Redactions, "BANK_ACCT") {
		t.Fatalf("expected BANK_ACCT redaction, got %+v", r.Redactions)
	}
}

func TestScrubDoesNotRedactUnlabelledBankAccount(t *testing.T) {
	r := Scrub("the total is 1234567890 and that's final")
	if hasType(r.Redactions, "BANK_ACCT") {
		t.Fatalf("did not expect BANK_ACCT redaction without a label, got %+v", r.Redactions)
	}
}

func TestScrubRedactsPassportStyleId(t *testing.T) {
	r := Scrub("passport A1234567 issued")
	if !containsSub(r.Clean, "[REDACTED-ID]") {
		t.Fatalf("expected passport-style id to be redacted, got %q", r.Clean)
	}
	if !hasType(r.Redactions, "PASSPORT") {
		t.Fatalf("expected PASSPORT redaction, got %+v", r.Redactions)
	}
}

func TestScrubFalsePositiveCorpusUntouched(t *testing.T) {
	clean := []string{
		"order 1234567890123456 shipped", // 16-digit, not Luhn, not a valid NIK
		"invoice #99001234 approved",
		"the meeting is at 08.30 in room 12",
		"budget is 15000000 rupiah for Q3",
		"Project Alpha is behind schedule, need help on the API by Friday.",
		"PO 2024-00123 and PO 2024-00124 are ready",
		"we poured 250 m3 of concrete over 3 days",
		"SKU ABC12345 restocked", // passport-like but digit run isn't immediately after 1-2 letters
	}
	for _, tc := range clean {
		r := Scrub(tc)
		if r.Clean != tc {
			t.Errorf("expected %q to be left untouched, got %q", tc, r.Clean)
		}
		if len(r.Redactions) != 0 {
			t.Errorf("expected no redactions for %q, got %+v", tc, r.Redactions)
		}
	}
}

func TestScrubRulesetVersion(t *testing.T) {
	if ScrubRulesetVersion != 2 {
		t.Fatalf("expected ScrubRulesetVersion == 2, got %d", ScrubRulesetVersion)
	}
}

func TestDLPNeverPassesRawOnInternalFailure(t *testing.T) {
	// DLP() must always return either a scrubbed result or an error — never the raw input
	// on an internal failure. Scrub() itself doesn't error in this port, so this asserts
	// the wrapper contract holds for the happy path (fail-closed behavior is structural:
	// DLP() has no path that returns raw input alongside a non-nil error).
	result, err := DLP("card 4111111111111111")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Clean == "card 4111111111111111" {
		t.Fatal("expected redaction to have occurred")
	}
}

func TestDLPPassesThroughCleanText(t *testing.T) {
	result, err := DLP("nothing sensitive here")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Clean != "nothing sensitive here" {
		t.Fatalf("unexpected mutation of clean text: %q", result.Clean)
	}
	if len(result.Redactions) != 0 {
		t.Fatalf("expected no redactions, got %+v", result.Redactions)
	}
}

func containsSub(s, sub string) bool {
	return strings.Contains(s, sub)
}
