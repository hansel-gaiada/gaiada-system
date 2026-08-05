// ai-gateway-go/internal/server/server_stream_test.go
//
// ASST-10: SSE wire grammar v2 — every `data:` payload on /complete/stream is exactly one line
// of JSON (default/message events carry the JSON STRING of the token text; `event: error`
// carries `{"error": string}`; the new `event: done` carries `{}`). This file pins the grammar
// itself: that no possible token content can ever produce a raw newline on the wire, that the
// new `event: done` terminal appears exactly once on a clean finish and never on an error
// finish, and that the fallback (non-streaming-provider) path uses the identical grammar.
//
// ASST-03 (mid-stream failover) and ASST-04 (response-side DLP boundary buffering) tests live in
// server_test.go and stream_dlp_test.go respectively and are NOT duplicated here; this file only
// adds the newline-safety/grammar coverage that motivated ASST-10.
package server

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"gaiada/ai-gateway-go/internal/providers"
)

// assertNoUnprefixedLines is the assertion the whole ticket rests on: a spec-compliant SSE
// parser discards any physical line that doesn't start with a recognized field name (here:
// "data:" or "event:"). Before ASST-10, a token containing a raw "\n" produced exactly such a
// line. This walks every physical line of the raw wire body and fails on the first one that
// isn't "data:", "event:", or blank (blank lines are the SSE event terminator).
func assertNoUnprefixedLines(t *testing.T, body string) {
	t.Helper()
	for i, line := range strings.Split(body, "\n") {
		if line == "" {
			continue
		}
		if !strings.HasPrefix(line, "data:") && !strings.HasPrefix(line, "event:") {
			t.Fatalf("unprefixed SSE line at physical line %d — a real parser would silently discard this: %q\nfull body: %q", i, line, body)
		}
	}
}

// decodeDataLines JSON-decodes every "data: " line in the body that belongs to a default
// (message) event (no preceding "event:" line in its block) into a string and returns them
// concatenated. This is sseContent's decode step, exposed standalone with a hard failure on any
// line that isn't valid single-line JSON, so a grammar violation surfaces here rather than
// silently producing an empty/garbled decode the way sseContent (which tolerates decode errors,
// for use against error/done bodies too) does.
func decodeDataLines(t *testing.T, body string) string {
	t.Helper()
	var out strings.Builder
	for _, block := range strings.Split(body, "\n\n") {
		if block == "" || strings.HasPrefix(block, "event:") {
			continue
		}
		for _, line := range strings.Split(block, "\n") {
			rest, ok := strings.CutPrefix(line, "data: ")
			if !ok {
				continue
			}
			var tok string
			if err := json.Unmarshal([]byte(rest), &tok); err != nil {
				t.Fatalf("data: line is not valid single-line JSON (grammar violation): %q: %v", rest, err)
			}
			out.WriteString(tok)
		}
	}
	return out.String()
}

// --- mandated case 1: a token containing a single "\n" -----------------------------------

func TestCompleteStreamTokenWithNewlineRoundTripsByteIdentical(t *testing.T) {
	want := "first line of the answer\nsecond line of the answer, no PII here"
	p := &fakeStreamingProvider{name: "one-newline", tokens: []string{want}}
	got := streamOnce(t, []providers.Provider{p})
	assertNoUnprefixedLines(t, got)
	if decoded := decodeDataLines(t, got); decoded != want {
		t.Fatalf("token with \\n did not round-trip byte-identical:\n  got  %q\n  want %q", decoded, want)
	}
}

// --- mandated case 2: a token containing "\n\n" (the paragraph-break token real Ollama emits) --

func TestCompleteStreamTokenWithDoubleNewlineRoundTripsByteIdentical(t *testing.T) {
	want := "Paragraph one of the answer.\n\nParagraph two of the answer, still no PII."
	p := &fakeStreamingProvider{name: "para-break", tokens: []string{want}}
	got := streamOnce(t, []providers.Provider{p})
	assertNoUnprefixedLines(t, got)
	if decoded := decodeDataLines(t, got); decoded != want {
		t.Fatalf("token with \\n\\n did not round-trip byte-identical:\n  got  %q\n  want %q", decoded, want)
	}
	// The pre-fix bug's other failure mode: \n\n reads as the SSE event terminator, so a naive
	// framing would show MORE than one physical blank-line pair inside what should be a single
	// logical answer. Assert there is exactly one true event terminator (the trailing \n\n of
	// the single data: line) by checking the decoded content carries the paragraph break INSIDE
	// the JSON string, never as a literal blank line in the raw body.
	if strings.Contains(got, "\n\n\n") {
		t.Fatalf("raw wire body contains 3 consecutive newlines — the \\n\\n leaked out of the JSON string as literal SSE framing: %q", got)
	}
}

// --- mandated case 3: a multi-token fenced code block reassembles byte-identical ---------------

func TestCompleteStreamFencedCodeBlockReassemblesByteIdentical(t *testing.T) {
	tokens := []string{
		"Here is the function:\n\n",
		"```go\n",
		"func add(a, b int) int {\n",
		"\treturn a + b\n",
		"}\n",
		"```\n\n",
		"That should compile.",
	}
	want := strings.Join(tokens, "")
	p := &fakeStreamingProvider{name: "fenced", tokens: tokens}
	got := streamOnce(t, []providers.Provider{p})
	assertNoUnprefixedLines(t, got)
	if decoded := decodeDataLines(t, got); decoded != want {
		t.Fatalf("fenced code block did not reassemble byte-identical:\n  got  %q\n  want %q", decoded, want)
	}
}

// --- mandated case 4: a multi-line provider error survives intact as ONE event: error ----------

func TestCompleteStreamMultiLineErrorSurvivesAsOneErrorEvent(t *testing.T) {
	// Pre-failure tokens must exceed dlp.MaxDetectableSpan (37 bytes) so the scrubber actually
	// releases bytes to the wire before the failure — otherwise this hits the short-buffered
	// clean-failover path (a different, already-covered case) rather than the mid-stream
	// event: error path this test targets.
	preamble := "This preamble is long enough on its own to clear the scrubber's hold window before the failure arrives. "
	wantErr := "upstream failed: line one\nline two of the same error\nline three, still the same error"
	first := &fakeStreamingProvider{
		name:      "erroring",
		tokens:    []string{preamble},
		failAfter: errors.New(wantErr),
	}
	second := &fakeStreamingProvider{name: "unused", tokens: []string{"must never appear"}}
	got := streamOnce(t, []providers.Provider{first, second})

	assertNoUnprefixedLines(t, got)
	if n := strings.Count(got, "event: error"); n != 1 {
		t.Fatalf("expected exactly one event: error, got %d in %q", n, got)
	}
	if strings.Contains(got, "event: done") {
		t.Fatalf("event: done must never appear alongside event: error, got %q", got)
	}
	if second.calls != 0 {
		t.Fatalf("expected the second provider to never be invoked (streamed already reached the client), got %d calls", second.calls)
	}

	errPayload := extractErrorPayload(t, got)
	if errPayload != wantErr {
		t.Fatalf("multi-line error text was not preserved intact:\n  got  %q\n  want %q", errPayload, wantErr)
	}
}

// extractErrorPayload finds the "event: error" block and JSON-decodes its data: line as
// {"error": string}, returning the error string.
func extractErrorPayload(t *testing.T, body string) string {
	t.Helper()
	for _, block := range strings.Split(body, "\n\n") {
		if !strings.HasPrefix(block, "event: error") {
			continue
		}
		for _, line := range strings.Split(block, "\n") {
			rest, ok := strings.CutPrefix(line, "data: ")
			if !ok {
				continue
			}
			var payload struct {
				Error string `json:"error"`
			}
			if err := json.Unmarshal([]byte(rest), &payload); err != nil {
				t.Fatalf("event: error data: line is not valid single-line JSON: %q: %v", rest, err)
			}
			return payload.Error
		}
	}
	t.Fatalf("no event: error block found in %q", body)
	return ""
}

// --- event: done — exactly once on clean completion, never on the error path -------------------

func TestCompleteStreamDoneEmittedExactlyOnceOnCleanCompletion(t *testing.T) {
	p := &fakeStreamingProvider{name: "clean", tokens: []string{"hello ", "world"}}
	got := streamOnce(t, []providers.Provider{p})
	assertNoUnprefixedLines(t, got)
	if n := strings.Count(got, "event: done"); n != 1 {
		t.Fatalf("expected exactly one event: done on clean completion, got %d in %q", n, got)
	}
	if strings.Count(got, "data: {}") != 1 {
		t.Fatalf("expected the done event's payload to be the single-line JSON {}, got %q", got)
	}
	if strings.Contains(got, "event: error") {
		t.Fatalf("clean completion must not carry an error event, got %q", got)
	}
	// done must be the LAST frame, not merely present somewhere.
	trimmed := strings.TrimRight(got, "\n")
	if !strings.HasSuffix(trimmed, "data: {}") {
		t.Fatalf("expected event: done to be the terminal frame, got %q", got)
	}
}

func TestCompleteStreamDoneNotEmittedOnErrorPath(t *testing.T) {
	first := &fakeStreamingProvider{
		name:      "erroring",
		tokens:    []string{"long enough preamble to clear the thirty-seven byte hold window before it fails "},
		failAfter: errors.New("upstream died"),
	}
	got := streamOnce(t, []providers.Provider{first})
	if strings.Contains(got, "event: done") {
		t.Fatalf("event: done must not appear when the stream ends in event: error, got %q", got)
	}
	if n := strings.Count(got, "event: error"); n != 1 {
		t.Fatalf("expected exactly one event: error, got %d in %q", n, got)
	}
}

// --- the fallback (non-streaming provider) path uses the identical grammar ---------------------

func TestCompleteStreamFallbackUsesSameGrammarAndEmitsDone(t *testing.T) {
	p := &piiProvider{name: "nonstreaming", text: "line one of the fallback answer\nline two of the fallback answer"}
	got := streamOnce(t, []providers.Provider{p})
	assertNoUnprefixedLines(t, got)
	if decoded := decodeDataLines(t, got); decoded != p.text {
		t.Fatalf("fallback path did not round-trip byte-identical:\n  got  %q\n  want %q", decoded, p.text)
	}
	if n := strings.Count(got, "event: done"); n != 1 {
		t.Fatalf("expected exactly one event: done on the fallback path, got %d in %q", n, got)
	}
	if n := contentDataEventCount(got); n != 1 {
		t.Fatalf("expected the fallback to stay a single content data event, got %d in %q", n, got)
	}
}
