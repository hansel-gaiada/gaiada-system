package main

import (
	"context"
	"log/slog"
)

// typedHandler is an slog.Handler that re-emits ANY record as one constant, value-free line. It backs
// http.Server.ErrorLog: net/http's own error messages can include the remote address ("http: TLS handshake
// error from 203.0.113.7:51234"), and the collector must not let an address reach a log by that route.
type typedHandler struct{ log *slog.Logger }

func (h *typedHandler) Enabled(context.Context, slog.Level) bool { return true }

func (h *typedHandler) Handle(ctx context.Context, _ slog.Record) error {
	h.log.WarnContext(ctx, "http server error", "outcome", "http_server_error")
	return nil
}

func (h *typedHandler) WithAttrs([]slog.Attr) slog.Handler { return h }
func (h *typedHandler) WithGroup(string) slog.Handler      { return h }
