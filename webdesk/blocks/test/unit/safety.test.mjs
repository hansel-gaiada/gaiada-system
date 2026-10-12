// webdesk/blocks/test/unit/safety.test.mjs
//
// M6-P5c — the render-time output-safety helpers (src/safety.ts): link/image scheme allow-lists,
// safe inline JSON, and the rich-text sanitiser's allow-list. The PHP theme mirrors these in
// wordpress/theme/gaiada-webdesk/inc/safety.php (probe: wordpress/test/safety-probe.php).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  safeHref,
  safeImgSrc,
  safeJsonForScript,
  sanitizeRichHtml,
  RICH_TEXT_SANITIZE_OPTIONS,
} from '../../src/safety.ts'

test('safeHref: dangerous schemes become "#" (case, whitespace, control chars, tab-split)', () => {
  const hostile = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    '  javascript:alert(1)',
    '\tjavascript:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    'java\r\nscript:alert(1)',
    '\u0001javascript:alert(1)',
    'jav\u0000ascript:alert(1)',
    ' \u000bjavascript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'DATA:text/html,<script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'ftp://example.com',
    '//evil.example/x',
    '/\\evil.example/x',
    '\\\\evil.example',
    'a\\b',
    'about\\evil',
    '1:foo',
    '',
    '   ',
  ]
  for (const h of hostile) assert.equal(safeHref(h), '#', JSON.stringify(h))
  for (const v of [null, undefined, 42, {}, [], true]) assert.equal(safeHref(v), '#')
})

test('safeHref: allowed schemes and relative forms are kept', () => {
  const ok = [
    'http://example.com/a?b=1#c',
    'https://example.com',
    'HTTPS://example.com',
    'mailto:hi@example.com',
    'tel:+6281234',
    '/about',
    '/a/b?c=d',
    './x',
    '../x',
    '?page=2',
    '#section',
    'about',
    'about/',
    'page.html',
    'a/b?c=1#d',
  ]
  for (const h of ok) assert.equal(safeHref(h), h, h)
  assert.equal(safeHref('  https://example.com/x  '), 'https://example.com/x', 'trimmed')
  assert.equal(safeHref('https://example.com/a\tb'), 'https://example.com/ab', 'control chars removed from output')
})

test('safeImgSrc: only http, https and relative; everything else is undefined', () => {
  assert.equal(safeImgSrc('https://cdn.example.com/a.png'), 'https://cdn.example.com/a.png')
  assert.equal(safeImgSrc('http://cdn.example.com/a.png'), 'http://cdn.example.com/a.png')
  assert.equal(safeImgSrc('/media/a.png'), '/media/a.png')
  assert.equal(safeImgSrc('./a.png'), './a.png')
  assert.equal(safeImgSrc('../a.png'), '../a.png')
  for (const bad of [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'java\tscript:alert(1)',
    'data:image/svg+xml,<svg onload=alert(1)>',
    'mailto:a@b.c',
    'tel:123',
    '//evil.example/a.png',
    '#frag',
    '?q=1',
    '',
    null,
    undefined,
    7,
  ]) {
    assert.equal(safeImgSrc(bad), undefined, JSON.stringify(bad))
  }
})

test('safeJsonForScript: cannot close or open anything inside a <script>, and round-trips', () => {
  const value = {
    root: { text: '</script><script>alert(1)</script>', comment: '<!-- x -->', amp: 'a&b', sep: 'a\u2028b\u2029c' },
    list: ['</SCRIPT>', 1, null, true],
  }
  const out = safeJsonForScript(value)
  for (const ch of ['<', '>', '&', '\u2028', '\u2029']) assert.ok(!out.includes(ch), `contains raw ${JSON.stringify(ch)}`)
  assert.ok(out.includes('\\u003c/script\\u003e'))
  assert.deepEqual(JSON.parse(out), value)
  assert.equal(safeJsonForScript(undefined), 'null')
  assert.equal(safeJsonForScript('plain'), '"plain"')
})

test('sanitizeRichHtml: scripts, handlers, iframes, forms, styles and hostile URLs are removed', () => {
  const cases = [
    ['<p>hi</p><script>alert(1)</script>', ['<script', 'alert']],
    // "x" is a legitimate relative image path, so src survives; the handler must not.
    ['<img src=x onerror=alert(1)>', ['onerror', 'alert']],
    ['<img src="a\\b.png">', ['src=']],
    ['<a href="javascript:alert(1)">x</a>', ['javascript']],
    ['<a href="JaVa&#x73;cript:alert(1)">x</a>', ['javascript', 'JaVa']],
    ['<a href="java\tscript:alert(1)">x</a>', ['javascript', 'script:']],
    ['<a href="data:text/html,<script>alert(1)</script>">x</a>', ['data:', '<script']],
    ['<iframe src="https://evil.example"></iframe>', ['iframe', 'evil.example']],
    ['<form action="/x"><input name=a><button>go</button></form>', ['<form', '<input', '<button']],
    ['<p style="background:url(javascript:alert(1))">x</p>', ['style']],
    ['<svg onload=alert(1)><circle/></svg>', ['<svg', 'onload']],
    ['<style>body{display:none}</style>x', ['<style', 'display']],
    ['<img src="data:image/svg+xml,<svg onload=alert(1)>">', ['data:']],
    ['<img src="//evil.example/a.png">', ['evil.example']],
    ['<div onclick="alert(1)">x</div>', ['onclick']],
    ['<a href="/ok" target="_blank" onmouseover="x()">x</a>', ['onmouseover', 'target']],
  ]
  for (const [input, forbidden] of cases) {
    const out = sanitizeRichHtml(input).toLowerCase()
    for (const f of forbidden) assert.ok(!out.includes(f.toLowerCase()), `${input} -> ${out} still has ${f}`)
  }
})

test('sanitizeRichHtml: ordinary editorial markup survives', () => {
  const html =
    '<h2>Title</h2><p>One <strong>two</strong> <em>three</em> <a href="https://example.com/x" title="t">link</a>' +
    ' <a href="mailto:a@b.co">m</a></p><ul><li>a</li></ul><ol><li>b</li></ol><blockquote>q</blockquote>' +
    '<pre><code>x = 1</code></pre><img src="https://cdn.example.com/a.png" alt="A" width="10" height="20" />' +
    '<table><thead><tr><th scope="col">h</th></tr></thead><tbody><tr><td colspan="2">c</td></tr></tbody></table>'
  assert.equal(sanitizeRichHtml(html), html)
  assert.equal(sanitizeRichHtml('<a href="/relative">r</a>'), '<a href="/relative">r</a>')
})

test('sanitizeRichHtml: plain text stays text; non-strings render empty', () => {
  assert.equal(sanitizeRichHtml('Tom & Jerry <3'), 'Tom &amp; Jerry &lt;3')
  assert.equal(sanitizeRichHtml(null), '')
  assert.equal(sanitizeRichHtml({ root: {} }), '')
})

test('the sanitiser config pins the allow-list (no style/event/iframe/script/form, https-only images)', () => {
  const o = RICH_TEXT_SANITIZE_OPTIONS
  for (const banned of ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'svg', 'link', 'meta', 'base']) {
    assert.ok(!o.allowedTags.includes(banned), `${banned} must not be allowed`)
  }
  for (const [tag, attrs] of Object.entries(o.allowedAttributes)) {
    for (const a of attrs) {
      assert.ok(!/^on/i.test(a) && a !== 'style' && a !== 'srcdoc', `${tag}[${a}] must not be allowed`)
    }
  }
  assert.deepEqual(o.allowedSchemes, ['http', 'https', 'mailto', 'tel'])
  assert.deepEqual(o.allowedSchemesByTag, { img: ['http', 'https'] })
  assert.equal(o.allowProtocolRelative, false)
})
