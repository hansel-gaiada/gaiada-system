// Package geotest writes tiny MMDB fixture files for tests, using github.com/maxmind/mmdbwriter.
//
// Choice (V2-a): the fixtures are GENERATED at test time from the RFC 5737 / RFC 3849 documentation ranges.
// No DB-IP data is committed (its licence allows use with attribution, but the full database must never sit
// in the repository, and a real-data fixture would add nothing the generated one does not prove).
// Imported by tests only; the production binary does not link it.
package geotest

import (
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/maxmind/mmdbwriter"
	"github.com/maxmind/mmdbwriter/mmdbtype"
)

// Documentation addresses the fixtures cover. 203.0.113.7 is the test IP of the V2-a acceptance.
const (
	IPBerlin   = "203.0.113.7"  // DE, Berlin, AS64500 "Example Fiber GmbH"
	IPSaoPaulo = "198.51.100.9" // BR, Sao Paulo (non-ASCII name), AS64501 "Operadora Exemplo S.A."
	IPCloud    = "192.0.2.44"   // no city; AS16509 "Amazon.com, Inc." (a listed datacenter ASN)
	IPv6Paris  = "2001:db8::1"  // FR, Paris, AS64502
)

func tree(t *testing.T, dbType string) *mmdbwriter.Tree {
	t.Helper()
	w, err := mmdbwriter.New(mmdbwriter.Options{
		DatabaseType:            dbType,
		RecordSize:              24,
		IPVersion:               6,
		IncludeReservedNetworks: true, // the documentation ranges are "reserved"
		BuildEpoch:              time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC).Unix(),
	})
	if err != nil {
		t.Fatal(err)
	}
	return w
}

func insert(t *testing.T, w *mmdbwriter.Tree, cidr string, v mmdbtype.DataType) {
	t.Helper()
	_, n, err := net.ParseCIDR(cidr)
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Insert(n, v); err != nil {
		t.Fatal(err)
	}
}

func write(t *testing.T, w *mmdbwriter.Tree, path string) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := w.WriteTo(f); err != nil {
		t.Fatal(err)
	}
}

func city(country, subISO, subName, name string) mmdbtype.Map {
	return mmdbtype.Map{
		"country":      mmdbtype.Map{"iso_code": mmdbtype.String(country)},
		"subdivisions": mmdbtype.Slice{mmdbtype.Map{"iso_code": mmdbtype.String(subISO), "names": mmdbtype.Map{"en": mmdbtype.String(subName)}}},
		"city":         mmdbtype.Map{"names": mmdbtype.Map{"en": mmdbtype.String(name)}},
	}
}

func asn(n uint32, org string) mmdbtype.Map {
	return mmdbtype.Map{
		"autonomous_system_number":       mmdbtype.Uint32(n),
		"autonomous_system_organization": mmdbtype.String(org),
	}
}

// WriteCity writes a City-edition fixture as dir/name.
func WriteCity(t *testing.T, dir, name string) {
	t.Helper()
	w := tree(t, "DBIP-City-Lite")
	insert(t, w, "203.0.113.0/24", city("DE", "BE", "Berlin", "Berlin"))
	insert(t, w, "198.51.100.0/24", city("BR", "", "São Paulo", "São Paulo")) // no ISO code: the name is the fallback
	insert(t, w, "2001:db8::/32", city("FR", "IDF", "Île-de-France", "Paris"))
	write(t, w, filepath.Join(dir, name))
}

// WriteASN writes an ASN-edition fixture as dir/name.
func WriteASN(t *testing.T, dir, name string) {
	t.Helper()
	w := tree(t, "DBIP-ASN-Lite")
	insert(t, w, "203.0.113.0/24", asn(64500, "Example Fiber GmbH"))
	insert(t, w, "198.51.100.0/24", asn(64501, "Operadora Exemplo S.A."))
	insert(t, w, "192.0.2.0/24", asn(16509, "Amazon.com, Inc."))
	insert(t, w, "2001:db8::/32", asn(64502, "Exemple Réseau SAS"))
	write(t, w, filepath.Join(dir, name))
}

// WriteBoth writes dbip-city-lite.mmdb and dbip-asn-lite.mmdb into dir.
func WriteBoth(t *testing.T, dir string) {
	t.Helper()
	WriteCity(t, dir, "dbip-city-lite.mmdb")
	WriteASN(t, dir, "dbip-asn-lite.mmdb")
}
