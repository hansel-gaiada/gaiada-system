// Package migrations embeds the vdb schema steps. The collector applies them at start (store.Migrate).
package migrations

import "embed"

// FS holds the numbered *.sql files, applied in file-name order, each once.
//
//go:embed *.sql
var FS embed.FS
