package company

import (
	"net/netip"
	"testing"
)

func TestEmptyNameSelectsNetworkOnly(t *testing.T) {
	for _, name := range []string{"", "  "} {
		r, err := NewRegistry().Select(name, Options{ASNVersion: "2026-10"})
		if err != nil {
			t.Fatalf("Select(%q): %v", name, err)
		}
		if r.Name() != "network-only" {
			t.Errorf("Select(%q) = %s, want network-only", name, r.Name())
		}
	}
}

func TestUnknownResolverRefuses(t *testing.T) {
	if _, err := NewRegistry().Select("snitcher", Options{}); err == nil {
		t.Fatal("an unregistered resolver must be an error, not a silent fallback")
	}
}

func TestNetworkOnlyLabelsTheNetworkNeverACompany(t *testing.T) {
	r, _ := NewRegistry().Select("", Options{ASNVersion: "2026-10"})
	res, ok := r.Resolve(netip.MustParseAddr("203.0.113.7"), ASN{Number: 64500, Org: "  Example Fiber GmbH "})
	if !ok {
		t.Fatal("known ASN must resolve")
	}
	want := Result{Kind: "network", Name: "Example Fiber GmbH", Domain: "", Confidence: "network", Source: "dbip-asn-lite", Version: "2026-10"}
	if res != want {
		t.Errorf("got %+v want %+v", res, want)
	}
	if res.Kind == KindCompany || res.Domain != "" {
		t.Error("the default resolver must never claim a company or a domain")
	}
}

func TestNetworkOnlyKnowsNothingForAnUnknownASN(t *testing.T) {
	r, _ := NewRegistry().Select("network-only", Options{})
	if _, ok := r.Resolve(netip.MustParseAddr("203.0.113.7"), ASN{}); ok {
		t.Error("no ASN organisation must be (zero, false), never a guess")
	}
	if _, ok := r.Resolve(netip.MustParseAddr("203.0.113.7"), ASN{Number: 5, Org: "  "}); ok {
		t.Error("a blank organisation must be (zero, false)")
	}
}

type fakeResolver struct{}

func (fakeResolver) Name() string { return "fake" }
func (fakeResolver) Resolve(netip.Addr, ASN) (Result, bool) {
	return Result{Kind: KindCompany, Name: "Acme", Domain: "acme.test", Confidence: ConfidenceLow, Source: "file", Version: "1"}, true
}

func TestRegistryAcceptsAnotherLocalFileResolverWithoutInterfaceChange(t *testing.T) {
	reg := NewRegistry()
	reg.Register("fake", func(Options) Resolver { return fakeResolver{} })
	r, err := reg.Select("fake", Options{})
	if err != nil || r.Name() != "fake" {
		t.Fatalf("select fake: %v %v", r, err)
	}
	if got := reg.Names(); len(got) != 2 || got[0] != "fake" || got[1] != "network-only" {
		t.Errorf("names: %v", got)
	}
}
