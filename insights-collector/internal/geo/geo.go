// Package geo looks an address up in the local DB-IP Lite City and ASN files (MaxMind DB format).
//
// Both files are optional at start (design 3.4): a missing or unreadable file degrades the lookup (no
// location, no network, bot check by user agent only) and is reported by Status, never fatal unless the
// operator set GEO_REQUIRED=1. The files are replaced monthly by geo-refresh.sh, which restarts the
// collector, so there is no reload path here.
//
// Nothing in this package keeps or logs the address it is asked about.
package geo

import (
	"fmt"
	"net/netip"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/oschwald/maxminddb-golang/v2"

	"gaiada/insights-collector/internal/company"
)

// Location is the city-level answer for one address.
type Location struct {
	Country string // ISO 3166-1 alpha-2, upper case, or ""
	Region  string // subdivision ISO code when the file has one, else its English name, or ""
	City    string // English name, or ""
}

// Info is everything the two files say about one address.
type Info struct {
	Location
	ASN company.ASN // zero when unknown
}

// FileStatus describes one database file.
type FileStatus struct {
	Loaded  bool   `json:"loaded"`
	Type    string `json:"type,omitempty"`    // MMDB database_type
	Version string `json:"version,omitempty"` // build month, YYYY-MM
	Problem string `json:"problem,omitempty"` // "missing" | "unreadable" | "wrong-type"; never a path or an address
}

// Status is the state of both files.
type Status struct {
	City FileStatus `json:"city"`
	ASN  FileStatus `json:"asn"`
}

// Degraded reports whether either file is not loaded.
func (s Status) Degraded() bool { return !s.City.Loaded || !s.ASN.Loaded }

// DB holds the opened readers. A nil reader means that file is not loaded.
type DB struct {
	city   *maxminddb.Reader
	asn    *maxminddb.Reader
	status Status
}

// Open opens both files in dir. It always returns a usable *DB; problems are in Status. The caller logs one
// line per problem (file name only).
func Open(dir, cityFile, asnFile string) *DB {
	d := &DB{}
	d.city, d.status.City = openOne(filepath.Join(dir, cityFile), "City")
	d.asn, d.status.ASN = openOne(filepath.Join(dir, asnFile), "ASN")
	return d
}

func openOne(path, wantType string) (*maxminddb.Reader, FileStatus) {
	r, err := maxminddb.Open(path)
	if err != nil {
		if isNotExist(err) {
			return nil, FileStatus{Problem: "missing"}
		}
		return nil, FileStatus{Problem: "unreadable"}
	}
	st := FileStatus{Loaded: true, Type: r.Metadata.DatabaseType, Version: r.Metadata.BuildTime().UTC().Format("2006-01")}
	// DB-IP names its editions "DBIP-City-Lite" and "DBIP-ASN-Lite"; MaxMind's are "GeoLite2-City"/"GeoLite2-ASN".
	// Both contain the edition word, which is all that is checked: a City file given as the ASN file would
	// decode to nothing useful and must not be accepted silently.
	if !strings.Contains(strings.ToLower(r.Metadata.DatabaseType), strings.ToLower(wantType)) {
		_ = r.Close()
		return nil, FileStatus{Problem: "wrong-type"}
	}
	return r, st
}

// Close releases the readers.
func (d *DB) Close() {
	if d.city != nil {
		_ = d.city.Close()
	}
	if d.asn != nil {
		_ = d.asn.Close()
	}
}

// Status returns the file states.
func (d *DB) Status() Status { return d.status }

type cityRecord struct {
	Country struct {
		ISOCode string `maxminddb:"iso_code"`
	} `maxminddb:"country"`
	Subdivisions []struct {
		ISOCode string            `maxminddb:"iso_code"`
		Names   map[string]string `maxminddb:"names"`
	} `maxminddb:"subdivisions"`
	City struct {
		Names map[string]string `maxminddb:"names"`
	} `maxminddb:"city"`
}

type asnRecord struct {
	Number uint32 `maxminddb:"autonomous_system_number"`
	Org    string `maxminddb:"autonomous_system_organization"`
}

// Lookup resolves one address once, against both files. Unknown or unreadable data yields zero fields.
func (d *DB) Lookup(ip netip.Addr) Info {
	var out Info
	ip = ip.Unmap()
	if !ip.IsValid() {
		return out
	}
	if d.city != nil {
		var rec cityRecord
		if res := d.city.Lookup(ip); res.Found() && res.Decode(&rec) == nil {
			out.Country = cleanCountry(rec.Country.ISOCode)
			if len(rec.Subdivisions) > 0 {
				sd := rec.Subdivisions[0]
				region := sd.ISOCode
				if region == "" {
					region = sd.Names["en"]
				}
				out.Region = cleanText(region)
			}
			out.City = cleanText(rec.City.Names["en"])
		}
	}
	if d.asn != nil {
		var rec asnRecord
		if res := d.asn.Lookup(ip); res.Found() && res.Decode(&rec) == nil {
			out.ASN = company.ASN{Number: rec.Number, Org: cleanText(rec.Org)}
		}
	}
	return out
}

func cleanCountry(s string) string {
	s = strings.ToUpper(strings.TrimSpace(s))
	if len(s) != 2 || s[0] < 'A' || s[0] > 'Z' || s[1] < 'A' || s[1] > 'Z' {
		return ""
	}
	return s
}

// cleanText keeps a printable, bounded string: file contents are data, not trusted markup, and these values
// end up in HTTP headers and in the ERP.
func cleanText(s string) string {
	s = strings.TrimSpace(s)
	if !utf8.ValidString(s) {
		return ""
	}
	var b strings.Builder
	n := 0
	for _, r := range s {
		if unicode.IsControl(r) || r == utf8.RuneError {
			continue
		}
		b.WriteRune(r)
		if n++; n >= 120 {
			break
		}
	}
	return b.String()
}

func isNotExist(err error) bool {
	// maxminddb wraps os errors with fmt.Errorf("%w"); a substring check keeps this independent of its wrapping.
	return err != nil && (strings.Contains(err.Error(), "no such file") || strings.Contains(err.Error(), "cannot find the"))
}

// String is for logs: file states, no paths.
func (s Status) String() string {
	f := func(n string, fs FileStatus) string {
		if fs.Loaded {
			return fmt.Sprintf("%s=%s", n, fs.Version)
		}
		return fmt.Sprintf("%s=%s", n, fs.Problem)
	}
	return f("city", s.City) + " " + f("asn", s.ASN)
}
