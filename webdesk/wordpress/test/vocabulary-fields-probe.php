<?php
// webdesk/wordpress/test/vocabulary-fields-probe.php
//
// M6-P5e — proves the PHP block templates read the vocabulary's REAL field names. Before this ticket
// `richText` read `value` (vocabulary: `content`) and `cta` read `label`/`href` (vocabulary:
// `buttonLabel`/`buttonHref`), so those blocks rendered empty in WordPress while every probe stayed green
// (their fixtures used the same wrong names).
//
// For each block type this builds props from the vocabulary's own field names
// (webdesk/blocks/src/vocabulary/blocks.ts, vocabulary 1.2.0), with recognisable sample values (written
// by hand, with HTML-special characters), renders them, and asserts every sample value, escaped, appears
// in the output. It also asserts the set of block types in inc/block-vocabulary.php equals the set covered
// here, so a new vocabulary block type without coverage fails the probe.
//
//   php test/vocabulary-fields-probe.php        (exit 0 = all PASS)
declare(strict_types=1);

require_once __DIR__ . '/../theme/gaiada-webdesk/inc/block-renderer.php';

use function GaiadaWebDesk\Theme\gaiada_drain_unknown_block_reports;
use function GaiadaWebDesk\Theme\gaiada_h;
use function GaiadaWebDesk\Theme\gaiada_known_block_types;
use function GaiadaWebDesk\Theme\gaiada_render_blocks;

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

// Each case: block type => [props, [field => sample value that must appear (escaped) in the output]].
// The `fields` lists mirror BLOCKS[type].fields in blocks.ts, name for name.
$s = static fn (string $name): string => "S-{$name}-<&\"'>";
$media = static fn (string $name): array => [
    'url' => "https://cdn.example.com/{$name}.png?a=1&b=2",
    'alt' => $s($name . 'Alt'),
    'width' => 640,
    'height' => 480,
];

$cases = [
    // hero: heading*, subheading, media, ctaLabel, ctaHref
    'hero' => [
        ['heading' => $s('heroHeading'), 'subheading' => $s('heroSub'), 'media' => $media('heroMedia'),
         'ctaLabel' => $s('heroCtaLabel'), 'ctaHref' => 'https://example.com/hero-cta?x=1&y=2'],
        [$s('heroHeading'), $s('heroSub'), $media('heroMedia')['url'], $s('heroMediaAlt'),
         $s('heroCtaLabel'), 'https://example.com/hero-cta?x=1&y=2'],
    ],
    // richText: content* (a string here; the Lexical { root } shape is checked below)
    'richText' => [
        ['content' => '<p>' . $s('richContent') . '</p>'],
        ['<p>' . $s('richContent') . '</p>'],
    ],
    // gallery: items* (media, multiple), caption
    'gallery' => [
        ['items' => [$media('galleryOne'), $media('galleryTwo')], 'caption' => $s('galleryCaption')],
        [$media('galleryOne')['url'], $s('galleryOneAlt'), $media('galleryTwo')['url'], $s('galleryTwoAlt'), $s('galleryCaption')],
    ],
    // cta: heading*, body, buttonLabel*, buttonHref*
    'cta' => [
        ['heading' => $s('ctaHeading'), 'body' => $s('ctaBody'), 'buttonLabel' => $s('ctaButtonLabel'),
         'buttonHref' => 'https://example.com/cta?x=1&y=2'],
        [$s('ctaHeading'), $s('ctaBody'), $s('ctaButtonLabel'), 'https://example.com/cta?x=1&y=2'],
    ],
    // featureGrid: heading, items* (relation -> feature, multiple: { collection, slug })
    'featureGrid' => [
        ['heading' => $s('gridHeading'), 'items' => [
            ['collection' => $s('gridColA'), 'slug' => $s('gridSlugA')],
            ['collection' => $s('gridColB'), 'slug' => $s('gridSlugB')],
        ]],
        [$s('gridHeading'), $s('gridColA'), $s('gridSlugA'), $s('gridColB'), $s('gridSlugB')],
    ],
    // form: formKey* (relation -> form_defs: { collection, slug })
    'form' => [
        ['formKey' => ['collection' => $s('formCol'), 'slug' => $s('formSlug')]],
        [$s('formCol'), $s('formSlug')],
    ],
    // testimonial: quote* (richtext), author*, role, avatar (media)
    'testimonial' => [
        ['quote' => $s('testimonialQuote'), 'author' => $s('testimonialAuthor'), 'role' => $s('testimonialRole'),
         'avatar' => $media('testimonialAvatar')],
        [$s('testimonialQuote'), $s('testimonialAuthor'), $s('testimonialRole'),
         $media('testimonialAvatar')['url'], $s('testimonialAvatarAlt')],
    ],
    // faq: heading, items* (relation -> faqItem, multiple: { collection, slug })
    'faq' => [
        ['heading' => $s('faqHeading'), 'items' => [
            ['collection' => $s('faqColA'), 'slug' => $s('faqSlugA')],
            ['collection' => $s('faqColB'), 'slug' => $s('faqSlugB')],
        ]],
        [$s('faqHeading'), $s('faqColA'), $s('faqSlugA'), $s('faqColB'), $s('faqSlugB')],
    ],
    // logoCloud: heading, logos* (media, multiple)
    'logoCloud' => [
        ['heading' => $s('logoHeading'), 'logos' => [$media('logoOne'), $media('logoTwo')]],
        [$s('logoHeading'), $media('logoOne')['url'], $s('logoOneAlt'), $media('logoTwo')['url'], $s('logoTwoAlt')],
    ],
];

// --- 1. every vocabulary block type is covered, and nothing else is ------------------------------
// `fields` is the composition-typed block: its vocabulary field list is empty, it is data not
// presentation, and it draws nothing (checked in section 3), so it has no sample values.
$nonVisual = ['fields'];
$vendored = gaiada_known_block_types();
$covered = array_merge(array_keys($cases), $nonVisual);
sort($vendored);
sort($covered);
check($vendored === $covered, 'the block types in inc/block-vocabulary.php equal the set this probe covers (a new block type without coverage fails here): ' . implode(',', $vendored));

// --- 2. each visual block renders every sample value, escaped ------------------------------------
foreach ($cases as $type => [$props, $expected]) {
    $html = gaiada_render_blocks([['type' => $type, 'props' => $props]], 'page', 'probe');
    $reports = gaiada_drain_unknown_block_reports();
    check($html !== '' && count($reports) === 0, "{$type}: renders output and is not reported unknown");
    foreach ($expected as $value) {
        $escaped = gaiada_h($value);
        check(str_contains($html, $escaped), "{$type}: renders sample value " . json_encode($value, JSON_UNESCAPED_SLASHES));
    }
    // The escaping is real: the raw sample (with its raw `<` / `"`) never appears unescaped.
    check(!str_contains($html, '<&"\'>'), "{$type}: no sample value reaches the output unescaped");
}

// --- 3. shapes the plain cases above do not exercise ---------------------------------------------
// richText `content` as a Lexical { root } document: an inert JSON payload (RichText.astro), not dropped.
$lexical = ['root' => ['children' => [['text' => 'LEXICAL-ROOT-MARKER']]]];
$rt = gaiada_render_blocks([['type' => 'richText', 'props' => ['content' => $lexical]]]);
gaiada_drain_unknown_block_reports();
check(str_contains($rt, 'LEXICAL-ROOT-MARKER') && str_contains($rt, '<script type="application/json">'), 'richText: a Lexical { root } content renders as an inert JSON payload');
// testimonial `quote` as a richtext object: same payload shape.
$tq = gaiada_render_blocks([['type' => 'testimonial', 'props' => ['quote' => $lexical, 'author' => 'A']]]);
gaiada_drain_unknown_block_reports();
check(str_contains($tq, 'LEXICAL-ROOT-MARKER') && str_contains($tq, '<script type="application/json">'), 'testimonial: a richtext-object quote renders as an inert JSON payload');
// Pre-1.2 names are NOT read any more: the old wrong props render nothing of their own.
$old = gaiada_render_blocks([['type' => 'richText', 'props' => ['value' => 'OLD-VALUE-NAME']], ['type' => 'cta', 'props' => ['label' => 'OLD-LABEL-NAME', 'href' => 'https://example.com/old']]]);
gaiada_drain_unknown_block_reports();
check(!str_contains($old, 'OLD-VALUE-NAME') && !str_contains($old, 'OLD-LABEL-NAME') && !str_contains($old, 'example.com/old'), 'the old wrong prop names (value, label, href) are not read');
// hero: the CTA needs BOTH label and href (Hero.astro); media is optional.
$heroNoHref = gaiada_render_blocks([['type' => 'hero', 'props' => ['heading' => 'H', 'ctaLabel' => 'LONELY-LABEL']]]);
gaiada_drain_unknown_block_reports();
check(!str_contains($heroNoHref, 'LONELY-LABEL') && !str_contains($heroNoHref, '<img'), 'hero: a ctaLabel without a ctaHref renders no link; no media renders no image');
// `fields` draws nothing.
check(gaiada_render_blocks([['type' => 'fields', 'props' => ['heading' => 'FIELDS-LEAK']]]) === '', 'fields: a known non-visual block renders nothing');
gaiada_drain_unknown_block_reports();

echo "\n{$checksRun} checks, {$failures} failure(s)\n";
exit($failures === 0 ? 0 : 1);
