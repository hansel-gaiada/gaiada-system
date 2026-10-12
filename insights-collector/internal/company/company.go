// Package company holds the CompanyResolver plug-in point (design 3.3).
//
// A resolver turns "who owns this network" into a labelled result. The default, "network-only", returns the
// ASN organisation labelled as a NETWORK, never as a company: an ASN name says who owns the network (an ISP,
// a university, a hosting provider), not who sits on it. Only local-file resolvers can exist: the collector
// has no egress, so an API vendor would need a ruling and a network change first (design D7, open item O-12).
//
// Resolvers run only on the consented channel (V3-b), never on the aggregate channel.
package company

import (
	"fmt"
	"net/netip"
	"sort"
	"strings"
)

// DefaultName is the resolver selected when COMPANY_RESOLVER is empty. The default is a real choice, never
// "off by accident".
const DefaultName = "network-only"

// Result kinds and confidences.
const (
	KindNetwork = "network"
	KindCompany = "company"

	ConfidenceNetwork = "network"
	ConfidenceLow     = "low"
	ConfidenceMedium  = "medium"
	ConfidenceHigh    = "high"
)

// ASN is an autonomous system as the ASN database reports it.
type ASN struct {
	Number uint32
	Org    string
}

// Result is what a resolver knows about the visitor's network or company.
type Result struct {
	Kind, Name, Domain string // Kind: "network" | "company"; Domain "" for a network
	Confidence         string // "network" | "low" | "medium" | "high"
	Source, Version    string // e.g. "dbip-asn-lite", "2026-10"
}

// Resolver resolves a network or company for one address.
type Resolver interface {
	Name() string
	// Resolve returns false when nothing is known. It never guesses. The address is passed for resolvers that
	// match IP ranges; implementations must not retain or log it.
	Resolve(ip netip.Addr, asn ASN) (Result, bool)
}

// Options are the facts a factory may need from the running collector.
type Options struct {
	ASNVersion string // version label of the loaded ASN file, "" when none is loaded
}

// Factory builds a resolver.
type Factory func(Options) Resolver

// Registry maps resolver names to factories.
type Registry struct{ factories map[string]Factory }

// NewRegistry returns a registry holding the built-in resolvers. After O-12, a new resolver is one more
// local-file implementation and one more Register call; the interface does not change.
func NewRegistry() *Registry {
	r := &Registry{factories: map[string]Factory{}}
	r.Register(DefaultName, func(o Options) Resolver { return NetworkOnly{version: o.ASNVersion} })
	return r
}

// Register adds or replaces a factory.
func (r *Registry) Register(name string, f Factory) { r.factories[name] = f }

// Names lists the registered resolvers, sorted.
func (r *Registry) Names() []string {
	out := make([]string, 0, len(r.factories))
	for n := range r.factories {
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}

// Select builds the named resolver. An empty name selects DefaultName; an unknown name is an error (the
// collector refuses to start rather than run without a resolver).
func (r *Registry) Select(name string, o Options) (Resolver, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		name = DefaultName
	}
	f, ok := r.factories[name]
	if !ok {
		return nil, fmt.Errorf("COMPANY_RESOLVER: unknown resolver %q (known: %s)", name, strings.Join(r.Names(), ", "))
	}
	return f(o), nil
}

// NetworkOnly is the default resolver: the ASN organisation, labelled as a network.
type NetworkOnly struct{ version string }

// Name implements Resolver.
func (NetworkOnly) Name() string { return DefaultName }

// Resolve implements Resolver. It ignores the address and says nothing when the ASN has no organisation.
func (n NetworkOnly) Resolve(_ netip.Addr, asn ASN) (Result, bool) {
	org := strings.TrimSpace(asn.Org)
	if org == "" {
		return Result{}, false
	}
	return Result{Kind: KindNetwork, Name: org, Confidence: ConfidenceNetwork, Source: "dbip-asn-lite", Version: n.version}, true
}
