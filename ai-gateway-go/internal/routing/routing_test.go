package routing

import (
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"
)

var testTable = Table{
	Tiers: map[string]Entry{
		"fast":     {Provider: "openai", Model: ""},
		"standard": {Provider: "openai", Model: "std-model"},
		"strong":   {Provider: "claude", Model: "claude-strong"},
	},
	TaskTiers: map[string]string{"chat": "standard", "summarise": "fast", "draft": "strong"},
}

func TestResolve(t *testing.T) {
	cases := []struct {
		name             string
		hint, task, tier string
		table            Table
		want             Route
	}{
		{"nothing asked, nothing configured", "", "", "", Table{}, Route{}},
		{"nothing asked, table configured", "", "", "", testTable, Route{}},
		{"tier alone", "", "", "strong", testTable, Route{Hint: "claude", Model: "claude-strong", Tier: "strong"}},
		{"tier with an empty model keeps the provider default", "", "", "fast", testTable, Route{Hint: "openai", Model: "", Tier: "fast"}},
		{"task alone resolves through TaskTiers", "", "chat", "", testTable, Route{Hint: "openai", Model: "std-model", Tier: "standard", Task: "chat"}},
		{"explicit tier beats the task's tier", "", "draft", "fast", testTable, Route{Hint: "openai", Model: "", Tier: "fast", Task: "draft"}},
		{"valid task that maps to nothing is only carried", "", "classify", "", testTable, Route{Task: "classify"}},
		{"task maps to a tier with no entry", "", "chat", "", Table{TaskTiers: map[string]string{"chat": "strong"}, Tiers: map[string]Entry{"fast": {Provider: "openai"}}}, Route{Task: "chat"}},
		{"tier with no entry is today's path", "", "", "strong", Table{Tiers: map[string]Entry{"fast": {Provider: "openai"}}}, Route{}},
		{"empty table ignores a valid tier and task", "", "chat", "strong", Table{}, Route{Task: "chat"}},
		{"provider wins, tier not consulted, task still carried", "ollama", "chat", "strong", testTable, Route{Hint: "ollama", Task: "chat"}},
		{"provider alone", "ollama", "", "", testTable, Route{Hint: "ollama"}},
		{"unknown provider hint is still the hint (the chain ignores it)", "no-such", "", "fast", testTable, Route{Hint: "no-such"}},
		// invalid values are ABSENT, never errors
		{"unknown tier is absent", "", "", "gold", testTable, Route{}},
		{"wrong-case tier is absent", "", "", "Fast", testTable, Route{}},
		{"empty-ish tier is absent", "", "", " ", testTable, Route{}},
		{"unknown task is absent", "", "poetry", "", testTable, Route{}},
		{"wrong-case task is absent", "", "Chat", "", testTable, Route{}},
		{"invalid tier falls back to the valid task's tier", "", "chat", "gold", testTable, Route{Hint: "openai", Model: "std-model", Tier: "standard", Task: "chat"}},
		{"invalid task with a valid tier still routes by tier", "", "poetry", "strong", testTable, Route{Hint: "claude", Model: "claude-strong", Tier: "strong"}},
		{"invalid task never reaches the table", "", "poetry", "", Table{TaskTiers: map[string]string{"poetry": "fast"}, Tiers: map[string]Entry{"fast": {Provider: "openai"}}}, Route{}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Resolve(c.hint, c.task, c.tier, c.table); got != c.want {
				t.Fatalf("Resolve(%q,%q,%q) = %+v, want %+v", c.hint, c.task, c.tier, got, c.want)
			}
		})
	}
}

func TestTableTierNamesAreSortedNamesOnly(t *testing.T) {
	if got := (Table{}).TierNames(); got != nil {
		t.Fatalf("empty table: %v", got)
	}
	if got := (Table{TaskTiers: map[string]string{"chat": "fast"}}).TierNames(); got != nil {
		t.Fatalf("task mappings alone are not tiers: %v", got)
	}
	got := testTable.TierNames()
	if !reflect.DeepEqual(got, []string{"fast", "standard", "strong"}) {
		t.Fatalf("got %v", got)
	}
}

var testValidator = NewValidator(
	[]string{"whisper", "ollama", "openai", "gemini", "claude", "hermes", "echo"},
	[]string{"ollama", "openai", "gemini", "claude"},
)

func TestParseTiers(t *testing.T) {
	cases := []struct {
		name     string
		raw      string
		want     map[string]Entry
		problems []string // each must appear as "key: reason-substring"
	}{
		{"empty", "", map[string]Entry{}, nil},
		{"whitespace and stray commas", " , ,", map[string]Entry{}, nil},
		{"provider only", "fast=openai", map[string]Entry{"fast": {Provider: "openai"}}, nil},
		{"all three", "fast=openai,standard=openai,strong=openai:z-ai/glm-5.3-flash",
			map[string]Entry{"fast": {Provider: "openai"}, "standard": {Provider: "openai"}, "strong": {Provider: "openai", Model: "z-ai/glm-5.3-flash"}}, nil},
		{"split at the FIRST colon (the model keeps its own)", "strong=ollama:qwen3.5:397b-cloud",
			map[string]Entry{"strong": {Provider: "ollama", Model: "qwen3.5:397b-cloud"}}, nil},
		{"spaces are trimmed", " fast = openai : m1 ", map[string]Entry{"fast": {Provider: "openai", Model: "m1"}}, nil},
		{"trailing colon is an empty model", "fast=openai:", map[string]Entry{"fast": {Provider: "openai"}}, nil},
		{"unknown tier", "gold=openai", map[string]Entry{}, []string{"gold: unknown tier"}},
		{"wrong-case tier", "Fast=openai", map[string]Entry{}, []string{"Fast: unknown tier"}},
		{"unknown provider", "fast=nope", map[string]Entry{}, []string{"fast: unknown provider"}},
		{"echo refused", "fast=echo", map[string]Entry{}, []string{"fast: provider echo is refused"}},
		{"echo with a model refused", "fast=echo:x", map[string]Entry{}, []string{"fast: provider echo is refused"}},
		{"empty provider", "fast=", map[string]Entry{}, []string{"fast: provider required"}},
		{"no equals sign", "fastopenai", map[string]Entry{}, []string{"fastopenai: expected tier=provider"}},
		{"bad model chars (space)", "fast=openai:a b", map[string]Entry{}, []string{"fast: model has characters"}},
		{"bad model chars (quote)", `fast=openai:a"b`, map[string]Entry{}, []string{"fast: model has characters"}},
		{"model starting with a symbol", "fast=openai:-x", map[string]Entry{}, []string{"fast: model has characters"}},
		{"model too long", "fast=openai:a" + strings.Repeat("b", 128), map[string]Entry{}, []string{"fast: model has characters"}},
		{"model at the 128 limit", "fast=openai:a" + strings.Repeat("b", 127),
			map[string]Entry{"fast": {Provider: "openai", Model: "a" + strings.Repeat("b", 127)}}, nil},
		{"model on a provider that cannot override", "fast=hermes:x", map[string]Entry{}, []string{"fast: provider \"hermes\" cannot take a model override"}},
		{"hermes without a model is fine", "fast=hermes", map[string]Entry{"fast": {Provider: "hermes"}}, nil},
		{"duplicate keeps the first", "fast=openai,fast=claude", map[string]Entry{"fast": {Provider: "openai"}}, []string{"fast: duplicate tier"}},
		{"good entries survive a bad neighbour", "fast=openai,gold=openai,strong=claude:m",
			map[string]Entry{"fast": {Provider: "openai"}, "strong": {Provider: "claude", Model: "m"}}, []string{"gold: unknown tier"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, problems := ParseTiers(c.raw, testValidator)
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("tiers = %+v, want %+v", got, c.want)
			}
			if len(problems) != len(c.problems) {
				t.Fatalf("problems = %+v, want %v", problems, c.problems)
			}
			for i, want := range c.problems {
				key, reason, _ := strings.Cut(want, ": ")
				if problems[i].Key != key || !strings.Contains(problems[i].Reason, reason) {
					t.Fatalf("problem %d = %+v, want key %q reason containing %q", i, problems[i], key, reason)
				}
			}
		})
	}
}

func TestParseTaskTiers(t *testing.T) {
	cases := []struct {
		name     string
		raw      string
		want     map[string]string
		problems []string
	}{
		{"empty", "", map[string]string{}, nil},
		{"good", "chat=standard, summarise = fast", map[string]string{"chat": "standard", "summarise": "fast"}, nil},
		{"all five", "chat=fast,summarise=fast,classify=fast,agent_step=strong,draft=strong",
			map[string]string{"chat": "fast", "summarise": "fast", "classify": "fast", "agent_step": "strong", "draft": "strong"}, nil},
		{"unknown task", "poetry=fast", map[string]string{}, []string{"poetry: unknown task"}},
		{"wrong-case task", "Chat=fast", map[string]string{}, []string{"Chat: unknown task"}},
		{"unknown tier", "chat=gold", map[string]string{}, []string{"chat: unknown tier"}},
		{"no equals sign", "chat", map[string]string{}, []string{"chat: expected task=tier"}},
		{"duplicate keeps the first", "chat=fast,chat=strong", map[string]string{"chat": "fast"}, []string{"chat: duplicate task"}},
		{"good survives bad", "chat=fast,nope=fast,draft=strong", map[string]string{"chat": "fast", "draft": "strong"}, []string{"nope: unknown task"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, problems := ParseTaskTiers(c.raw)
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("taskTiers = %+v, want %+v", got, c.want)
			}
			if len(problems) != len(c.problems) {
				t.Fatalf("problems = %+v, want %v", problems, c.problems)
			}
			for i, want := range c.problems {
				key, reason, _ := strings.Cut(want, ": ")
				if problems[i].Key != key || !strings.Contains(problems[i].Reason, reason) {
					t.Fatalf("problem %d = %+v", i, problems[i])
				}
			}
		})
	}
}

// A dropped entry is logged by KEY and reason; the value after `=` (the part an operator might have
// pasted a secret into) is never logged, and a boot with every entry bad is just an empty table.
func TestFromEnvLogsKeysNotValuesAndNeverFails(t *testing.T) {
	var lines []string
	logf := func(format string, args ...any) { lines = append(lines, fmt.Sprintf(format, args...)) }
	tbl := FromEnv("fast=openai,gold=SECRETVALUE:abc,strong=echo", "chat=standard,nope=fast,junkjunk", testValidator, logf)

	if !reflect.DeepEqual(tbl.Tiers, map[string]Entry{"fast": {Provider: "openai"}}) {
		t.Fatalf("tiers %+v", tbl.Tiers)
	}
	if !reflect.DeepEqual(tbl.TaskTiers, map[string]string{"chat": "standard"}) {
		t.Fatalf("task tiers %+v", tbl.TaskTiers)
	}
	if len(lines) != 4 {
		t.Fatalf("want one line per dropped entry (gold, strong, nope, junkjunk), got %d: %q", len(lines), lines)
	}
	joined := strings.Join(lines, "\n")
	for _, want := range []string{`"gold"`, `"strong"`, `"nope"`, `"junkjunk"`, "GATEWAY_TIERS", "GATEWAY_TASK_TIERS"} {
		if !strings.Contains(joined, want) {
			t.Errorf("log lacks %s: %s", want, joined)
		}
	}
	if strings.Contains(joined, "SECRETVALUE") {
		t.Errorf("a value leaked into the log: %s", joined)
	}
	// nil logger is allowed (silent)
	_ = FromEnv("x", "y", testValidator, nil)
	if got := FromEnv("", "", testValidator, nil); got.Empty() != true {
		t.Fatalf("empty env must be an empty table, got %+v", got)
	}
}

func TestCheckTiersAndTaskTiers(t *testing.T) {
	if err := testValidator.CheckTiers(nil); err != nil {
		t.Fatalf("no tiers is valid: %v", err)
	}
	if err := testValidator.CheckTiers(map[string]Entry{"fast": {Provider: "openai", Model: "a/b:c@d+e-f_g.h"}}); err != nil {
		t.Fatalf("all model punctuation is allowed: %v", err)
	}
	for _, bad := range []map[string]Entry{
		{"gold": {Provider: "openai"}},
		{"fast": {Provider: ""}},
		{"fast": {Provider: "echo"}},
		{"fast": {Provider: "nope"}},
		{"fast": {Provider: "hermes", Model: "m"}},
		{"fast": {Provider: "openai", Model: "bad model"}},
	} {
		if err := testValidator.CheckTiers(bad); err == nil {
			t.Errorf("expected %+v to be refused", bad)
		}
	}
	if err := CheckTaskTiers(map[string]string{"chat": "fast", "draft": "strong"}); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []map[string]string{{"nope": "fast"}, {"chat": "gold"}, {"Chat": "fast"}, {"chat": ""}} {
		if err := CheckTaskTiers(bad); err == nil {
			t.Errorf("expected %+v to be refused", bad)
		}
	}
}

func TestHolderKeepsAPrivateCopyAndIsRaceFree(t *testing.T) {
	src := Table{Tiers: map[string]Entry{"fast": {Provider: "openai"}}}
	h := NewHolder(src)
	src.Tiers["strong"] = Entry{Provider: "claude"} // a later edit of the caller's map must not leak in
	if names := h.Get().TierNames(); !reflect.DeepEqual(names, []string{"fast"}) {
		t.Fatalf("holder shares the caller's map: %v", names)
	}

	var readers, writers sync.WaitGroup
	stop := make(chan struct{})
	for i := 0; i < 8; i++ {
		readers.Add(1)
		go func() {
			defer readers.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				tbl := h.Get()
				_ = Resolve("", "chat", "", tbl)
				_ = tbl.TierNames()
			}
		}()
	}
	for i := 0; i < 4; i++ {
		writers.Add(1)
		go func() {
			defer writers.Done()
			for j := 0; j < 500; j++ {
				if j%2 == 0 {
					h.Set(Table{Tiers: map[string]Entry{"fast": {Provider: "openai"}}, TaskTiers: map[string]string{"chat": "fast"}})
				} else {
					h.Update(func() Table { return Table{Tiers: map[string]Entry{"strong": {Provider: "claude"}}} })
				}
			}
		}()
	}
	writers.Wait()
	close(stop)
	readers.Wait()
}
