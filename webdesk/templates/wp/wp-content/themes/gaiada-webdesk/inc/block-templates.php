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
 *  attribute. $url is NOT yet escaped here, $alt IS already escaped. $width/$height are emitted only
 *  when they are positive integers (Astro passes media.width/height straight through). */
function gaiada_img_tag(string $url, string $alt, mixed $width = null, mixed $height = null): string
{
    $src = $url === '' ? '' : ' src="' . gaiada_h($url) . '"';
    $dims = '';
    if (is_int($width) && $width > 0) {
        $dims .= ' width="' . $width . '"';
    }
    if (is_int($height) && $height > 0) {
        $dims .= ' height="' . $height . '"';
    }
    return "<img{$src} alt=\"{$alt}\"{$dims} loading=\"lazy\">";
}

/** One vocabulary `media` value ({ url, alt?, width?, height? }) as an <img>. The url passes
 *  gaiada_safe_img_src(), the alt gaiada_h(). */
function gaiada_media_img(mixed $media): string
{
    $m = is_array($media) ? $media : [];
    return gaiada_img_tag(
        gaiada_safe_img_src($m['url'] ?? ''),
        gaiada_h($m['alt'] ?? ''),
        $m['width'] ?? null,
        $m['height'] ?? null,
    );
}

/** A vocabulary `media` value is a non-empty { url } object. */
function gaiada_has_media(mixed $media): bool
{
    return is_array($media) && is_string($media['url'] ?? null) && $media['url'] !== '';
}

/** The inert JSON payload Astro emits for a Lexical `{ root }` document (RichText.astro,
 *  Testimonial.astro): a <script type="application/json"> whose body cannot close the tag. */
function gaiada_json_payload(mixed $value): string
{
    return '<script type="application/json">' . gaiada_safe_json_for_script($value) . '</script>';
}

/** @param array<string,mixed> $props */
function gaiada_render_block_hero(array $props): string
{
    $heading = gaiada_h($props['heading'] ?? '');
    $html = "<section class=\"gaiada-block gaiada-block-hero\"><h1>{$heading}</h1>";
    if (is_string($props['subheading'] ?? null) && $props['subheading'] !== '') {
        $html .= '<p>' . gaiada_h($props['subheading']) . '</p>';
    }
    if (gaiada_has_media($props['media'] ?? null)) {
        $html .= gaiada_media_img($props['media']);
    }
    $ctaLabel = $props['ctaLabel'] ?? '';
    $ctaHref = $props['ctaHref'] ?? '';
    if (is_string($ctaLabel) && $ctaLabel !== '' && is_string($ctaHref) && $ctaHref !== '') {
        $html .= '<a class="gaiada-hero-cta" href="' . gaiada_h(gaiada_safe_href($ctaHref)) . '">' . gaiada_h($ctaLabel) . '</a>';
    }
    return $html . '</section>';
}

/** @param array<string,mixed> $props */
function gaiada_render_block_richText(array $props): string
{
    // richText's `content` is a RichTextValue: a plain string OR a Lexical `{ root }` document. Both are
    // EDITOR-CONTROLLED and NOT sanitised at write time (the WebDesk API validates shape only), so this
    // renderer makes them inert here. A string is sanitised via the one route gaiada_sanitize_html()
    // (wp_kses_post() inside WordPress, htmlspecialchars() outside); a `{ root }` document is embedded as
    // an inert JSON payload via gaiada_safe_json_for_script(), exactly as RichText.astro does (M6-P5c).
    $content = $props['content'] ?? null;
    $body = '';
    if (is_string($content)) {
        $body = gaiada_sanitize_html($content);
    } elseif (is_array($content) && array_key_exists('root', $content)) {
        $body = gaiada_json_payload($content);
    }
    return "<div class=\"gaiada-block gaiada-block-richtext\">{$body}</div>";
}

/** @param array<string,mixed> $props */
function gaiada_render_block_gallery(array $props): string
{
    $items = is_array($props['items'] ?? null) ? $props['items'] : [];
    $html = '<div class="gaiada-block gaiada-block-gallery">';
    foreach ($items as $item) {
        $html .= gaiada_media_img($item);
    }
    if (is_string($props['caption'] ?? null) && $props['caption'] !== '') {
        $html .= '<p class="gaiada-gallery-caption">' . gaiada_h($props['caption']) . '</p>';
    }
    return $html . '</div>';
}

/** @param array<string,mixed> $props */
function gaiada_render_block_cta(array $props): string
{
    $heading = gaiada_h($props['heading'] ?? '');
    $label = gaiada_h($props['buttonLabel'] ?? '');
    $href = gaiada_h(gaiada_safe_href($props['buttonHref'] ?? '#'));
    $html = "<div class=\"gaiada-block gaiada-block-cta\"><h2>{$heading}</h2>";
    if (is_string($props['body'] ?? null) && $props['body'] !== '') {
        $html .= '<p>' . gaiada_h($props['body']) . '</p>';
    }
    return $html . "<a href=\"{$href}\">{$label}</a></div>";
}

/** One vocabulary `relation` value ({ collection, slug }) as a list item carrying the pointer, as
 *  FeatureGrid.astro / Faq.astro render it: the slug is the visible text. */
function gaiada_relation_item(mixed $rel, string $class): string
{
    $r = is_array($rel) ? $rel : [];
    $collection = gaiada_h($r['collection'] ?? '');
    $slug = gaiada_h($r['slug'] ?? '');
    return "<li class=\"{$class}\" data-relation-collection=\"{$collection}\" data-relation-slug=\"{$slug}\">{$slug}</li>";
}

/** @param array<string,mixed> $props */
function gaiada_render_block_featureGrid(array $props): string
{
    $items = is_array($props['items'] ?? null) ? $props['items'] : [];
    $html = '<div class="gaiada-block gaiada-block-featuregrid">';
    if (is_string($props['heading'] ?? null) && $props['heading'] !== '') {
        $html .= '<h2>' . gaiada_h($props['heading']) . '</h2>';
    }
    $html .= '<ul>';
    foreach ($items as $item) {
        $html .= gaiada_relation_item($item, 'gaiada-feature');
    }
    return $html . '</ul></div>';
}

/** @param array<string,mixed> $props */
function gaiada_render_block_form(array $props): string
{
    // `formKey` is a relation value { collection, slug } (FormBlock.astro); the slug is the form id.
    $key = is_array($props['formKey'] ?? null) ? $props['formKey'] : [];
    $collection = gaiada_h($key['collection'] ?? '');
    $slug = gaiada_h($key['slug'] ?? '');
    return "<div class=\"gaiada-block gaiada-block-form\" data-gaiada-form-collection=\"{$collection}\" data-gaiada-form-id=\"{$slug}\"></div>";
}

/** @param array<string,mixed> $props */
function gaiada_render_block_testimonial(array $props): string
{
    // `quote` is a richtext value. Testimonial.astro renders a string as escaped text and anything else
    // as an inert JSON payload; mirrored here.
    $quote = $props['quote'] ?? '';
    $quoteHtml = is_string($quote) ? gaiada_h($quote) : gaiada_json_payload($quote);
    $author = gaiada_h($props['author'] ?? '');
    $html = "<blockquote class=\"gaiada-block gaiada-block-testimonial\">{$quoteHtml}<footer>";
    if (gaiada_has_media($props['avatar'] ?? null)) {
        $html .= gaiada_media_img($props['avatar']);
    }
    $html .= "<cite>{$author}</cite>";
    if (is_string($props['role'] ?? null) && $props['role'] !== '') {
        $html .= '<span class="gaiada-testimonial-role">' . gaiada_h($props['role']) . '</span>';
    }
    return $html . '</footer></blockquote>';
}

/** @param array<string,mixed> $props */
function gaiada_render_block_faq(array $props): string
{
    // `items` are relation pointers ({ collection, slug }) to the `faqItem` collection, rendered as
    // pointers (Faq.astro); there is no inline question/answer in the vocabulary.
    $items = is_array($props['items'] ?? null) ? $props['items'] : [];
    $html = '<div class="gaiada-block gaiada-block-faq">';
    if (is_string($props['heading'] ?? null) && $props['heading'] !== '') {
        $html .= '<h2>' . gaiada_h($props['heading']) . '</h2>';
    }
    $html .= '<ul>';
    foreach ($items as $item) {
        $html .= gaiada_relation_item($item, 'gaiada-faq-item');
    }
    return $html . '</ul></div>';
}

/** @param array<string,mixed> $props */
function gaiada_render_block_logoCloud(array $props): string
{
    $logos = is_array($props['logos'] ?? null) ? $props['logos'] : [];
    $html = '<div class="gaiada-block gaiada-block-logocloud">';
    if (is_string($props['heading'] ?? null) && $props['heading'] !== '') {
        $html .= '<h2>' . gaiada_h($props['heading']) . '</h2>';
    }
    foreach ($logos as $logo) {
        $html .= gaiada_media_img($logo);
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
