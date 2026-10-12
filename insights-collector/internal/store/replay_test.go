package store

import (
	"context"
	"fmt"
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

// V6-a acceptance: a schema test proves the replay tables have no IP or user-agent column. The generic scan in
// store_test.go covers every migration; this pins what 0003 DOES declare, so a column added later has to be looked at.
func TestReplayMigrationDeclaresExactlyTheDesignedColumns(t *testing.T) {
	b, err := fs.ReadFile(migrations.FS, "0003_replay.sql")
	if err != nil {
		t.Fatal(err)
	}
	var code strings.Builder
	for _, line := range strings.Split(string(b), "\n") {
		if c := strings.Index(line, "--"); c >= 0 {
			line = line[:c]
		}
		code.WriteString(line + "\n")
	}
	columns := func(table string) []string {
		m := regexp.MustCompile(`(?is)CREATE TABLE IF NOT EXISTS ` + table + ` \((.*?)\n\);`).FindStringSubmatch(code.String())
		if m == nil {
			t.Fatalf("%s not found in 0003", table)
		}
		var cols []string
		for _, line := range strings.Split(m[1], "\n") {
			f := strings.Fields(strings.TrimSpace(line))
			if len(f) < 2 || strings.EqualFold(f[0], "CONSTRAINT") || strings.EqualFold(f[0], "PRIMARY") {
				continue
			}
			cols = append(cols, f[0])
		}
		return cols
	}
	want := map[string]string{
		"replay_sessions": "id,website,visitor_id,consent_id,started_at,last_chunk_at,chunks,bytes,pages",
		"replay_chunks":   "session_id,seq,received_at,bytes,data",
	}
	addr := regexp.MustCompile(`(?i)(^|_)(ip|ua|user_agent|useragent|address|addr|inet|cidr|agent|remote|client)($|_)`)
	for table, w := range want {
		cols := columns(table)
		if strings.Join(cols, ",") != w {
			t.Errorf("columns of %s:\n got %v\nwant %s", table, cols, w)
		}
		for _, c := range cols {
			if addr.MatchString(c) {
				t.Errorf("%s.%s looks like an address or a user agent", table, c)
			}
		}
	}
	if !strings.Contains(code.String(), "ON DELETE CASCADE") {
		t.Error("replay_chunks must cascade from replay_sessions (a forget and the purge delete the session row only)")
	}
}

// V6-a acceptance: the backup holds no replay data. backup.sh excludes the DATA of both tables by their exact names and
// refuses a dump that still has a COPY block for either; this reads the script so a rename on either side fails here.
func TestBackupScriptExcludesTheReplayTablesByTheirExactNames(t *testing.T) {
	b, err := os.ReadFile("../../../infra/sumopod/umami/backup.sh")
	if err != nil {
		t.Fatalf("backup.sh must be readable from the repository checkout (CI checks the whole repo out): %v", err)
	}
	script := string(b)
	var tables []string
	for _, name := range []string{"0001_bot_counts_tombstones.sql", "0002_consented_events.sql", "0003_replay.sql"} {
		sql, _ := fs.ReadFile(migrations.FS, name)
		for _, m := range regexp.MustCompile(`(?i)CREATE TABLE IF NOT EXISTS (\w+)`).FindAllStringSubmatch(string(sql), -1) {
			tables = append(tables, m[1])
		}
	}
	personal := map[string]bool{"consented_events": true, "replay_sessions": true, "replay_chunks": true}
	for _, tb := range tables {
		excluded := strings.Contains(script, "--exclude-table-data="+tb)
		if personal[tb] && !excluded {
			t.Errorf("backup.sh does not pass --exclude-table-data=%s", tb)
		}
		if !personal[tb] && excluded {
			t.Errorf("backup.sh excludes %s, which is meant to be backed up", tb)
		}
		delete(personal, tb)
	}
	for tb := range personal {
		t.Errorf("table %s is named in backup.sh but no migration creates it: renamed?", tb)
	}
	guard := regexp.MustCompile(`grep -qE '\^COPY public\\\.\(([a-z_|]+)\) '`).FindStringSubmatch(script)
	if guard == nil {
		t.Fatal("the COPY-block guard is missing from backup.sh")
	}
	for _, tb := range []string{"consented_events", "replay_sessions", "replay_chunks"} {
		if !strings.Contains("|"+guard[1]+"|", "|"+tb+"|") {
			t.Errorf("the COPY guard does not cover %s", tb)
		}
	}
	// What IS backed up must stay: the aggregate counts and the tombstone hashes.
	for _, tb := range []string{"bot_counts", "tombstones"} {
		if strings.Contains(script, "--exclude-table-data="+tb) {
			t.Errorf("%s must be in the backup", tb)
		}
	}
}

func rc(rec string, seq int, at time.Time, size int, pages ...string) ReplayChunk {
	return ReplayChunk{
		Website: "11111111-2222-3333-4444-555555555555", VisitorID: "aaaaaaaa-0000-4000-8000-000000000001",
		ConsentID: "bbbbbbbb-0000-4000-8000-000000000001", RecordingID: rec, Seq: seq, Data: make([]byte, size), Pages: pages, ReceivedAt: at,
	}
}

// replayContract is what the Memory store and Postgres must both satisfy. `ids` makes unique ids per call so a shared
// database can be reused across runs.
func replayContract(t *testing.T, st interface {
	ReplayStore
	EventStore
}, website string, now time.Time, ids func(n int) string) {
	t.Helper()
	ctx := context.Background()
	v1, v2, c1, c2 := ids(1), ids(2), ids(3), ids(4)
	r1, r2, r3, r4 := ids(5), ids(6), ids(7), ids(8)
	big := ReplayLimits{BudgetBytes: 1 << 30, SiteDaily: 1000, VisitorDaily: 1000}
	chunk := func(v, c, rec string, seq int, at time.Time, size int, pages ...string) ReplayChunk {
		return ReplayChunk{Website: website, VisitorID: v, ConsentID: c, RecordingID: rec, Seq: seq, Data: make([]byte, size), Pages: pages, ReceivedAt: at}
	}
	must := func(res ReplayChunkResult, err error, want ChunkOutcome, what string) {
		t.Helper()
		if err != nil || res.Outcome != want {
			t.Fatalf("%s: outcome %v refusal %q err %v, want %v", what, res.Outcome, res.Refusal, err, want)
		}
	}
	refused := func(res ReplayChunkResult, err error, why, what string) {
		t.Helper()
		if err != nil || res.Outcome != ChunkRefused || res.Refusal != why {
			t.Fatalf("%s: outcome %v refusal %q err %v, want refused %q", what, res.Outcome, res.Refusal, err, why)
		}
	}

	// A recording of two chunks, with pages merged in order and without repeats.
	res, err := st.AddReplayChunk(ctx, chunk(v1, c1, r1, 0, now, 100, "/a/", "/b/"), big)
	must(res, err, ChunkStored, "first chunk")
	res, err = st.AddReplayChunk(ctx, chunk(v1, c1, r1, 1, now.Add(10*time.Second), 50, "/b/", "/c/"), big)
	must(res, err, ChunkStored, "second chunk")
	// A repeat of a stored chunk changes nothing.
	res, err = st.AddReplayChunk(ctx, chunk(v1, c1, r1, 1, now.Add(20*time.Second), 50, "/zzz/"), big)
	must(res, err, ChunkDuplicate, "repeat")

	list, err := st.ReplaySessions(ctx, website, v1, 10)
	if err != nil || len(list) != 1 {
		t.Fatalf("list: %+v %v", list, err)
	}
	s := list[0]
	if s.ID != r1 || s.VisitorID != v1 || s.ConsentID != c1 || s.Chunks != 2 || s.Bytes != 150 ||
		strings.Join(s.Pages, ",") != "/a/,/b/,/c/" || !s.StartedAt.Equal(now) || !s.LastChunkAt.Equal(now.Add(10*time.Second)) {
		t.Errorf("session: %+v", s)
	}
	if other, _ := st.ReplaySessions(ctx, website, v2, 10); len(other) != 0 {
		t.Errorf("another visitor's list: %+v", other)
	}

	// Content, in seq order, paged by `after`.
	sess, chunks, found, err := st.ReplayChunksAfter(ctx, website, r1, -1, 10)
	if err != nil || !found || len(chunks) != 2 || chunks[0].Seq != 0 || chunks[1].Seq != 1 || chunks[0].Bytes != 100 || len(chunks[0].Data) != 100 || sess.ID != r1 {
		t.Fatalf("chunks: %+v found=%v %v", chunks, found, err)
	}
	if _, rest, _, _ := st.ReplayChunksAfter(ctx, website, r1, 0, 10); len(rest) != 1 || rest[0].Seq != 1 {
		t.Errorf("after 0: %+v", rest)
	}
	if _, one, _, _ := st.ReplayChunksAfter(ctx, website, r1, -1, 1); len(one) != 1 {
		t.Errorf("limit 1: %+v", one)
	}
	// A recording id of another website is not found.
	if _, _, found, _ := st.ReplayChunksAfter(ctx, ids(99), r1, -1, 10); found {
		t.Error("a recording must not be readable through another website")
	}
	if _, _, found, _ := st.ReplayChunksAfter(ctx, website, ids(98), -1, 10); found {
		t.Error("an unknown recording was found")
	}

	// A recording id owned by another visitor or consent id is refused, and nothing is written.
	res, err = st.AddReplayChunk(ctx, chunk(v2, c1, r1, 2, now, 10), big)
	must(res, err, ChunkMismatch, "other visitor")
	res, err = st.AddReplayChunk(ctx, chunk(v1, c2, r1, 2, now, 10), big)
	must(res, err, ChunkMismatch, "other consent")
	if list, _ := st.ReplaySessions(ctx, website, v1, 10); list[0].Chunks != 2 {
		t.Errorf("a mismatch wrote a chunk: %+v", list[0])
	}

	// Per-recording caps: bytes, duration, chunk count.
	res, err = st.AddReplayChunk(ctx, chunk(v1, c1, r1, 2, now.Add(time.Minute), ReplaySessionMaxBytes), big)
	refused(res, err, RefusedSessionBytes, "past 5 MB")
	res, err = st.AddReplayChunk(ctx, chunk(v1, c1, r1, 2, now.Add(ReplaySessionMaxDuration+time.Second), 10), big)
	refused(res, err, RefusedSessionDuration, "past 30 minutes")
	res, err = st.AddReplayChunk(ctx, chunk(v1, c1, r1, 2, now.Add(ReplaySessionMaxDuration), 10), big)
	must(res, err, ChunkStored, "exactly 30 minutes is still inside")
	// A repeat of a stored chunk at a cap is still a duplicate, not a refusal (a retry must not stop the recorder).
	res, err = st.AddReplayChunk(ctx, chunk(v1, c1, r1, 0, now.Add(time.Hour), 100), big)
	must(res, err, ChunkDuplicate, "repeat past the duration cap")

	if _, err := st.AddReplayChunk(ctx, chunk(v2, c2, r2, 0, now, 10), big); err != nil {
		t.Fatal(err)
	}
	for seq := 1; seq < ReplaySessionMaxChunks; seq++ {
		if res, err := st.AddReplayChunk(ctx, chunk(v2, c2, r2, seq, now.Add(time.Second), 1), big); err != nil || res.Outcome != ChunkStored {
			t.Fatalf("seq %d: %v %v", seq, res, err)
		}
	}
	res, err = st.AddReplayChunk(ctx, chunk(v2, c2, r2, ReplaySessionMaxChunks, now.Add(time.Second), 1), big)
	refused(res, err, RefusedSessionChunks, "past the chunk count")

	// New-recording caps: per visitor and per site, over a rolling 24 hours, and the budget (a hard cap).
	day := now.Add(48 * time.Hour) // clear of everything above
	lim := ReplayLimits{BudgetBytes: 1 << 30, SiteDaily: 1000, VisitorDaily: 2}
	v3, c3 := ids(10), ids(11)
	for i := 0; i < 2; i++ {
		res, err = st.AddReplayChunk(ctx, chunk(v3, c3, ids(20+i), 0, day, 10), lim)
		must(res, err, ChunkStored, fmt.Sprintf("visitor recording %d", i))
	}
	res, err = st.AddReplayChunk(ctx, chunk(v3, c3, ids(22), 0, day, 10), lim)
	refused(res, err, RefusedVisitorDaily, "third recording of one visitor")
	res, err = st.AddReplayChunk(ctx, chunk(v3, c3, ids(20), 1, day.Add(time.Second), 10), lim)
	must(res, err, ChunkStored, "an existing recording is not a new recording")
	res, err = st.AddReplayChunk(ctx, chunk(v3, c3, ids(22), 0, day.Add(25*time.Hour), 10), lim)
	must(res, err, ChunkStored, "a day later")

	// Everything this website has stored in the 24 hours before `later` counts for the site cap.
	later := day.Add(25 * time.Hour)
	var inWindow int
	for _, v := range []string{v1, v2, v3} {
		all, _ := st.ReplaySessions(ctx, website, v, 100)
		for _, x := range all {
			if !x.StartedAt.Before(later.Add(-ReplayDailyWindow)) {
				inWindow++
			}
		}
	}
	siteLim := ReplayLimits{BudgetBytes: 1 << 30, SiteDaily: inWindow, VisitorDaily: 1000}
	res, err = st.AddReplayChunk(ctx, chunk(ids(30), ids(31), ids(32), 0, later, 10), siteLim)
	refused(res, err, RefusedSiteDaily, "past the site's daily count")

	// The budget: used bytes + this chunk may not pass it, for a new recording or an existing one.
	var used int64
	for _, v := range []string{v1, v2, v3} {
		all, _ := st.ReplaySessions(ctx, website, v, 100)
		for _, x := range all {
			used += x.Bytes
		}
	}
	tight := ReplayLimits{BudgetBytes: used + 9, SiteDaily: 1000, VisitorDaily: 1000}
	res, err = st.AddReplayChunk(ctx, chunk(ids(40), ids(41), ids(42), 0, later, 10), tight)
	refused(res, err, RefusedBudget, "new recording past the budget")
	res, err = st.AddReplayChunk(ctx, chunk(v3, c3, ids(22), 1, later.Add(time.Second), 10), tight)
	refused(res, err, RefusedBudget, "existing recording past the budget")
	tight.BudgetBytes = used + 10
	res, err = st.AddReplayChunk(ctx, chunk(v3, c3, ids(22), 1, later.Add(time.Second), 10), tight)
	must(res, err, ChunkStored, "exactly at the budget")
	if after, _ := st.ReplaySessions(ctx, ids(42), ids(41), 1); len(after) != 0 {
		t.Error("a refused new recording left a row")
	}

	// Purge: a recording whose started_at is 31 days old goes (chunks with it), a 29-day-old one stays.
	old, recent := ids(50), ids(51)
	v4, c4 := ids(52), ids(53)
	res, err = st.AddReplayChunk(ctx, chunk(v4, c4, old, 0, later.Add(-31*24*time.Hour), 10), big)
	must(res, err, ChunkStored, "old recording")
	res, err = st.AddReplayChunk(ctx, chunk(v4, c4, recent, 0, later.Add(-29*24*time.Hour), 10), big)
	must(res, err, ChunkStored, "recent recording")
	n, err := st.PurgeReplay(ctx, later.Add(-30*24*time.Hour))
	if err != nil || n < 1 {
		t.Fatalf("purge: %d %v", n, err)
	}
	if _, _, found, _ := st.ReplayChunksAfter(ctx, website, old, -1, 10); found {
		t.Error("a 31-day-old recording survived the purge")
	}
	if _, kept, found, _ := st.ReplayChunksAfter(ctx, website, recent, -1, 10); !found || len(kept) != 1 {
		t.Error("a 29-day-old recording was purged")
	}

	// Forget by visitor id removes that visitor's recordings and chunks and counts them; by consent id too; the pair too.
	if gone, _ := st.InsertEvents(ctx, website, v4, c4, []ConsentedEvent{{ReceivedAt: later, OccurredAt: later, Kind: "pageview", Path: "/", Device: DeviceUnknown}}); gone {
		t.Fatal("unexpected tombstone")
	}
	fr, err := st.Forget(ctx, ForgetRequest{Website: website, VisitorIDs: []string{v4}, Reason: ReasonWithdraw})
	if err != nil || fr.DeletedRecordings != 1 || fr.DeletedEvents != 1 {
		t.Fatalf("forget visitor: %+v %v", fr, err)
	}
	if _, _, found, _ := st.ReplayChunksAfter(ctx, website, recent, -1, 10); found {
		t.Error("forget left the recording")
	}
	again, _ := st.Forget(ctx, ForgetRequest{Website: website, VisitorIDs: []string{v4}, Reason: ReasonWithdraw})
	if again.DeletedRecordings != 0 {
		t.Errorf("repeat forget: %+v", again)
	}
	// A chunk for the tombstoned visitor is refused and writes nothing.
	res, err = st.AddReplayChunk(ctx, chunk(v4, c4, ids(60), 0, later, 10), big)
	must(res, err, ChunkGone, "tombstoned visitor")
	// Consent id.
	res, err = st.AddReplayChunk(ctx, chunk(ids(61), ids(62), r3, 0, later, 10), big)
	must(res, err, ChunkStored, "r3")
	fr, err = st.Forget(ctx, ForgetRequest{Website: website, ConsentIDs: []string{ids(62)}, Reason: ReasonErase})
	if err != nil || fr.DeletedRecordings != 1 {
		t.Fatalf("forget consent: %+v %v", fr, err)
	}
	res, err = st.AddReplayChunk(ctx, chunk(ids(63), ids(62), ids(64), 0, later, 10), big)
	must(res, err, ChunkGone, "tombstoned consent id")
	// The pair (the browser's /f) removes only the exact pair.
	res, err = st.AddReplayChunk(ctx, chunk(ids(70), ids(71), r4, 0, later, 10), big)
	must(res, err, ChunkStored, "r4")
	res, err = st.AddReplayChunk(ctx, chunk(ids(72), ids(73), ids(74), 0, later, 10), big)
	must(res, err, ChunkStored, "r other")
	if _, err := st.ForgetPair(ctx, website, ids(70), ids(73)); err != nil { // wrong consent id: the visitor is tombstoned, but this pair does not match
		t.Fatal(err)
	}
	if _, _, found, _ := st.ReplayChunksAfter(ctx, website, r4, -1, 1); !found {
		t.Error("ForgetPair with a non-matching pair deleted a recording")
	}
	if _, err := st.ForgetPair(ctx, website, ids(72), ids(73)); err != nil {
		t.Fatal(err)
	}
	if _, _, found, _ := st.ReplayChunksAfter(ctx, website, ids(74), -1, 1); found {
		t.Error("ForgetPair left the pair's recording")
	}
}

func TestMemoryReplayStoreContract(t *testing.T) {
	replayContract(t, NewMemory(), "11111111-2222-3333-4444-555555555555", time.Date(2026, 10, 12, 10, 0, 0, 0, time.UTC), func(i int) string {
		return fmt.Sprintf("aaaaaaaa-0000-4000-8000-%012d", i)
	})
}

// V6-a acceptance: a 31-day-old recording is purged by the Purger (the loop's one pass), a 29-day-old one is not.
func TestPurgerDeletesRecordingsOlderThanThirtyDays(t *testing.T) {
	now := time.Date(2026, 10, 12, 10, 0, 0, 0, time.UTC)
	m := NewMemory()
	ctx := context.Background()
	big := ReplayLimits{BudgetBytes: 1 << 30, SiteDaily: 1000, VisitorDaily: 1000}
	for i, age := range []time.Duration{31 * 24 * time.Hour, 30*24*time.Hour + time.Minute, 29 * 24 * time.Hour, time.Hour} {
		rec := fmt.Sprintf("eeeeeeee-0000-4000-8000-%012d", i)
		if res, err := m.AddReplayChunk(ctx, rc(rec, 0, now.Add(-age), 10, "/a/"), big); err != nil || res.Outcome != ChunkStored {
			t.Fatal(res, err)
		}
	}
	c := &stats.Counters{}
	p := &Purger{St: m, Log: slog.New(slog.DiscardHandler), Stats: c, Retention: 72 * time.Hour, ReplayRetention: 30 * 24 * time.Hour, TombstoneMonths: 14, Now: func() time.Time { return now }}
	if _, _, err := p.Once(ctx); err != nil {
		t.Fatal(err)
	}
	left := m.ReplaySessionsAll()
	if len(left) != 2 || m.ReplayChunkCount() != 2 {
		t.Fatalf("recordings left: %+v (chunks %d)", left, m.ReplayChunkCount())
	}
	for _, s := range left {
		if now.Sub(s.StartedAt) > 30*24*time.Hour {
			t.Errorf("an expired recording survived: %+v", s)
		}
	}
	if c.PurgedRecordings.Load() != 2 {
		t.Errorf("counter %d", c.PurgedRecordings.Load())
	}
	// A pass again deletes nothing. A ReplayRetention of 0 never purges recordings (not what the config yields).
	if _, _, err := p.Once(ctx); err != nil || c.PurgedRecordings.Load() != 2 {
		t.Errorf("second pass: %v %d", err, c.PurgedRecordings.Load())
	}
	// vdb down: an error and a failure count.
	m.Down = true
	if _, _, err := p.Once(ctx); err == nil || c.PurgeFailures.Load() == 0 {
		t.Errorf("down: %v %d", err, c.PurgeFailures.Load())
	}
	// A failing buffer purge must not stop the recording purge, and the reverse holds too: each retention is its own promise.
	m2 := NewMemory()
	_, _ = m2.AddReplayChunk(ctx, rc("eeeeeeee-0000-4000-8000-0000000000aa", 0, now.Add(-40*24*time.Hour), 10), big)
	p2 := &Purger{St: m2, Log: slog.New(slog.DiscardHandler), Retention: 72 * time.Hour, ReplayRetention: 30 * 24 * time.Hour, TombstoneMonths: 14, Now: func() time.Time { return now }}
	if _, _, err := p2.Once(ctx); err != nil || len(m2.ReplaySessionsAll()) != 0 {
		t.Errorf("without stats: %v %d", err, len(m2.ReplaySessionsAll()))
	}
}

// Real Postgres (CI's service container; there is NO Postgres on the laptop): the same contract, plus the catalogue.
func TestPostgresReplay(t *testing.T) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set: needs the Linux gate or CI (no Postgres on the laptop)")
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
	stamp := time.Now().UTC().Format("150405000000")
	website := "c0c0c0c0-0000-4000-8000-" + stamp
	ids := func(i int) string { return fmt.Sprintf("d0d0d0d0-0000-4000-80%02d-%s", i%100, stamp) }
	cleanup := func() {
		_, _ = p.pool.Exec(ctx, `DELETE FROM replay_sessions WHERE website = $1::text::uuid`, website)
		_, _ = p.pool.Exec(ctx, `DELETE FROM consented_events WHERE website = $1::text::uuid`, website)
		_, _ = p.pool.Exec(ctx, `DELETE FROM tombstones WHERE website = $1::text::uuid`, website)
	}
	cleanup()
	defer cleanup()

	replayContract(t, p, website, time.Now().UTC().Add(-90*24*time.Hour).Truncate(time.Second), ids)

	// Catalogue: exactly the designed columns, no address or user agent, and the cascade is real.
	for table, want := range map[string]string{
		"replay_sessions": "id,website,visitor_id,consent_id,started_at,last_chunk_at,chunks,bytes,pages",
		"replay_chunks":   "session_id,seq,received_at,bytes,data",
	} {
		rows, err := p.pool.Query(ctx, `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, table)
		if err != nil {
			t.Fatal(err)
		}
		var names []string
		for rows.Next() {
			var c string
			_ = rows.Scan(&c)
			names = append(names, c)
		}
		rows.Close()
		if strings.Join(names, ",") != want {
			t.Errorf("live columns of %s: %v", table, names)
		}
	}
	now := time.Now().UTC()
	v, c, rec := ids(80), ids(81), ids(82)
	if res, err := p.AddReplayChunk(ctx, ReplayChunk{Website: website, VisitorID: v, ConsentID: c, RecordingID: rec, Seq: 0, Data: []byte{1, 2, 3}, ReceivedAt: now},
		ReplayLimits{BudgetBytes: 1 << 30, SiteDaily: 1000, VisitorDaily: 1000}); err != nil || res.Outcome != ChunkStored {
		t.Fatal(res, err)
	}
	if _, err := p.pool.Exec(ctx, `DELETE FROM replay_sessions WHERE id = $1::text::uuid`, rec); err != nil {
		t.Fatal(err)
	}
	var left int
	if err := p.pool.QueryRow(ctx, `SELECT count(*) FROM replay_chunks WHERE session_id = $1::text::uuid`, rec).Scan(&left); err != nil || left != 0 {
		t.Errorf("chunks left after deleting the recording: %d %v", left, err)
	}
	// Check constraints refuse what the application would never send.
	for name, sql := range map[string]string{
		"negative bytes": `INSERT INTO replay_sessions (id, website, visitor_id, consent_id, started_at, last_chunk_at, bytes) VALUES ($1::text::uuid, $1::text::uuid, $1::text::uuid, $1::text::uuid, now(), now(), -1)`,
		"51 pages":       `INSERT INTO replay_sessions (id, website, visitor_id, consent_id, started_at, last_chunk_at, pages) VALUES ($1::text::uuid, $1::text::uuid, $1::text::uuid, $1::text::uuid, now(), now(), (SELECT array_agg(g::text) FROM generate_series(1, 51) g))`,
		"orphan chunk":   `INSERT INTO replay_chunks (session_id, seq, received_at, bytes, data) VALUES ($1::text::uuid, 0, now(), 1, '\x00')`,
	} {
		if _, err := p.pool.Exec(ctx, sql, ids(90)); err == nil {
			t.Errorf("%s was accepted by the database", name)
		}
	}
}
