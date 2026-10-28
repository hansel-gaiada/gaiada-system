package adminconfig

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"gaiada/ai-gateway-go/internal/routing"
)

var (
	known       = []string{"ollama", "openai", "gemini", "claude", "hermes", "echo"}
	overridable = []string{"ollama", "openai", "gemini", "claude"}
)

func decode(t *testing.T, raw string) any {
	t.Helper()
	var v any
	if err := json.Unmarshal([]byte(raw), &v); err != nil {
		t.Fatalf("bad test json %q: %v", raw, err)
	}
	return v
}

func TestSetTiersAcceptsAndRejects(t *testing.T) {
	accept := []string{
		`{}`,
		`{"fast":{"provider":"openai"}}`,
		`{"fast":{"provider":"openai","model":""}}`,
		`{"fast":{"provider":"openai","model":"z-ai/glm-5.3-flash"},"standard":{"provider":"ollama","model":"qwen3.5:397b-cloud"},"strong":{"provider":"claude","model":"claude-haiku-4-5-20251001"}}`,
		`{"fast":{"provider":"hermes"}}`, // known, no model
		`{"fast":{"provider":" openai ","model":" m "}}`,
		`"{\"fast\":{\"provider\":\"openai\"}}"`, // a JSON string, as a console text field sends it
	}
	for _, raw := range accept {
		s, _ := Load("")
		if _, err := s.Set("tiers", decode(t, raw), known, overridable); err != nil {
			t.Errorf("%s: expected accept, got %v", raw, err)
		}
	}
	reject := map[string]string{
		`{"gold":{"provider":"openai"}}`:                                            "unknown tier",
		`{"Fast":{"provider":"openai"}}`:                                            "unknown tier",
		`{"fast":{"provider":"nope"}}`:                                              "unknown provider",
		`{"fast":{"provider":"echo"}}`:                                              "echo",
		`{"fast":{"provider":"echo","model":"m"}}`:                                  "echo",
		`{"fast":{"provider":""}}`:                                                  "provider required",
		`{"fast":{}}`:                                                               "provider required",
		`{"fast":{"provider":"hermes","model":"m"}}`:                                "cannot take a model override",
		`{"fast":{"provider":"openai","model":"has space"}}`:                        "model has characters",
		`{"fast":{"provider":"openai","model":"-leading"}}`:                         "model has characters",
		`{"fast":{"provider":"openai","model":"a;b"}}`:                              "model has characters",
		`{"fast":{"provider":"openai","model":"` + strings.Repeat("a", 129) + `"}}`: "model has characters",
		`{"fast":{"provider":"openai","extra":"x"}}`:                                "unknown field",
		`{"fast":{"provider":5}}`:                                                   "must be a string",
		`{"fast":{"provider":"openai","model":7}}`:                                  "must be a string",
		`{"fast":"openai"}`:                                                         "must be an object",
		`[]`:                                                                        "JSON object",
		`5`:                                                                         "JSON object",
		`null`:                                                                      "JSON object",
		`"not json"`:                                                                "JSON object",
	}
	for raw, why := range reject {
		s, _ := Load("")
		_, err := s.Set("tiers", decode(t, raw), known, overridable)
		if err == nil || !strings.Contains(err.Error(), why) {
			t.Errorf("%s: expected a refusal containing %q, got %v", raw, why, err)
		}
		if s.Get().Tiers != nil {
			t.Errorf("%s: a refused write must record nothing", raw)
		}
	}
}

func TestSetTaskTiersAcceptsAndRejects(t *testing.T) {
	for _, raw := range []string{`{}`, `{"summarise":"fast"}`, `{"chat":"standard","agent_step":"strong","draft":"strong","classify":"fast","summarise":"fast"}`, `"{\"chat\":\"fast\"}"`} {
		s, _ := Load("")
		if _, err := s.Set("taskTiers", decode(t, raw), known, overridable); err != nil {
			t.Errorf("%s: expected accept, got %v", raw, err)
		}
	}
	reject := map[string]string{
		`{"poetry":"fast"}`: "unknown task",
		`{"Chat":"fast"}`:   "unknown task",
		`{"chat":"gold"}`:   "unknown tier",
		`{"chat":""}`:       "unknown tier",
		`{"chat":1}`:        "tier name string",
		`{"chat":["fast"]}`: "tier name string",
		`["chat"]`:          "JSON object",
		`3`:                 "JSON object",
	}
	for raw, why := range reject {
		s, _ := Load("")
		_, err := s.Set("taskTiers", decode(t, raw), known, overridable)
		if err == nil || !strings.Contains(err.Error(), why) {
			t.Errorf("%s: expected a refusal containing %q, got %v", raw, why, err)
		}
		if s.Get().TaskTiers != nil {
			t.Errorf("%s: a refused write must record nothing", raw)
		}
	}
}

func TestTierKeysAreWritable(t *testing.T) {
	if !IsWritable("tiers") || !IsWritable("taskTiers") {
		t.Fatal("tiers and taskTiers must be writable keys")
	}
}

// A write is persisted, survives a reload, and an EMPTY object stays an override ("no tiers"), distinct
// from no override at all.
func TestTiersPersistRoundTripAndEmptyIsAnOverride(t *testing.T) {
	path := filepath.Join(t.TempDir(), "o.json")
	s, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Set("tiers", decode(t, `{"strong":{"provider":"openai","model":"z-ai/glm-5.3-flash"}}`), known, overridable); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Set("taskTiers", decode(t, `{}`), known, overridable); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	if !strings.Contains(string(raw), `"taskTiers": {}`) {
		t.Fatalf("an empty override must be persisted as {}: %s", raw)
	}

	re, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	ov := re.Get()
	if ov.Tiers == nil || !reflect.DeepEqual(*ov.Tiers, map[string]routing.Entry{"strong": {Provider: "openai", Model: "z-ai/glm-5.3-flash"}}) {
		t.Fatalf("tiers did not round-trip: %+v", ov.Tiers)
	}
	if ov.TaskTiers == nil || len(*ov.TaskTiers) != 0 {
		t.Fatalf("an empty taskTiers override must reload as a non-nil empty map: %+v", ov.TaskTiers)
	}

	// Clear is persisted too, and reloads as "not overridden".
	if err := re.Clear("tiers"); err != nil {
		t.Fatal(err)
	}
	if err := re.Clear("taskTiers"); err != nil {
		t.Fatal(err)
	}
	re2, _ := Load(path)
	if ov := re2.Get(); ov.Tiers != nil || ov.TaskTiers != nil {
		t.Fatalf("clear did not persist: %+v", ov)
	}
}

func TestFoldRoutingReplacesEachHalfWholesale(t *testing.T) {
	env := routing.Table{
		Tiers:     map[string]routing.Entry{"fast": {Provider: "openai"}, "strong": {Provider: "claude"}},
		TaskTiers: map[string]string{"chat": "fast"},
	}
	if got := FoldRouting(env, Overrides{}); !reflect.DeepEqual(got, env) {
		t.Fatalf("no override must be the env table: %+v", got)
	}
	tiers := map[string]routing.Entry{"standard": {Provider: "ollama"}}
	got := FoldRouting(env, Overrides{Tiers: &tiers})
	if !reflect.DeepEqual(got.Tiers, tiers) || !reflect.DeepEqual(got.TaskTiers, env.TaskTiers) {
		t.Fatalf("tiers override must replace only the tiers: %+v", got)
	}
	none := map[string]routing.Entry{}
	if got := FoldRouting(env, Overrides{Tiers: &none}); !got.Empty() {
		t.Fatalf("an empty tiers override means no tiers: %+v", got)
	}
	noTasks := map[string]string{}
	if got := FoldRouting(env, Overrides{TaskTiers: &noTasks}); len(got.TaskTiers) != 0 || len(got.Tiers) != 2 {
		t.Fatalf("an empty taskTiers override clears only the mapping: %+v", got)
	}
	if len(env.Tiers) != 2 {
		t.Fatal("FoldRouting must not edit the env table")
	}
}
