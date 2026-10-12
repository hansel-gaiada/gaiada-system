package geo

import (
	"net/netip"
	"os"
	"path/filepath"
	"testing"

	"gaiada/insights-collector/internal/geo/geotest"
)

func TestLookupCityAndASNFromFixture(t *testing.T) {
	dir := t.TempDir()
	geotest.WriteBoth(t, dir)
	db := Open(dir, "dbip-city-lite.mmdb", "dbip-asn-lite.mmdb")
	defer db.Close()

	st := db.Status()
	if st.Degraded() || st.City.Version != "2026-10" || st.ASN.Version != "2026-10" {
		t.Fatalf("status: %+v", st)
	}

	got := db.Lookup(netip.MustParseAddr(geotest.IPBerlin))
	if got.Country != "DE" || got.Region != "BE" || got.City != "Berlin" || got.ASN.Number != 64500 || got.ASN.Org != "Example Fiber GmbH" {
		t.Errorf("Berlin: %+v", got)
	}

	// A subdivision with no ISO code falls back to its English name; non-ASCII survives.
	sp := db.Lookup(netip.MustParseAddr(geotest.IPSaoPaulo))
	if sp.Country != "BR" || sp.Region != "São Paulo" || sp.City != "São Paulo" {
		t.Errorf("Sao Paulo: %+v", sp)
	}

	// An address only the ASN file knows: network yes, location empty.
	cloud := db.Lookup(netip.MustParseAddr(geotest.IPCloud))
	if cloud.Country != "" || cloud.City != "" || cloud.ASN.Number != 16509 {
		t.Errorf("cloud: %+v", cloud)
	}

	// IPv6 and IPv4-mapped IPv6 both resolve.
	if v6 := db.Lookup(netip.MustParseAddr(geotest.IPv6Paris)); v6.Country != "FR" || v6.City != "Paris" || v6.ASN.Number != 64502 {
		t.Errorf("v6: %+v", v6)
	}
	if m := db.Lookup(netip.MustParseAddr("::ffff:" + geotest.IPBerlin)); m.Country != "DE" {
		t.Errorf("mapped v4: %+v", m)
	}

	// Unknown and invalid addresses: all zero, never an error or a guess.
	if z := db.Lookup(netip.MustParseAddr("8.8.4.4")); z != (Info{}) {
		t.Errorf("unknown: %+v", z)
	}
	if z := db.Lookup(netip.Addr{}); z != (Info{}) {
		t.Errorf("invalid: %+v", z)
	}
}

func TestMissingFilesDegradeInsteadOfFailing(t *testing.T) {
	dir := t.TempDir()
	geotest.WriteCity(t, dir, "dbip-city-lite.mmdb") // ASN file absent
	db := Open(dir, "dbip-city-lite.mmdb", "dbip-asn-lite.mmdb")
	defer db.Close()
	st := db.Status()
	if !st.Degraded() || !st.City.Loaded || st.ASN.Loaded || st.ASN.Problem != "missing" {
		t.Fatalf("status: %+v", st)
	}
	got := db.Lookup(netip.MustParseAddr(geotest.IPBerlin))
	if got.Country != "DE" || got.ASN.Number != 0 {
		t.Errorf("city-only lookup: %+v", got)
	}

	none := Open(t.TempDir(), "a.mmdb", "b.mmdb")
	defer none.Close()
	if s := none.Status(); !s.Degraded() || s.City.Problem != "missing" || s.ASN.Problem != "missing" {
		t.Errorf("no files: %+v", s)
	}
	if z := none.Lookup(netip.MustParseAddr(geotest.IPBerlin)); z != (Info{}) {
		t.Errorf("no files must resolve to nothing: %+v", z)
	}
}

func TestWrongEditionIsRefused(t *testing.T) {
	dir := t.TempDir()
	geotest.WriteCity(t, dir, "dbip-asn-lite.mmdb") // a City file under the ASN name
	db := Open(dir, "dbip-city-lite.mmdb", "dbip-asn-lite.mmdb")
	defer db.Close()
	if st := db.Status(); st.ASN.Loaded || st.ASN.Problem != "wrong-type" {
		t.Errorf("a City file as the ASN file must not load: %+v", st.ASN)
	}
}

func TestGarbageFileIsUnreadableNotFatal(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "dbip-city-lite.mmdb"), []byte("not an mmdb"), 0o600); err != nil {
		t.Fatal(err)
	}
	db := Open(dir, "dbip-city-lite.mmdb", "dbip-asn-lite.mmdb")
	defer db.Close()
	if st := db.Status(); st.City.Loaded || st.City.Problem != "unreadable" {
		t.Errorf("garbage: %+v", st.City)
	}
}

func TestCleanTextBoundsAndStripsControls(t *testing.T) {
	if got := cleanText("Ber\r\nlin\x00"); got != "Berlin" {
		t.Errorf("controls: %q", got)
	}
	long := make([]rune, 500)
	for i := range long {
		long[i] = 'x'
	}
	if got := cleanText(string(long)); len([]rune(got)) != 120 {
		t.Errorf("length cap: %d", len([]rune(got)))
	}
	if cleanCountry("de") != "DE" || cleanCountry("DEU") != "" || cleanCountry("1A") != "" {
		t.Error("country normalisation")
	}
}
