// Runtime config overrides for the admin console's config WRITES.
//
// The env stays the source of truth at boot. A write from the console records an OVERRIDE here,
// which is (a) applied to the live objects immediately and (b) persisted to a small JSON file so it
// survives a restart — otherwise every deploy would silently revert an operator's change and the
// console would be lying about the running state.
//
// Only the keys in this file are writable. That is deliberate: a provider credential, the egress
// allowlist, the internal TLS mode and the topology are NOT runtime-tunable here, because changing
// them at runtime either can't take effect (credentials are captured in provider objects at boot) or
// would let a console session widen the service's own security boundary. Those remain env+restart.
package adminconfig

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"gaiada/ai-gateway-go/internal/routing"
)

// Overrides is the persisted set. A nil pointer means "not overridden — use the env value", which is
// why every field is a pointer rather than a zero-valued int.
type Overrides struct {
	DailyCallCap          *int     `json:"dailyCallCap,omitempty"`
	PerTenantDailyCallCap *int     `json:"perTenantDailyCallCap,omitempty"`
	BreakerThreshold      *int     `json:"breakerThreshold,omitempty"`
	BreakerCooldownMs     *int     `json:"breakerCooldownMs,omitempty"`
	ProviderTimeoutMs     *int     `json:"providerTimeoutMs,omitempty"`
	DLPClassifierEnabled  *bool    `json:"dlpClassifierEnabled,omitempty"`
	LLMChain              []string `json:"llmChain,omitempty"`
	MediaChain            []string `json:"mediaChain,omitempty"`
	EmbedChain            []string `json:"embedChain,omitempty"`
	// Tiers and TaskTiers (AIP-06) are POINTERS to maps so that "overridden to no tiers" (an empty
	// object, persisted as {}) is distinguishable from "not overridden" (nil, use the env table).
	// The maps are replaced wholesale by a write and never edited in place.
	Tiers     *map[string]routing.Entry `json:"tiers,omitempty"`
	TaskTiers *map[string]string        `json:"taskTiers,omitempty"`
}

// WritableKeys is the allowlist the HTTP layer validates against, and what the console renders as
// editable. Anything absent here is read-only by design (see the package comment).
var WritableKeys = []string{
	"dailyCallCap",
	"perTenantDailyCallCap",
	"breakerThreshold",
	"breakerCooldownMs",
	"providerTimeoutMs",
	"dlpClassifierEnabled",
	"llmChain",
	"mediaChain",
	"embedChain",
	"tiers",
	"taskTiers",
}

func IsWritable(key string) bool {
	for _, k := range WritableKeys {
		if k == key {
			return true
		}
	}
	return false
}

// Store owns the override set and its file. Safe for concurrent use.
type Store struct {
	mu   sync.Mutex
	path string
	ov   Overrides
}

// Load reads the override file if present. A missing file is the normal first-run case (empty
// overrides); an unreadable/corrupt file is reported so a silent config reset can't go unnoticed.
func Load(path string) (*Store, error) {
	s := &Store{path: path}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return s, nil
		}
		return s, fmt.Errorf("read overrides: %w", err)
	}
	if err := json.Unmarshal(raw, &s.ov); err != nil {
		return s, fmt.Errorf("parse overrides (%s): %w", path, err)
	}
	return s, nil
}

func (s *Store) Get() Overrides {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ov
}

// Bounds on the numeric keys. These are sanity rails, not policy: they stop a fat-fingered write
// from disabling the budget entirely (cap 0) or setting a timeout no request could ever meet.
var numericBounds = map[string][2]int{
	"dailyCallCap":          {1, 10_000_000},
	"perTenantDailyCallCap": {1, 10_000_000},
	"breakerThreshold":      {1, 100},
	"breakerCooldownMs":     {100, 24 * 60 * 60 * 1000},
	"providerTimeoutMs":     {1_000, 10 * 60 * 1000},
}

// Set validates one key/value pair, records it, and persists. Returns the normalized value that was
// stored so the caller can echo exactly what took effect rather than what was asked for.
//
// knownProviders gates the chain keys: a chain naming a provider this build doesn't have would
// silently shrink the chain (buildChain skips unknown names), so it is rejected up front instead.
// It also gates the `tiers` key's provider names; overridableProviders (those implementing
// providers.ModelOverrider) gates which of them may carry a model.
func (s *Store) Set(key string, value any, knownProviders, overridableProviders []string) (any, error) {
	if !IsWritable(key) {
		return nil, fmt.Errorf("%s is not runtime-writable (env + restart only)", key)
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	switch key {
	case "dailyCallCap", "perTenantDailyCallCap", "breakerThreshold", "breakerCooldownMs", "providerTimeoutMs":
		n, err := toInt(value)
		if err != nil {
			return nil, fmt.Errorf("%s must be a number", key)
		}
		b := numericBounds[key]
		if n < b[0] || n > b[1] {
			return nil, fmt.Errorf("%s must be between %d and %d", key, b[0], b[1])
		}
		switch key {
		case "dailyCallCap":
			s.ov.DailyCallCap = &n
		case "perTenantDailyCallCap":
			s.ov.PerTenantDailyCallCap = &n
		case "breakerThreshold":
			s.ov.BreakerThreshold = &n
		case "breakerCooldownMs":
			s.ov.BreakerCooldownMs = &n
		case "providerTimeoutMs":
			s.ov.ProviderTimeoutMs = &n
		}
		return n, s.persistLocked()

	case "dlpClassifierEnabled":
		b, err := toBool(value)
		if err != nil {
			return nil, fmt.Errorf("%s must be true or false", key)
		}
		s.ov.DLPClassifierEnabled = &b
		return b, s.persistLocked()

	case "llmChain", "mediaChain", "embedChain":
		names, err := toChain(value, knownProviders)
		if err != nil {
			return nil, err
		}
		switch key {
		case "llmChain":
			s.ov.LLMChain = names
		case "mediaChain":
			s.ov.MediaChain = names
		case "embedChain":
			s.ov.EmbedChain = names
		}
		return names, s.persistLocked()

	case "tiers":
		m, err := toTiers(value, routing.NewValidator(knownProviders, overridableProviders))
		if err != nil {
			return nil, err
		}
		s.ov.Tiers = &m
		return m, s.persistLocked()

	case "taskTiers":
		m, err := toTaskTiers(value)
		if err != nil {
			return nil, err
		}
		s.ov.TaskTiers = &m
		return m, s.persistLocked()
	}
	return nil, fmt.Errorf("unhandled key %s", key)
}

// persistLocked writes the file atomically (temp + rename) so a crash mid-write can't leave a
// truncated overrides file that fails to parse on the next boot.
func (s *Store) persistLocked() error {
	if s.path == "" {
		return nil // in-memory only (tests)
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(s.ov, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// Clear removes one override, reverting that key to its env value on the next read/restart.
func (s *Store) Clear(key string) error {
	if !IsWritable(key) {
		return fmt.Errorf("%s is not runtime-writable", key)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	switch key {
	case "dailyCallCap":
		s.ov.DailyCallCap = nil
	case "perTenantDailyCallCap":
		s.ov.PerTenantDailyCallCap = nil
	case "breakerThreshold":
		s.ov.BreakerThreshold = nil
	case "breakerCooldownMs":
		s.ov.BreakerCooldownMs = nil
	case "providerTimeoutMs":
		s.ov.ProviderTimeoutMs = nil
	case "dlpClassifierEnabled":
		s.ov.DLPClassifierEnabled = nil
	case "llmChain":
		s.ov.LLMChain = nil
	case "mediaChain":
		s.ov.MediaChain = nil
	case "embedChain":
		s.ov.EmbedChain = nil
	case "tiers":
		s.ov.Tiers = nil
	case "taskTiers":
		s.ov.TaskTiers = nil
	}
	return s.persistLocked()
}

func toInt(v any) (int, error) {
	switch t := v.(type) {
	case float64: // JSON numbers decode as float64
		if t != float64(int(t)) {
			return 0, fmt.Errorf("not an integer")
		}
		return int(t), nil
	case int:
		return t, nil
	case string:
		var n int
		if _, err := fmt.Sscanf(strings.TrimSpace(t), "%d", &n); err != nil {
			return 0, err
		}
		return n, nil
	}
	return 0, fmt.Errorf("not a number")
}

func toBool(v any) (bool, error) {
	switch t := v.(type) {
	case bool:
		return t, nil
	case string:
		s := strings.ToLower(strings.TrimSpace(t))
		if s == "true" || s == "1" || s == "on" || s == "yes" {
			return true, nil
		}
		if s == "false" || s == "0" || s == "off" || s == "no" {
			return false, nil
		}
	}
	return false, fmt.Errorf("not a boolean")
}

// toChain accepts either a JSON array or a comma-separated string (the console's text field sends
// the latter), and rejects unknown/duplicate names rather than letting the chain silently shrink.
func toChain(v any, known []string) ([]string, error) {
	var raw []string
	switch t := v.(type) {
	case []any:
		for _, x := range t {
			raw = append(raw, fmt.Sprint(x))
		}
	case []string:
		raw = t
	case string:
		for _, p := range strings.Split(t, ",") {
			raw = append(raw, p)
		}
	default:
		return nil, fmt.Errorf("chain must be a list or a comma-separated string")
	}

	knownSet := map[string]bool{}
	for _, k := range known {
		knownSet[k] = true
	}
	seen := map[string]bool{}
	out := []string{}
	for _, r := range raw {
		name := strings.TrimSpace(r)
		if name == "" {
			continue
		}
		if !knownSet[name] {
			sorted := append([]string{}, known...)
			sort.Strings(sorted)
			return nil, fmt.Errorf("unknown provider %q (known: %s)", name, strings.Join(sorted, ", "))
		}
		if seen[name] {
			return nil, fmt.Errorf("provider %q listed twice", name)
		}
		seen[name] = true
		out = append(out, name)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("chain must name at least one provider")
	}
	return out, nil
}

// objectOf accepts a JSON object either already decoded (map[string]any, what a PUT body yields) or
// as a JSON string (what a console text field sends) and returns it as a generic map.
func objectOf(v any, what string) (map[string]any, error) {
	switch t := v.(type) {
	case map[string]any:
		return t, nil
	case string:
		var m map[string]any
		if err := json.Unmarshal([]byte(t), &m); err != nil || m == nil {
			return nil, fmt.Errorf("%s must be a JSON object", what)
		}
		return m, nil
	}
	return nil, fmt.Errorf("%s must be a JSON object", what)
}

// toTiers parses and validates a `tiers` write: {"fast": {"provider": "openai", "model": ""}, ...}.
// Keys only fast|standard|strong; an entry has exactly the fields provider and model (model may be
// omitted or empty). An empty object is valid and means "no tiers".
func toTiers(v any, val routing.Validator) (map[string]routing.Entry, error) {
	obj, err := objectOf(v, "tiers")
	if err != nil {
		return nil, err
	}
	out := make(map[string]routing.Entry, len(obj))
	for tier, raw := range obj {
		fields, ok := raw.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("tiers.%s must be an object {provider, model}", tier)
		}
		var e routing.Entry
		for name, fv := range fields {
			if name != "provider" && name != "model" {
				return nil, fmt.Errorf("tiers.%s: unknown field %q (allowed: provider, model)", tier, name)
			}
			str, ok := fv.(string)
			if !ok {
				return nil, fmt.Errorf("tiers.%s.%s must be a string", tier, name)
			}
			if name == "provider" {
				e.Provider = strings.TrimSpace(str)
			} else {
				e.Model = strings.TrimSpace(str)
			}
		}
		out[tier] = e
	}
	if err := val.CheckTiers(out); err != nil {
		return nil, err
	}
	return out, nil
}

// toTaskTiers parses and validates a `taskTiers` write: {"summarise": "fast", ...}. Keys only the
// five tasks, values only the three tiers. An empty object is valid.
func toTaskTiers(v any) (map[string]string, error) {
	obj, err := objectOf(v, "taskTiers")
	if err != nil {
		return nil, err
	}
	out := make(map[string]string, len(obj))
	for task, raw := range obj {
		tier, ok := raw.(string)
		if !ok {
			return nil, fmt.Errorf("taskTiers.%s must be a tier name string", task)
		}
		out[task] = strings.TrimSpace(tier)
	}
	if err := routing.CheckTaskTiers(out); err != nil {
		return nil, err
	}
	return out, nil
}

// FoldRouting returns the effective routing table: the env table with any persisted override
// replacing the matching half wholesale. Used at boot and after every tiers/taskTiers write or clear.
func FoldRouting(env routing.Table, ov Overrides) routing.Table {
	out := env
	if ov.Tiers != nil {
		out.Tiers = *ov.Tiers
	}
	if ov.TaskTiers != nil {
		out.TaskTiers = *ov.TaskTiers
	}
	return out
}

// Apply folds the overrides onto a boot config, returning the effective values. Callers use this at
// startup so a persisted override is in force from the first request, not only after a console read.
func Apply(ov Overrides, dailyCap, perTenantCap, breakerThreshold, breakerCooldownMs, providerTimeoutMs int, dlp bool, llm, media, embed []string) (
	int, int, int, int, int, bool, []string, []string, []string,
) {
	if ov.DailyCallCap != nil {
		dailyCap = *ov.DailyCallCap
	}
	if ov.PerTenantDailyCallCap != nil {
		perTenantCap = *ov.PerTenantDailyCallCap
	}
	if ov.BreakerThreshold != nil {
		breakerThreshold = *ov.BreakerThreshold
	}
	if ov.BreakerCooldownMs != nil {
		breakerCooldownMs = *ov.BreakerCooldownMs
	}
	if ov.ProviderTimeoutMs != nil {
		providerTimeoutMs = *ov.ProviderTimeoutMs
	}
	if ov.DLPClassifierEnabled != nil {
		dlp = *ov.DLPClassifierEnabled
	}
	if len(ov.LLMChain) > 0 {
		llm = ov.LLMChain
	}
	if len(ov.MediaChain) > 0 {
		media = ov.MediaChain
	}
	if len(ov.EmbedChain) > 0 {
		embed = ov.EmbedChain
	}
	return dailyCap, perTenantCap, breakerThreshold, breakerCooldownMs, providerTimeoutMs, dlp, llm, media, embed
}
