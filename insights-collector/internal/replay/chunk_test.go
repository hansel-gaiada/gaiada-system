package replay

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func gz(t *testing.T, b []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write(b); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func b64(b []byte) json.RawMessage {
	s, _ := json.Marshal(base64.StdEncoding.EncodeToString(b))
	return s
}

func TestDecodeAcceptsBase64GzipAndPlainArrays(t *testing.T) {
	events := []byte(`[{"type":4,"data":{"href":"https://x.test/a"}}]`)
	got, err := Decode(b64(gz(t, events)))
	if err != nil || string(got) != string(events) {
		t.Fatalf("gzip: %s %v", got, err)
	}
	got, err = Decode(json.RawMessage(events))
	if err != nil || string(got) != string(events) {
		t.Fatalf("plain: %s %v", got, err)
	}
	// Unpadded base64 is accepted too.
	raw, _ := json.Marshal(base64.RawStdEncoding.EncodeToString(gz(t, events)))
	if got, err = Decode(raw); err != nil || string(got) != string(events) {
		t.Fatalf("raw base64: %s %v", got, err)
	}
}

func TestDecodeRefusesWhatItCannotRead(t *testing.T) {
	notGzip, _ := json.Marshal(base64.StdEncoding.EncodeToString([]byte("plain text, not gzip")))
	for name, raw := range map[string]json.RawMessage{
		"absent": nil, "number": json.RawMessage(`5`), "object": json.RawMessage(`{}`), "null": json.RawMessage(`null`),
		"not base64": json.RawMessage(`"!!!not base64!!!"`), "base64 of non-gzip": notGzip,
		"truncated gzip": b64(gz(t, []byte(`[{"type":4}]`))[:12]),
	} {
		if _, err := Decode(raw); !errors.Is(err, ErrMalformed) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

// V6-a acceptance: an inflate bomb is refused. 6 MB of zeros gzips to a few KB; it must be refused without holding
// more than the limit in memory, and a stream that is within the limit still passes.
func TestInflateBombIsRefused(t *testing.T) {
	bomb := gz(t, bytes.Repeat([]byte{0}, 6<<20))
	if len(bomb) > MaxCompressedBytes {
		t.Fatalf("test bomb is not small enough to pass the compressed limit: %d", len(bomb))
	}
	if _, err := Decode(b64(bomb)); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("bomb: %v", err)
	}
	// Exactly at the limit passes; one byte over does not.
	atLimit := append([]byte("["), bytes.Repeat([]byte(" "), MaxInflatedBytes-2)...)
	atLimit = append(atLimit, ']')
	if got, err := Inflate(gz(t, atLimit), MaxInflatedBytes); err != nil || len(got) != MaxInflatedBytes {
		t.Fatalf("at the limit: %d %v", len(got), err)
	}
	if _, err := Inflate(gz(t, append(atLimit, ' ')), MaxInflatedBytes); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("one over: %v", err)
	}
	// Concatenated gzip members count together (a bomb split over members is still a bomb).
	two := append(gz(t, bytes.Repeat([]byte{0}, 3<<20)), gz(t, bytes.Repeat([]byte{0}, 3<<20))...)
	if _, err := Inflate(two, MaxInflatedBytes); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("multi-member: %v", err)
	}
}

func TestDecodeRefusesAnOversizedCompressedChunk(t *testing.T) {
	// Random-looking data does not compress: 300 KB of it stays over 256 KB.
	big := make([]byte, 300*1024)
	x := uint32(1)
	for i := range big {
		x = x*1664525 + 1013904223
		big[i] = byte(x >> 24)
	}
	if _, err := Decode(b64(gz(t, big))); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("compressed over 256 KB: %v", err)
	}
	// An overlong base64 string is refused before it is decoded.
	huge, _ := json.Marshal(strings.Repeat("A", base64.StdEncoding.EncodedLen(MaxCompressedBytes)+8))
	if _, err := Decode(huge); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("overlong string: %v", err)
	}
}

func input(text string) string {
	b, _ := json.Marshal(text)
	return `{"type":3,"data":{"source":5,"id":12,"text":` + string(b) + `,"isChecked":false}}`
}

func chunk(evs ...string) []byte { return []byte("[" + strings.Join(evs, ",") + "]") }

func snapshot(node string) string {
	return `{"type":2,"data":{"node":{"type":0,"childNodes":[` + node + `]},"initialOffset":{"left":0,"top":0}}}`
}

func el(tag, attrs string, children ...string) string {
	return `{"type":2,"tagName":"` + tag + `","attributes":{` + attrs + `},"childNodes":[` + strings.Join(children, ",") + `],"id":1}`
}

// V6-a acceptance: a chunk holding typed input is refused (the handler answers 422), and nothing of it is kept.
func TestInspectRefusesTypedInput(t *testing.T) {
	typed := map[string][]byte{
		"incremental input text":        chunk(input("hello world")),
		"input text amid other events":  chunk(`{"type":4,"data":{"href":"https://x.test/"}}`, `{"type":3,"data":{"source":1,"positions":[]}}`, input("x")),
		"whitespace text":               chunk(input(" ")),
		"masked text is still text":     chunk(input("*****")),
		"numeric text":                  chunk(`{"type":3,"data":{"source":5,"id":1,"text":5}}`),
		"snapshot text input value":     chunk(snapshot(el("input", `"type":"text","value":"jane@example.org"`))),
		"snapshot input without a type": chunk(snapshot(el("div", ``, el("input", `"value":"abc"`)))),
		"snapshot password":             chunk(snapshot(el("input", `"type":"password","value":"***"`))),
		"snapshot hidden value":         chunk(snapshot(el("input", `"type":"hidden","value":"token"`))),
		"snapshot textarea value":       chunk(snapshot(el("textarea", `"value":"my message"`))),
		"snapshot textarea text node":   chunk(snapshot(el("textarea", ``, `{"type":3,"textContent":"typed here","id":4}`))),
		"mutation adds an input":        chunk(`{"type":3,"data":{"source":0,"texts":[],"attributes":[],"removes":[],"adds":[{"parentId":1,"nextId":null,"node":` + el("input", `"type":"email","value":"a@b.c"`) + `}]}}`),
	}
	for name, c := range typed {
		if _, err := Inspect(c); !errors.Is(err, ErrTypedText) {
			t.Errorf("%s: want ErrTypedText, got %v", name, err)
		}
	}
}

func TestInspectKeepsWhatIsNotTypedText(t *testing.T) {
	ok := map[string][]byte{
		"empty input text (the site's maskInputFn)": chunk(input("")),
		"input event without text":                  chunk(`{"type":3,"data":{"source":5,"id":1,"isChecked":true}}`),
		"null text":                                 chunk(`{"type":3,"data":{"source":5,"id":1,"text":null}}`),
		"empty text input in a snapshot":            chunk(snapshot(el("input", `"type":"text","value":""`))),
		"text input with no value":                  chunk(snapshot(el("input", `"type":"search"`))),
		"submit button label":                       chunk(snapshot(el("input", `"type":"submit","value":"Send"`))),
		"checkbox and radio":                        chunk(snapshot(el("div", ``, el("input", `"type":"checkbox","value":"on"`), el("input", `"type":"radio","value":"a"`)))),
		"range":                                     chunk(snapshot(el("input", `"type":"range","value":"50"`))),
		"empty textarea":                            chunk(snapshot(el("textarea", `"value":""`))),
		"select and options":                        chunk(snapshot(el("select", ``, el("option", `"value":"de"`)))),
		"scroll and mouse events":                   chunk(`{"type":3,"data":{"source":3,"id":1,"x":0,"y":120}}`, `{"type":3,"data":{"source":2,"type":1,"id":3,"x":1,"y":2}}`),
		"custom event":                              chunk(`{"type":5,"data":{"tag":"x","payload":{"text":"free text here"}}}`),
		"mutation adds a div":                       chunk(`{"type":3,"data":{"source":0,"adds":[{"parentId":1,"node":` + el("div", `"class":"a"`) + `}]}}`),
	}
	for name, c := range ok {
		res, err := Inspect(c)
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		var back []json.RawMessage
		if json.Unmarshal(res.Events, &back) != nil || len(back) == 0 {
			t.Errorf("%s: stored form is not an event array: %s", name, res.Events)
		}
	}
}

func TestInspectRewritesTheMetaHrefToOriginAndPath(t *testing.T) {
	c := chunk(
		`{"type":4,"data":{"href":"https://User:Pw@WWW.Example.com:8443/services/web/?utm_source=x&email=a%40b.c#frag","width":1280,"height":800},"timestamp":1760000000000}`,
		`{"type":4,"data":{"href":"https://www.example.com/pricing/?q=1"}}`,
		`{"type":4,"data":{"href":"https://www.example.com/services/web/#again"}}`, // same path: listed once
		`{"type":4,"data":{"href":"about:blank"}}`,
		`{"type":4,"data":{"href":"javascript:alert(1)"}}`,
		`{"type":4,"data":{"width":10}}`,
	)
	res, err := Inspect(c)
	if err != nil {
		t.Fatal(err)
	}
	out := string(res.Events)
	for _, leak := range []string{"utm_source", "email", "a%40b.c", "frag", "Pw", "User", "q=1", "again", "javascript", "about:blank"} {
		if strings.Contains(out, leak) {
			t.Errorf("%q survived the rewrite: %s", leak, out)
		}
	}
	var evs []struct {
		Type      int            `json:"type"`
		Data      map[string]any `json:"data"`
		Timestamp json.Number    `json:"timestamp"`
	}
	dec := json.NewDecoder(strings.NewReader(out))
	dec.UseNumber()
	if err := dec.Decode(&evs); err != nil {
		t.Fatal(err)
	}
	if evs[0].Data["href"] != "https://www.example.com:8443/services/web/" || evs[1].Data["href"] != "https://www.example.com/pricing/" ||
		evs[2].Data["href"] != "https://www.example.com/services/web/" || evs[3].Data["href"] != "" || evs[4].Data["href"] != "" {
		t.Errorf("hrefs: %v", out)
	}
	if evs[0].Data["width"].(json.Number).String() != "1280" || evs[0].Timestamp.String() != "1760000000000" {
		t.Errorf("other members of the meta event changed: %s", out)
	}
	if got := strings.Join(res.Pages, ","); got != "/services/web/,/pricing/" {
		t.Errorf("pages: %q", got)
	}
}

func TestInspectCapsPages(t *testing.T) {
	var evs []string
	for i := 0; i < MaxPages+10; i++ {
		evs = append(evs, `{"type":4,"data":{"href":"https://x.test/p`+strings.Repeat("a", i%7)+string(rune('a'+i%26))+strings.Repeat("b", i)+`/"}}`)
	}
	res, err := Inspect(chunk(evs...))
	if err != nil || len(res.Pages) != MaxPages {
		t.Fatalf("pages: %d %v", len(res.Pages), err)
	}
}

func TestInspectRefusesMalformedChunks(t *testing.T) {
	for name, c := range map[string]string{
		"not json": `[`, "empty array": `[]`, "object": `{}`, "numbers": `[1,2]`, "type is a string": `[{"type":"3"}]`,
		"snapshot node of the wrong shape": `[{"type":2,"data":{"node":5}}]`,
	} {
		if _, err := Inspect([]byte(c)); !errors.Is(err, ErrMalformed) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestOriginAndPath(t *testing.T) {
	for in, want := range map[string][2]string{
		"https://example.com":                 {"https://example.com", "/"},
		"http://example.com/a/b/?x=1#y":       {"http://example.com", "/a/b/"},
		"https://u:p@Example.COM/a":           {"https://example.com", "/a"},
		"https://example.com//evil.test/path": {"https://example.com", ""},
		"https://example.com/a%0Ab":           {"https://example.com", "/a%0Ab"},
		"ftp://example.com/a":                 {"", ""},
		"/relative/path":                      {"", ""},
		"":                                    {"", ""},
		"https:///nohost":                     {"", ""},
		"https://example.com/" + strings.Repeat("a", 600): {"https://example.com", ""},
	} {
		o, p := OriginAndPath(in)
		if o != want[0] || p != want[1] {
			t.Errorf("%q: got (%q, %q) want %v", in[:min(len(in), 40)], o, p, want)
		}
	}
}

func TestCompressRoundTrips(t *testing.T) {
	in := bytes.Repeat([]byte(`[{"type":4}]`), 100)
	c, err := Compress(in)
	if err != nil {
		t.Fatal(err)
	}
	out, err := Inflate(c, MaxInflatedBytes)
	if err != nil || !bytes.Equal(in, out) || len(c) >= len(in) {
		t.Fatalf("round trip: %v", err)
	}
}
