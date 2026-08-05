// Tests for the boundary-buffered streaming response scrubber (ASST-04).
//
// The threat model these tests exist for is a SILENT leak: a PAN or NIK split across two
// provider token boundaries matches nothing in either fragment, so a naive per-token scrubber
// passes it straight to the client while every happy-path assertion stays green. Several tests
// below therefore assert BOTH that the buffered scrubber redacts the split PII AND that a naive
// per-token scrubber demonstrably does not — a security test that cannot fail proves nothing.
package dlp

import (
	"math/rand"
	"strings"
	"testing"
)

// ── helpers ─────────────────────────────────────────────────────────────────────────────────

// streamAll feeds chunks through a StreamScrubber and returns the concatenated sink output
// plus the scrubber (for buffer/redaction assertions).
func streamAll(t *testing.T, chunks []string) (string, *StreamScrubber) {
	t.Helper()
	var out strings.Builder
	s := NewStreamScrubber(func(tok string) { out.WriteString(tok) })
	for _, c := range chunks {
		s.Write(c)
	}
	if err := s.Close(); err != nil {
		t.Fatalf("Close returned an error: %v", err)
	}
	return out.String(), s
}

// naivePerTokenScrub is the WRONG implementation — the one this ticket exists to rule out. It
// is kept in the test file on purpose: every split-PII test asserts that this leaks, which is
// what proves the test is discriminating rather than vacuous.
func naivePerTokenScrub(chunks []string) string {
	var out strings.Builder
	for _, c := range chunks {
		out.WriteString(Scrub(c).Clean)
	}
	return out.String()
}

// splitEvery cuts s into n-byte chunks.
func splitEvery(s string, n int) []string {
	var out []string
	for i := 0; i < len(s); i += n {
		end := i + n
		if end > len(s) {
			end = len(s)
		}
		out = append(out, s[i:end])
	}
	return out
}

// luhnCheckDigit returns the digit that makes base+digit Luhn-valid.
func luhnCheckDigit(t *testing.T, base string) string {
	t.Helper()
	for d := '0'; d <= '9'; d++ {
		if luhnValid(base + string(d)) {
			return string(d)
		}
	}
	t.Fatalf("no Luhn check digit exists for %q", base)
	return ""
}

// ── 1. the buffer size is derived from the patterns, and stays derived ───────────────────────

// If scrub.go's patterns change, MaxDetectableSpan's derivation (see stream.go's package
// comment) is invalidated and a silently-too-small buffer becomes a leak. This canary pins
// every pattern's source text so that editing scrub.go breaks the build's tests loudly instead.
func TestScrubPatternsUnchangedCanary(t *testing.T) {
	want := map[string]string{
		"panRe":    `\b\d(?:[ -]?\d){12,18}\b`,
		"npwpFmt":  `\b\d{2}\.\d{3}\.\d{3}\.\d-\d{3}\.\d{3}\b`,
		"npwpBare": `(?i)\bNPWP\b\D{0,10}(\d{15})\b`,
		"nikLbl":   `(?i)\b(NIK|KTP)\b\D{0,12}(\d{16})\b`,
		"nik16":    `\b\d{16}\b`,
		"bankAcct": `(?i)\b(rek(?:ening)?|acc(?:ount|t)?|a[./]?n)\b\s*[:.]?\s*(\d[\d -]{6,18}\d)`,
		"passport": `\b[A-Z]{1,2}\d{6,8}\b`,
	}
	got := map[string]string{
		"panRe":    panRe.String(),
		"npwpFmt":  npwpFmt.String(),
		"npwpBare": npwpBare.String(),
		"nikLbl":   nikLbl.String(),
		"nik16":    nik16.String(),
		"bankAcct": bankAcct.String(),
		"passport": passport.String(),
	}
	for name, w := range want {
		if got[name] != w {
			t.Fatalf("pattern %s changed:\n  was  %s\n  now  %s\n"+
				"MaxDetectableSpan (%d) was derived from these patterns — redo the derivation in "+
				"stream.go's package comment before updating this canary.", name, w, got[name], MaxDetectableSpan)
		}
	}
	if len(got) != len(want) {
		t.Fatalf("pattern inventory changed: %d recorded, %d present", len(want), len(got))
	}
}

// The buffer must hold back the LONGEST detectable span. This builds panRe's true worst case —
// 19 Luhn-valid digits with a separator between every pair — and proves the regex really does
// match all 37 bytes of it, so MaxDetectableSpan is measured, not guessed.
func TestMaxDetectableSpanIsTheLongestRealMatch(t *testing.T) {
	base := "123456789012345678" // 18 digits
	pan19 := base + luhnCheckDigit(t, base)
	var spaced strings.Builder
	for i := 0; i < len(pan19); i++ {
		if i > 0 {
			spaced.WriteByte(' ')
		}
		spaced.WriteByte(pan19[i])
	}
	worst := spaced.String()
	if len(worst) != 37 {
		t.Fatalf("expected the worst-case PAN span to be 37 bytes, got %d (%q)", len(worst), worst)
	}
	if m := panRe.FindString(worst); m != worst {
		t.Fatalf("expected panRe to match the whole 37-byte span, matched %q", m)
	}
	if r := Scrub(worst); r.Clean != "[REDACTED-CARD]" || !hasType(r.Redactions, "PAN") {
		t.Fatalf("expected the 37-byte worst case to be redacted as a PAN, got %q / %+v", r.Clean, r.Redactions)
	}
	if MaxDetectableSpan != len(worst) {
		t.Fatalf("MaxDetectableSpan is %d but the longest real match is %d bytes — the trailing buffer is too small and PII split across that boundary leaks", MaxDetectableSpan, len(worst))
	}

	// Every other pattern's worst case must fit inside the same window.
	for _, tc := range []struct {
		name string
		max  int
	}{
		{"npwpFmt", 20}, {"npwpBare", 4 + 10 + 15}, {"nikLbl", 3 + 12 + 16},
		{"nik16", 16}, {"bankAcct (bounded separators)", 8 + 1 + 1 + 1 + 20}, {"passport", 2 + 8},
	} {
		if tc.max > MaxDetectableSpan {
			t.Errorf("%s can match %d bytes, more than MaxDetectableSpan=%d", tc.name, tc.max, MaxDetectableSpan)
		}
	}
}

// The lookback window is re-scanned text that was ALREADY emitted, so scrubbing it a second
// time must be a no-op. If Scrub were not idempotent, the lookback could shift output offsets
// and the alignment in scrubWindow would break.
func TestScrubIsIdempotentOverItsOwnOutput(t *testing.T) {
	for _, in := range []string{
		"card 4111111111111111 ok", "NIK 3201150812001234", "npwp 092542943407000",
		"rekening 1234567890 atas nama Budi", "passport A1234567", "09.254.294.3-407.000",
		"kirim data 3201150812001234 ya",
	} {
		once := Scrub(in).Clean
		twice := Scrub(once).Clean
		if once != twice {
			t.Errorf("Scrub is not idempotent for %q:\n  once  %q\n  twice %q", in, once, twice)
		}
	}
}

// ── 2. the headline test: PII split across a token boundary ─────────────────────────────────

// THE test. A Luhn-valid PAN written with spaces is split so that neither token contains
// enough digits for panRe (which needs ≥13 between word boundaries) to fire. The naive
// per-token scrubber passes the whole card number through; the buffered scrubber must not.
func TestSplitPanAcrossTokenBoundaryIsRedacted(t *testing.T) {
	const pan = "4111 1111 1111 1111"
	// Padding long enough that the scrubber has already emitted real output before the PAN
	// starts, so this exercises the mid-stream boundary logic, not just the final flush.
	chunks := []string{
		"Here is the summary of the invoice you asked about, plus the ",
		"payment details on file. The card on record is 4111 1111 ", // 8 digits — no match
		"1111 1111 and it expires next year.",                       // 8 digits — no match
	}
	whole := strings.Join(chunks, "")

	// (a) the naive implementation leaks — this is what makes the assertion below meaningful.
	if naive := naivePerTokenScrub(chunks); !strings.Contains(naive, pan) {
		t.Fatalf("test is not discriminating: the naive per-token scrubber was expected to leak %q, got %q", pan, naive)
	}

	// (b) the buffered scrubber must redact it.
	got, s := streamAll(t, chunks)
	if strings.Contains(got, pan) {
		t.Fatalf("PII LEAK: the split PAN reached the sink in full: %q", got)
	}
	if strings.Contains(got, "4111") || strings.Contains(got, "1111") {
		t.Fatalf("PII LEAK: card digits reached the sink: %q", got)
	}
	if !strings.Contains(got, "[REDACTED-CARD]") {
		t.Fatalf("expected a [REDACTED-CARD] sentinel, got %q", got)
	}
	if s.Redactions() != 1 {
		t.Fatalf("expected exactly 1 response-side redaction, got %d", s.Redactions())
	}
	// The stream must agree byte-for-byte with what batch Scrub would have produced.
	if want := Scrub(whole).Clean; got != want {
		t.Fatalf("stream output diverged from batch Scrub:\n  got  %q\n  want %q", got, want)
	}
	// Surrounding prose must survive untouched.
	if !strings.Contains(got, "Here is the summary of the invoice") || !strings.Contains(got, "expires next year.") {
		t.Fatalf("expected ordinary text to survive, got %q", got)
	}
}

// The same failure mode for an Indonesian national ID. Note nik16 requires all 16 digits
// between word boundaries, so ANY split kills it — including a 1-byte-per-chunk split, which is
// the worst case a real provider could produce.
func TestSplitKtpAcrossTokenBoundaryIsRedacted(t *testing.T) {
	const nik = "3201150812001234"
	whole := "Data karyawan baru sudah masuk ke sistem, NIK-nya " + nik + " mohon dicek ya."

	for _, chunkSize := range []int{1, 3, 7, 16, 40} {
		chunks := splitEvery(whole, chunkSize)
		if chunkSize < len(nik) {
			if naive := naivePerTokenScrub(chunks); !strings.Contains(naive, nik[:chunkSize]) {
				t.Fatalf("chunk=%d: test not discriminating — naive scrub should have leaked NIK fragments, got %q", chunkSize, naive)
			}
		}
		got, _ := streamAll(t, chunks)
		if strings.Contains(got, nik) {
			t.Fatalf("chunk=%d: PII LEAK: the NIK reached the sink in full: %q", chunkSize, got)
		}
		if want := Scrub(whole).Clean; got != want {
			t.Fatalf("chunk=%d: stream diverged from batch Scrub:\n  got  %q\n  want %q", chunkSize, got, want)
		}
		if !strings.Contains(got, "[REDACTED-ID]") {
			t.Fatalf("chunk=%d: expected [REDACTED-ID], got %q", chunkSize, got)
		}
	}
}

// A labelled bank account whose LABEL is already on the wire when the digits arrive. This is the
// case the lookback window exists for: without it the label→digits association is lost the
// moment the label crosses an emit boundary, and the account number goes out in the clear.
func TestBankAccountLabelEmittedBeforeDigitsStillRedacts(t *testing.T) {
	whole := "Silakan lakukan pembayaran ke rekening 1234567890 atas nama Budi Santoso terima kasih."
	for _, chunkSize := range []int{1, 5, 11} {
		chunks := splitEvery(whole, chunkSize)
		got, _ := streamAll(t, chunks)
		if strings.Contains(got, "1234567890") {
			t.Fatalf("chunk=%d: PII LEAK: account digits reached the sink: %q", chunkSize, got)
		}
		if want := Scrub(whole).Clean; got != want {
			t.Fatalf("chunk=%d: stream diverged from batch Scrub:\n  got  %q\n  want %q", chunkSize, got, want)
		}
	}
}

// PII entirely inside one token must still be redacted — the boring case that must not regress
// while chasing the boundary case.
func TestPiiWhollyInsideOneTokenIsRedacted(t *testing.T) {
	chunks := []string{
		"Employee record follows for the onboarding batch we discussed. ",
		"NIK 3201150812001234", // whole PII in one chunk
		" — please file it under HR.",
	}
	got, s := streamAll(t, chunks)
	if strings.Contains(got, "3201150812001234") {
		t.Fatalf("PII LEAK: %q", got)
	}
	if !strings.Contains(got, "[REDACTED-ID]") || s.Redactions() != 1 {
		t.Fatalf("expected 1 redaction with a sentinel, got %d / %q", s.Redactions(), got)
	}
}

// ── 3. clean text must be untouched, and memory bounded ─────────────────────────────────────

// A scrubber that mangles ordinary text is worse than no scrubber. Byte-identical, asserted
// across many chunkings, including chunk boundaries landing inside words and after capital
// letters (which look like passport prefixes) and inside numbers that are NOT PII.
func TestCleanStreamIsByteIdenticalAndBufferBounded(t *testing.T) {
	clean := "Project Alpha is behind schedule; PO 2024-00123 and PO 2024-00124 are ready, " +
		"the meeting is at 08.30 in room 12, budget is 15000000 rupiah for Q3, order " +
		"1234567890123456 shipped, SKU ABC12345 restocked, we poured 250 m3 of concrete " +
		"over 3 days. Ref A123 and naïve unicode — em dashes too.\nSecond line here."

	for _, chunkSize := range []int{1, 2, 3, 5, 13, 37, 38, 200} {
		chunks := splitEvery(clean, chunkSize)
		got, s := streamAll(t, chunks)
		if got != clean {
			t.Fatalf("chunk=%d: clean stream was NOT byte-identical:\n  got  %q\n  want %q", chunkSize, got, clean)
		}
		if s.Redactions() != 0 {
			t.Fatalf("chunk=%d: expected no redactions over clean text, got %d", chunkSize, s.Redactions())
		}
		if s.ForcedBoundaries() != 0 {
			t.Fatalf("chunk=%d: clean text should never hit a forced boundary, got %d", chunkSize, s.ForcedBoundaries())
		}
		if s.PeakBuffered() > DefaultMaxBufferBytes {
			t.Fatalf("chunk=%d: buffer exceeded its cap: peak %d > %d", chunkSize, s.PeakBuffered(), DefaultMaxBufferBytes)
		}
		// With small chunks the retained buffer should stay close to the hold window: the whole
		// point is bounded added latency, not "buffer the response and scrub at the end".
		if chunkSize <= 13 && s.PeakBuffered() > MaxDetectableSpan+2*chunkSize+1 {
			t.Fatalf("chunk=%d: buffer grew past the hold window (peak %d) — the scrubber is not emitting incrementally", chunkSize, s.PeakBuffered())
		}
	}
}

// hostilePANStream builds the nastiest input available to these patterns: 400 back-to-back
// 37-byte worst-case PANs (the longest possible match) separated by a single comma, so the
// period (38) exceeds the hold window (37) and almost no split point is transparent to Scrub.
func hostilePANStream(t *testing.T, n int) string {
	t.Helper()
	base := "123456789012345678"
	pan19 := base + luhnCheckDigit(t, base)
	var spaced strings.Builder
	for i := 0; i < len(pan19); i++ {
		if i > 0 {
			spaced.WriteByte(' ')
		}
		spaced.WriteByte(pan19[i])
	}
	return strings.Repeat(spaced.String()+",", n)
}

// At the SHIPPED cap the forced-boundary path must never be reached, even on the hostile input
// above: memory stays two orders of magnitude below the cap and every single PAN is redacted.
// This is the assertion that the cap costs nothing in practice.
func TestShippedCapNeverForcesABoundary(t *testing.T) {
	hostile := hostilePANStream(t, 400) // ~15 KB
	var out strings.Builder
	s := NewStreamScrubber(func(tok string) { out.WriteString(tok) })
	for _, c := range splitEvery(hostile, 4) {
		s.Write(c)
	}
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if s.ForcedBoundaries() != 0 {
		t.Fatalf("expected no forced boundaries at the %d-byte cap, got %d", DefaultMaxBufferBytes, s.ForcedBoundaries())
	}
	if n := strings.Count(out.String(), "[REDACTED-CARD]"); n != 400 {
		t.Fatalf("expected all 400 worst-case PANs redacted, got %d", n)
	}
	if strings.ContainsAny(out.String(), "0123456789") {
		t.Fatalf("PII LEAK: digits survived a stream made entirely of PANs: %q", out.String())
	}
	if s.PeakBuffered() > DefaultMaxBufferBytes {
		t.Fatalf("buffer exceeded its cap: %d > %d", s.PeakBuffered(), DefaultMaxBufferBytes)
	}
	t.Logf("shipped cap %d: forced=%d, peak buffered=%d bytes, 400/400 PANs redacted",
		DefaultMaxBufferBytes, s.ForcedBoundaries(), s.PeakBuffered())
}

// The forced path itself, exercised by squeezing the cap down to its floor (2×the hold window)
// so the same hostile input can no longer be resolved inside the memory budget.
//
// This test's job is to MEASURE the documented cost rather than to claim it is small: a forced
// boundary splits a span, and on an input that is nothing but back-to-back maximal PANs almost
// every forced flush damages one — 40 of 400 PANs survive redaction here, i.e. the rest go out
// as two halves that match nothing. That is the price of bounded memory, and it is why the cap
// ships at 8 KiB (where TestShippedCapNeverForcesABoundary shows the path is unreachable) and
// why ForcedBoundaries() is exported: the degradation is countable, not silent.
func TestForcedBoundaryAtCapFloorKeepsMemoryBounded(t *testing.T) {
	hostile := hostilePANStream(t, 400)
	const capBytes = 2 * MaxDetectableSpan // the floor NewStreamScrubberWithCap enforces
	const chunk = 4

	var out strings.Builder
	s := NewStreamScrubberWithCap(func(tok string) { out.WriteString(tok) }, capBytes)
	for _, c := range splitEvery(hostile, chunk) {
		s.Write(c)
		if got := len(s.pending); got > capBytes {
			t.Fatalf("retained buffer %d exceeded the cap %d", got, capBytes)
		}
	}
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if s.PeakBuffered() > capBytes+chunk {
		t.Fatalf("peak buffered %d exceeded cap+chunk (%d) — memory is not bounded", s.PeakBuffered(), capBytes+chunk)
	}
	if s.ForcedBoundaries() == 0 {
		t.Fatal("expected cap-triggered boundaries at the cap floor — if this no longer fires, the forced path is untested")
	}
	// Each forced boundary can damage at most one span, so the surviving redactions must be at
	// least (spans − forced). This is the bound that makes the cost predictable.
	redacted := strings.Count(out.String(), "[REDACTED-CARD]")
	if redacted < 400-s.ForcedBoundaries() {
		t.Fatalf("a forced boundary damaged more than one span each: %d redacted, %d forced", redacted, s.ForcedBoundaries())
	}
	t.Logf("cap floor %d: forced=%d, %d/400 PANs still redacted, peak buffered=%d bytes",
		capBytes, s.ForcedBoundaries(), redacted, s.PeakBuffered())
}

// ── 4. flush exactly once ───────────────────────────────────────────────────────────────────

// Not zero times (truncated output), not twice (duplicated tail). The tail is the last
// MaxDetectableSpan bytes, which are held until Close by construction, so this is the assertion
// that the end of every response actually arrives — once.
func TestCloseFlushesHeldTailExactlyOnce(t *testing.T) {
	whole := "The quarterly report is attached and the numbers are final for review."
	var sink []string
	s := NewStreamScrubber(func(tok string) { sink = append(sink, tok) })
	for _, c := range splitEvery(whole, 6) {
		s.Write(c)
	}

	beforeClose := strings.Join(sink, "")
	if beforeClose == whole {
		t.Fatal("nothing was being held back — the trailing buffer is not doing its job")
	}
	if !strings.HasPrefix(whole, beforeClose) {
		t.Fatalf("pre-Close output is not a prefix of the input: %q", beforeClose)
	}

	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	afterFirstClose := strings.Join(sink, "")
	if afterFirstClose != whole {
		t.Fatalf("Close did not flush the whole held tail (truncation):\n  got  %q\n  want %q", afterFirstClose, whole)
	}

	// Idempotent: a second Close (e.g. a mid-stream error path that already closed, followed by
	// the handler's normal close) must not re-emit the tail.
	if err := s.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
	if got := strings.Join(sink, ""); got != whole {
		t.Fatalf("second Close duplicated the tail:\n  got  %q\n  want %q", got, whole)
	}
	if err := s.Close(); err != nil {
		t.Fatalf("third Close: %v", err)
	}
	if got := strings.Join(sink, ""); got != whole {
		t.Fatalf("third Close duplicated the tail: %q", got)
	}
}

// A stream that produced nothing must emit nothing at all — an empty sink call would put a
// stray `data: \n\n` event on the SSE wire.
func TestCloseOnEmptyStreamEmitsNothing(t *testing.T) {
	calls := 0
	s := NewStreamScrubber(func(string) { calls++ })
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if calls != 0 {
		t.Fatalf("expected no sink calls for an empty stream, got %d", calls)
	}
}

// Reset is the failover path. Everything buffered must be DISCARDED, not flushed: the stream
// route only treats output as "delivered" when the sink fires, so a provider that dies while
// all of its tokens are still buffered is still failed over — and if Reset flushed instead of
// dropping, the dead provider's partial answer would be prefixed onto the next provider's full
// answer, re-opening exactly the duplicate-output bug ASST-03 closed.
func TestResetDiscardsBufferWithoutEmitting(t *testing.T) {
	var sink []string
	s := NewStreamScrubber(func(tok string) { sink = append(sink, tok) })
	// Short enough to sit entirely inside the hold window — nothing has reached the sink, which
	// is precisely the case where failover is still safe and Reset must be used.
	s.Write("partial ")
	s.Write("answer")
	if len(sink) != 0 {
		t.Fatalf("expected output shorter than the %d-byte hold window to still be buffered, got %v", MaxDetectableSpan, sink)
	}
	s.Reset()
	if err := s.Close(); err != nil {
		t.Fatalf("Close after Reset: %v", err)
	}
	if len(sink) != 0 {
		t.Fatalf("Reset must never emit the discarded buffer, got %v", sink)
	}

	// And the scrubber is usable again for the next provider's attempt.
	s2out := ""
	s2 := NewStreamScrubber(func(tok string) { s2out += tok })
	s2.Write("first attempt")
	s2.Reset()
	s2.Write("second provider's complete answer, which must arrive alone.")
	if err := s2.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if s2out != "second provider's complete answer, which must arrive alone." {
		t.Fatalf("post-Reset stream was contaminated by the discarded attempt: %q", s2out)
	}
}

// ── 5. the differential property test ───────────────────────────────────────────────────────

// The strongest statement available: for arbitrary PII-dense text split at arbitrary
// boundaries, the streamed output must equal what batch Scrub() produces over the whole text.
// Any boundary bug — a missed match, an over-redaction, a mangled clean run, a lost or
// duplicated tail — shows up as an inequality here.
func TestStreamMatchesBatchScrubAcrossRandomChunkings(t *testing.T) {
	fragments := []string{
		"hello ", "world ", "please review ", "Project Alpha ", "invoice ", "\n", "  ", ": ", ", ",
		"4111111111111111", "4111 1111 1111 1111", "4111-1111-1111-1111",
		"3201150812001234", "NIK 3201150812001234", "KTP: 3201150812001234",
		"npwp 092542943407000", "NPWP 09.254.294.3-407.000", "09.254.294.3-407.000",
		"rekening 1234567890", "rek. 1234567890", "account 1234567890",
		"A1234567", "AB12345678", "1234567890123456", "08.30", "15000000", "2024-00123",
		"atas nama Budi ", "naïve — unicode ", "the total is ", "Q3 ", "SKU ABC12345 ",
	}
	rng := rand.New(rand.NewSource(0xA557_04))
	for iter := 0; iter < 3000; iter++ {
		var sb strings.Builder
		for n := 1 + rng.Intn(14); n > 0; n-- {
			sb.WriteString(fragments[rng.Intn(len(fragments))])
		}
		whole := sb.String()

		// random, uneven chunk boundaries — including 1-byte chunks and mid-rune splits
		var chunks []string
		for i := 0; i < len(whole); {
			n := 1 + rng.Intn(9)
			if i+n > len(whole) {
				n = len(whole) - i
			}
			chunks = append(chunks, whole[i:i+n])
			i += n
		}

		var out strings.Builder
		s := NewStreamScrubber(func(tok string) { out.WriteString(tok) })
		for _, c := range chunks {
			s.Write(c)
		}
		if err := s.Close(); err != nil {
			t.Fatalf("iter %d: Close: %v", iter, err)
		}
		want := Scrub(whole).Clean
		if out.String() != want {
			t.Fatalf("iter %d: streamed output != batch Scrub\n  input  %q\n  chunks %q\n  got    %q\n  want   %q",
				iter, whole, chunks, out.String(), want)
		}
		if s.ForcedBoundaries() != 0 {
			t.Fatalf("iter %d: unexpected forced boundary on a %d-byte input", iter, len(whole))
		}
	}
}
