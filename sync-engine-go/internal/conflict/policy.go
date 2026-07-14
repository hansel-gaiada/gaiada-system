// Declarative per-field conflictPolicy (sync-engine-revision §2, D3 fix #3): default
// status/decision/money fields to conflict-queue (never auto-resolved by clock order),
// everything else to lww. This package only decides HOW to resolve once the caller
// (protocol/apply.go) has detected a genuine concurrent write; concurrency detection is the
// caller's job (base-version/HLC comparison), not this package's.
package conflict

import (
	"gaiada/sync-engine-go/internal/hlc"
)

type PolicyType string

const (
	PolicyLWW           PolicyType = "lww"
	PolicyConflictQueue PolicyType = "conflict-queue"
	PolicyNumericMerge  PolicyType = "numeric-merge"
	PolicyMax           PolicyType = "max"
	PolicyMin           PolicyType = "min"
)

// EntityPolicy maps a field name to its policy; the "*" key is the default for unlisted fields.
type EntityPolicy map[string]PolicyType

type FieldValue struct {
	HLC   hlc.HLC
	Value any
}

// fieldsByEntity lists the fields that must default to conflict-queue per entity (status /
// decision / money-ish). Extend as verticals grow. Everything else falls through to lww.
// Field names match the live entity columns (platform-nest migrations 0001/0002): status and
// money-ish fields must never be auto-resolved by clock order. time_entry.minutes is included
// because silently LWW-ing logged time can lose billable hours — it deserves review too.
var fieldsByEntity = map[string][]string{
	"deliverable": {"status"},
	"campaign":    {"status", "budget_minor"},
	"time_entry":  {"minutes"},
}

func DefaultPolicyFor(entityType string) EntityPolicy {
	p := EntityPolicy{"*": PolicyLWW}
	for _, f := range fieldsByEntity[entityType] {
		p[f] = PolicyConflictQueue
	}
	return p
}

// PolicyFor returns the policy for a field, falling back to the "*" default.
func (p EntityPolicy) PolicyFor(field string) PolicyType {
	if pol, ok := p[field]; ok {
		return pol
	}
	if def, ok := p["*"]; ok {
		return def
	}
	return PolicyLWW
}

// Resolve applies policy to two concurrently-written values of the same field. needsReview
// signals the caller MUST record a sync_conflicts row instead of applying winner directly
// (D3 fix #7: no silent loss).
func Resolve(policy PolicyType, local, remote FieldValue) (winner FieldValue, needsReview bool) {
	switch policy {
	case PolicyLWW:
		if local.HLC.Compare(remote.HLC) >= 0 {
			return local, false
		}
		return remote, false
	case PolicyConflictQueue:
		if valuesEqual(local.Value, remote.Value) {
			return local, false // not actually divergent
		}
		return FieldValue{}, true
	case PolicyNumericMerge:
		lv, lok := toFloat(local.Value)
		rv, rok := toFloat(remote.Value)
		if !lok || !rok {
			return FieldValue{}, true // can't merge non-numeric — escalate
		}
		hi := local.HLC
		if remote.HLC.Compare(hi) > 0 {
			hi = remote.HLC
		}
		return FieldValue{HLC: hi, Value: lv + rv}, false
	case PolicyMax, PolicyMin:
		lv, lok := toFloat(local.Value)
		rv, rok := toFloat(remote.Value)
		if !lok || !rok {
			return FieldValue{}, true
		}
		pick := local
		if (policy == PolicyMax && rv > lv) || (policy == PolicyMin && rv < lv) {
			pick = remote
		}
		return pick, false
	default:
		return FieldValue{}, true // unknown policy — escalate, never silently guess
	}
}

func valuesEqual(a, b any) bool {
	// JSON round-trips numbers as float64; compare those numerically, everything else by ==.
	if af, aok := toFloat(a); aok {
		if bf, bok := toFloat(b); bok {
			return af == bf
		}
		return false
	}
	return a == b
}

func toFloat(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case int32:
		return float64(n), true
	default:
		return 0, false
	}
}
