// Package replay is the pure part of the session replay channel (V6-a, design 6.1, 6.2): decoding a chunk the
// browser sent (base64 of gzip, with a hard inflate limit), refusing a chunk that holds typed input, reducing the
// meta event's href to origin + path, and compressing what is stored. It holds no state and does no I/O, so every
// rule here is testable without a database.
//
// What it does NOT do: it cannot make a recording safe on its own. The site records with forms blocked and inputs
// masked (design 6.1); this package is the server's second look, and it fails closed: a chunk it cannot read is
// refused, and a chunk with any typed text or input value is refused whole.
package replay

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"strings"
)

// Limits of the wire contract (design 6.2).
const (
	MaxCompressedBytes = 256 * 1024      // a chunk as the browser sent it, after base64
	MaxInflatedBytes   = 4 * 1024 * 1024 // a chunk after gzip: the inflate-bomb guard
	MaxPages           = 50              // distinct paths kept per recording
	MaxPathLen         = 512
)

// Errors a caller maps to a status. None carries content from the chunk.
var (
	ErrTooLarge  = errors.New("chunk too large") // 413: compressed or inflated limit
	ErrMalformed = errors.New("chunk malformed") // 400: not base64, not gzip, not a JSON array of events
	ErrTypedText = errors.New("chunk has input") // 422: typed text or an input value
)

// Decode turns the request's `chunk` member into the JSON array of rrweb events. The member is either a JSON string
// (base64 of a gzip stream, the browser's CompressionStream output) or a JSON array (uncompressed events; used by
// tests and by a browser without CompressionStream). The inflated size is capped at MaxInflatedBytes whatever the
// stream claims: the reader stops one byte past the limit and the chunk is refused.
func Decode(raw json.RawMessage) ([]byte, error) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return nil, ErrMalformed
	}
	switch raw[0] {
	case '[':
		if len(raw) > MaxInflatedBytes {
			return nil, ErrTooLarge
		}
		return raw, nil
	case '"':
		var s string
		if json.Unmarshal(raw, &s) != nil {
			return nil, ErrMalformed
		}
		// Refuse before decoding: base64 is 4 characters per 3 bytes.
		if len(s) > base64.StdEncoding.EncodedLen(MaxCompressedBytes) {
			return nil, ErrTooLarge
		}
		comp, err := base64.StdEncoding.DecodeString(s)
		if err != nil {
			if comp, err = base64.RawStdEncoding.DecodeString(s); err != nil {
				return nil, ErrMalformed
			}
		}
		if len(comp) > MaxCompressedBytes {
			return nil, ErrTooLarge
		}
		return Inflate(comp, MaxInflatedBytes)
	}
	return nil, ErrMalformed
}

// Inflate decompresses a gzip stream to at most limit bytes. A stream that would inflate to more is ErrTooLarge
// (nothing past limit+1 bytes is ever held in memory). Concatenated gzip members count together.
func Inflate(comp []byte, limit int) ([]byte, error) {
	zr, err := gzip.NewReader(bytes.NewReader(comp))
	if err != nil {
		return nil, ErrMalformed
	}
	defer zr.Close()
	out, err := io.ReadAll(io.LimitReader(zr, int64(limit)+1))
	if len(out) > limit {
		return nil, ErrTooLarge
	}
	if err != nil {
		return nil, ErrMalformed
	}
	return out, nil
}

// Compress gzips the stored form of a chunk.
func Compress(events []byte) ([]byte, error) {
	var buf bytes.Buffer
	zw, err := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	if err != nil {
		return nil, err
	}
	if _, err := zw.Write(events); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// rrweb event types and sources (rrweb's EventType and IncrementalSource enums).
const (
	typeFullSnapshot = 2
	typeIncremental  = 3
	typeMeta         = 4

	sourceMutation = 0
	sourceInput    = 5
)

type event struct {
	Type int             `json:"type"`
	Data json.RawMessage `json:"data"`
}

// node is the part of rrweb-snapshot's serialized node the input check reads.
type node struct {
	Type        int            `json:"type"` // 2 element, 3 text
	TagName     string         `json:"tagName"`
	Attributes  map[string]any `json:"attributes"`
	TextContent string         `json:"textContent"`
	ChildNodes  []node         `json:"childNodes"`
}

// Result is what Inspect found in a chunk.
type Result struct {
	// Events is the chunk to store: the same events, with the meta href reduced to origin + path.
	Events []byte
	// Pages are the distinct paths of the meta events, in order of first sight (at most MaxPages).
	Pages []string
}

// Inspect applies design 6.2's server check to a decoded chunk (a JSON array of rrweb events):
//
//   - any incremental input event (source 5) whose text is not empty, and any text-like input or textarea in a full
//     snapshot or an added mutation node whose value is not empty, refuses the WHOLE chunk (ErrTypedText); nothing
//     is kept. Masked values count: rrweb's mask is "*" per character, so a masked value is still non-empty and still
//     refused. The site's maskInputFn returns "" for inputs outside a form, which passes;
//   - the meta event's href is rewritten to origin + path (no query, hash or credentials); an href that is not
//     http(s) becomes "" and adds no page.
//
// A chunk that is not a non-empty array of objects with a numeric "type" is ErrMalformed.
func Inspect(decoded []byte) (Result, error) {
	var raws []json.RawMessage
	if err := json.Unmarshal(decoded, &raws); err != nil || len(raws) == 0 {
		return Result{}, ErrMalformed
	}
	out := make([]json.RawMessage, len(raws))
	var pages []string
	seen := map[string]bool{}
	for i, r := range raws {
		var e event
		if err := json.Unmarshal(r, &e); err != nil {
			return Result{}, ErrMalformed
		}
		out[i] = r
		switch e.Type {
		case typeIncremental:
			typed, err := incrementalHasInput(e.Data)
			if err != nil {
				return Result{}, err
			}
			if typed {
				return Result{}, ErrTypedText
			}
		case typeFullSnapshot:
			var d struct {
				Node node `json:"node"`
			}
			if json.Unmarshal(e.Data, &d) != nil {
				return Result{}, ErrMalformed
			}
			if nodeHasInput(d.Node) {
				return Result{}, ErrTypedText
			}
		case typeMeta:
			rewritten, path, err := rewriteMeta(r)
			if err != nil {
				return Result{}, err
			}
			out[i] = rewritten
			if path != "" && !seen[path] && len(pages) < MaxPages {
				seen[path] = true
				pages = append(pages, path)
			}
		}
	}
	b, err := json.Marshal(out)
	if err != nil {
		return Result{}, ErrMalformed
	}
	return Result{Events: b, Pages: pages}, nil
}

func incrementalHasInput(data json.RawMessage) (bool, error) {
	var d struct {
		Source int             `json:"source"`
		Text   json.RawMessage `json:"text"`
		Adds   []struct {
			Node node `json:"node"`
		} `json:"adds"`
	}
	if json.Unmarshal(data, &d) != nil {
		return false, ErrMalformed
	}
	switch d.Source {
	case sourceInput:
		return !emptyJSON(d.Text), nil
	case sourceMutation:
		for _, a := range d.Adds {
			if nodeHasInput(a.Node) {
				return true, nil
			}
		}
	}
	return false, nil
}

// emptyJSON is true for an absent value, null and "". Anything else, including a number or " ", is content.
func emptyJSON(raw json.RawMessage) bool {
	s := string(bytes.TrimSpace(raw))
	return s == "" || s == "null" || s == `""`
}

// valueless are the input types whose value is a label or a fixed choice, never typed text.
var valueless = map[string]bool{"button": true, "submit": true, "reset": true, "image": true, "checkbox": true, "radio": true, "range": true, "color": true}

// nodeHasInput walks a serialized node tree for a typed value: an input (of a type that takes typed text) or a
// textarea carrying a non-empty value, or a textarea with non-empty text inside. Select and option are not
// checked: their values are the page's own option list, and a choice reaches the recording as an input event.
func nodeHasInput(n node) bool {
	switch strings.ToLower(n.TagName) {
	case "input":
		t, _ := n.Attributes["type"].(string)
		if !valueless[strings.ToLower(strings.TrimSpace(t))] && attrNonEmpty(n.Attributes["value"]) {
			return true
		}
	case "textarea":
		if attrNonEmpty(n.Attributes["value"]) {
			return true
		}
		for _, c := range n.ChildNodes {
			if c.Type == 3 && c.TextContent != "" {
				return true
			}
		}
	}
	for _, c := range n.ChildNodes {
		if nodeHasInput(c) {
			return true
		}
	}
	return false
}

func attrNonEmpty(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case string:
		return x != ""
	case bool:
		return false // rrweb uses true for a valueless attribute; a bare `value` attribute carries no text
	}
	return true // a number or an object where a string belongs: not something the recorder writes; refuse
}

// rewriteMeta reduces data.href of a meta event to origin + path and returns the path. Everything else in the
// event (width, height, any other key) is kept untouched.
func rewriteMeta(raw json.RawMessage) (json.RawMessage, string, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var ev map[string]any
	if err := dec.Decode(&ev); err != nil {
		return nil, "", ErrMalformed
	}
	data, ok := ev["data"].(map[string]any)
	if !ok {
		return raw, "", nil
	}
	href, present := data["href"]
	if !present {
		return raw, "", nil
	}
	s, _ := href.(string)
	origin, path := OriginAndPath(s)
	if origin == "" {
		data["href"] = ""
	} else {
		data["href"] = origin + path
	}
	out, err := json.Marshal(ev)
	if err != nil {
		return nil, "", ErrMalformed
	}
	return out, path, nil
}

// OriginAndPath splits an absolute http(s) URL into scheme://host and its path, dropping credentials, query and
// hash. Both are "" for anything that is not an http(s) URL with a host. A path that is too long, does not start
// with "/" or holds a control character or backslash yields the origin alone and an empty path (no page is listed
// and the stored href is the bare origin).
func OriginAndPath(href string) (origin, path string) {
	u, err := url.Parse(strings.TrimSpace(href))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
		return "", ""
	}
	origin = u.Scheme + "://" + strings.ToLower(u.Host)
	p := u.EscapedPath()
	if p == "" {
		p = "/"
	}
	if len(p) > MaxPathLen || p[0] != '/' || strings.HasPrefix(p, "//") {
		return origin, ""
	}
	for _, r := range p {
		if r < 0x20 || r == 0x7f || r == '\\' {
			return origin, ""
		}
	}
	return origin, p
}
