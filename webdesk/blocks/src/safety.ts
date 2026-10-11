// webdesk/blocks/src/safety.ts
//
// M6-P5c — render-time output safety for the Astro block library (stored-XSS class). Client editors
// can edit their own site's content (rulings WSK-D58–D60), so every editor-controlled value that
// reaches an href/src, an inline <script type="application/json"> or raw HTML must be made inert
// HERE: the WebDesk API validates SHAPE only (webdesk/api/src/delivery/vocabulary/primitives.ts: a
// richtext is "a { root } object or a string", a markdown is "a string") and does not sanitise
// content at write time. The PHP theme mirrors this file in inc/safety.php.
//
//   safeHref(v)          link allow-list; anything else -> '#'
//   safeImgSrc(v)        image src allow-list; anything else -> undefined (attribute omitted)
//   safeJsonForScript(v) JSON for a <script type="application/json"> body, cannot close the tag
//   sanitizeRichHtml(s)  allow-list HTML sanitiser (sanitize-html) for richText string content
import sanitizeHtml from 'sanitize-html'

// Browsers ignore leading/trailing C0 controls and spaces, and strip tab/LF/CR anywhere, in a URL
// before parsing its scheme. We strip every ASCII control character and space for the CHECK, so no
// variant ("java\tscript:", " javascript:", "JaVaScRiPt:") can slip past.
// eslint-disable-next-line no-control-regex
const IGNORED_IN_SCHEME_CHECK = /[\u0000-\u0020\u007f]+/g
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]+/g
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i

const LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:'])
const IMAGE_SCHEMES = new Set(['http:', 'https:'])

function checkUrl(value: unknown, allowedSchemes: ReadonlySet<string>, allowFragmentAndQuery: boolean): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value.replace(IGNORED_IN_SCHEME_CHECK, '')
  if (cleaned === '') return null
  const scheme = HAS_SCHEME.exec(cleaned)
  if (scheme) {
    if (!allowedSchemes.has(scheme[0].toLowerCase())) return null
  } else if (cleaned.startsWith('/')) {
    // "//host" and "/\host" are scheme-relative (browsers treat "\" as "/"): not a local path.
    if (cleaned[1] === '/' || cleaned[1] === '\\') return null
  } else if (!(cleaned.startsWith('./') || cleaned.startsWith('../'))) {
    if (!(allowFragmentAndQuery && (cleaned.startsWith('?') || cleaned.startsWith('#')))) return null
  }
  // Emit the trimmed original minus control characters (what a browser would see anyway).
  return value.replace(CONTROL_CHARS, '').trim()
}

/** href allow-list: http, https, mailto, tel, "/x", "./x", "../x", "?x", "#x". Else '#'. */
export function safeHref(value: unknown): string {
  return checkUrl(value, LINK_SCHEMES, true) ?? '#'
}

/** img src allow-list: http, https, "/x", "./x", "../x". Else undefined (Astro omits the attribute). */
export function safeImgSrc(value: unknown): string | undefined {
  return checkUrl(value, IMAGE_SCHEMES, false) ?? undefined
}

/** JSON.stringify for the body of a <script type="application/json">: `<`, `>`, `&`, U+2028 and
 *  U+2029 become \uXXXX escapes, so content can never close the tag or open a comment. The result
 *  is still valid JSON that parses back to the same value. */
export function safeJsonForScript(value: unknown): string {
  const json = JSON.stringify(value) ?? 'null'
  return json.replace(/[<>&\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
}

/** The sanitize-html options used for rich text. Exported so the unit tests pin the allow-list. */
export const RICH_TEXT_SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p', 'br', 'hr', 'div', 'span',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'sub', 'sup', 'small', 'mark',
    'ul', 'ol', 'li',
    'blockquote', 'pre', 'code',
    'a', 'img', 'figure', 'figcaption',
    'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  ],
  allowedAttributes: {
    a: ['href', 'title'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    th: ['colspan', 'rowspan', 'scope'],
    td: ['colspan', 'rowspan'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['http', 'https'] },
  allowedSchemesAppliedToAttributes: ['href', 'src'],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard', // script/style/textarea/option content is dropped with the tag
  transformTags: {
    // Run our own allow-list on the DECODED attribute too, so both renderers agree on a link.
    a: (tagName, attribs) => {
      const next = { ...attribs }
      if (next.href !== undefined) next.href = safeHref(next.href)
      return { tagName, attribs: next }
    },
    img: (tagName, attribs) => {
      const next = { ...attribs }
      if (next.src !== undefined) {
        const src = safeImgSrc(next.src)
        if (src === undefined) delete next.src
        else next.src = src
      }
      return { tagName, attribs: next }
    },
  },
}

/** Allow-list sanitiser for richText string content (no style, no event handlers, no iframes,
 *  scripts or forms). A plain-text string passes through as correctly escaped text. */
export function sanitizeRichHtml(html: unknown): string {
  return typeof html === 'string' ? sanitizeHtml(html, RICH_TEXT_SANITIZE_OPTIONS) : ''
}
