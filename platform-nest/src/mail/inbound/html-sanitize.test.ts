// MAIL-13 — the sanitizer's bypass corpus. Pure unit tests (no DB, no app), because the property
// under test is a string→string function and the DB-level "inert AS STORED" assertion lives in
// corpus.test.ts where a real row can be read back out of Postgres.
import { describe, it, expect } from "vitest";
import { safeHref, sanitizeInboundHeaderText, sanitizeInboundHtml, sanitizeInboundText } from "./html-sanitize";

const NUL = String.fromCharCode(0);
const TAB = String.fromCharCode(9);
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);

/** The properties every sanitizer output must satisfy, asserted as a set so a new case only has to
 *  supply the input. Written as "the output must not CONTAIN" rather than "must not EQUAL" because the
 *  danger is a surviving fragment, not a surviving document. */
function assertInert(html: string | null): void {
  const out = html ?? "";
  expect(out).not.toMatch(/<script/i);
  expect(out).not.toMatch(/<\/script/i);
  expect(out).not.toMatch(/<style/i);
  expect(out).not.toMatch(/<iframe/i);
  expect(out).not.toMatch(/<svg/i);
  expect(out).not.toMatch(/<math/i);
  expect(out).not.toMatch(/<img/i);
  expect(out).not.toMatch(/<form/i);
  expect(out).not.toMatch(/<object/i);
  expect(out).not.toMatch(/<embed/i);
  expect(out).not.toMatch(/<input/i);
  expect(out).not.toMatch(/\son[a-z]+\s*=/i); // onerror=, onload=, onmouseover=, ...
  expect(out).not.toMatch(/javascript:/i);
  expect(out).not.toMatch(/data:/i);
  expect(out).not.toMatch(/\sstyle\s*=/i);
  expect(out).not.toMatch(/\ssrc\s*=/i);
  expect(out).not.toMatch(/\ssrcset\s*=/i);
  expect(out).not.toMatch(/formaction/i);
  expect(out).not.toContain("<!--");
}

describe("mail inbound — HTML allowlist sanitizer", () => {
  it("keeps allowlisted structure and text, drops everything else", () => {
    const out = sanitizeInboundHtml("<p>Hello <strong>there</strong></p><table><tr><td>cell</td></tr></table>");
    expect(out).toContain("<p>Hello <strong>there</strong></p>");
    // Unknown wrapper is UNWRAPPED, not excised: the text a human wrote survives.
    expect(out).toContain("cell");
    expect(out).not.toContain("<table");
  });

  it("excises script/style/svg/math/iframe WITH their content, and never re-emits the innards", () => {
    const out = sanitizeInboundHtml(
      "<p>keep</p><script>steal(document.cookie)</script><style>body{background:url(https://t.invalid/p.gif)}</style>" +
        "<svg onload=alert(1)><desc>svgtext</desc></svg><math><mtext><script>alert(2)</script></mtext></math>" +
        "<iframe src=https://a.invalid/f></iframe>",
    );
    assertInert(out);
    expect(out).toContain("keep");
    expect(out).not.toContain("steal");
    expect(out).not.toContain("svgtext");
    expect(out).not.toContain("background");
  });

  it("drops EVERY attribute except a validated a[href] — event handlers and style are unrepresentable", () => {
    const out = sanitizeInboundHtml(
      '<div onmouseover="alert(1)" style="position:fixed;inset:0" class="x" data-x="y" id="z">overlay</div>',
    );
    assertInert(out);
    expect(out).toBe("<div>overlay</div>");
  });

  it("removes remote-image trackers entirely (the tag allowlist, not URL inspection, closes this)", () => {
    const out = sanitizeInboundHtml('<p>hi</p><img src="https://tracker.invalid/open.gif?id=1" width="1" height="1">');
    assertInert(out);
    expect(out).not.toContain("tracker.invalid");
  });

  it("keeps a safe href, and drops an unsafe one while KEEPING the link text", () => {
    const safe = sanitizeInboundHtml('<a href="https://client.invalid/ok">ok</a>');
    expect(safe).toBe('<a href="https://client.invalid/ok" rel="noopener noreferrer nofollow">ok</a>');

    const unsafe = sanitizeInboundHtml('<a href="javascript:alert(1)">click me</a>');
    assertInert(unsafe);
    // The <a> survives without an href so the human's words are not silently deleted.
    expect(unsafe).toBe("<a>click me</a>");
  });

  it("decodes entity/control obfuscation BEFORE the scheme allowlist (the classic bypass order)", () => {
    expect(safeHref(`java${TAB}script:alert(1)`)).toBeNull();
    expect(safeHref(`java${NUL}script:alert(1)`)).toBeNull();
    expect(safeHref("java&Tab;script:alert(1)")).toBeNull();
    expect(safeHref("javascript&colon;alert(1)")).toBeNull();
    expect(safeHref("&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;alert(1)")).toBeNull();
    expect(safeHref("&#x6a;avascript:alert(1)")).toBeNull();
    expect(safeHref("  https://ok.invalid/x  ")).toBe("https://ok.invalid/x");
    expect(safeHref("mailto:someone@ok.invalid")).toBe("mailto:someone@ok.invalid");
    expect(safeHref("data:text/html;base64,PHNjcmlwdD4=")).toBeNull();
    expect(safeHref("vbscript:msgbox(1)")).toBeNull();
    expect(safeHref("//evil.invalid/x")).toBeNull(); // protocol-relative: no scheme, refused
  });

  it("is not fooled by a NUL inside a tag name", () => {
    const out = sanitizeInboundHtml(`<p>keep</p><scr${NUL}ipt>alert(1)</scr${NUL}ipt>`);
    assertInert(out);
    // The tag name is unrecognized, so it unwraps; the payload survives only as ESCAPED text.
    expect(out).toContain("keep");
    expect(out).not.toMatch(/<[^>]*script/i);
  });

  it("drops the remainder of an unterminated tag rather than re-emitting its tail as text", () => {
    const out = sanitizeInboundHtml('<p>before</p><script src="https://a.invalid/x.js"');
    assertInert(out);
    expect(out).toContain("before");
    expect(out).not.toContain("a.invalid");
  });

  it("treats a quoted '>' inside an attribute as part of the tag, not as the tag's end", () => {
    const out = sanitizeInboundHtml('<a title="a>b" href="https://ok.invalid/q">q</a>');
    expect(out).toBe('<a href="https://ok.invalid/q" rel="noopener noreferrer nofollow">q</a>');
    // The critical part: `b"` did not leak out as text, which would mean the tag boundary was misread.
    expect(out).not.toContain("a&gt;b");
  });

  it("drops comments including IE conditional comments (payload lives inside the comment)", () => {
    const out = sanitizeInboundHtml("<p>x</p><!--[if IE]><script>alert(3)</script><![endif]-->");
    assertInert(out);
    expect(out).toBe("<p>x</p>");
  });

  it("escapes text so already-escaped and numeric-entity payloads stay escaped, never re-decoded", () => {
    const out = sanitizeInboundHtml("<p>&lt;script&gt;a&lt;/script&gt;</p><p>&#60;script&#62;b&#60;/script&#62;</p>");
    assertInert(out);
    // `&lt;` re-escapes to `&amp;lt;` — deliberately: this is a string builder, so the only way text can
    // ever become markup is if the builder emits markup, and it never emits what it did not construct.
    expect(out).toContain("&amp;lt;script&amp;gt;");
  });

  it("only ever closes tags it opened (a stray close tag cannot unbalance the output)", () => {
    const out = sanitizeInboundHtml("</p></div>text<p>ok");
    expect(out).toBe("text<p>ok</p>");
  });

  it("caps output length and nesting depth without throwing", () => {
    const deep = "<div>".repeat(500) + "bottom" + "</div>".repeat(500);
    const out = sanitizeInboundHtml(deep);
    expect(out).toContain("bottom");
    expect((out ?? "").match(/<div>/g)?.length ?? 0).toBeLessThanOrEqual(64);

    const long = sanitizeInboundHtml(`<p>${"a".repeat(50_000)}</p>`, { maxLength: 1000 });
    expect((long ?? "").length).toBeLessThanOrEqual(1000 + "</p>".length);
  });

  it("returns null when nothing renderable survives, so the column stores SQL NULL", () => {
    expect(sanitizeInboundHtml("<script>alert(1)</script>")).toBeNull();
    expect(sanitizeInboundHtml("   ")).toBeNull();
    expect(sanitizeInboundHtml(null)).toBeNull();
    // ...but a message that is only a line break IS renderable content.
    expect(sanitizeInboundHtml("<br>")).toBe("<br>");
  });
});

describe("mail inbound — text + header sanitizers", () => {
  it("strips control characters from a body but keeps tab and newline", () => {
    const { text } = sanitizeInboundText(`a${NUL}b${String.fromCharCode(7)}c${TAB}d${CR}${LF}e`);
    expect(text).toBe(`abc${TAB}d${LF}e`);
  });

  it("caps a body and says so, rather than silently truncating", () => {
    const { text, truncatedChars } = sanitizeInboundText("x".repeat(5000), 1000);
    expect(truncatedChars).toBe(4000);
    expect(text).toContain("[truncated at intake: 4000 characters omitted here]");
  });

  it("[MAIL-19 / A15] keeps BOTH head and tail of an over-cap body, so a bottom-posted reply survives", () => {
    // maxLength 1000 -> head 750 (ceil(1000*0.75)), tail 250 — the exact split the function computes.
    // A distinctive canary (not a bare repeated letter) so a coincidental substring match — e.g. "M"
    // inside a word like "oMitted" — can never produce a false pass.
    const head = "H".repeat(750);
    const middle = "ZZZ-DROPPED-CANARY-ZZZ".repeat(Math.ceil((4000 - 750 - 250) / 22)).slice(0, 4000 - 750 - 250);
    const tail = "T".repeat(250);
    const { text, truncatedChars } = sanitizeInboundText(head + middle + tail, 1000);

    expect(truncatedChars).toBe(4000 - 1000); // == raw.length - maxLength, unaffected by the split
    expect(text).toContain("[truncated at intake: 3000 characters omitted here]");
    // The head is kept verbatim and in full...
    expect(text.startsWith("H".repeat(750))).toBe(true);
    // ...and so is the tail (a bottom-posted reply is exactly "the last N characters").
    expect(text.endsWith("T".repeat(250))).toBe(true);
    // The dropped middle never appears — the marker replaces it, not sits alongside it.
    expect(text).not.toContain("ZZZ-DROPPED-CANARY-ZZZ");
  });

  it("[MAIL-19 / A15] a top-posted reply (in the head) survives unchanged by the reshape", () => {
    const reply = "Approved. Ship it.";
    const quote = ">".repeat(200_000);
    const { text } = sanitizeInboundText(reply + quote, 128 * 1024);
    expect(text.startsWith(reply)).toBe(true);
  });

  it("[MAIL-19 / A15] an under-cap body is stored verbatim — no marker, zero truncatedChars", () => {
    const { text, truncatedChars } = sanitizeInboundText("short and sweet", 1000);
    expect(truncatedChars).toBe(0);
    expect(text).toBe("short and sweet");
    expect(text).not.toContain("truncated at intake");
  });

  it("[MAIL-19 / A15] elision-marker spoof: a sender-embedded fake marker is inert — length math decides truncation, never content", () => {
    const fakeMarker = "[truncated at intake: 999999999 characters omitted here]";

    // Under cap: the whole thing — decoy included — is stored verbatim. Presence of marker-shaped
    // text in the input has ZERO effect on whether real truncation happens.
    const under = sanitizeInboundText(`${fakeMarker} Approved.`, 1000);
    expect(under.truncatedChars).toBe(0);
    expect(under.text).toBe(`${fakeMarker} Approved.`);

    // Over cap, with the decoy planted RIGHT AT the real elision boundary (the last thing before the
    // cut) — an attempt to make the genuine marker look like a continuation of, or be masked by, the
    // forged one.
    const head = "h".repeat(750 - fakeMarker.length) + fakeMarker;
    const middleCanary = "ZZZ-DROPPED-CANARY-ZZZ";
    const middle = middleCanary.repeat(Math.ceil((4000 - 750 - 250) / middleCanary.length)).slice(0, 4000 - 750 - 250);
    const tail = "t".repeat(250);
    const { text, truncatedChars } = sanitizeInboundText(head + middle + tail, 1000);

    expect(truncatedChars).toBe(3000);
    // The decoy survives verbatim, exactly where the sender put it (immediately before the cut)...
    expect(text).toContain(fakeMarker);
    // ...and the GENUINE marker — with the mathematically correct count — also appears, distinct
    // from the decoy's bogus count. A reader (or a future render-time parser) can never confuse the
    // two: only one string in the output has the true omitted-character value.
    expect(text).toContain("[truncated at intake: 3000 characters omitted here]");
    expect(text.indexOf(fakeMarker)).toBeLessThan(text.indexOf("[truncated at intake: 3000"));
    // The dropped middle is really dropped — a decoy planted there would not survive either.
    expect(text).not.toContain(middleCanary);
  });

  it("flattens a header value to one line — the outbound header-injection class, closed on the way IN", () => {
    const subject = sanitizeInboundHeaderText(`Re: ok${CR}${LF}Bcc: attacker@evil.invalid${CR}${LF}Subject: second`);
    expect(subject).toBe("Re: ok Bcc: attacker@evil.invalid Subject: second");
    expect(subject).not.toContain(CR);
    expect(subject).not.toContain(LF);
  });

  it("returns null for a header value that is empty once cleaned", () => {
    expect(sanitizeInboundHeaderText(`   ${NUL} `)).toBeNull();
    expect(sanitizeInboundHeaderText(null)).toBeNull();
  });
});

describe("mail inbound — sanitizer regressions found by the corpus", () => {
  it("a VOID dangerous element does not eat the rest of the message", () => {
    // Regression: `embed` was subtree-dropped, so the scan looked for a `</embed>` that can never
    // exist and ran to EOF — discarding the human's reply that followed. Found by the hostile-HTML
    // corpus case asserting that innocent text AFTER the hostile markup survives.
    const out = sanitizeInboundHtml('<p>before</p><embed src="https://a.invalid/e"><p>AFTER SURVIVES</p>');
    assertInert(out);
    expect(out).toContain("before");
    expect(out).toContain("AFTER SURVIVES");
    expect(out).not.toContain("a.invalid");
  });

  it("a self-closed subtree-drop element does not eat the rest of the message either", () => {
    const out = sanitizeInboundHtml("<p>before</p><svg/><p>AFTER SURVIVES</p>");
    assertInert(out);
    expect(out).toContain("AFTER SURVIVES");
  });

  it("the same for source/track/param/link/meta/base/input", () => {
    for (const tag of ["source", "track", "param", "link", "meta", "base", "input"]) {
      const out = sanitizeInboundHtml(`<p>a</p><${tag} src="https://a.invalid/x"><p>TAIL</p>`);
      assertInert(out);
      expect(out, tag).toContain("TAIL");
    }
  });
});
