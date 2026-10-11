import { describe, it, expect } from "vitest";
import { Fragment } from "@tiptap/pm/model";
import {
  diagnose, markdownSchema, parseMarkdown, placeholderSyntaxes, roundTrip, roundTrips, serializeDoc, type PlaceholderSyntax,
} from "./markdownCodec";

// WSK-45 — the codec behind the visual markdown editor. EVERY fixture here is SYNTHETIC: it reproduces a CONSTRUCT seen in a
// real site's bodies (tables, raw HTML, placeholders, soft line breaks, CRLF files …), never any of its sentences. The real
// content is measured by scripts/check-markdown-roundtrip.mjs, outside git.

const PH: PlaceholderSyntax[] = [
  { open: "{{", close: "}}" },
  { open: "[CONFIRM:", close: "]" },
  { open: "[CLIENT:", close: "]" },
];

const crlf = (s: string) => s.replace(/\n/g, "\r\n");

describe("lossless constructs: parse then serialise gives the same bytes", () => {
  const cases: Record<string, string> = {
    "empty text": "",
    "one paragraph": "Alpha beta gamma.",
    "ATX headings 1-3 with paragraphs": "# One\n\nAlpha.\n\n## Two\n\nBeta.\n\n### Three\n\nGamma.",
    "a heading directly followed by its paragraph (no blank line)": "## Two\nAlpha beta.",
    "a soft line break inside a paragraph": "Alpha beta\ngamma delta.",
    "bold and italic with * and **": "Alpha **bold** and *italic* and ***both***.",
    "bold link, the outer mark first": "See **[the guide](/guide/)** now, or [a *plain* one](https://example.test/a).",
    "inline code, also inside bold": "Use `code` and **`bold code`** here.",
    "tight bullet list with -": "- one\n- two\n- three",
    "nested bullets, two-space indent": "- one\n  - inner a\n  - inner b\n- two",
    "ordered list 1. 2. 3.": "1. one\n2. two\n3. three",
    "ordered list that starts elsewhere": "4. four\n5. five",
    "loose list (blank lines between items)": "- one\n\n- two\n\n- three",
    "block quote": "> quoted line\n> second line",
    "fenced code with an info string": "```json\n{\n  \"a\": 1\n}\n```",
    "fenced code containing a shorter fence": "````md\n```js\nx\n```\n````",
    "horizontal rule": "Alpha.\n\n---\n\nBeta.",
    "GFM table, compact style": "| Name | Value |\n|---|---|\n| a | 1 |\n| b | 2 |",
    "GFM table with alignment": "| L | C | R |\n|:---|:---:|---:|\n| a | b | c |",
    "table cells holding links, code and a placeholder": "| Item | Link |\n|---|---|\n| `x` | [y](/y/) |\n| {{tok_name}} | **z** |",
    "an HTML block (div)": "<div class=\"note\">\n  <p>Raw</p>\n</div>",
    "an HTML table block": "<table>\n<tr><td>a</td></tr>\n</table>",
    "inline HTML around text": "Call <a href=\"/x/\">us</a> today, or <br> write.",
    "an image": "Before ![alt text](/img/a.png) after.",
    "a footnote-looking marker is plain text": "A claim.[^1] And more.",
    "placeholders: token and markers, in text and a table": "Hello {{site_name}}, [CONFIRM: check this *one*] and [CLIENT: name].\n\n| k | v |\n|---|---|\n| x | [CONFIRM: y] |",
    "a run of two blank lines between blocks": "Alpha.\n\n\nBeta.",
    "a trailing newline": "Alpha.\n",
    "a trailing blank run": "Alpha.\n\n",
    "leading blank lines": "\n\nAlpha.",
    "raw & < > in text that Markdown leaves alone": "Fish & chips, 3 < 4 and 5 > 2, a*b, snake_case_name.",
    "a loose list whose first item holds two paragraphs": "- one\n\n  more\n\n- two",
    "a tight list item holding a code block": "- one\n  ```\n  x\n  ```\n- two",
    "an empty list item": "- one\n-\n- three",
  };
  for (const [name, text] of Object.entries(cases)) {
    it(name, () => {
      const r = roundTrip(text, PH);
      expect(r.ok, r.ok ? "" : `${r.reason}\n${JSON.stringify(r.out)}`).toBe(true);
    });
    it(`${name} — the same text with CRLF line endings`, () => {
      const t = crlf(text);
      expect(roundTrips(t, PH)).toBe(true);
    });
  }

  it("CRLF everywhere is kept as CRLF (a Windows-authored body)", () => {
    const text = crlf("# T\n\nAlpha\nbeta.\n\n- a\n- b\n\n| x | y |\n|---|---|\n| 1 | 2 |");
    const p = parseMarkdown(text);
    expect(p.env.eol).toBe("\r\n");
    expect(serializeDoc(p.doc, p.env, PH).text).toBe(text);
  });
});

describe("lossy constructs: the round-trip differs, so the field opens as source", () => {
  const lossy: Record<string, [string, string]> = {
    "a paragraph that starts with a space": [" Alpha beta.", "paragraph:leading-space"],
    "table cells padded by hand": ["| a | b |\n|---|---|\n| x  | y |", "table:cell-spacing"],
    "a table padded to a column width": ["| a   | b |\n|-----|---|\n| x   | y |", "table:cell-spacing"],
    "numbering that skips": ["1. one\n2. two\n4. four", "list:ordered-numbering"],
    "a table row with fewer cells": ["| a | b |\n|---|---|\n| x |", "table:column-count"],
    "a lazy continuation line under a list item": ["- one\ncontinued", "list:lazy-continuation"],
    "a setext heading": ["Title\n=====\n\nAlpha.", "heading:setext"],
    "a * bullet": ["* one\n* two", "list:bullet-marker"],
    "an _underscore_ emphasis": ["Alpha _beta_ gamma.", "emphasis:underscore-marker"],
    "a tilde fence": ["~~~\ncode\n~~~", "code:tilde-fence"],
    "an indented code block": ["    code line\n", "code:indented"],
    "a character reference": ["Fish &amp; chips.", "entity:character-reference"],
    "an * rule": ["Alpha.\n\n***\n\nBeta.", "rule:style"],
    "mixed line endings": ["Alpha\r\nbeta\ngamma", "line-endings:mixed"],
    "a bare carriage return": ["Alpha\rbeta", "line-endings:bare-CR"],
    "a hard break with trailing spaces": ["Alpha  \nbeta.", "other"],
    "an ordered list closed with )": ["1) one\n2) two", "other"],
  };
  for (const [name, [text, construct]] of Object.entries(lossy)) {
    it(`${name} -> ${construct}`, () => {
      expect(roundTrips(text, PH)).toBe(false);
      expect(diagnose(text, PH)?.construct).toBe(construct);
    });
  }

  it("diagnose names the construct and the 1-based line, and never carries the text", () => {
    const d = diagnose("Alpha.\n\nSecretword beta.\n\n1. a\n3. c", PH);
    expect(d).toEqual({ construct: "list:ordered-numbering", line: 6 });
    expect(JSON.stringify(d)).not.toContain("Secretword");
  });

  it("a lossless text has no difference", () => {
    expect(diagnose("Alpha **b**.", PH)).toBeNull();
  });
});

describe("placeholders stay verbatim", () => {
  const text = "Hi {{a_b_c}} and [CONFIRM: pick *one* of {{x}}].\n\n- [CLIENT: name_here] item\n\n| k | v |\n|---|---|\n| {{t_1}} | [CONFIRM: v] |";
  const parsed = parseMarkdown(text);
  const tokens = ["{{a_b_c}}", "[CONFIRM: pick *one* of {{x}}]", "[CLIENT: name_here]", "{{t_1}}", "[CONFIRM: v]"];

  it("an unchanged document serialises to the same bytes", () => {
    expect(serializeDoc(parsed.doc, parsed.env, PH).text).toBe(text);
  });

  it("after an edit elsewhere, every placeholder is byte-for-byte as it was", () => {
    const s = markdownSchema();
    const added = s.nodes.paragraph.create({ gap: 1 }, [s.text("Typed with 2 * 3, a_b, [x] and <y>.")]);
    const edited = parsed.doc.copy(parsed.doc.content.append(Fragment.from(added)));
    const out = serializeDoc(edited, parsed.env, PH);
    expect(out.verified).toBe(true);
    for (const t of tokens) expect(out.text).toContain(t);
    expect(out.text.startsWith(text)).toBe(true); // the untouched blocks are exactly as they were
    // the typed characters that Markdown would act on were escaped, in the block that holds them only
    expect(out.text.slice(text.length)).toContain("\\<y>");
    expect(out.text.slice(text.length)).not.toContain("\\<y\\>"); // `>` only needs escaping at the start of a line
  });

  it("the escaping mode never touches a placeholder, even with every block forced into it", () => {
    const out = serializeDoc(parsed.doc, parsed.env, PH, { forceSafe: true });
    expect(out.verified).toBe(true);
    for (const t of tokens) expect(out.text).toContain(t);
    // ...and it is the escaping mode: the emphasis stars that sit OUTSIDE a placeholder were not here to escape, but a bare one is
    const s = markdownSchema();
    const doc = s.nodes.doc.create(null, [s.nodes.paragraph.create({ gap: 1 }, [s.text("a * b {{x*y}} c_d")])]);
    const forced = serializeDoc(doc, parsed.env, PH, { forceSafe: true }).text;
    expect(forced).toBe("a \\* b {{x*y}} c\\_d");
  });

  it("a placeholder is kept inside a block even when the user types a literal marker character right next to it", () => {
    const s = markdownSchema();
    const doc = s.nodes.doc.create(null, [s.nodes.paragraph.create({ gap: 1 }, [s.text("*{{tok}}* and [CONFIRM: a]*")])]);
    const out = serializeDoc(doc, parsed.env, PH);
    expect(out.verified).toBe(true);
    expect(out.text).toContain("{{tok}}");
    expect(out.text).toContain("[CONFIRM: a]");
    expect(parseMarkdown(out.text).doc.firstChild?.textContent).toBe("*{{tok}}* and [CONFIRM: a]*");
  });

  it("placeholderSyntaxes reads a composition's lint block and ignores the rest", () => {
    expect(placeholderSyntaxes([{ kind: "token", open: "{{", close: "}}", registry: {} }, { kind: "marker", open: "[X:", close: "]", label: "X" }, { open: "", close: "]" }, null, 4]))
      .toEqual([{ open: "{{", close: "}}" }, { open: "[X:", close: "]" }]);
    expect(placeholderSyntaxes(undefined)).toEqual([]);
  });
});

describe("an edited document is serialised in the source's own style", () => {
  const base = "# Title\n\nAlpha beta.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
  it("an appended paragraph leaves the rest, the table and the trailing newline alone", () => {
    const p = parseMarkdown(base);
    const s = markdownSchema();
    const doc = p.doc.copy(p.doc.content.append(Fragment.from(s.nodes.paragraph.create({ gap: 1 }, [s.text("Gamma.")]))));
    expect(serializeDoc(doc, p.env, PH).text).toBe("# Title\n\nAlpha beta.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nGamma.\n");
  });

  it("an edit in a CRLF body is written with CRLF", () => {
    const p = parseMarkdown(crlf("Alpha.\n\nBeta."));
    const s = markdownSchema();
    const doc = p.doc.copy(p.doc.content.append(Fragment.from(s.nodes.paragraph.create({ gap: 1 }, [s.text("Gamma.")]))));
    expect(serializeDoc(doc, p.env, PH).text).toBe(crlf("Alpha.\n\nBeta.\n\nGamma."));
  });

  it("bold applied to text with a trailing space moves the space outside the markers", () => {
    const s = markdownSchema();
    const bold = s.marks.bold.create();
    const doc = s.nodes.doc.create(null, [s.nodes.paragraph.create({ gap: 1 }, [s.text("Alpha "), s.text("beta ", [bold]), s.text("gamma")])]);
    expect(serializeDoc(doc, { eol: "\n", lead: "", tail: "" }, PH).text).toBe("Alpha **beta** gamma");
  });

  it("a link inside bold and bold inside a link both nest correctly", () => {
    const s = markdownSchema();
    const bold = s.marks.bold.create();
    const link = s.marks.link.create({ href: "/x/" });
    const env = { eol: "\n" as const, lead: "", tail: "" };
    const a = s.nodes.doc.create(null, [s.nodes.paragraph.create({ gap: 1 }, [s.text("a ", [link]), s.text("b", [bold, link]), s.text(" c", [link])])]);
    expect(serializeDoc(a, env, PH).text).toBe("[a **b** c](/x/)");
    const b = s.nodes.doc.create(null, [s.nodes.paragraph.create({ gap: 1 }, [s.text("a ", [bold]), s.text("b", [bold, link]), s.text(" c", [bold])])]);
    expect(serializeDoc(b, env, PH).text).toBe("**a [b](/x/) c**");
  });
});

describe("parse is total over what it accepts", () => {
  it("never throws for a list item that opens with a heading: it is reported, not crashed", () => {
    const r = roundTrip("- # Heading in an item", PH);
    expect(r.ok).toBe(false);
  });
});
