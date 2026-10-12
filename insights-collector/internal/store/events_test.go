package store

import (
	"context"
	"encoding/hex"
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

// The tombstone hash contract, written in platform-nest/migrations/202610131600_search_visitor_profiles.sql:
// id_hash = sha256(utf8(lower-case uuid text)). The vector below was produced independently with
// Node: createHash('sha256').update('00000000-0000-4000-8000-000000000000'.toLowerCase(), 'utf8').digest('hex').
func TestIDHashMatchesTheErpContract(t *testing.T) {
	const id = "00000000-0000-4000-8000-000000000000"
	const want = "db8055e0e0307d5a016bec4dc338d69875eb0fb7e614a8b125b08fb082095d98"
	if got := hex.EncodeToString(IDHash(id)); got != want {
		t.Errorf("sha256 of the lower-case id: got %s want %s", got, want)
	}
	if hex.EncodeToString(IDHash(strings.ToUpper("aaaaaaaa-0000-4000-8000-00000000000a"))) != hex.EncodeToString(IDHash("aaaaaaaa-0000-4000-8000-00000000000a")) {
		t.Error("an upper-case id must hash as its lower-case form")
	}
	if len(IDHash(id)) != 32 {
		t.Error("hash must be 32 bytes")
	}
}

// V3-b acceptance: a schema test proves the consented table has no IP or user-agent column. The generic scan in
// store_test.go covers every migration; this one pins what 0002 DOES declare, so a column added later has to be
// looked at by a person.
func TestConsentedEventsMigrationDeclaresExactlyTheDesignedColumns(t *testing.T) {
	b, err := fs.ReadFile(migrations.FS, "0002_consented_events.sql")
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
	m := regexp.MustCompile(`(?is)CREATE TABLE IF NOT EXISTS consented_events \((.*?)\n\);`).FindStringSubmatch(code.String())
	if m == nil {
		t.Fatal("consented_events table not found in 0002")
	}
	var cols []string
	for _, line := range strings.Split(m[1], "\n") {
		f := strings.Fields(strings.TrimSpace(line))
		if len(f) < 2 || strings.EqualFold(f[0], "CONSTRAINT") {
			continue
		}
		cols = append(cols, f[0])
	}
	want := []string{"id", "website", "visitor_id", "consent_id", "received_at", "occurred_at", "kind", "path", "name", "data",
		"device", "country", "city", "asn", "network_name", "company"}
	if strings.Join(cols, ",") != strings.Join(want, ",") {
		t.Errorf("columns of consented_events:\n got %v\nwant %v", cols, want)
	}
	for _, c := range cols {
		if regexp.MustCompile(`(?i)(^|_)(ip|ua|user_agent|useragent|address|addr|inet|cidr)($|_)`).MatchString(c) {
			t.Errorf("column %q looks like an address or a user agent", c)
		}
	}
}

// contract is what both the Memory store and Postgres must satisfy.
func contract(t *testing.T, st EventStore, website string, now time.Time, ids func(n int) string) {
	t.Helper()
	ctx := context.Background()
	v1, v2, c1, c2 := ids(1), ids(2), ids(3), ids(4)
	ev := func(age time.Duration, path string) ConsentedEvent {
		return ConsentedEvent{
			ReceivedAt: now.Add(-age), OccurredAt: now.Add(-age), Kind: "event", Name: "cta_click", Path: path,
			Data: `{"section_id": "hero"}`, Device: DeviceDesktop, Country: "DE", City: "Berlin", ASN: 64500, NetworkName: "Example Fiber GmbH",
			Company: `{"kind": "network", "name": "Example Fiber GmbH"}`,
		}
	}
	pageview := ConsentedEvent{ReceivedAt: now.Add(-time.Hour), OccurredAt: now.Add(-time.Hour), Kind: "pageview", Path: "/", Device: DeviceUnknown}

	if gone, err := st.InsertEvents(ctx, website, v1, c1, []ConsentedEvent{ev(time.Hour, "/a/"), ev(time.Hour, "/b/"), pageview}); err != nil || gone {
		t.Fatalf("insert: gone=%v err=%v", gone, err)
	}
	if gone, err := st.InsertEvents(ctx, website, v2, c2, []ConsentedEvent{ev(time.Hour, "/c/")}); err != nil || gone {
		t.Fatalf("insert 2: gone=%v err=%v", gone, err)
	}
	if gone, err := st.InsertEvents(ctx, website, v1, c1, nil); err != nil || gone {
		t.Fatalf("empty insert must be a no-op: gone=%v err=%v", gone, err)
	}

	// Paging by id, oldest first, cursor moves forward.
	rows, err := st.EventsAfter(ctx, website, 0, 2, now.Add(-15*time.Second))
	if err != nil || len(rows) != 2 || rows[0].ID >= rows[1].ID {
		t.Fatalf("page 1: %+v %v", rows, err)
	}
	rest, err := st.EventsAfter(ctx, website, rows[1].ID, 10, now.Add(-15*time.Second))
	if err != nil || len(rest) != 2 || rest[0].ID <= rows[1].ID {
		t.Fatalf("page 2: %+v %v", rest, err)
	}
	first := rows[0]
	if first.VisitorID != v1 || first.ConsentID != c1 || first.Kind != "event" || first.Name != "cta_click" || first.Path != "/a/" ||
		first.Country != "DE" || first.City != "Berlin" || first.ASN != 64500 || first.NetworkName != "Example Fiber GmbH" ||
		first.Device != DeviceDesktop || !strings.Contains(first.Data, "hero") || !strings.Contains(first.Company, "network") {
		t.Errorf("round trip: %+v", first)
	}
	pv := rest[0]
	if pv.Kind != "pageview" || pv.Name != "" || pv.Data != "" || pv.Company != "" || pv.Country != "" || pv.ASN != 0 || pv.Device != DeviceUnknown {
		t.Errorf("nulls must read back as empty: %+v", pv)
	}

	// The read lag: a row received inside it is hidden, and so is every row after it.
	if _, err := st.InsertEvents(ctx, website, v2, c2, []ConsentedEvent{ev(5*time.Second, "/young/"), ev(time.Hour, "/later-id-but-old/")}); err != nil {
		t.Fatal(err)
	}
	vis, err := st.EventsAfter(ctx, website, 0, 100, now.Add(-15*time.Second))
	if err != nil || len(vis) != 4 {
		t.Fatalf("lag: want the 4 old rows, got %d (%v)", len(vis), err)
	}
	for _, r := range vis {
		if r.Path == "/young/" || r.Path == "/later-id-but-old/" {
			t.Errorf("row behind the lag was returned: %s", r.Path)
		}
	}
	if all, _ := st.EventsAfter(ctx, website, 0, 100, now.Add(time.Minute)); len(all) != 6 {
		t.Errorf("with the lag passed every row shows: %d", len(all))
	}

	// ForgetPair removes only the exact pair and tombstones the visitor.
	if n, err := st.ForgetPair(ctx, website, v1, c2); err != nil || n != 0 {
		t.Errorf("a pair that does not match deletes nothing: %d %v", n, err)
	}
	// ...but it DID tombstone v1 (the visitor id), which is the withdrawal contract; undo that for the next steps by using fresh ids.
	if gone, _ := st.InsertEvents(ctx, website, v1, c1, []ConsentedEvent{ev(time.Hour, "/x/")}); !gone {
		t.Error("ForgetPair must tombstone the visitor id")
	}
	// Forget by consent id: deletes v2's rows, tombstones the consent id; idempotent.
	res, err := st.Forget(ctx, ForgetRequest{Website: website, ConsentIDs: []string{c2}, Reason: ReasonErase})
	if err != nil || res.DeletedEvents != 3 || res.TombstonedConsents != 1 || res.TombstonedVisitors != 0 {
		t.Fatalf("forget: %+v %v", res, err)
	}
	again, err := st.Forget(ctx, ForgetRequest{Website: website, ConsentIDs: []string{c2}, Reason: ReasonErase})
	if err != nil || again.DeletedEvents != 0 || again.TombstonedConsents != 1 {
		t.Fatalf("repeat forget: %+v %v", again, err)
	}
	if gone, _ := st.InsertEvents(ctx, website, ids(9), c2, []ConsentedEvent{ev(time.Hour, "/y/")}); !gone {
		t.Error("a new visitor id under a tombstoned consent id must be refused")
	}
	// Both ids empty is not an error.
	if _, err := st.Forget(ctx, ForgetRequest{Website: website, Reason: ReasonWithdraw}); err != nil {
		t.Error(err)
	}
	// Forgetting a visitor removes its rows.
	res, err = st.Forget(ctx, ForgetRequest{Website: website, VisitorIDs: []string{v1}, Reason: ReasonWithdraw})
	if err != nil || res.DeletedEvents != 3 {
		t.Errorf("forget visitor: %+v %v", res, err)
	}
	if left, _ := st.EventsAfter(ctx, website, 0, 100, now.Add(time.Minute)); len(left) != 0 {
		t.Errorf("rows left after forgetting both: %+v", left)
	}
}

func TestMemoryEventStoreContract(t *testing.T) {
	contract(t, NewMemory(), "11111111-2222-3333-4444-555555555555", time.Date(2026, 10, 12, 10, 0, 0, 0, time.UTC), func(i int) string {
		return "aaaaaaaa-0000-4000-8000-00000000000" + string(rune('0'+i))
	})
}

func TestPurgeDeletesRowsOlderThan72HoursAndTombstonesOlderThan14Months(t *testing.T) {
	now := time.Date(2026, 10, 12, 10, 0, 0, 0, time.UTC)
	m := NewMemory()
	m.Now = func() time.Time { return now }
	ctx := context.Background()
	site := "11111111-2222-3333-4444-555555555555"
	vid, cid := "aaaaaaaa-0000-4000-8000-000000000001", "bbbbbbbb-0000-4000-8000-000000000001"
	mk := func(age time.Duration, path string) ConsentedEvent {
		return ConsentedEvent{ReceivedAt: now.Add(-age), OccurredAt: now.Add(-age), Kind: "pageview", Path: path, Device: DeviceUnknown}
	}
	_, _ = m.InsertEvents(ctx, site, vid, cid, []ConsentedEvent{
		mk(73*time.Hour, "/73h/"), mk(72*time.Hour+time.Minute, "/72h1m/"), mk(71*time.Hour, "/71h/"), mk(time.Minute, "/new/"),
	})
	// An old and a recent tombstone.
	m.Now = func() time.Time { return now.AddDate(0, -15, 0) }
	_, _ = m.Forget(ctx, ForgetRequest{Website: site, VisitorIDs: []string{"aaaaaaaa-0000-4000-8000-000000000002"}, Reason: ReasonErase})
	m.Now = func() time.Time { return now.AddDate(0, -13, 0) }
	_, _ = m.Forget(ctx, ForgetRequest{Website: site, VisitorIDs: []string{"aaaaaaaa-0000-4000-8000-000000000003"}, Reason: ReasonErase})

	c := &stats.Counters{}
	p := &Purger{St: m, Log: slog.New(slog.DiscardHandler), Stats: c, Retention: 72 * time.Hour, TombstoneMonths: 14, Now: func() time.Time { return now }}
	ev, tb, err := p.Once(ctx)
	if err != nil || ev != 2 || tb != 1 {
		t.Fatalf("purge: events=%d tombstones=%d err=%v", ev, tb, err)
	}
	var left []string
	for _, e := range m.Events() {
		left = append(left, e.Path)
	}
	if strings.Join(left, ",") != "/71h/,/new/" {
		t.Errorf("rows left: %v", left)
	}
	if len(m.Tombstones()) != 1 {
		t.Errorf("tombstones left: %+v", m.Tombstones())
	}
	if c.PurgedEvents.Load() != 2 || c.PurgedTombstones.Load() != 1 {
		t.Errorf("counters: %+v", c.Snapshot())
	}
	// Running it again deletes nothing.
	if ev, tb, _ := p.Once(ctx); ev != 0 || tb != 0 {
		t.Errorf("second pass: %d %d", ev, tb)
	}
	// vdb down: an error and a failure count, nothing else.
	m.Down = true
	if _, _, err := p.Once(ctx); err == nil || c.PurgeFailures.Load() != 1 {
		t.Errorf("down: %v %d", err, c.PurgeFailures.Load())
	}
}

func TestPurgerRunPurgesAtStartAndEveryInterval(t *testing.T) {
	m := NewMemory()
	now := time.Now().UTC()
	ctx, cancel := context.WithCancel(context.Background())
	// A row already past retention before Run starts: the first pass is immediate, not after one interval.
	_, _ = m.InsertEvents(ctx, "w", "aaaaaaaa-0000-4000-8000-000000000001", "bbbbbbbb-0000-4000-8000-000000000001",
		[]ConsentedEvent{{ReceivedAt: now.Add(-100 * time.Hour), OccurredAt: now, Kind: "pageview", Path: "/", Device: DeviceUnknown}})
	p := &Purger{St: m, Log: slog.New(slog.DiscardHandler), Stats: &stats.Counters{}, Retention: 72 * time.Hour, TombstoneMonths: 14}
	done := make(chan struct{})
	go func() { p.Run(ctx, 20*time.Millisecond); close(done) }()
	waitFor(t, func() bool { return len(m.Events()) == 0 })
	// A row that expires later is picked up by a later tick.
	_, _ = m.InsertEvents(ctx, "w", "aaaaaaaa-0000-4000-8000-000000000001", "bbbbbbbb-0000-4000-8000-000000000001",
		[]ConsentedEvent{{ReceivedAt: now.Add(-100 * time.Hour), OccurredAt: now, Kind: "pageview", Path: "/", Device: DeviceUnknown}})
	waitFor(t, func() bool { return len(m.Events()) == 0 })
	cancel()
	<-done
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("condition not met in time")
}

// Real Postgres (the CI job has a service container; there is NO Postgres on the laptop): the same contract,
// the forget/insert race, the purge, and the catalogue check for consented_events.
func TestPostgresConsentedEvents(t *testing.T) {
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
	website := "cccccccc-0000-4000-8000-" + stamp
	ids := func(i int) string { return "dddddddd-0000-4000-80" + string(rune('0'+i%10)) + "0-" + stamp }
	cleanup := func() {
		_, _ = p.pool.Exec(ctx, `DELETE FROM consented_events WHERE website = $1::text::uuid`, website)
		_, _ = p.pool.Exec(ctx, `DELETE FROM tombstones WHERE website = $1::text::uuid`, website)
	}
	cleanup()
	defer cleanup()

	contract(t, p, website, time.Now().UTC(), ids)

	// The tombstone table holds only hashes, 32 bytes each, never the id.
	rows, err := p.pool.Query(ctx, `SELECT kind, reason, encode(id_hash, 'hex') FROM tombstones WHERE website = $1::text::uuid`, website)
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for rows.Next() {
		var kind, reason, h string
		_ = rows.Scan(&kind, &reason, &h)
		n++
		if len(h) != 64 || strings.Contains(h, "dddddddd") {
			t.Errorf("tombstone %s/%s: %s", kind, reason, h)
		}
	}
	rows.Close()
	if n != 2 { // the visitor id (ForgetPair, then Forget) and the consent id; the empty forget wrote none
		t.Errorf("tombstones written by the contract run: %d, want 2", n)
	}

	// The purge: a 73-hour-old row goes, a 71-hour-old row stays; a 15-month-old tombstone goes.
	now := time.Now().UTC()
	v, c := "eeeeeeee-0000-4000-8000-"+stamp, "ffffffff-0000-4000-8000-"+stamp
	if _, err := p.InsertEvents(ctx, website, v, c, []ConsentedEvent{
		{ReceivedAt: now.Add(-73 * time.Hour), OccurredAt: now, Kind: "pageview", Path: "/old/", Device: DeviceUnknown},
		{ReceivedAt: now.Add(-71 * time.Hour), OccurredAt: now, Kind: "pageview", Path: "/keep/", Device: DeviceUnknown},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := p.pool.Exec(ctx, `INSERT INTO tombstones (website, kind, id_hash, reason, created_at)
		VALUES ($1::text::uuid, 'visitor', $2, 'erase', now() - interval '15 months')`, website, IDHash("11111111-1111-4111-8111-111111111111")); err != nil {
		t.Fatal(err)
	}
	pg := &Purger{St: p, Log: slog.New(slog.DiscardHandler), Stats: &stats.Counters{}, Retention: 72 * time.Hour, TombstoneMonths: 14}
	if _, tb, err := pg.Once(ctx); err != nil || tb < 1 {
		t.Fatalf("purge: tombstones=%d %v", tb, err)
	}
	left, err := p.EventsAfter(ctx, website, 0, 100, now.Add(time.Minute))
	if err != nil || len(left) != 1 || left[0].Path != "/keep/" {
		t.Fatalf("after purge: %+v %v", left, err)
	}

	// Check constraints refuse what the application would never send.
	for name, sql := range map[string]string{
		"event without a name": `INSERT INTO consented_events (website, visitor_id, consent_id, received_at, occurred_at, kind, path) VALUES ($1::text::uuid, $1::text::uuid, $1::text::uuid, now(), now(), 'event', '/')`,
		"bad kind":             `INSERT INTO consented_events (website, visitor_id, consent_id, received_at, occurred_at, kind, path) VALUES ($1::text::uuid, $1::text::uuid, $1::text::uuid, now(), now(), 'identify', '/')`,
		"bad country":          `INSERT INTO consented_events (website, visitor_id, consent_id, received_at, occurred_at, kind, path, country) VALUES ($1::text::uuid, $1::text::uuid, $1::text::uuid, now(), now(), 'pageview', '/', 'Germany')`,
	} {
		if _, err := p.pool.Exec(ctx, sql, website); err == nil {
			t.Errorf("%s was accepted by the database", name)
		}
	}

	// Catalogue: consented_events has exactly the designed columns and none looks like an address or a user agent.
	cols, err := p.pool.Query(ctx, `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'consented_events' ORDER BY ordinal_position`)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for cols.Next() {
		var c string
		_ = cols.Scan(&c)
		names = append(names, c)
	}
	cols.Close()
	if strings.Join(names, ",") != "id,website,visitor_id,consent_id,received_at,occurred_at,kind,path,name,data,device,country,city,asn,network_name,company" {
		t.Errorf("live columns: %v", names)
	}
}
