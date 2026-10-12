package ingest

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"net/netip"
	"sync"
	"time"
)

// DayKey turns an address into a pseudonym that Umami can use as "the visitor's address" without ever seeing
// the real one (design D2).
//
// The key is 32 random bytes held ONLY in memory. It is replaced at 00:00 UTC and on every restart, and is never
// written anywhere, so nobody can test guessed addresses against the pseudonym (a plain hash of an IPv4
// address, or one with a published salt, can be brute-forced in seconds). The cost, accepted in the design: at
// the rollover Umami's sessions split, and a restart day counts slightly more visitors.
type DayKey struct {
	now func() time.Time

	mu  sync.Mutex
	day string
	key [32]byte
}

// NewDayKey returns a key source using the given clock (time.Now in production).
func NewDayKey(now func() time.Time) *DayKey { return &DayKey{now: now} }

// pseudonymPrefix is 2001:db8::/32, the IPv6 DOCUMENTATION range (RFC 3849): never assigned to anyone, so a
// pseudonym can never be mistaken for, or collide with, a real visitor's address.
//
// NOT fd00::/8 (the first choice). M5-V2-d proved on sumopod that Umami 3.4.0 runs `is-localhost-ip` on the
// client address before reading any location header, and that package treats all of fc00::/7 as local: with an
// fd… pseudonym Umami stored NO country, region or city even though the cf-* headers were set. With a 2001:db8
// pseudonym the same request stored GB / GB-ENG / London from the headers. Re-check if Umami is upgraded.
var pseudonymPrefix = [4]byte{0x20, 0x01, 0x0d, 0xb8}

// Pseudonym returns an address in 2001:db8::/32: the first 32 bits are the prefix and the other 96 bits are the
// first 12 bytes of HMAC-SHA256(day key, the address in 16-byte form). IPv4 and IPv4-mapped IPv6 give the same result.
func (k *DayKey) Pseudonym(ip netip.Addr) netip.Addr {
	key := k.currentKey()
	raw := ip.Unmap().As16()
	m := hmac.New(sha256.New, key[:])
	m.Write(raw[:])
	sum := m.Sum(nil)
	var out [16]byte
	copy(out[:4], pseudonymPrefix[:])
	copy(out[4:], sum[:12])
	return netip.AddrFrom16(out)
}

func (k *DayKey) currentKey() [32]byte {
	today := k.now().UTC().Format("2006-01-02")
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.day != today {
		if _, err := rand.Read(k.key[:]); err != nil {
			// crypto/rand failing means the platform is broken; a predictable key would defeat the design.
			panic("insights-collector: no randomness available for the day key")
		}
		k.day = today
	}
	return k.key
}
