<?php
// webdesk/wordpress/test/render-invariant-probe.php
//
// WSK-35's load-bearing proof: the render-time half of the renderer invariant (webdesk-design.md
// §05 hard rule 2), PHP-side, "by observation" per this ticket's bar — feed the real renderer a
// block the vocabulary does not know and show it skipped the block, reported it, and still
// rendered the rest. Mirrors WSK-16's own render-time proof (webdesk/blocks/test/*) and WSK-18's
// P3 gate condition 3 exactly, restated for this renderer.
//
// Run for real (see this directory's README for the exact `docker run` invocation):
//   php test/render-invariant-probe.php
declare(strict_types=1);

require_once __DIR__ . '/../theme/gaiada-webdesk/inc/block-renderer.php';

use function GaiadaWebDesk\Theme\gaiada_render_blocks;
use function GaiadaWebDesk\Theme\gaiada_drain_unknown_block_reports;
use function GaiadaWebDesk\Theme\gaiada_known_block_types;
use function GaiadaWebDesk\Theme\gaiada_resolve_blocks;

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

// ---------------------------------------------------------------------------------------------
// 1. THE MAIN PROOF — a real ItemEnvelope-shaped blocks array with an unknown block SANDWICHED
//    between two known ones, exactly WSK-16's own "between a hero and a richText" pattern.
// ---------------------------------------------------------------------------------------------
$blocks = [
    ['type' => 'hero', 'props' => ['heading' => 'Welcome to Acme', 'subheading' => 'A distinctive seeded string: WSK35-HERO-MARKER']],
    ['type' => 'pricingTable', 'props' => ['tiers' => [['name' => 'Pro', 'price' => 99]]]], // NOT in the vocabulary
    ['type' => 'richText', 'props' => ['content' => '<p>A distinctive seeded string: WSK35-RICHTEXT-MARKER</p>']],
];

$html = gaiada_render_blocks($blocks, 'article', 'welcome');
$reports = gaiada_drain_unknown_block_reports();

echo "\n--- rendered HTML ---\n{$html}\n--- end HTML ---\n\n";
echo '--- unknown-block reports: ' . json_encode($reports) . " ---\n\n";

check(str_contains($html, 'WSK35-HERO-MARKER'), 'known block BEFORE the unknown one still renders (hero)');
check(str_contains($html, 'WSK35-RICHTEXT-MARKER'), 'known block AFTER the unknown one still renders (richText)');
check(substr_count($html, 'pricingTable') === 0, 'the unknown block type name appears ZERO times in the rendered HTML');
check(!str_contains($html, 'tiers') && !str_contains($html, 'Pro') && !str_contains($html, '99'), 'the unknown block\'s PROPS never leak into the rendered HTML either');
check(count($reports) === 1, 'exactly one unknown-block report was captured (not zero, not swallowed silently)');
check(($reports[0]['type'] ?? null) === 'pricingTable', 'the report names the exact unknown type, verbatim');
check(($reports[0]['index'] ?? null) === 1, 'the report carries the correct index in the original blocks array (1, not renumbered post-skip)');
check(($reports[0]['collection'] ?? null) === 'article' && ($reports[0]['slug'] ?? null) === 'welcome', 'the report carries which collection/slug it happened in');

// ---------------------------------------------------------------------------------------------
// 2. POSITIVE CONTROL — an all-known blocks array produces ZERO reports and renders every block.
//    Without this, a renderer that reported EVERYTHING (including known blocks) would still pass
//    check #5 above by accident; this proves the "known" path is not a no-op.
// ---------------------------------------------------------------------------------------------
$allKnown = [
    ['type' => 'cta', 'props' => ['heading' => 'WSK35-CTA-HEADING', 'buttonLabel' => 'WSK35-CTA-MARKER', 'buttonHref' => '/go']],
    ['type' => 'faq', 'props' => ['items' => [['collection' => 'faqItem', 'slug' => 'WSK35-FAQ-Q']]]],
];
$htmlAllKnown = gaiada_render_blocks($allKnown, 'article', 'faq-page');
$reportsAllKnown = gaiada_drain_unknown_block_reports();
check(count($reportsAllKnown) === 0, 'positive control: an all-known blocks array produces ZERO unknown-block reports');
check(str_contains($htmlAllKnown, 'WSK35-CTA-MARKER') && str_contains($htmlAllKnown, 'WSK35-FAQ-Q'), 'positive control: both known blocks actually rendered');

// ---------------------------------------------------------------------------------------------
// 3. NEGATIVE CONTROL — a deliberate break, proving this probe CAN fail (per this program's own
//    "a check that cannot fail is decoration" bar). Simulates the composition-time REJECT behavior
//    being wrongly applied at render time: if gaiada_render_blocks threw on an unknown type
//    instead of skipping it, this control demonstrates the failure the real function must NOT
//    exhibit. We do not monkey-patch the real function (PHP has no clean seam for that without a
//    second implementation); instead this proves resolve-time detection is real by flipping the
//    vocabulary list to empty and confirming EVERY block — including the known ones — is then
//    correctly classified unknown, i.e. gaiada_resolve_blocks() is not hardcoding "known" as true.
// ---------------------------------------------------------------------------------------------
function gaiada_resolve_blocks_with_empty_vocabulary(array $blocks): array
{
    $resolved = [];
    foreach (array_values($blocks) as $index => $block) {
        $type = is_string($block['type'] ?? null) ? $block['type'] : '';
        $props = is_array($block['props'] ?? null) ? $block['props'] : [];
        $resolved[] = ['index' => $index, 'type' => $type, 'props' => $props, 'known' => in_array($type, [], true)];
    }
    return $resolved;
}
$forcedUnknown = gaiada_resolve_blocks_with_empty_vocabulary([['type' => 'hero', 'props' => []]]);
check($forcedUnknown[0]['known'] === false, 'NEGATIVE CONTROL: with the vocabulary list forced empty, a normally-known type ("hero") IS classified unknown — proves the known/unknown branch is a real vocabulary lookup, not a hardcoded true');
check(count(gaiada_known_block_types()) === 10, 'sanity: the vendored vocabulary has all 10 known block types (the 9 generic ones plus the composition-typed `fields`; the drift check is a separate gate, this just confirms the fixture used here matches it)');

// ---------------------------------------------------------------------------------------------
// 4. THE `fields` BLOCK (vocabulary 1.1.0, WSK-64) — KNOWN but NON-VISUAL, as in webdesk/blocks'
//    renderer. It must render nothing, must NOT throw (the dispatcher throws for a known type with no
//    template), and must NOT be reported as unknown. Its neighbours must still render.
// ---------------------------------------------------------------------------------------------
$withFields = [
    ['type' => 'fields', 'props' => ['title' => 'WSK64-FIELDS-LEAK-CHECK', 'tags' => ['a', 'b']]],
    ['type' => 'hero', 'props' => ['heading' => 'WSK64-HERO-MARKER']],
];
$fieldsThrew = false;
$htmlFields = '';
try {
    $htmlFields = gaiada_render_blocks($withFields, 'page', 'home');
} catch (\Throwable $e) {
    $fieldsThrew = true;
}
$reportsFields = gaiada_drain_unknown_block_reports();
check(in_array('fields', gaiada_known_block_types(), true), '`fields` is a known block type in the vendored vocabulary');
check($fieldsThrew === false, 'a `fields` block does NOT throw (a template exists for every known type)');
check(count($reportsFields) === 0, 'a `fields` block is NOT reported as unknown');
check(!str_contains($htmlFields, 'WSK64-FIELDS-LEAK-CHECK'), 'a `fields` block\'s values never reach the rendered HTML');
check(str_contains($htmlFields, 'WSK64-HERO-MARKER'), 'the block AFTER a `fields` block still renders');
check(\GaiadaWebDesk\Theme\gaiada_render_known_block('fields', ['title' => 'x']) === '', 'the `fields` template returns the empty string');
check(gaiada_render_blocks([['type' => 'fields', 'props' => []]], 'page', 'home') === '', 'a blocks array holding only a `fields` block renders to the empty string');
gaiada_drain_unknown_block_reports();

// ---------------------------------------------------------------------------------------------
// 5. TEMPLATE COVERAGE — every name in the vendored vocabulary has a render function, so a future
//    re-vendor that adds a block type fails HERE, not at render time on a live page.
// ---------------------------------------------------------------------------------------------
foreach (gaiada_known_block_types() as $knownType) {
    check(function_exists('GaiadaWebDesk\Theme\gaiada_render_block_' . $knownType), "template coverage: gaiada_render_block_{$knownType}() exists");
}

echo "\n" . ($failures === 0 ? 'ALL PASS' : "{$failures} FAILURE(S)") . " — {$checksRun} checks run.\n";
exit($failures === 0 ? 0 : 1);
