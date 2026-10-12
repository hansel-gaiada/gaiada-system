package store

import (
	"context"
	"io/fs"
	"log/slog"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"gaiada/insights-collector/internal/stats"
	"gaiada/insights-collector/migrations"
)

// A schema test: no column anywhere in vdb may hold an IP address or a user agent (design 3.2 step 6; V3-b's
// acceptance repeats it for the consented tables). Migration files are read as text.
func TestNoMigrationDeclaresAnAddressOrUserAgentColumn(t *testing.T) {
	forbidden := regexp.MustCompile(`(?i)\b(ip|ip_addr|ip_address|ipaddr|remote_addr|client_ip|x_real_ip|x_forwarded_for|user_agent|useragent|ua|inet|cidr|macaddr)\b`)
	quoted := regexp.MustCompile(`'[^']*'`)
	entries, err := fs.ReadDir(migrations.FS, ".")
	if err != nil || len(entries) == 0 {
		t.Fatalf("no migrations: %v", err)
	}
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".sql") {
			continue
		}
		b, _ := fs.ReadFile(migrations.FS, e.Name())
		for i, line := range strings.Split(string(b), "\n") {
			code := line
			if c := strings.Index(code, "--"); c >= 0 {
				code = code[:c] // comments may say "no IP column"
			}
			code = quoted.ReplaceAllString(code, "''") // 'ua' is a bot_counts.reason VALUE, not a column
			if m := forbidden.FindString(code); m != "" {
				t.Errorf("%s line %d declares or mentions %q: %s", e.Name(), i+1, m, strings.TrimSpace(line))
			}
		}
	}
}

func TestMigrationsHoldNoDML(t *testing.T) {
	dml := regexp.MustCompile(`(?im)^\s*(insert|update|delete|truncate)\b`)
	entries, _ := fs.ReadDir(migrations.FS, ".")
	for _, e := range entries {
		b, _ := fs.ReadFile(migrations.FS, e.Name())
		if dml.Match(b) {
			t.Errorf("%s contains DML; migrations are DDL only", e.Name())
		}
	}
}

func counter() (*BotCounter, *Memory, *stats.Counters) {
	m := NewMemory()
	c := &stats.Counters{}
	return NewBotCounter(m, slog.New(slog.DiscardHandler), c), m, c
}

func TestBotCounterAggregatesPerWebsiteDayReason(t *testing.T) {
	b, m, _ := counter()
	d1 := time.Date(2026, 10, 12, 23, 59, 0, 0, time.UTC)
	d2 := d1.Add(2 * time.Minute) // next UTC day
	for i := 0; i < 3; i++ {
		b.Record("w1", "ua", d1)
	}
	b.Record("w1", "asn", d1)
	b.Record("w1", "ua", d2)
	b.Record("w2", "ua", d1)
	if b.Pending() != 6 {
		t.Fatalf("pending %d", b.Pending())
	}
	if err := b.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(m.Calls) != 4 || b.Pending() != 0 {
		t.Fatalf("rows %+v pending %d", m.Calls, b.Pending())
	}
	// A second flush with nothing pending writes nothing.
	if err := b.Flush(context.Background()); err != nil || len(m.Calls) != 4 {
		t.Fatalf("idempotent flush: %v %d", err, len(m.Calls))
	}
	// A restart-free retry cannot double count: counts leave `pending` only when the write succeeded.
	b.Record("w1", "ua", d1)
	m.Down = true
	_ = b.Flush(context.Background())
	_ = b.Flush(context.Background())
	m.Down = false
	if err := b.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	var total int64
	for _, c := range m.Calls {
		if c.Website == "w1" && c.Reason == "ua" && c.Day.Day() == 12 {
			total += c.Count
		}
	}
	if total != 4 { // 3 + 1
		t.Errorf("w1/ua/12th total %d, want 4", total)
	}
}

func TestBotCounterRunFlushesOnTickAndOnShutdown(t *testing.T) {
	b, m, _ := counter()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { b.Run(ctx, 20*time.Millisecond); close(done) }()
	b.Record("w1", "ua", time.Now())
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		m.mu.Lock()
		n := len(m.Calls)
		m.mu.Unlock()
		if n > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	b.Record("w1", "asn", time.Now())
	cancel()
	<-done
	if b.Pending() != 0 {
		t.Errorf("shutdown must flush what is pending, %d left", b.Pending())
	}
}

// Real Postgres: needs a vdb-like database, so it runs on the Linux gate only. TEST_DATABASE_URL must point at
// a scratch database; the test creates and uses the vdb schema in it.
func TestPostgresMigrateAndCounts(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set: needs the Linux gate (no Postgres on the laptop)")
	}
	ctx := context.Background()
	p, err := OpenPostgres(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	if err := p.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	// Migrating twice is a no-op.
	if err := Migrate(ctx, p.pool); err != nil {
		t.Fatal(err)
	}
	site := "aaaaaaaa-0000-4000-8000-" + time.Now().UTC().Format("150405000000")
	day := time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)
	for i := 0; i < 2; i++ { // two flushes add up
		if err := p.AddBotCounts(ctx, []BotCount{{Website: site, Day: day, Reason: "ua", Count: 3}, {Website: site, Day: day, Reason: "asn", Count: 1}}); err != nil {
			t.Fatal(err)
		}
	}
	rows, err := p.BotCounts(ctx, site, day, day)
	if err != nil || len(rows) != 2 || rows[0].Reason != "asn" || rows[0].Count != 2 || rows[1].Reason != "ua" || rows[1].Count != 6 {
		t.Fatalf("rows %+v %v", rows, err)
	}
	// The schema has no address/user-agent column, checked against the live catalogue.
	cols, err := p.pool.Query(ctx, `SELECT table_name || '.' || column_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name ~* '(^|_)(ip|ua|user_agent|address|addr)($|_)'`)
	if err != nil {
		t.Fatal(err)
	}
	defer cols.Close()
	for cols.Next() {
		var c string
		_ = cols.Scan(&c)
		t.Errorf("forbidden column in vdb: %s", c)
	}
	if _, err := p.pool.Exec(ctx, `DELETE FROM bot_counts WHERE website = $1`, site); err != nil {
		t.Fatal(err)
	}
}
