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
    // richText's `value` is trusted, pre-sanitized editorial HTML (matching RichText.astro's own
    // `set:html` — the vocabulary's job to sanitize at write time, not this renderer's).
    $value = is_string($props['value'] ?? null) ? $props['value'] : '';
    return "<div class=\"gaiada-block gaiada-block-richtext\">{$value}</div>";
}

/** @param array<string,mixed> $props */
function gaiada_render_block_gallery(array $props): string
{
    $items = is_array($props['items'] ?? null) ? $props['items'] : [];
    $html = '<div class="gaiada-block gaiada-block-gallery">';
    foreach ($items as $item) {
        $url = gaiada_h(is_array($item) ? ($item['url'] ?? '') : '');
        $alt = gaiada_h(is_array($item) ? ($item['alt'] ?? '') : '');
        $html .= "<img src=\"{$url}\" alt=\"{$alt}\" loading=\"lazy\">";
    }
    return $html . '</div>';
}

/** @param array<string,mixed> $props */
function gaiada_render_block_cta(array $props): string
{
    $label = gaiada_h($props['label'] ?? '');
    $href = gaiada_h($props['href'] ?? '#');
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
        $url = gaiada_h(is_array($logo) ? ($logo['url'] ?? '') : '');
        $html .= "<img src=\"{$url}\" alt=\"\" loading=\"lazy\">";
    }
    return $html . '</div>';
}
