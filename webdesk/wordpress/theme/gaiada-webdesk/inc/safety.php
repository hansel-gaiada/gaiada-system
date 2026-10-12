<?php
// webdesk/wordpress/theme/gaiada-webdesk/inc/safety.php
//
// M6-P5c — render-time output safety for the PHP theme (stored-XSS class), mirroring
// webdesk/blocks/src/safety.ts (the Astro half). Client editors can edit their own site's content
// (rulings WSK-D58–D60), so every editor-controlled value that reaches an href/src, an inline
// <script type="application/json"> or raw HTML is made inert HERE. The WebDesk API validates SHAPE
// only (richtext = a string or a `{ root }` object, markdown = a string); it does not sanitise
// content at write time, so this renderer must not assume anything did.
//
//   gaiada_safe_href(v)          link allow-list; anything else -> '#'
//   gaiada_safe_img_src(v)       image src allow-list; anything else -> '' (caller omits the attribute)
//   gaiada_safe_json_for_script  JSON for a <script type="application/json"> body, cannot close the tag
//   gaiada_sanitize_html(s)      wp_kses_post() inside WordPress, htmlspecialchars() outside it
declare(strict_types=1);

namespace GaiadaWebDesk\Theme;

/**
 * Shared URL check. Browsers ignore leading/trailing C0 controls and spaces and strip tab/LF/CR
 * anywhere in a URL before reading its scheme, so every ASCII control character and space is
 * removed for the CHECK ("java\tscript:", " javascript:", "JaVaScRiPt:" all resolve to the same
 * scheme). Returns the value to emit (trimmed, control characters removed) or null when refused.
 *
 * @param string[] $allowedSchemes lower-case, with the trailing colon
 */
function gaiada_check_url(mixed $value, array $allowedSchemes, bool $allowFragmentAndQuery): ?string
{
    if (!is_string($value)) {
        return null;
    }
    $cleaned = preg_replace('/[\x00-\x20\x7f]+/', '', $value);
    if (!is_string($cleaned) || $cleaned === '') {
        return null;
    }
    if (preg_match('/^[a-z][a-z0-9+.-]*:/i', $cleaned, $m) === 1) {
        if (!in_array(strtolower($m[0]), $allowedSchemes, true)) {
            return null;
        }
    } elseif ($cleaned[0] === '/') {
        // "//host" and "/\host" are scheme-relative (browsers treat "\" as "/"): not a local path.
        if (isset($cleaned[1]) && ($cleaned[1] === '/' || $cleaned[1] === '\\')) {
            return null;
        }
    } elseif ($cleaned[0] === '?' || $cleaned[0] === '#') {
        if (!$allowFragmentAndQuery) {
            return null;
        }
    } elseif (preg_match('~^[^\\\\:/?#]+(?:[/?#][^\\\\]*)?$~', $cleaned) !== 1) {
        // A relative path ("about/", "page.html", "./x", "../x"): no backslash anywhere (browsers
        // read a backslash as "/", so two of them would be scheme-relative) and no ":" before the
        // first "/", "?" or "#". (In this single-quoted PHP string "\\\\" is one regex-escaped backslash.)
        return null;
    }
    $out = preg_replace('/[\x00-\x1f\x7f]+/', '', $value);
    return is_string($out) ? trim($out) : null;
}

/** href allow-list: http, https, mailto, tel, "/x", relative paths ("x", "./x", "../x"), "?x", "#x". Anything else is "#". */
function gaiada_safe_href(mixed $value): string
{
    return gaiada_check_url($value, ['http:', 'https:', 'mailto:', 'tel:'], true) ?? '#';
}

/** img src allow-list: http, https, "/x", relative paths. Anything else is '' (omit the attribute). */
function gaiada_safe_img_src(mixed $value): string
{
    return gaiada_check_url($value, ['http:', 'https:'], false) ?? '';
}

/** json_encode for the body of a <script type="application/json">: `<`, `>`, `&`, U+2028 and U+2029
 *  become \uXXXX escapes, so content can never close the tag or open a comment. Still valid JSON. */
function gaiada_safe_json_for_script(mixed $value): string
{
    $json = json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if (!is_string($json)) {
        return 'null';
    }
    return strtr($json, [
        '<' => '\u003c',
        '>' => '\u003e',
        '&' => '\u0026',
        "\u{2028}" => '\u2028',
        "\u{2029}" => '\u2029',
    ]);
}

/** The ONE route for editor-controlled HTML (richText). Inside WordPress it is wp_kses_post(); outside
 *  WordPress (php-cli probes, a host without WP loaded) it is htmlspecialchars(), so the fallback is
 *  always safe and never "allow". */
function gaiada_sanitize_html(string $html): string
{
    if (function_exists('wp_kses_post')) {
        return (string) \wp_kses_post($html);
    }
    return htmlspecialchars($html, ENT_QUOTES, 'UTF-8');
}
