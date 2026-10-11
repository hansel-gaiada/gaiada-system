<?php
// webdesk/wordpress/theme/gaiada-webdesk/inc/block-templates.php
//
// WSK-35 — one render function per KNOWN vocabulary block type (webdesk/blocks/src/components/*
// .astro, WSK-16, is the frozen reference this file mirrors in PHP). Intentionally simple markup
// — this ticket's bar is proving the renderer INVARIANT (known blocks render, unknown ones are
// skipped-and-reported), not shipping a pixel-accurate theme; visual polish is design-system work
// outside WSK-35's scope. Every function name is `gaiada_render_block_<type>`, matching
// block-renderer.php's `gaiada_render_known_block()` dispatch by convention.
declare(strict_types=1);

namespace GaiadaWebDesk\Theme;

/** An <img> whose src has already passed gaiada_safe_img_src(); an empty (refused) src omits the
 *  attribute. $url is NOT yet escaped here, $alt IS already escaped. */
function gaiada_img_tag(string $url, string $alt): string
{
    $src = $url === '' ? '' : ' src="' . gaiada_h($url) . '"';
    return "<img{$src} alt=\"{$alt}\" loading=\"lazy\">";
}

/** @param array<string,mixed> $props */
function gaiada_render_block_hero(array $props): string
{
    $heading = gaiada_h($props['heading'] ?? '');
    $subheading = gaiada_h($props['subheading'] ?? '');
    return "<section class=\"gaiada-block gaiada-block-hero\"><h1>{$heading}</h1><p>{$subheading}</p></section>";
}

/** @param array<string,mixed> $props */
function gaiada_render_block_richText(array $props): string
{
    // richText's `value` is EDITOR-CONTROLLED HTML and is NOT sanitised at write time: the WebDesk API
    // validates shape only (a string or a `{ root }` object), so this renderer sanitises it here, via
    // the one route gaiada_sanitize_html() (wp_kses_post() inside WordPress, htmlspecialchars() outside).
    // RichText.astro does the same with an allow-list sanitiser (M6-P5c).
    $value = gaiada_sanitize_html(is_string($props['value'] ?? null) ? $props['value'] : '');
    return "<div class=\"gaiada-block gaiada-block-richtext\">{$value}</div>";
}

/** @param array<string,mixed> $props */
function gaiada_render_block_gallery(array $props): string
{
    $items = is_array($props['items'] ?? null) ? $props['items'] : [];
    $html = '<div class="gaiada-block gaiada-block-gallery">';
    foreach ($items as $item) {
        $url = gaiada_safe_img_src(is_array($item) ? ($item['url'] ?? '') : '');
        $alt = gaiada_h(is_array($item) ? ($item['alt'] ?? '') : '');
        $html .= gaiada_img_tag($url, $alt);
    }
    return $html . '</div>';
}

/** @param array<string,mixed> $props */
function gaiada_render_block_cta(array $props): string
{
    $label = gaiada_h($props['label'] ?? '');
    $href = gaiada_h(gaiada_safe_href($props['href'] ?? '#'));
    return "<div class=\"gaiada-block gaiada-block-cta\"><a href=\"{$href}\">{$label}</a></div>";
}

/** @param array<string,mixed> $props */
function gaiada_render_block_featureGrid(array $props): string
{
    $items = is_array($props['items'] ?? null) ? $props['items'] : [];
    $html = '<div class="gaiada-block gaiada-block-featuregrid">';
    foreach ($items as $item) {
        $title = gaiada_h(is_array($item) ? ($item['title'] ?? '') : '');
        $body = gaiada_h(is_array($item) ? ($item['body'] ?? '') : '');
        $html .= "<div class=\"gaiada-feature\"><h3>{$title}</h3><p>{$body}</p></div>";
    }
    return $html . '</div>';
}

/** @param array<string,mixed> $props */
function gaiada_render_block_form(array $props): string
{
    $formId = gaiada_h($props['formId'] ?? '');
    return "<div class=\"gaiada-block gaiada-block-form\" data-gaiada-form-id=\"{$formId}\"></div>";
}

/** @param array<string,mixed> $props */
function gaiada_render_block_testimonial(array $props): string
{
    $quote = gaiada_h($props['quote'] ?? '');
    $author = gaiada_h($props['author'] ?? '');
    return "<blockquote class=\"gaiada-block gaiada-block-testimonial\">{$quote}<cite>{$author}</cite></blockquote>";
}

/** @param array<string,mixed> $props */
function gaiada_render_block_faq(array $props): string
{
    $items = is_array($props['items'] ?? null) ? $props['items'] : [];
    $html = '<div class="gaiada-block gaiada-block-faq">';
    foreach ($items as $item) {
        $q = gaiada_h(is_array($item) ? ($item['question'] ?? '') : '');
        $a = gaiada_h(is_array($item) ? ($item['answer'] ?? '') : '');
        $html .= "<details><summary>{$q}</summary><p>{$a}</p></details>";
    }
    return $html . '</div>';
}

/** @param array<string,mixed> $props */
function gaiada_render_block_logoCloud(array $props): string
{
    $logos = is_array($props['logos'] ?? null) ? $props['logos'] : [];
    $html = '<div class="gaiada-block gaiada-block-logocloud">';
    foreach ($logos as $logo) {
        $url = gaiada_safe_img_src(is_array($logo) ? ($logo['url'] ?? '') : '');
        $html .= gaiada_img_tag($url, '');
    }
    return $html . '</div>';
}

/** The composition-typed `fields` block (vocabulary 1.1.0, WSK-64). It carries an item's typed field
 *  values for the site's own code to read; it is data, not presentation, so it draws NOTHING and is
 *  not an unknown block (nothing is reported). Mirrors webdesk/blocks/src/renderer: resolve-blocks.ts
 *  treats `fields` as known but non-visual (NON_VISUAL_BLOCK_TYPES) and BlockRenderer.astro returns null
 *  for it. Without this function the dispatcher in block-renderer.php would throw for it, because
 *  `fields` is in gaiada_known_block_types().
 *
 * @param array<string,mixed> $props
 */
function gaiada_render_block_fields(array $props): string
{
    return '';
}
