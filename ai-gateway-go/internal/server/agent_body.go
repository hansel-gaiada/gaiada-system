// agent_body.go: the request allow-list and the DLP pass for POST /v1/chat/completions
// (AIP-00a-1, plan docs/plans/2026-10-27-ai-plan.md §6.1 items 1 and 2).
//
// Nothing the caller sends is forwarded by default. Each allowed top-level key is validated and
// rebuilt; messages are rebuilt field by field from {role, content, tool_calls, tool_call_id}, and
// content parts from {type:"text", text}. Every unknown key, at the top level and inside a message
// or a part, is dropped; the names (never the values) are reported for the log.
package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"gaiada/ai-gateway-go/internal/dlp"
)

const (
	// agentMaxBodyBytes caps the request body. A Hermes turn with a long history and big tool
	// results fits comfortably; anything larger is refused with 413 before it is parsed.
	agentMaxBodyBytes = 2 << 20
	// agentMaxMessages caps the message count.
	agentMaxMessages = 400
)

// reqError is a 4xx the caller can fix, in the OpenAI error shape.
type reqError struct {
	status int
	code   string
	msg    string
}

func badRequest(code, format string, args ...any) *reqError {
	return &reqError{status: 400, code: code, msg: fmt.Sprintf(format, args...)}
}

// chatToolCall is one earlier assistant tool call, rebuilt from {id, type, function{name, arguments}}.
type chatToolCall struct {
	ID        *string
	Name      string
	Arguments string
}

// chatContent is a message's content: absent, null, a string, or text parts.
type chatContent struct {
	kind  int // contentAbsent | contentNull | contentString | contentParts
	text  string
	parts []string
}

const (
	contentAbsent = iota
	contentNull
	contentString
	contentParts
)

type chatMessage struct {
	role       string
	content    chatContent
	toolCalls  []chatToolCall
	hasCalls   bool
	toolCallID *string
}

// chatBody is the validated request before DLP: messages still hold the caller's raw text.
type chatBody struct {
	messages []chatMessage
	// passthrough holds the other allowed keys, validated, as the caller sent them.
	passthrough map[string]json.RawMessage
	stream      bool
	// dropped is the sorted set of dropped key names ("foo", "messages[].name", "content[].cache_control").
	dropped []string
}

// agentTopLevelKeys is the top-level allow-list. `model` and `stream` are read but never
// forwarded as sent: the provider sets its own model, and the stream flag is re-issued.
var agentTopLevelKeys = map[string]bool{
	"model": true, "messages": true, "tools": true, "tool_choice": true, "temperature": true,
	"top_p": true, "max_tokens": true, "max_completion_tokens": true, "stop": true, "stream": true,
}

var agentRoles = map[string]bool{"system": true, "user": true, "assistant": true, "tool": true}

// safeName keeps a dropped key's NAME printable and short for the log. A name is caller-chosen, so
// it is clipped; a value is never logged at all.
var plainKeyRe = regexp.MustCompile(`^[A-Za-z0-9_.\-\[\]]{1,64}$`)

func safeName(k string) string {
	if plainKeyRe.MatchString(k) {
		return k
	}
	r := []rune(k)
	if len(r) > 32 {
		r = r[:32]
	}
	return fmt.Sprintf("%q", string(r))
}

func isNull(raw json.RawMessage) bool {
	return len(bytes.TrimSpace(raw)) == 0 || string(bytes.TrimSpace(raw)) == "null"
}

// parseChatBody validates a request body against the allow-list. It does not run DLP.
func parseChatBody(raw []byte) (*chatBody, *reqError) {
	var top map[string]json.RawMessage
	if err := json.Unmarshal(raw, &top); err != nil || top == nil {
		return nil, badRequest("invalid_json", "the request body must be a JSON object")
	}
	out := &chatBody{passthrough: map[string]json.RawMessage{}}
	dropped := map[string]bool{}
	for k := range top {
		if !agentTopLevelKeys[k] {
			dropped[safeName(k)] = true
		}
	}
	if v, ok := top["model"]; ok && !isNull(v) {
		var s string
		if json.Unmarshal(v, &s) != nil {
			return nil, badRequest("invalid_model", "model must be a string")
		}
	}
	if v, ok := top["stream"]; ok && !isNull(v) {
		if json.Unmarshal(v, &out.stream) != nil {
			return nil, badRequest("invalid_stream", "stream must be a boolean")
		}
	}
	for _, k := range []string{"temperature", "top_p"} {
		if v, ok := top[k]; ok && !isNull(v) {
			var f float64
			if json.Unmarshal(v, &f) != nil {
				return nil, badRequest("invalid_"+k, "%s must be a number", k)
			}
			out.passthrough[k] = v
		}
	}
	for _, k := range []string{"max_tokens", "max_completion_tokens"} {
		if v, ok := top[k]; ok && !isNull(v) {
			var n int64
			if json.Unmarshal(v, &n) != nil || n < 1 {
				return nil, badRequest("invalid_"+k, "%s must be a positive integer", k)
			}
			out.passthrough[k] = v
		}
	}
	if v, ok := top["stop"]; ok && !isNull(v) {
		var s string
		var ss []string
		if json.Unmarshal(v, &s) != nil && json.Unmarshal(v, &ss) != nil {
			return nil, badRequest("invalid_stop", "stop must be a string or an array of strings")
		}
		out.passthrough["stop"] = v
	}
	if v, ok := top["tool_choice"]; ok && !isNull(v) {
		var s string
		var o map[string]json.RawMessage
		if json.Unmarshal(v, &s) != nil && (json.Unmarshal(v, &o) != nil || o == nil) {
			return nil, badRequest("invalid_tool_choice", "tool_choice must be a string or an object")
		}
		out.passthrough["tool_choice"] = v
	}
	if v, ok := top["tools"]; ok && !isNull(v) {
		var tools []map[string]json.RawMessage
		if json.Unmarshal(v, &tools) != nil {
			return nil, badRequest("invalid_tools", "tools must be an array of objects")
		}
		for i, t := range tools {
			var typ string
			if t == nil || json.Unmarshal(t["type"], &typ) != nil || typ != "function" {
				return nil, badRequest("invalid_tools", "tools[%d].type must be \"function\"", i)
			}
		}
		// Tool definitions are code (names and JSON schemas), not caller data: passed as sent and
		// not scrubbed (plan §6.1 item 2).
		out.passthrough["tools"] = v
	}

	rawMsgs, ok := top["messages"]
	if !ok || isNull(rawMsgs) {
		return nil, badRequest("missing_messages", "messages is required")
	}
	var msgs []map[string]json.RawMessage
	if json.Unmarshal(rawMsgs, &msgs) != nil {
		return nil, badRequest("invalid_messages", "messages must be an array of objects")
	}
	if len(msgs) == 0 {
		return nil, badRequest("missing_messages", "messages must not be empty")
	}
	if len(msgs) > agentMaxMessages {
		return nil, badRequest("too_many_messages", "messages holds %d entries; the limit is %d", len(msgs), agentMaxMessages)
	}
	for i, m := range msgs {
		cm, rerr := parseChatMessage(i, m, dropped)
		if rerr != nil {
			return nil, rerr
		}
		out.messages = append(out.messages, cm)
	}
	for k := range dropped {
		out.dropped = append(out.dropped, k)
	}
	sort.Strings(out.dropped)
	return out, nil
}

var chatMessageKeys = map[string]bool{"role": true, "content": true, "tool_calls": true, "tool_call_id": true}

var partTypeRe = regexp.MustCompile(`^[a-z_]{1,32}$`)

func parseChatMessage(i int, m map[string]json.RawMessage, dropped map[string]bool) (chatMessage, *reqError) {
	var cm chatMessage
	if m == nil {
		return cm, badRequest("invalid_messages", "messages[%d] must be an object", i)
	}
	for k := range m {
		if !chatMessageKeys[k] {
			dropped["messages[]."+safeName(k)] = true
		}
	}
	if json.Unmarshal(m["role"], &cm.role) != nil || !agentRoles[cm.role] {
		return cm, badRequest("invalid_role", "messages[%d].role must be one of system, user, assistant, tool", i)
	}

	// Content: a string, null, or text parts. Any non-text part is refused, because DLP cannot read
	// an image or audio payload (plan §6.1 item 1).
	if raw, ok := m["content"]; ok {
		trimmed := bytes.TrimSpace(raw)
		switch {
		case isNull(raw):
			cm.content.kind = contentNull
		case len(trimmed) > 0 && trimmed[0] == '"':
			cm.content.kind = contentString
			if json.Unmarshal(raw, &cm.content.text) != nil {
				return cm, badRequest("invalid_content", "messages[%d].content is not a valid string", i)
			}
		case len(trimmed) > 0 && trimmed[0] == '[':
			cm.content.kind = contentParts
			var parts []map[string]json.RawMessage
			if json.Unmarshal(raw, &parts) != nil {
				return cm, badRequest("invalid_content", "messages[%d].content must be a string or an array of parts", i)
			}
			cm.content.parts = []string{}
			for j, p := range parts {
				var typ string
				if p == nil || json.Unmarshal(p["type"], &typ) != nil {
					return cm, badRequest("invalid_content", "messages[%d].content[%d] has no type", i, j)
				}
				if typ != "text" {
					shown := typ
					if !partTypeRe.MatchString(shown) {
						shown = "unknown"
					}
					return cm, badRequest("unsupported_content_part",
						"messages[%d].content[%d] is a %q part; only text parts are accepted (the gateway cannot inspect images or audio)", i, j, shown)
				}
				var text string
				if json.Unmarshal(p["text"], &text) != nil {
					return cm, badRequest("invalid_content", "messages[%d].content[%d].text must be a string", i, j)
				}
				for k := range p {
					if k != "type" && k != "text" {
						dropped["content[]."+safeName(k)] = true
					}
				}
				cm.content.parts = append(cm.content.parts, text)
			}
		default:
			return cm, badRequest("invalid_content", "messages[%d].content must be a string, null, or an array of text parts", i)
		}
	}

	if raw, ok := m["tool_calls"]; ok && !isNull(raw) {
		if cm.role != "assistant" {
			dropped["messages[].tool_calls"] = true
		} else {
			var calls []map[string]json.RawMessage
			if json.Unmarshal(raw, &calls) != nil {
				return cm, badRequest("invalid_tool_calls", "messages[%d].tool_calls must be an array of objects", i)
			}
			cm.hasCalls = true
			cm.toolCalls = []chatToolCall{}
			for j, c := range calls {
				tc, rerr := parseToolCall(i, j, c)
				if rerr != nil {
					return cm, rerr
				}
				cm.toolCalls = append(cm.toolCalls, tc)
			}
		}
	}

	if raw, ok := m["tool_call_id"]; ok && !isNull(raw) {
		if cm.role != "tool" {
			dropped["messages[].tool_call_id"] = true
		} else {
			var id string
			if json.Unmarshal(raw, &id) != nil {
				return cm, badRequest("invalid_tool_call_id", "messages[%d].tool_call_id must be a string", i)
			}
			cm.toolCallID = &id
		}
	}
	return cm, nil
}

func parseToolCall(i, j int, c map[string]json.RawMessage) (chatToolCall, *reqError) {
	var tc chatToolCall
	if c == nil {
		return tc, badRequest("invalid_tool_calls", "messages[%d].tool_calls[%d] must be an object", i, j)
	}
	if raw, ok := c["id"]; ok && !isNull(raw) {
		var id string
		if json.Unmarshal(raw, &id) != nil {
			return tc, badRequest("invalid_tool_calls", "messages[%d].tool_calls[%d].id must be a string", i, j)
		}
		tc.ID = &id
	}
	if raw, ok := c["type"]; ok && !isNull(raw) {
		var typ string
		if json.Unmarshal(raw, &typ) != nil || typ != "function" {
			return tc, badRequest("invalid_tool_calls", "messages[%d].tool_calls[%d].type must be \"function\"", i, j)
		}
	}
	var fn map[string]json.RawMessage
	if json.Unmarshal(c["function"], &fn) != nil || fn == nil {
		return tc, badRequest("invalid_tool_calls", "messages[%d].tool_calls[%d].function must be an object", i, j)
	}
	if json.Unmarshal(fn["name"], &tc.Name) != nil {
		return tc, badRequest("invalid_tool_calls", "messages[%d].tool_calls[%d].function.name must be a string", i, j)
	}
	if raw, ok := fn["arguments"]; ok && !isNull(raw) {
		if json.Unmarshal(raw, &tc.Arguments) != nil {
			// Some clients send the arguments as an object. Re-encode it as the string the
			// chat-completions dialect specifies, so it is scrubbed like any other.
			var anyv any
			if json.Unmarshal(raw, &anyv) != nil {
				return tc, badRequest("invalid_tool_calls", "messages[%d].tool_calls[%d].function.arguments must be a string", i, j)
			}
			var buf bytes.Buffer
			_ = json.Compact(&buf, raw)
			tc.Arguments = buf.String()
		}
	}
	return tc, nil
}

// cleanedChat is the request after DLP: ready to hand to a ChatProvider.
type cleanedChat struct {
	fields     map[string]json.RawMessage
	redactions int
	// cleanText is every scrubbed text joined, for the classifier. Never logged or audited.
	cleanText string
}

// scrubChat runs dlp.DLP on every text the caller sent: each message's string or text parts
// (system, user, assistant and tool alike) and the arguments of every earlier assistant tool call.
// Tool definitions, tool names and ids are code and are not scrubbed. A DLP failure is returned
// (fail closed: nothing is forwarded).
func scrubChat(cb *chatBody) (*cleanedChat, error) {
	out := &cleanedChat{fields: map[string]json.RawMessage{}}
	var texts []string
	clean := func(s string) (string, error) {
		res, err := dlp.DLP(s)
		if err != nil {
			return "", err
		}
		out.redactions += len(res.Redactions)
		if res.Clean != "" {
			texts = append(texts, res.Clean)
		}
		return res.Clean, nil
	}
	msgs := make([]map[string]any, 0, len(cb.messages))
	for _, m := range cb.messages {
		om := map[string]any{"role": m.role}
		switch m.content.kind {
		case contentNull:
			om["content"] = nil
		case contentString:
			c, err := clean(m.content.text)
			if err != nil {
				return nil, err
			}
			om["content"] = c
		case contentParts:
			parts := make([]map[string]string, 0, len(m.content.parts))
			for _, p := range m.content.parts {
				c, err := clean(p)
				if err != nil {
					return nil, err
				}
				parts = append(parts, map[string]string{"type": "text", "text": c})
			}
			om["content"] = parts
		}
		if m.hasCalls {
			calls := make([]map[string]any, 0, len(m.toolCalls))
			for _, tc := range m.toolCalls {
				args, n, err := scrubArguments(tc.Arguments)
				if err != nil {
					return nil, err
				}
				out.redactions += n
				if args != "" {
					texts = append(texts, args)
				}
				call := map[string]any{"type": "function", "function": map[string]string{"name": tc.Name, "arguments": args}}
				if tc.ID != nil {
					call["id"] = *tc.ID
				}
				calls = append(calls, call)
			}
			om["tool_calls"] = calls
		}
		if m.toolCallID != nil {
			om["tool_call_id"] = *m.toolCallID
		}
		msgs = append(msgs, om)
	}
	enc, err := json.Marshal(msgs)
	if err != nil {
		return nil, err
	}
	out.fields["messages"] = enc
	for k, v := range cb.passthrough {
		out.fields[k] = v
	}
	out.cleanText = strings.Join(texts, "\n\n")
	return out, nil
}

// scrubArguments scrubs a tool call's `arguments` string and keeps it valid JSON when it was.
//
// A plain Scrub of the raw string is tried first. The labelled patterns can reach across JSON
// punctuation (`"npwp": "0123..."` matches `NPWP\D{0,10}\d{15}` through the `": "`), so a raw
// scrub can break the JSON a downstream provider may parse. When it does, the arguments are
// scrubbed value by value instead, with each value's key as its label context; a value whose key
// makes it match but which matches nothing on its own is redacted whole ("[REDACTED]").
// Over-redaction is the failure direction, never a leak.
func scrubArguments(s string) (string, int, error) {
	if s == "" {
		return "", 0, nil
	}
	res, err := dlp.DLP(s)
	if err != nil {
		return "", 0, err
	}
	if len(res.Redactions) == 0 {
		return s, 0, nil
	}
	if !json.Valid([]byte(s)) || json.Valid([]byte(res.Clean)) {
		return res.Clean, len(res.Redactions), nil
	}
	dec := json.NewDecoder(strings.NewReader(s))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return res.Clean, len(res.Redactions), nil
	}
	n := 0
	cleaned, err := scrubJSONValue(v, "", &n)
	if err != nil {
		return "", 0, err
	}
	enc, err := json.Marshal(cleaned)
	if err != nil {
		return "", 0, err
	}
	if n < len(res.Redactions) {
		n = len(res.Redactions)
	}
	return string(enc), n, nil
}

func scrubJSONValue(v any, key string, n *int) (any, error) {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			kr, err := dlp.DLP(k)
			if err != nil {
				return nil, err
			}
			*n += len(kr.Redactions)
			cv, err := scrubJSONValue(val, kr.Clean, n)
			if err != nil {
				return nil, err
			}
			out[kr.Clean] = cv
		}
		return out, nil
	case []any:
		out := make([]any, len(t))
		for i, val := range t {
			cv, err := scrubJSONValue(val, key, n)
			if err != nil {
				return nil, err
			}
			out[i] = cv
		}
		return out, nil
	case string:
		return scrubJSONString(t, key, n)
	case json.Number:
		cv, err := scrubJSONString(t.String(), key, n)
		if err != nil {
			return nil, err
		}
		if cv == t.String() {
			return t, nil
		}
		return cv, nil
	default:
		return v, nil
	}
}

func scrubJSONString(s, key string, n *int) (string, error) {
	alone, err := dlp.DLP(s)
	if err != nil {
		return "", err
	}
	if key != "" {
		withKey, err := dlp.DLP(key + ": " + s)
		if err != nil {
			return "", err
		}
		if len(withKey.Redactions) > len(alone.Redactions) {
			*n += len(withKey.Redactions)
			return "[REDACTED]", nil
		}
	}
	*n += len(alone.Redactions)
	return alone.Clean, nil
}
