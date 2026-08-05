// stream.go — the boundary-buffered RESPONSE scrubber (ASST-04).
//
// WHY THIS EXISTS
// ---------------
// /complete/stream hands provider tokens straight to the wire. Running Scrub() on each token
// as it arrives is not a fix — it is a fix-shaped hole: a PAN written "4111 1111 1111 1111"
// that arrives as two tokens ("…4111 1111 " then "1111 1111…") matches NOTHING in either
// fragment (panRe needs ≥13 digits between word boundaries), so the full card number reaches
// the client while every happy-path test stays green. That is the silent-leak failure mode.
//
// The fix is a TRAILING BUFFER. StreamScrubber accumulates incoming text, scrubs the whole
// accumulated window on every write, and emits only the prefix that no future input can
// change — holding back at least MaxDetectableSpan bytes so no possible match can be cut in
// half. At stream end Close() scrubs and emits the held tail exactly once.
//
// HOW BIG THE BUFFER HAS TO BE — DERIVED FROM scrub.go's OWN PATTERNS
// -------------------------------------------------------------------
// Worst-case match length, byte-counted directly off each regex in scrub.go:
//
//	panRe    \b\d(?:[ -]?\d){12,18}\b                    1 + 18×2                  = 37
//	npwpFmt  \b\d{2}\.\d{3}\.\d{3}\.\d-\d{3}\.\d{3}\b     2+1+3+1+3+1+1+1+3+1+3     = 20
//	npwpBare (?i)\bNPWP\b\D{0,10}(\d{15})\b               4 + 10 + 15               = 29
//	nikLbl   (?i)\b(NIK|KTP)\b\D{0,12}(\d{16})\b          3 + 12 + 16               = 31
//	nik16    \b\d{16}\b                                   16                        = 16
//	bankAcct (?i)\b(rek(?:ening)?|acc(?:ount|t)?|a[./]?n)\b\s*[:.]?\s*(\d[\d -]{6,18}\d)
//	                                                      8 + \s* + 1 + \s* + 20    = 31 + |\s*|
//	passport \b[A-Z]{1,2}\d{6,8}\b                        2 + 8                     = 10
//
// The maximum over all BOUNDED patterns is 37 (panRe) ⇒ MaxDetectableSpan = 37.
// TestMaxDetectableSpanIsTheLongestRealMatch builds the 37-byte worst case and asserts panRe
// actually matches all 37 of it, and TestScrubPatternsUnchangedCanary pins every pattern's
// source text so editing scrub.go forces this derivation to be redone rather than silently
// invalidated.
//
// THE ONE UNBOUNDED PATTERN, AND WHY IT IS NOT A BLOCKER
// ------------------------------------------------------
// bankAcct's two `\s*` runs are unbounded, so its total match length is unbounded. It is NOT
// an unbounded PII window, though: the label is ≤8 bytes and the digit group is ≤20 bytes —
// only the *separator whitespace* between them is unbounded, and whitespace carries no PII.
// So the bound that matters (how much PII-bearing text a match can cover) is still 37, and
// the association label→digits is preserved by the `lookback` window below rather than by the
// trailing buffer: already-emitted output is re-scanned for regex left-context, so a
// "rekening" that has already gone to the wire still redacts digits that arrive later.
// Residual, documented: a bank-account label separated from its digits by more than
// lookbackBytes (101) bytes of whitespace is not associated, and the digits then fall under
// scrub.go's deliberate "unlabelled digit runs are not redacted" rule
// (TestScrubDoesNotRedactUnlabelledBankAccount). Batch Scrub() would catch that case; the
// stream does not. Closing it fully would require an unbounded buffer, i.e. a memory-DoS.
//
// WHAT "SAFE BOUNDARY" MEANS, PRECISELY (the proof the whole ticket rests on)
// --------------------------------------------------------------------------
// Let pending be the un-emitted text and b = len(pending) − MaxDetectableSpan.
//
//  1. No FUTURE input can change how pending[:b] scrubs. Any match that extends past the
//     current end of pending is ≤ MaxDetectableSpan bytes long, so it starts at an index
//     > len(pending) − MaxDetectableSpan = b. It therefore cannot cover any byte of
//     pending[:b]. (Holding exactly MaxDetectableSpan gives one byte of slack over the
//     MaxDetectableSpan−1 the arithmetic strictly needs.)
//
//  2. No CURRENT match may be cut in half at b. A match wholly inside pending that straddles
//     b would be emitted half-raw. That is caught, not assumed, by a local differential check
//     against the batch scrubber: drain() only emits at a boundary c where
//
//     scrub(pending[:c]) + scrub(pending[c:]) == scrub(pending)
//
//     i.e. where splitting the window at c is transparent to Scrub(). A match straddling c
//     produces one joint sentinel on the right-hand side and two independently-scrubbed halves
//     on the left, so the equality fails and c is rejected. If the check fails the boundary
//     walks left one byte at a time; if no stable boundary exists yet, nothing is emitted and
//     the scrubber waits for more input.
//
//     A plain "is the head's scrub a PREFIX of the window's scrub" test is NOT enough, and the
//     hole is not hypothetical: cut a 19-digit Luhn-valid PAN after its 13th digit and, if
//     that 13-digit prefix happens to be Luhn-valid too, the head scrubs to
//     "…[REDACTED-CARD]" — a legitimate prefix of the window's "…[REDACTED-CARD]," — while the
//     remaining 6 digits would go out separately. The equality form rejects it. Where the two
//     sides can still coincide, both halves were themselves redacted, so the failure direction
//     is over-redaction, never a leak.
//
// Clean text therefore passes through byte-identical (Scrub is the identity on it, so both
// sides of the equality trivially hold) — asserted over eight chunkings by
// TestCleanStreamIsByteIdenticalAndBufferBounded, and over 3000 random PII-dense inputs at
// random chunk boundaries by TestStreamMatchesBatchScrubAcrossRandomChunkings, which asserts
// the streamed output equals Scrub(whole) exactly.
//
// LATENCY COST
// ------------
// A constant ≤MaxDetectableSpan (37) byte lag, not batching: once the buffer is warm, each
// incoming token advances the safe boundary by its own length, so the number of SSE events
// still tracks the number of provider tokens 1:1 — the content is just shifted back 37 bytes,
// with the remainder released by Close().
//
// BOUNDED MEMORY
// --------------
// pending is capped (DefaultMaxBufferBytes). A provider streaming megabytes with no stable
// boundary hits the cap and gets a FORCED boundary flush at b, skipping check (2). Cost, in
// full: a PII span straddling that exact byte offset is split, each half matches nothing, and
// it leaks. ForcedBoundaries() counts them, so the degradation is countable rather than silent.
//
// Measured, not asserted: on the most hostile input these patterns admit — 400 back-to-back
// 37-byte maximal PANs, comma-separated so the period (38) exceeds the hold window (37) —
// the shipped 8 KiB cap forces ZERO boundaries, peaks at 113 buffered bytes, and redacts
// 400/400 (TestShippedCapNeverForcesABoundary). Squeezing the cap to its floor (2×37 = 74)
// does trigger it, and then the cost is severe: 379 forced boundaries, only 40/400 PANs still
// redacted (TestForcedBoundaryAtCapFloorKeepsMemoryBounded). That asymmetry is the argument for
// the 8 KiB default: the forced path is a memory-exhaustion backstop, not an operating mode.
//
// CONCURRENCY: not goroutine-safe by design. Providers call onToken synchronously from
// CompleteStream, and the sink writes to an http.ResponseWriter, which is itself
// single-writer. Call Write/Close from the goroutine that owns the sink.
package dlp

import "strings"

// MaxDetectableSpan is the longest match any scrub.go pattern can produce over PII-bearing
// text, in bytes. Derived in the package comment above from the patterns themselves — do NOT
// treat it as a tunable. If scrub.go gains or widens a pattern, redo the derivation (the
// canary test in stream_test.go will fail until you do).
const MaxDetectableSpan = 37

// lookbackBytes is how much ALREADY-EMITTED output is re-prepended to the window purely for
// regex left-context. Two jobs:
//   - `\b` fidelity: scrubbing a window in isolation puts a word boundary at its left edge
//     that the real text may not have, which would redact text batch Scrub() leaves alone
//     ("ref" + "A1234567" must stay "refA1234567", not become "ref[REDACTED-ID]").
//   - label→digits association across an emit boundary: the labelled patterns (nikLbl,
//     npwpBare, bankAcct) put the label before the digits, and the label may already be on
//     the wire when the digits arrive. MaxDetectableSpan alone would cover every bounded
//     pattern; the extra 64 bytes are deliberate slack for bankAcct's unbounded `\s*`.
//
// The lookback text is post-scrub output, so it is PII-free by construction and re-scanning it
// can never re-expose anything.
const lookbackBytes = MaxDetectableSpan + 64

// DefaultMaxBufferBytes bounds pending. 8 KiB is ~200× the longest possible match, so a
// forced boundary can only ever be reached by adversarial/pathological input, never by a
// long-but-normal response.
const DefaultMaxBufferBytes = 8192

// StreamScrubber wraps a token sink with response-side DLP. Write() feeds provider output in;
// the sink receives only text that has been scrubbed and is safe to consider final.
type StreamScrubber struct {
	sink      func(string)
	pending   []byte
	lookback  []byte
	maxBuffer int

	redactions int
	peak       int
	forced     int
	closed     bool
	err        error
}

// NewStreamScrubber wraps sink with the default buffer cap.
func NewStreamScrubber(sink func(string)) *StreamScrubber {
	return NewStreamScrubberWithCap(sink, DefaultMaxBufferBytes)
}

// NewStreamScrubberWithCap allows tests (and callers with a tighter memory budget) to set the
// cap. The cap is floored at 2×MaxDetectableSpan: below that the forced-boundary path could
// not leave a full hold window behind, which would defeat the whole mechanism.
func NewStreamScrubberWithCap(sink func(string), maxBuffer int) *StreamScrubber {
	if maxBuffer < 2*MaxDetectableSpan {
		maxBuffer = 2 * MaxDetectableSpan
	}
	return &StreamScrubber{sink: sink, maxBuffer: maxBuffer}
}

// Write feeds one provider token (or any chunk) into the buffer and emits whatever has become
// safe. It is deliberately silent about errors: a DLP failure is fail-closed (nothing further
// is ever emitted) and surfaced via Err(), which the caller checks before finishing the
// response.
func (s *StreamScrubber) Write(chunk string) {
	if s.closed || s.err != nil || chunk == "" {
		return
	}
	s.pending = append(s.pending, chunk...)
	if len(s.pending) > s.peak {
		s.peak = len(s.pending)
	}
	// drain until it stops making progress: one Write can unblock several boundaries when the
	// previous rounds had to hold a long straddling match.
	for s.drain() {
	}
}

// drain emits at most one safe prefix. Returns true if it emitted something (so the caller can
// try again).
func (s *StreamScrubber) drain() bool {
	if s.err != nil {
		return false
	}
	forced := len(s.pending) > s.maxBuffer
	if len(s.pending) <= MaxDetectableSpan && !forced {
		return false
	}
	b := len(s.pending) - MaxDetectableSpan
	if b <= 0 {
		return false
	}

	if forced {
		// Cap reached: emit at b without the split-transparency check. See the package comment
		// for the exact cost of this.
		out, red, ok := s.scrubWindow(s.lookback, string(s.pending[:b]))
		if !ok {
			if s.err != nil {
				return false
			}
			// Could not align against the lookback — scrub the head standalone. Safe direction:
			// isolation can only over-redact via a spurious `\b`, never under-redact a match
			// that lies wholly inside the head.
			res, derr := DLP(string(s.pending[:b]))
			if derr != nil {
				s.err = derr
				return false
			}
			out, red = res.Clean, len(res.Redactions)
		}
		s.forced++
		s.commit(out, red, b)
		return true
	}

	full, _, ok := s.scrubWindow(s.lookback, string(s.pending))
	if !ok {
		return false // fail-closed / unalignable: hold and wait (bounded by maxBuffer)
	}
	// Walk the boundary left until splitting there is transparent to Scrub(). A straddling
	// match is ≤ MaxDetectableSpan bytes, so MaxDetectableSpan steps is enough to clear one; a
	// chain of them holds until more input arrives or the cap forces a flush.
	limit := b - MaxDetectableSpan
	if limit < 0 {
		limit = 0
	}
	for c := b; c > limit; c-- {
		head, red, ok := s.scrubWindow(s.lookback, string(s.pending[:c]))
		if !ok {
			return false
		}
		// The tail is scrubbed with the lookback the NEXT round will actually use, so this is
		// a faithful simulation of "emit head now, scrub the rest later".
		tail, _, ok := s.scrubWindow(trimLookback(append(append([]byte(nil), s.lookback...), head...)), string(s.pending[c:]))
		if !ok {
			return false
		}
		if head+tail == full {
			s.commit(head, red, c)
			return true
		}
	}
	return false
}

// trimLookback keeps only the trailing lookbackBytes of b.
func trimLookback(b []byte) []byte {
	if len(b) <= lookbackBytes {
		return b
	}
	return b[len(b)-lookbackBytes:]
}

// commit emits out (the scrub of pending[:n]) and retires those n raw bytes.
func (s *StreamScrubber) commit(out string, redactions, n int) {
	s.pending = append([]byte(nil), s.pending[n:]...)
	s.redactions += redactions
	if out == "" {
		return
	}
	s.lookback = append([]byte(nil), trimLookback(append(s.lookback, out...))...)
	s.sink(out)
}

// scrubWindow scrubs text with lookback prepended for regex left-context and returns only
// text's own scrubbed bytes.
//
// ok=false means one of two things, and both mean "do not emit": either DLP failed (fail
// closed — err is set and nothing is ever emitted again), or a redaction consumed part of the
// already-emitted lookback so the result cannot be aligned back to text. The latter should be
// unreachable — a redaction spanning the emit boundary is exactly what drain()'s
// split-transparency check refuses to emit through, and every labelled pattern's replacement
// KEEPS its label ("NIK [REDACTED-ID]", "rekening [REDACTED-ACCT]") so the lookback survives
// verbatim — but it is handled rather than assumed, because the one known case where it does
// not survive is npwpBare uppercasing a lowercase "npwp" label.
func (s *StreamScrubber) scrubWindow(lookback []byte, text string) (out string, redactions int, ok bool) {
	lb := string(lookback)
	res, err := DLP(lb + text)
	if err != nil {
		s.err = err
		s.pending = nil // fail-closed: never hold raw text we might later flush
		return "", 0, false
	}
	if !strings.HasPrefix(res.Clean, lb) {
		return "", 0, false
	}
	return res.Clean[len(lb):], len(res.Redactions), true
}

// Close flushes the held tail — scrubbed — EXACTLY ONCE and marks the scrubber done. Calling
// it twice is a no-op (no duplicated tail); never calling it truncates the response, so every
// exit path of the stream route must reach it. Returns the fail-closed DLP error, if any, in
// which case nothing was emitted.
func (s *StreamScrubber) Close() error {
	if s.closed {
		return s.err
	}
	s.closed = true
	if s.err != nil {
		return s.err
	}
	if len(s.pending) == 0 {
		return nil
	}
	tail := string(s.pending)
	out, red, ok := s.scrubWindow(s.lookback, tail)
	if !ok {
		if s.err != nil {
			return s.err
		}
		res, derr := DLP(tail)
		if derr != nil {
			s.err = derr
			s.pending = nil
			return derr
		}
		out, red = res.Clean, len(res.Redactions)
	}
	s.commit(out, red, len(s.pending))
	return nil
}

// Reset discards everything buffered WITHOUT emitting it, and re-arms the scrubber.
//
// This is the failover path, and it is load-bearing for ASST-03's duplicate-output fix. The
// stream route flips its `streamed` flag when the SINK fires — i.e. when bytes actually reach
// the client — not when a provider hands over a token, because a token sitting in this buffer
// has reached nobody. So a provider that dies while all of its output is still buffered can
// still be failed over cleanly. That is only true if the buffer is dropped: flush it and the
// dead provider's partial answer would be prefixed onto the next provider's full answer,
// re-opening exactly the corruption ASST-03 closed.
func (s *StreamScrubber) Reset() {
	s.pending = nil
	s.lookback = nil
	s.redactions = 0
	s.closed = false
	s.err = nil
}

// Err reports the fail-closed DLP error, if any. Non-nil means the response is incomplete and
// the caller must surface an error to the client rather than pretend the stream finished.
func (s *StreamScrubber) Err() error { return s.err }

// Redactions counts response-side redactions emitted since the last Reset.
func (s *StreamScrubber) Redactions() int { return s.redactions }

// PeakBuffered is the high-water mark of buffered bytes — the assertion surface for "the
// buffer never exceeds its cap".
func (s *StreamScrubber) PeakBuffered() int { return s.peak }

// ForcedBoundaries counts cap-triggered flushes that skipped the straddle check. Any non-zero
// value means the stream contained a span this scrubber could not resolve within its memory
// budget; see the package comment for what that costs.
func (s *StreamScrubber) ForcedBoundaries() int { return s.forced }
