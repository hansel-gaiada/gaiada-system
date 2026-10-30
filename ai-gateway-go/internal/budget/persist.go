// AIP-17a: the daily call counters survive a restart. A Persister owns ONE state file holding the
// day counters of every registered Budget (the chat/agent budget under "chat", the separate /embed
// budget under "embed"), each under its own key so one budget's counts can never be loaded into
// another.
//
// The file holds COUNTS and the UTC day only. Caps, the console overrides and DR mode are never
// written: SetCaps / EnableDR behave exactly as before, and a restart never changes a cap.
//
// Write path: a background loop (Run) snapshots every budget under that budget's own mutex, then
// does the marshalling and file I/O outside it, atomically (temp file in the same directory, fsync,
// rename, mode 0600). A write happens at most once per interval and only when the snapshot differs
// from what was last written; Run flushes once more when its context ends (graceful shutdown). A
// crash can lose up to one interval of counts, which is accepted.
//
// Boot path: NewPersister reads the file once; Register restores a budget from its key when the
// stored day is today (UTC). A missing, corrupt or stale file starts from zero, with one log line
// saying which. It never fails and never refuses to start.
package budget

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"
)

// DefaultStateFile is the state file path when GATEWAY_BUDGET_STATE_FILE is unset. It is relative to
// the gateway's working dir, like data/admin-overrides.json, so it lands on the gateway-data volume.
const DefaultStateFile = "data/budget-state.json"

// DefaultPersistInterval is the most often the state file is rewritten.
const DefaultPersistInterval = 5 * time.Second

const stateVersion = 1

// StatePathFromEnv resolves GATEWAY_BUDGET_STATE_FILE with the house `${VAR-default}` semantics:
// unset gives the default path, an explicitly empty value gives "" (persistence off).
func StatePathFromEnv() string {
	if v, ok := os.LookupEnv("GATEWAY_BUDGET_STATE_FILE"); ok {
		return v
	}
	return DefaultStateFile
}

// stateFile is the on-disk shape. Budgets are keyed by the name given to Register.
type stateFile struct {
	Version int                    `json:"version"`
	Budgets map[string]budgetState `json:"budgets"`
}

type budgetState struct {
	Day    string         `json:"day"`
	Global int            `json:"global"`
	Counts map[string]int `json:"counts"`
}

type persistEntry struct {
	key string
	b   *Budget
}

// Persister writes and restores the day counters of the budgets registered with it. A nil
// *Persister is valid and does nothing (persistence off).
type Persister struct {
	path     string
	logf     func(format string, args ...any)
	now      func() time.Time
	interval time.Duration

	loaded    map[string]budgetState // read once at construction; consumed by Register
	loadState string                 // "" = file usable, else why it was not ("missing", "corrupt", ...)

	mu      sync.Mutex // serializes flushes (loop tick vs shutdown) and guards entries/last
	entries []persistEntry
	last    []byte // bytes of the last successful write (or of the loaded file)
	failing bool   // the last write failed (log once per failure streak, not every tick)

	writes atomic.Int64 // successful file writes (tests, diagnostics)
}

// NewPersister reads path once and returns the persister. An empty path returns nil (off).
func NewPersister(path string, logf func(string, ...any)) *Persister {
	return newPersister(path, logf, time.Now, DefaultPersistInterval)
}

func newPersister(path string, logf func(string, ...any), now func() time.Time, interval time.Duration) *Persister {
	if path == "" {
		return nil
	}
	if logf == nil {
		logf = func(string, ...any) {}
	}
	p := &Persister{path: path, logf: logf, now: now, interval: interval}
	raw, err := os.ReadFile(path)
	switch {
	case errors.Is(err, os.ErrNotExist):
		p.loadState = "missing"
		logf("budget state: no file at %s, starting from zero", path)
	case err != nil:
		p.loadState = "unreadable"
		logf("budget state: cannot read %s (%v), starting from zero", path, err)
	default:
		var sf stateFile
		jerr := json.Unmarshal(raw, &sf)
		if jerr == nil && (sf.Version != stateVersion || sf.Budgets == nil) {
			jerr = fmt.Errorf("unexpected content (version %d)", sf.Version)
		}
		if jerr != nil {
			p.loadState = "corrupt"
			logf("budget state: %s is corrupt (%v), starting from zero", path, jerr)
		} else {
			p.loaded = sf.Budgets
			p.last = raw
		}
	}
	return p
}

// Register adds a budget under key and restores it from the file when the stored day is today
// (UTC). Each key is independent: a key absent from the file starts from zero.
func (p *Persister) Register(key string, b *Budget) {
	if p == nil || b == nil {
		return
	}
	p.mu.Lock()
	p.entries = append(p.entries, persistEntry{key: key, b: b})
	p.mu.Unlock()
	if p.loadState != "" {
		return // already logged at load
	}
	st, ok := p.loaded[key]
	if !ok {
		p.logf("budget state: no %q counters in %s, starting from zero", key, p.path)
		return
	}
	day := today(p.now())
	if st.Day != day {
		p.logf("budget state: %q counters are from %q, not today (%s), starting from zero", key, st.Day, day)
		return
	}
	b.restore(st.Day, st.Global, st.Counts)
	p.logf("budget state: %q restored for %s (global %d, %d scope(s))", key, st.Day, st.Global, len(st.Counts))
}

// restore seeds the counters. Only the counts and the day are touched, never a cap or DR state.
func (b *Budget) restore(day string, global int, counts map[string]int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.day = day
	if global < 0 {
		global = 0
	}
	b.globalCount = global
	b.tenantCounts = make(map[string]int, len(counts))
	for k, n := range counts {
		if n > 0 {
			b.tenantCounts[k] = n
		}
	}
}

// counters copies the day counters under the budget's mutex. The copy is what the writer
// marshals, so no JSON work or file I/O ever happens while the mutex is held.
func (b *Budget) counters() budgetState {
	b.mu.Lock()
	defer b.mu.Unlock()
	st := budgetState{Day: b.day, Global: b.globalCount, Counts: make(map[string]int, len(b.tenantCounts))}
	for k, n := range b.tenantCounts {
		st.Counts[k] = n
	}
	return st
}

// Flush writes the state file now if any counter changed since the last write. Safe to call from
// several goroutines; it returns the write error, if any (the next tick retries).
func (p *Persister) Flush() error {
	if p == nil {
		return nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	sf := stateFile{Version: stateVersion, Budgets: map[string]budgetState{}}
	for _, e := range p.entries {
		if st := e.b.counters(); st.Day != "" { // a budget never used has nothing to record
			sf.Budgets[e.key] = st
		}
	}
	if len(sf.Budgets) == 0 {
		return nil
	}
	raw, err := json.Marshal(sf) // map keys marshal sorted, so equal counters give equal bytes
	if err != nil {
		return err
	}
	if string(raw) == string(p.last) {
		return nil
	}
	if err := writeAtomic(p.path, raw); err != nil {
		if !p.failing {
			p.logf("budget state: write failed (%v), will retry every %s", err, p.interval)
		}
		p.failing = true
		return err
	}
	p.failing = false
	p.last = raw
	p.writes.Add(1)
	return nil
}

// Run flushes every interval (when counts changed), and once more when ctx ends, then returns.
// It blocks; start it in a goroutine and wait for it on shutdown.
func (p *Persister) Run(ctx context.Context) {
	if p == nil {
		return
	}
	t := time.NewTicker(p.interval)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			_ = p.Flush()
		case <-ctx.Done():
			_ = p.Flush()
			return
		}
	}
}

// writeAtomic writes data to path through a temp file in the SAME directory (so the rename never
// crosses a filesystem), fsyncs it, then renames over the target: a reader sees the old or the new
// file, never a partial one. Mode 0600, like the admin overrides file.
func writeAtomic(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	tmp := f.Name()
	cleanup := func() { _ = os.Remove(tmp) }
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		cleanup()
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		cleanup()
		return err
	}
	if err := f.Close(); err != nil {
		cleanup()
		return err
	}
	if err := os.Chmod(tmp, 0o600); err != nil {
		cleanup()
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		cleanup()
		return err
	}
	return nil
}
