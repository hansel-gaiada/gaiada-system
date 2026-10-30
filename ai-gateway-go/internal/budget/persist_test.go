package budget

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

var day1 = time.Date(2026, 10, 30, 10, 0, 0, 0, time.UTC)

type logSink struct {
	mu    sync.Mutex
	lines []string
}

func (l *logSink) logf(format string, args ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, strings.TrimSpace(format))
	_ = args
}

func (l *logSink) count() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.lines)
}

func statePath(t *testing.T) string { return filepath.Join(t.TempDir(), "data", "budget-state.json") }

func newP(path string, now time.Time) (*Persister, *logSink) {
	l := &logSink{}
	return newPersister(path, l.logf, func() time.Time { return now }, 20*time.Millisecond), l
}

func TestSaveThenLoadRestoresEveryCounterButNotCaps(t *testing.T) {
	path := statePath(t)
	p, _ := newP(path, day1)
	chat, emb := NewBudget(100, 50), NewBudget(1000, 0)
	p.Register("chat", chat)
	p.Register("embed", emb)

	chat.Take("acme", day1)
	chat.Take("acme", day1)
	chat.Take("globex", day1)
	chat.Take("", day1)
	if ok, _ := chat.TakeAgent("agent:hermes", 10, 0, day1); !ok {
		t.Fatal("agent take refused")
	}
	for i := 0; i < 7; i++ {
		emb.Take("", day1)
	}
	if err := p.Flush(); err != nil {
		t.Fatal(err)
	}

	// A new process: fresh budgets with DIFFERENT caps (a console override or env change).
	p2, _ := newP(path, day1.Add(time.Hour))
	chat2, emb2 := NewBudget(9, 3), NewBudget(77, 0)
	p2.Register("chat", chat2)
	p2.Register("embed", emb2)

	used, cap, tenants, perTenant := chat2.Snapshot(day1)
	if used != 5 || tenants != 3 { // acme, globex, agent:hermes
		t.Fatalf("chat restored used=%d tenants=%d, want 5 and 3", used, tenants)
	}
	if cap != 9 || perTenant != 3 {
		t.Fatalf("caps must come from the constructor, not the file: cap=%d perTenant=%d", cap, perTenant)
	}
	bd := chat2.Breakdown(day1)
	if bd.Tenants["acme"] != 2 || bd.Tenants["globex"] != 1 || bd.Tenants["agent:hermes"] != 1 {
		t.Fatalf("per-scope counts not restored: %v", bd.Tenants)
	}
	if u, _ := chat2.AgentUsage("agent:hermes", 10, day1); u != 1 {
		t.Fatalf("agent usage = %d, want 1", u)
	}
	if eu, ecap, _, _ := emb2.Snapshot(day1); eu != 7 || ecap != 77 {
		t.Fatalf("embed restored used=%d cap=%d, want 7 and 77", eu, ecap)
	}
	// Chat and embed never cross: the embed budget holds none of the chat scopes.
	if len(emb2.Breakdown(day1).Tenants) != 0 {
		t.Fatalf("embed budget picked up chat scopes: %v", emb2.Breakdown(day1).Tenants)
	}
	// The restored count is enforced: acme had 2, a per-tenant cap of 3 leaves one more.
	if ok, _ := chat2.Take("acme", day1); !ok {
		t.Fatal("third acme call should fit under perTenantCap 3")
	}
	if ok, scope := chat2.Take("acme", day1); ok || scope != "tenant" {
		t.Fatalf("fourth acme call should hit the tenant cap, got ok=%v scope=%q", ok, scope)
	}
}

func TestFileHoldsCountsAndDayNeverCaps(t *testing.T) {
	path := statePath(t)
	p, _ := newP(path, day1)
	b := NewBudget(123, 45)
	b.EnableDR(day1, time.Hour, 999)
	p.Register("chat", b)
	b.Take("acme", day1)
	if err := p.Flush(); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	for _, forbidden := range []string{"123", "45", "999", "dr", "cap"} {
		if strings.Contains(strings.ToLower(string(raw)), forbidden) {
			t.Fatalf("state file leaks %q: %s", forbidden, raw)
		}
	}
	p2, _ := newP(path, day1)
	b2 := NewBudget(10, 5)
	p2.Register("chat", b2)
	if b2.DRModeActive(day1) {
		t.Fatal("DR state must not be restored")
	}
}

func TestStaleCorruptMissingStartFromZero(t *testing.T) {
	yesterday := day1.Add(-24 * time.Hour)
	cases := map[string]func(t *testing.T, path string) (want string){
		"stale": func(t *testing.T, path string) string {
			p, _ := newP(path, yesterday)
			b := NewBudget(100, 50)
			p.Register("chat", b)
			b.Take("acme", yesterday)
			if err := p.Flush(); err != nil {
				t.Fatal(err)
			}
			return "not today"
		},
		"corrupt": func(t *testing.T, path string) string {
			_ = os.MkdirAll(filepath.Dir(path), 0o755)
			_ = os.WriteFile(path, []byte(`{"version":1,"budgets":{"chat":{"day":"2026-1`), 0o600)
			return "corrupt"
		},
		"wrong-shape": func(t *testing.T, path string) string {
			_ = os.MkdirAll(filepath.Dir(path), 0o755)
			_ = os.WriteFile(path, []byte(`[1,2,3]`), 0o600)
			return "corrupt"
		},
		"missing": func(t *testing.T, path string) string { return "no file" },
	}
	for name, prep := range cases {
		t.Run(name, func(t *testing.T) {
			path := statePath(t)
			want := prep(t, path)
			p, l := newP(path, day1)
			b := NewBudget(100, 50)
			p.Register("chat", b)
			if used, _, tenants, _ := b.Snapshot(day1); used != 0 || tenants != 0 {
				t.Fatalf("expected zero counts, got used=%d tenants=%d", used, tenants)
			}
			if l.count() != 1 || !strings.Contains(l.lines[0], want) {
				t.Fatalf("want exactly one log line mentioning %q, got %v", want, l.lines)
			}
			// It must still work, and the old file must not seed today.
			if ok, _ := b.Take("acme", day1); !ok {
				t.Fatal("take refused after a bad state file")
			}
			if used, _, _, _ := b.Snapshot(day1); used != 1 {
				t.Fatalf("used=%d, want 1", used)
			}
		})
	}
}

func TestPersistenceOffWritesNothing(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("GATEWAY_BUDGET_STATE_FILE", "")
	if got := StatePathFromEnv(); got != "" {
		t.Fatalf("explicit empty must mean off, got %q", got)
	}
	p := NewPersister(StatePathFromEnv(), nil)
	if p != nil {
		t.Fatal("empty path must give a nil (off) persister")
	}
	b := NewBudget(10, 5)
	p.Register("chat", b) // nil-safe
	b.Take("acme", day1)
	if err := p.Flush(); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	p.Run(ctx) // returns at once
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatalf("persistence off wrote files: %v", entries)
	}
}

func TestStatePathFromEnv(t *testing.T) {
	t.Setenv("GATEWAY_BUDGET_STATE_FILE", "/x/y.json")
	if got := StatePathFromEnv(); got != "/x/y.json" {
		t.Fatalf("got %q", got)
	}
	// Unset: the default. t.Setenv already registered the restore; unsetting after it is safe.
	if err := os.Unsetenv("GATEWAY_BUDGET_STATE_FILE"); err != nil {
		t.Fatal(err)
	}
	if got := StatePathFromEnv(); got != "data/budget-state.json" {
		t.Fatalf("default path = %q", got)
	}
}

func TestNoWriteWhenNothingChanged(t *testing.T) {
	path := statePath(t)
	p, _ := newP(path, day1)
	b := NewBudget(100, 50)
	p.Register("chat", b)
	if err := p.Flush(); err != nil || p.writes.Load() != 0 {
		t.Fatalf("an unused budget must not write: err=%v writes=%d", err, p.writes.Load())
	}
	if _, err := os.Stat(path); err == nil {
		t.Fatal("file exists though nothing was taken")
	}
	b.Take("acme", day1)
	_ = p.Flush()
	_ = p.Flush()
	_ = p.Flush()
	if p.writes.Load() != 1 {
		t.Fatalf("unchanged counters must not rewrite: writes=%d", p.writes.Load())
	}
	b.Take("acme", day1)
	_ = p.Flush()
	if p.writes.Load() != 2 {
		t.Fatalf("a change must write once: writes=%d", p.writes.Load())
	}
}

func TestRestoredFileIsNotRewrittenUntilSomethingChanges(t *testing.T) {
	path := statePath(t)
	p, _ := newP(path, day1)
	b := NewBudget(100, 50)
	p.Register("chat", b)
	b.Take("acme", day1)
	_ = p.Flush()

	p2, _ := newP(path, day1)
	b2 := NewBudget(100, 50)
	p2.Register("chat", b2)
	_ = p2.Flush()
	if p2.writes.Load() != 0 {
		t.Fatalf("a freshly restored, unchanged budget must not rewrite the file: writes=%d", p2.writes.Load())
	}
}

func TestDebounceManyTakesOneWritePerWindow(t *testing.T) {
	path := statePath(t)
	p := newPersister(path, nil, func() time.Time { return day1 }, 150*time.Millisecond)
	b := NewBudget(1_000_000, 1_000_000)
	p.Register("chat", b)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { p.Run(ctx); close(done) }()

	for i := 0; i < 5000; i++ { // a burst, far faster than the window
		b.Take("acme", day1)
	}
	deadline := time.Now().Add(3 * time.Second)
	for p.writes.Load() < 1 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if p.writes.Load() != 1 {
		t.Fatalf("burst should produce exactly one write, got %d", p.writes.Load())
	}
	time.Sleep(500 * time.Millisecond) // several idle windows: still nothing new
	if p.writes.Load() != 1 {
		t.Fatalf("idle windows must not write, got %d", p.writes.Load())
	}
	cancel()
	<-done
	if p.writes.Load() != 1 { // the shutdown flush found nothing changed
		t.Fatalf("shutdown flush with no change must not write, got %d", p.writes.Load())
	}
	st := readState(t, path)
	if st.Budgets["chat"].Global != 5000 || st.Budgets["chat"].Counts["acme"] != 5000 {
		t.Fatalf("file holds %+v", st.Budgets["chat"])
	}
}

func TestShutdownFlushWritesLatestCounts(t *testing.T) {
	path := statePath(t)
	// An interval far longer than the test: only the shutdown flush can write.
	p := newPersister(path, nil, func() time.Time { return day1 }, time.Hour)
	b := NewBudget(100, 50)
	p.Register("chat", b)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { p.Run(ctx); close(done) }()
	b.Take("acme", day1)
	b.Take("acme", day1)
	b.Take("", day1)
	if _, err := os.Stat(path); err == nil {
		t.Fatal("nothing should be written before the interval or shutdown")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("Run did not return after its context ended")
	}
	st := readState(t, path)
	if c := st.Budgets["chat"]; c.Global != 3 || c.Counts["acme"] != 2 || c.Day != "2026-10-30" {
		t.Fatalf("shutdown flush wrote %+v", c)
	}
}

func TestAtomicWriteTempInSameDirAndAlwaysCompleteJSON(t *testing.T) {
	path := statePath(t)
	dir := filepath.Dir(path)
	if err := writeAtomic(path, []byte(`{"version":1,"budgets":{}}`)); err != nil {
		t.Fatal(err)
	}
	// While the writer replaces the file over and over, a reader must never see a partial file,
	// and no temp file may linger afterwards.
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; ; i++ {
			select {
			case <-stop:
				return
			default:
			}
			payload, _ := json.Marshal(stateFile{Version: 1, Budgets: map[string]budgetState{
				"chat": {Day: "2026-10-30", Global: i, Counts: map[string]int{"acme": i}},
			}})
			if err := writeAtomic(path, payload); err != nil {
				if runtime.GOOS == "windows" {
					continue // Windows denies a rename while the reader holds the file open; Flush retries next tick
				}
				t.Errorf("write: %v", err)
				return
			}
		}
	}()
	for i := 0; i < 300; i++ {
		raw, err := os.ReadFile(path)
		if err != nil {
			continue // Windows can briefly deny an open during a rename; never a partial read
		}
		var sf stateFile
		if err := json.Unmarshal(raw, &sf); err != nil {
			t.Fatalf("reader saw a partial file: %v: %q", err, raw)
		}
	}
	close(stop)
	wg.Wait()
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 || entries[0].Name() != "budget-state.json" {
		t.Fatalf("temp files left behind in the state dir: %v", entries)
	}
	if info, _ := os.Stat(path); info != nil && os.PathSeparator == '/' && info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v, want 0600", info.Mode().Perm())
	}
}

func TestAtomicWriteFailureKeepsOldFileAndLeavesNoTemp(t *testing.T) {
	path := statePath(t)
	if err := writeAtomic(path, []byte("old")); err != nil {
		t.Fatal(err)
	}
	// The target is a non-empty directory: the rename must fail, the old file must survive, and
	// no temp file may remain.
	bad := filepath.Join(filepath.Dir(path), "isdir")
	if err := os.MkdirAll(filepath.Join(bad, "child"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := writeAtomic(bad, []byte("new")); err == nil {
		t.Fatal("expected an error writing over a non-empty directory")
	}
	entries, _ := os.ReadDir(filepath.Dir(path))
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") {
			t.Fatalf("temp file left behind: %s", e.Name())
		}
	}
	if raw, _ := os.ReadFile(path); string(raw) != "old" {
		t.Fatalf("old file damaged: %q", raw)
	}
}

func TestDayRolloverStillResetsAndOldFileNeverSeedsToday(t *testing.T) {
	path := statePath(t)
	p, _ := newP(path, day1)
	b := NewBudget(100, 50)
	p.Register("chat", b)
	b.Take("acme", day1)
	_ = p.Flush()

	// The same process crosses UTC midnight: counts reset, and the next flush records the new day.
	next := time.Date(2026, 10, 31, 0, 0, 1, 0, time.UTC)
	b.Take("globex", next)
	if used, _, tenants, _ := b.Snapshot(next); used != 1 || tenants != 1 {
		t.Fatalf("rollDay must reset: used=%d tenants=%d", used, tenants)
	}
	_ = p.Flush()
	st := readState(t, path)
	if c := st.Budgets["chat"]; c.Day != "2026-10-31" || c.Global != 1 || c.Counts["acme"] != 0 {
		t.Fatalf("flush after rollover wrote %+v", c)
	}

	// A restart on yet another day ignores that file.
	later := next.Add(24 * time.Hour)
	p3, _ := newP(path, later)
	b3 := NewBudget(100, 50)
	p3.Register("chat", b3)
	if used, _, _, _ := b3.Snapshot(later); used != 0 {
		t.Fatalf("an old day's file seeded today: used=%d", used)
	}
}

func TestRestoreSanitizesNegativeCounts(t *testing.T) {
	path := statePath(t)
	_ = os.MkdirAll(filepath.Dir(path), 0o755)
	raw := `{"version":1,"budgets":{"chat":{"day":"2026-10-30","global":-4,"counts":{"a":-1,"b":2}}}}`
	_ = os.WriteFile(path, []byte(raw), 0o600)
	p, _ := newP(path, day1)
	b := NewBudget(100, 50)
	p.Register("chat", b)
	used, _, tenants, _ := b.Snapshot(day1)
	if used != 0 || tenants != 1 {
		t.Fatalf("used=%d tenants=%d, want 0 and 1", used, tenants)
	}
}

// Many goroutines Take (and read) while the writer snapshots and writes: meaningful under -race, and
// the final file must equal the final counts.
func TestConcurrentTakesWhileWriterSnapshots(t *testing.T) {
	path := statePath(t)
	p := newPersister(path, nil, time.Now, time.Millisecond)
	chat, emb := NewBudget(1_000_000, 1_000_000), NewBudget(1_000_000, 0)
	p.Register("chat", chat)
	p.Register("embed", emb)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { p.Run(ctx); close(done) }()

	const workers, per = 16, 400
	now := time.Now()
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			tenant := []string{"a", "b", "c", ""}[w%4]
			for i := 0; i < per; i++ {
				switch i % 4 {
				case 0:
					chat.Take(tenant, now)
				case 1:
					chat.TakeAgent("agent:x", 0, 0, now)
				case 2:
					emb.Take("", now)
				default:
					_ = chat.Breakdown(now)
					_ = p.Flush() // a second flusher racing the loop, as shutdown does
				}
			}
		}(w)
	}
	wg.Wait()
	cancel()
	<-done

	st := readState(t, path)
	cu, _, _, _ := chat.Snapshot(now)
	eu, _, _, _ := emb.Snapshot(now)
	if st.Budgets["chat"].Global != cu || cu != workers*per/2 {
		t.Fatalf("chat file=%d live=%d want %d", st.Budgets["chat"].Global, cu, workers*per/2)
	}
	if st.Budgets["embed"].Global != eu || eu != workers*per/4 {
		t.Fatalf("embed file=%d live=%d want %d", st.Budgets["embed"].Global, eu, workers*per/4)
	}
}

func readState(t *testing.T, path string) stateFile {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read state: %v", err)
	}
	var sf stateFile
	if err := json.Unmarshal(raw, &sf); err != nil {
		t.Fatalf("state is not complete JSON: %v: %q", err, raw)
	}
	return sf
}
