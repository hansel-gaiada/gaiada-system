package providers

import (
	"context"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestEchoProviderAlwaysAvailable(t *testing.T) {
	p := NewEchoProvider()
	if !p.Available() {
		t.Fatal("echo should always be available")
	}
	text, err := p.Complete(context.Background(), "hello world")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if text == "" {
		t.Fatal("expected non-empty echo response")
	}
}

func TestEchoCompleteTruncatesByRuneNotByte(t *testing.T) {
	p := NewEchoProvider()
	// Multi-byte rune ("é" is 2 bytes in UTF-8): repeat enough times that a
	// byte-index truncation at 200 would split a rune mid-sequence, producing
	// invalid UTF-8, while a rune-index truncation stays valid.
	prompt := strings.Repeat("é", 250)
	text, err := p.Complete(context.Background(), prompt)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !utf8.ValidString(text) {
		t.Fatalf("truncated output is not valid UTF-8: %q", text)
	}
	runeCount := len([]rune(strings.TrimPrefix(text, "[echo — no provider key configured] ")))
	if runeCount != 200 {
		t.Fatalf("expected truncation at 200 runes, got %d", runeCount)
	}
}

// ASST-03: CompleteStream is the keyless dev/test streaming terminator — it must emit the
// prompt word-by-word (not the whole answer as one chunk) so /complete/stream has something
// real to exercise with zero providers configured, and the joined tokens must reconstruct
// exactly what Complete() would have returned.
func TestEchoCompleteStreamEmitsWordByWordAndReconstructsCompleteOutput(t *testing.T) {
	p := NewEchoProvider()
	full, err := p.Complete(context.Background(), "hello there friend")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	var got []string
	if err := p.CompleteStream(context.Background(), "hello there friend", func(tok string) {
		got = append(got, tok)
	}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) < 3 {
		t.Fatalf("expected >=3 discrete onToken calls, got %d: %v", len(got), got)
	}
	if joined := strings.Join(got, ""); joined != full {
		t.Fatalf("expected joined tokens to reconstruct Complete()'s output exactly;\n got:  %q\n want: %q", joined, full)
	}
}

func TestEchoEmbedIsDeterministicAndNormalized(t *testing.T) {
	p := NewEchoProvider()
	v1, err := p.Embed(context.Background(), "hello world")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	v2, _ := p.Embed(context.Background(), "hello world")
	if len(v1) != 128 {
		t.Fatalf("expected 128 dims, got %d", len(v1))
	}
	for i := range v1 {
		if v1[i] != v2[i] {
			t.Fatalf("embed not deterministic at index %d: %f != %f", i, v1[i], v2[i])
		}
	}
}
