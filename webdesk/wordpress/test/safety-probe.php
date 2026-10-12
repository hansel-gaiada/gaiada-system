<?php
// webdesk/wordpress/test/safety-probe.php
//
// M6-P5c — proves the PHP theme's render-time output safety (inc/safety.php + the templates that use
// it): the link/image scheme allow-lists, inline-JSON safety, and the single rich-text route
// gaiada_sanitize_html(). Mirrors webdesk/blocks/test/unit/safety.test.mjs for the Astro renderer.
//
//   php test/safety-probe.php        (exit 0 = all PASS)
declare(strict_types=1);

require_once __DIR__ . '/../theme/gaiada-webdesk/inc/block-renderer.php';

use function GaiadaWebDesk\Theme\gaiada_render_blocks;
use function GaiadaWebDesk\Theme\gaiada_safe_href;
use function GaiadaWebDesk\Theme\gaiada_safe_img_src;
use function GaiadaWebDesk\Theme\gaiada_safe_json_for_script;
use function GaiadaWebDesk\Theme\gaiada_sanitize_html;

$failures = 0;
$checksRun = 0;
function check(bool $ok, string $label): void
{
    global $failures, $checksRun;
    $checksRun++;
    echo ($ok ? 'PASS' : 'FAIL') . "  {$label}\n";
    if (!$ok) {
        $failures++;
    }
}

// --- 1. href allow-list: dangerous -> '#' ---------------------------------------------------------
$hostile = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    '  javascript:alert(1)',
    "\tjavascript:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "java\r\nscript:alert(1)",
    "\x01javascript:alert(1)",
    "jav\x00ascript:alert(1)",
    " \x0bjavascript:alert(1)",
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
];
$allHostileBlocked = true;
foreach ($hostile as $h) {
    if (gaiada_safe_href($h) !== '#') {
        $allHostileBlocked = false;
        echo 'FAIL  not blocked: ' . json_encode($h) . ' -> ' . json_encode(gaiada_safe_href($h)) . "\n";
    }
}
check($allHostileBlocked, 'every hostile / unlisted href (javascript: any case, whitespace, tab-split, data:, vbscript:, //host) becomes "#" (' . count($hostile) . ' cases)');
check(gaiada_safe_href(null) === '#' && gaiada_safe_href(42) === '#' && gaiada_safe_href([]) === '#', 'non-string hrefs become "#"');

foreach (['http://example.com/a?b=1#c', 'https://example.com', 'HTTPS://example.com', 'mailto:hi@example.com', 'tel:+6281234', '/about', '/a/b?c=d', './x', '../x', '?page=2', '#section', 'about', 'about/', 'page.html', 'a/b?c=1#d'] as $ok) {
    check(gaiada_safe_href($ok) === $ok, "allowed href kept verbatim: {$ok}");
}
check(gaiada_safe_href('  https://example.com/x  ') === 'https://example.com/x', 'href is trimmed');
check(gaiada_safe_href("https://example.com/a\tb") === 'https://example.com/ab', 'control characters are removed from an allowed href');

// --- 2. img src allow-list ------------------------------------------------------------------------
foreach (['https://cdn.example.com/a.png', 'http://cdn.example.com/a.png', '/media/a.png', './a.png', '../a.png'] as $ok) {
    check(gaiada_safe_img_src($ok) === $ok, "allowed img src kept: {$ok}");
}
$badImg = ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', "java\tscript:alert(1)", 'data:image/svg+xml,<svg onload=alert(1)>', 'mailto:a@b.c', 'tel:123', '//evil.example/a.png', '#frag', '?q=1', '', null, 7];
$allBlocked = true;
foreach ($badImg as $b) {
    if (gaiada_safe_img_src($b) !== '') {
        $allBlocked = false;
        echo 'FAIL  img not blocked: ' . json_encode($b) . "\n";
    }
}
check($allBlocked, 'every non-(http|https|relative) img src is refused (' . count($badImg) . ' cases)');

// --- 3. inline JSON cannot break out of its <script> ---------------------------------------------
$value = [
    'root' => ['text' => '</script><script>alert(1)</script>', 'comment' => '<!-- x -->', 'amp' => 'a&b', 'sep' => "a\u{2028}b\u{2029}c"],
    'list' => ['</SCRIPT>', 1, null, true],
];
$json = gaiada_safe_json_for_script($value);
$clean = true;
foreach (['<', '>', '&', "\u{2028}", "\u{2029}"] as $ch) {
    if (str_contains($json, $ch)) {
        $clean = false;
    }
}
check($clean, 'inline JSON contains no raw <, >, &, U+2028 or U+2029');
check(str_contains($json, '\u003c/script\u003e'), 'inline JSON escapes "</script>" as \u003c/script\u003e');
check(json_decode($json, true) === $value, 'inline JSON still parses back to the same value');
check(gaiada_safe_json_for_script(null) === 'null', 'null serialises to null');

// --- 4. rich text OUTSIDE WordPress is escaped (never "allow") -----------------------------------
check(!function_exists('wp_kses_post'), 'precondition: wp_kses_post() is not defined (php-cli, outside WordPress)');
$evil = '<p>hi</p><script>alert(1)</script><img src=x onerror=alert(1)>';
$escaped = gaiada_sanitize_html($evil);
check(!str_contains($escaped, '<') && !str_contains($escaped, '>'), 'outside WordPress, gaiada_sanitize_html() leaves no raw angle bracket');
check($escaped === htmlspecialchars($evil, ENT_QUOTES, 'UTF-8'), 'outside WordPress, gaiada_sanitize_html() is exactly htmlspecialchars()');
$rt = gaiada_render_blocks([['type' => 'richText', 'props' => ['content' => $evil]]]);
check(!str_contains($rt, '<script') && !str_contains($rt, '<img'), 'a rendered richText block outside WordPress contains no live <script> or <img>');
check(str_contains($rt, '&lt;script&gt;'), 'the richText script payload is visible only as escaped text');

// --- 5. blocks use the helpers at every href/src -------------------------------------------------
$cta = gaiada_render_blocks([['type' => 'cta', 'props' => ['buttonLabel' => 'Go', 'buttonHref' => 'javascript:alert(1)']]]);
check(str_contains($cta, 'href="#"') && !str_contains(strtolower($cta), 'javascript'), 'cta with a javascript: href renders href="#"');
$cta2 = gaiada_render_blocks([['type' => 'cta', 'props' => ['buttonLabel' => 'Go', 'buttonHref' => "java\tscript:alert(1)"]]]);
check(str_contains($cta2, 'href="#"') && !str_contains(strtolower($cta2), 'script:'), 'cta with a tab-split javascript: href renders href="#"');
$cta3 = gaiada_render_blocks([['type' => 'cta', 'props' => ['buttonLabel' => 'Go', 'buttonHref' => 'https://example.com/a?x=1&y=2']]]);
check(str_contains($cta3, 'href="https://example.com/a?x=1&amp;y=2"'), 'cta with an https href keeps it (attribute-escaped)');
$cta4 = gaiada_render_blocks([['type' => 'cta', 'props' => ['buttonLabel' => 'Go']]]);
check(str_contains($cta4, 'href="#"'), 'cta with no href renders href="#"');

$gallery = gaiada_render_blocks([['type' => 'gallery', 'props' => ['items' => [
    ['url' => 'javascript:alert(1)', 'alt' => 'a'],
    ['url' => 'data:image/svg+xml,<svg onload=alert(1)>', 'alt' => 'b'],
    ['url' => 'https://cdn.example.com/ok.png', 'alt' => 'c'],
    ['url' => '/media/ok2.png', 'alt' => 'd'],
]]]]);
check(!str_contains(strtolower($gallery), 'javascript') && !str_contains($gallery, 'data:') && !str_contains($gallery, 'onload'), 'gallery drops javascript: and data: image sources');
check(str_contains($gallery, 'src="https://cdn.example.com/ok.png"') && str_contains($gallery, 'src="/media/ok2.png"'), 'gallery keeps https and relative image sources');
check(substr_count($gallery, '<img') === 4 && substr_count($gallery, ' src=') === 2, 'gallery renders all 4 <img> but only 2 carry a src');

$logos = gaiada_render_blocks([['type' => 'logoCloud', 'props' => ['logos' => [
    ['url' => 'javascript:alert(1)'],
    ['url' => 'https://cdn.example.com/logo.svg'],
]]]]);
check(!str_contains(strtolower($logos), 'javascript') && str_contains($logos, 'src="https://cdn.example.com/logo.svg"'), 'logoCloud drops javascript: and keeps https sources');

$testimonial = gaiada_render_blocks([['type' => 'testimonial', 'props' => ['quote' => ['root' => ['text' => '</script><script>alert(1)</script>']], 'author' => 'x']]]);
// The Lexical quote is emitted as an inert JSON payload (as Testimonial.astro does): exactly ONE script
// element (the payload's own), and the editor's `</script><script>` can neither close nor open another.
check(substr_count($testimonial, '<script') === 1 && substr_count($testimonial, '</script>') === 1 && str_contains($testimonial, '\u003c/script\u003e'), 'a richtext-object testimonial quote cannot emit a script tag of its own (one payload script, editor tags escaped)');

// --- 6. INSIDE WordPress, wp_kses_post() is the route -------------------------------------------
$GLOBALS['kses_calls'] = [];
if (!function_exists('wp_kses_post')) {
    // Declared at runtime (inside the if) so the section-4 precondition above still held.
    function wp_kses_post(string $data): string
    {
        $GLOBALS['kses_calls'][] = $data;
        return 'KSES(' . strlen($data) . ')';
    }
}
$in = '<p onclick="x()">hello</p>';
check(gaiada_sanitize_html($in) === 'KSES(' . strlen($in) . ')', 'inside WordPress, gaiada_sanitize_html() returns wp_kses_post() output');
check(($GLOBALS['kses_calls'][0] ?? null) === $in, 'wp_kses_post() received the raw editor HTML');
$GLOBALS['kses_calls'] = [];
$rt2 = gaiada_render_blocks([['type' => 'richText', 'props' => ['content' => $in]]]);
check(str_contains($rt2, 'KSES(') && count($GLOBALS['kses_calls']) === 1, 'a rendered richText block goes through wp_kses_post() exactly once');
check(!str_contains($rt2, 'onclick'), 'the unsanitised editor HTML never reaches the output');

echo "\n{$checksRun} checks, {$failures} failure(s)\n";
exit($failures === 0 ? 0 : 1);
