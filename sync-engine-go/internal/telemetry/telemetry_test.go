package telemetry

import (
	"context"
	"testing"
)

// The fail-soft contract: with OTEL_ENABLED unset, Init must be a no-op — no error, a callable
// shutdown, and no attempt to reach a collector. This is what keeps the data plane runnable bare.
func TestInitNoopWhenDisabled(t *testing.T) {
	t.Setenv("OTEL_ENABLED", "")
	if Enabled() {
		t.Fatal("Enabled() should be false when OTEL_ENABLED is unset")
	}
	shutdown, err := Init(context.Background(), "test-svc")
	if err != nil {
		t.Fatalf("disabled Init must not error, got %v", err)
	}
	if shutdown == nil {
		t.Fatal("shutdown must be callable even when disabled")
	}
	if err := shutdown(context.Background()); err != nil {
		t.Fatalf("no-op shutdown must not error, got %v", err)
	}
}

func TestEnabledParsing(t *testing.T) {
	for _, v := range []string{"1", "true", "TRUE", "yes"} {
		t.Setenv("OTEL_ENABLED", v)
		if !Enabled() {
			t.Fatalf("OTEL_ENABLED=%q should be enabled", v)
		}
	}
	for _, v := range []string{"", "0", "false", "no"} {
		t.Setenv("OTEL_ENABLED", v)
		if Enabled() {
			t.Fatalf("OTEL_ENABLED=%q should be disabled", v)
		}
	}
}

func TestNewLoggerDefault(t *testing.T) {
	if NewLogger("test-svc") == nil {
		t.Fatal("NewLogger returned nil")
	}
}
