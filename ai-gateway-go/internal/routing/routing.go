// Package routing resolves "route by task" (AIP-06, plan docs/plans/2026-10-27-ai-plan.md §2.2,
// rulings AIP-D1 and AIP-D5) for POST /complete and POST /complete/stream.
//
// A request may carry a `task` (chat, summarise, classify, agent_step, draft) and/or a `tier`
// (fast, standard, strong). A tier names a (provider, model) pair in a Table. Resolve is a PURE
// function: it never errors and never touches a provider; the server turns its Route into a chain
// hint plus a one-attempt model override. The tier is a HINT exactly like the existing `provider`
// field, never a requirement: an unavailable or breaker-open tier provider is skipped by the chain
// and the request fails over as it always did.
//
// Precedence: provider > tier > the task's tier > default (today's plain chain order).
package routing

import (
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
)

// Tasks and TierNames are the only accepted values. Anything else (wrong case, unknown, empty) is
// treated as ABSENT by Resolve, never as an error.
var (
	Tasks     = []string{"chat", "summarise", "classify", "agent_step", "draft"}
	TierNames = []string{"fast", "standard", "strong"}
)

// ValidTask reports whether s is exactly one of Tasks.
func ValidTask(s string) bool { return contains(Tasks, s) }

// ValidTier reports whether s is exactly one of TierNames.
func ValidTier(s string) bool { return contains(TierNames, s) }

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// Entry is what a tier points at: a provider name from the LLM chain and, optionally, a text model
// for that provider. An empty Model means "that provider's own default model".
type Entry struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
}

// Table is the routing configuration. A Table that has been handed to a Holder is immutable: swap
// it, never edit it.
type Table struct {
	Tiers     map[string]Entry  // tier name -> entry
	TaskTiers map[string]string // task name -> tier name
}

// Empty reports whether no tier has an entry (task mappings alone route nothing).
func (t Table) Empty() bool { return len(t.Tiers) == 0 }

// TierNames returns the sorted names of the tiers that have an entry, or nil when there are none.
// Names only: never a provider or a model (it feeds GET /health).
func (t Table) TierNames() []string {
	if len(t.Tiers) == 0 {
		return nil
	}
	out := make([]string, 0, len(t.Tiers))
	for name := range t.Tiers {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

func (t Table) clone() Table {
	c := Table{}
	if t.Tiers != nil {
		c.Tiers = make(map[string]Entry, len(t.Tiers))
		for k, v := range t.Tiers {
			c.Tiers[k] = v
		}
	}
	if t.TaskTiers != nil {
		c.TaskTiers = make(map[string]string, len(t.TaskTiers))
		for k, v := range t.TaskTiers {
			c.TaskTiers[k] = v
		}
	}
	return c
}

// Route is the outcome of Resolve.
type Route struct {
	// Hint is the provider name to try first (RunWithHint's hint). "" = plain chain order.
	Hint string
	// Model is the text-model override for the Hint provider's attempt, "" = its own default.
	Model string
	// Tier is the tier being attempted ("" when none, or when `provider` was sent).
	Tier string
	// Task is the validated requested task ("" when absent or invalid). Carried for the audit even
	// when routing did not use it.
	Task string
}

// Resolve applies the precedence rules. providerHint is the request's existing `provider` field.
func Resolve(providerHint, task, tier string, table Table) Route {
	if !ValidTask(task) {
		task = ""
	}
	if !ValidTier(tier) {
		tier = ""
	}
	// 1. An explicit provider is today's path: the tier is not consulted at all.
	if providerHint != "" {
		return Route{Hint: providerHint, Task: task}
	}
	// 2. Effective tier: the request's tier, else the task's mapped tier.
	effective := tier
	if effective == "" && task != "" {
		effective = table.TaskTiers[task]
	}
	if effective == "" {
		return Route{Task: task}
	}
	// 3. The tier must have an entry; otherwise it is today's plain chain order.
	entry, ok := table.Tiers[effective]
	if !ok || entry.Provider == "" {
		return Route{Task: task}
	}
	return Route{Hint: entry.Provider, Model: entry.Model, Tier: effective, Task: task}
}

// Holder is the live table: requests read it per call and an admin write swaps it. Safe for
// concurrent use (an atomic pointer to an immutable Table).
type Holder struct {
	p atomic.Pointer[Table]
	// mu serialises writers that rebuild the table from several sources (see Update).
	mu sync.Mutex
}

// NewHolder returns a Holder seeded with a private copy of t.
func NewHolder(t Table) *Holder {
	h := &Holder{}
	c := t.clone()
	h.p.Store(&c)
	return h
}

// Get returns the current table. The result is shared and must be treated as read-only.
func (h *Holder) Get() Table { return *h.p.Load() }

// Set swaps in a private copy of t.
func (h *Holder) Set(t Table) {
	c := t.clone()
	h.p.Store(&c)
}

// Update rebuilds the table under a lock: build runs while the lock is held, so two concurrent
// admin writes can never leave the older rebuild as the live table.
func (h *Holder) Update(build func() Table) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.Set(build())
}

// --- validation ---------------------------------------------------------------------------------

var modelRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$`)

// ValidModel reports whether s is an acceptable model id: non-empty, starts alphanumeric, at most
// 128 characters of letters, digits and . _ : / @ + - (model ids carry `:` and `/`).
func ValidModel(s string) bool { return modelRe.MatchString(s) }

// Validator carries the two provider sets an entry is checked against.
type Validator struct {
	// Known is every provider name a tier may name (the same list a chain write is checked against).
	Known map[string]bool
	// Overridable is the subset whose model may be overridden (providers.ModelOverrider).
	Overridable map[string]bool
}

// NewValidator builds a Validator from name lists.
func NewValidator(known, overridable []string) Validator {
	v := Validator{Known: map[string]bool{}, Overridable: map[string]bool{}}
	for _, n := range known {
		v.Known[n] = true
	}
	for _, n := range overridable {
		v.Overridable[n] = true
	}
	return v
}

// CheckEntry validates one tier entry. tier is the tier name.
func (v Validator) CheckEntry(tier string, e Entry) error {
	if !ValidTier(tier) {
		return fmt.Errorf("unknown tier %q (allowed: %s)", tier, strings.Join(TierNames, ", "))
	}
	if e.Provider == "" {
		return errors.New("provider required")
	}
	if e.Provider == "echo" {
		return errors.New("provider echo is refused (it is the keyless terminator, not a brain)")
	}
	if !v.Known[e.Provider] {
		known := make([]string, 0, len(v.Known))
		for n := range v.Known {
			known = append(known, n)
		}
		sort.Strings(known)
		return fmt.Errorf("unknown provider %q (known: %s)", e.Provider, strings.Join(known, ", "))
	}
	if e.Model != "" {
		if !ValidModel(e.Model) {
			return errors.New("model has characters outside [A-Za-z0-9._:/@+-], must start alphanumeric, max 128")
		}
		if !v.Overridable[e.Provider] {
			return fmt.Errorf("provider %q cannot take a model override", e.Provider)
		}
	}
	return nil
}

// CheckTiers validates a whole tiers object (an empty or nil one is valid: no tiers).
func (v Validator) CheckTiers(m map[string]Entry) error {
	// Sorted so the first reported problem is deterministic.
	names := make([]string, 0, len(m))
	for n := range m {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		if err := v.CheckEntry(n, m[n]); err != nil {
			return fmt.Errorf("tiers.%s: %w", n, err)
		}
	}
	return nil
}

// CheckTaskTier validates one task=tier pair.
func CheckTaskTier(task, tier string) error {
	if !ValidTask(task) {
		return fmt.Errorf("unknown task %q (allowed: %s)", task, strings.Join(Tasks, ", "))
	}
	if !ValidTier(tier) {
		return fmt.Errorf("unknown tier %q (allowed: %s)", tier, strings.Join(TierNames, ", "))
	}
	return nil
}

// CheckTaskTiers validates a whole taskTiers object (an empty or nil one is valid).
func CheckTaskTiers(m map[string]string) error {
	names := make([]string, 0, len(m))
	for n := range m {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		if err := CheckTaskTier(n, m[n]); err != nil {
			return fmt.Errorf("taskTiers.%s: %w", n, err)
		}
	}
	return nil
}

// --- env parsing --------------------------------------------------------------------------------

// Problem is one dropped env entry: its key (never a value beyond what the operator typed as the
// key) and why it was dropped.
type Problem struct {
	Key    string
	Reason string
}

// entryKey is the part of an env entry before `=`; an entry with no `=` is reported by its first
// 40 characters, so a log line can never carry an arbitrarily long value.
func entryKey(entry string) string {
	if i := strings.Index(entry, "="); i >= 0 {
		return strings.TrimSpace(entry[:i])
	}
	if len(entry) > 40 {
		return entry[:40]
	}
	return entry
}

// ParseTiers parses GATEWAY_TIERS: comma-separated `tier=provider[:model]`. The provider is split
// from the model at the FIRST `:` (model ids may themselves contain `:` and `/`). A malformed,
// invalid or duplicate entry is dropped and reported, never fatal. Empty input is no tiers.
func ParseTiers(raw string, v Validator) (map[string]Entry, []Problem) {
	out := map[string]Entry{}
	var problems []Problem
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		key := entryKey(part)
		eq := strings.Index(part, "=")
		if eq < 0 {
			problems = append(problems, Problem{key, "expected tier=provider[:model]"})
			continue
		}
		tier, rest := strings.TrimSpace(part[:eq]), strings.TrimSpace(part[eq+1:])
		entry := Entry{Provider: rest}
		if c := strings.Index(rest, ":"); c >= 0 {
			entry = Entry{Provider: strings.TrimSpace(rest[:c]), Model: strings.TrimSpace(rest[c+1:])}
		}
		if err := v.CheckEntry(tier, entry); err != nil {
			problems = append(problems, Problem{key, err.Error()})
			continue
		}
		if _, dup := out[tier]; dup {
			problems = append(problems, Problem{key, "duplicate tier (the first entry is kept)"})
			continue
		}
		out[tier] = entry
	}
	return out, problems
}

// ParseTaskTiers parses GATEWAY_TASK_TIERS: comma-separated `task=tier`, with the same drop-and-
// report handling as ParseTiers.
func ParseTaskTiers(raw string) (map[string]string, []Problem) {
	out := map[string]string{}
	var problems []Problem
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		key := entryKey(part)
		eq := strings.Index(part, "=")
		if eq < 0 {
			problems = append(problems, Problem{key, "expected task=tier"})
			continue
		}
		task, tier := strings.TrimSpace(part[:eq]), strings.TrimSpace(part[eq+1:])
		if err := CheckTaskTier(task, tier); err != nil {
			problems = append(problems, Problem{key, err.Error()})
			continue
		}
		if _, dup := out[task]; dup {
			problems = append(problems, Problem{key, "duplicate task (the first entry is kept)"})
			continue
		}
		out[task] = tier
	}
	return out, problems
}

// FromEnv builds the boot table from the two env values. logf (log.Printf at boot; nil to stay
// silent) is called once per dropped entry with the env var name, the entry's key and the reason.
func FromEnv(tiersRaw, taskTiersRaw string, v Validator, logf func(format string, args ...any)) Table {
	tiers, p1 := ParseTiers(tiersRaw, v)
	tasks, p2 := ParseTaskTiers(taskTiersRaw)
	if logf != nil {
		for _, p := range p1 {
			logf("routing: GATEWAY_TIERS entry %q dropped: %s", p.Key, p.Reason)
		}
		for _, p := range p2 {
			logf("routing: GATEWAY_TASK_TIERS entry %q dropped: %s", p.Key, p.Reason)
		}
	}
	return Table{Tiers: tiers, TaskTiers: tasks}
}
