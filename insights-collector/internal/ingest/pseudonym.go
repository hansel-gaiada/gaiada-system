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

// Pseudonym returns an address in fd00::/8: the first byte is 0xfd and the other 120 bits are the first 15
// bytes of HMAC-SHA256(day key, the address in 16-byte form). IPv4 and IPv4-mapped IPv6 give the same result.
func (k *DayKey) Pseudonym(ip netip.Addr) netip.Addr {
	key := k.currentKey()
	raw := ip.Unmap().As16()
	m := hmac.New(sha256.New, key[:])
	m.Write(raw[:])
	sum := m.Sum(nil)
	var out [16]byte
	out[0] = 0xfd
	copy(out[1:], sum[:15])
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
