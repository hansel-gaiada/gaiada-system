<?php
// webdesk/wordpress/theme/gaiada-webdesk/inc/block-renderer.php
//
// WSK-35 — the PHP-side half of the renderer invariant (webdesk-design.md §05 hard rule 2), and
// the ticket's most load-bearing correctness requirement: an unknown block type at RENDER time
// must be SKIPPED AND REPORTED, never rejected and never silently dropped without a trace. This
// is the OPPOSITE of composition/authoring time (WSK-14's `validateCollectionComposition`, which
// genuinely REJECTS an out-of-vocabulary block type before it is ever saved) — getting these two
// moments backwards is documented in WSK-18's own report as "the easiest mistake available".
//
// Mirrors `webdesk/blocks/src/renderer/resolve-blocks.ts` + `report.ts` (WSK-16, the TS renderer,
// frozen) exactly, one function per file's job:
//   - gaiada_resolve_blocks()  == resolve-blocks.ts's resolveBlocks()
//   - gaiada_report_unknown()  == report.ts's defaultUnknownBlockReport()
//   - gaiada_render_blocks()  == BlockRenderer.astro's loop
declare(strict_types=1);

namespace GaiadaWebDesk\Theme;

require_once __DIR__ . '/block-vocabulary.php';

/**
 * Splits a raw `blocks` array (an ItemEnvelope's own `blocks`, per webdesk/payload/vocabulary/
 * envelope.ts) into resolved entries — never throws, mirroring resolve-blocks.ts's own "a
 * resolution failure here is exactly the scenario the renderer invariant exists to survive"
 * comment. Preserves order and the original index (needed for an accurate report).
 *
 * @param array<int,array<string,mixed>> $blocks
 * @return array<int,array{index:int,type:string,props:array<string,mixed>,known:bool}>
 */
function gaiada_resolve_blocks(array $blocks): array
{
    $known = gaiada_known_block_types();
    $resolved = [];
    foreach (array_values($blocks) as $index => $block) {
        $type = is_string($block['type'] ?? null) ? $block['type'] : '';
        $props = is_array($block['props'] ?? null) ? $block['props'] : [];
        $resolved[] = [
            'index' => $index,
            'type' => $type,
            'props' => $props,
            'known' => in_array($type, $known, true),
        ];
    }
    return $resolved;
}

/**
 * The reporting channel — always fires for an unknown block, mirroring report.ts's
 * defaultUnknownBlockReport(): "a vocabulary-MINOR addition must reach a site pinned to an older
 * renderer as a visible gap, never a crash." Logs via error_log (the one channel every PHP host,
 * including Hostinger shared hosting, actually has) AND appends to a process-local collector a
 * host (e.g. an admin notice, a QA probe) can read back — the exact "console warning plus a
 * reporting hook a host can wire to QA" shape WSK-16's own ticket text specifies, restated for a
 * request/response runtime that has no persistent in-memory host to hold a callback across
 * requests the way a JS module singleton can.
 *
 * @param array{index:int,type:string} $entry
 */
function gaiada_report_unknown_block(array $entry, string $collection, string $slug): void
{
    $where = $collection !== '' ? " in \"{$collection}/{$slug}\"" : '';
    $message = sprintf(
        '[gaiada-webdesk] unknown block type "%s" at blocks[%d]%s — rendered nothing. ' .
        'Renderer invariant (webdesk-design.md §05 hard rule 2): a vocabulary-MINOR addition ' .
        'must reach a site pinned to an older renderer as a visible gap, never a crash.',
        $entry['type'],
        $entry['index'],
        $where,
    );
    error_log($message);

    global $gaiada_unknown_block_reports;
    if (!is_array($gaiada_unknown_block_reports)) {
        $gaiada_unknown_block_reports = [];
    }
    $gaiada_unknown_block_reports[] = [
        'type' => $entry['type'],
        'index' => $entry['index'],
        'collection' => $collection,
        'slug' => $slug,
    ];
}

/** @return array<int,array{type:string,index:int,collection:string,slug:string}> */
function gaiada_drain_unknown_block_reports(): array
{
    global $gaiada_unknown_block_reports;
    $reports = is_array($gaiada_unknown_block_reports) ? $gaiada_unknown_block_reports : [];
    $gaiada_unknown_block_reports = [];
    return $reports;
}

/**
 * Renders every KNOWN block in order and calls `gaiada_report_unknown_block()` (never a render
 * call) for every UNKNOWN one — the renderer invariant, proven by this exact function in this
 * ticket's own render-time probe (see test/render-invariant-probe.php): known blocks before and
 * after an unknown one both still render; the unknown one contributes zero output bytes.
 *
 * @param array<int,array<string,mixed>> $blocks
 */
function gaiada_render_blocks(array $blocks, string $collection = '', string $slug = ''): string
{
    $html = '';
    foreach (gaiada_resolve_blocks($blocks) as $resolved) {
        if (!$resolved['known']) {
            gaiada_report_unknown_block($resolved, $collection, $slug);
            continue; // skip — never render, never throw, never abort the rest of the array.
        }
        $html .= gaiada_render_known_block($resolved['type'], $resolved['props']);
    }
    return $html;
}

/** Dispatches to one render function per known block type (inc/block-templates/*.php). A type
 *  that passed gaiada_known_block_types() but has no template function is a THEME bug (vocabulary
 *  and templates out of sync within this repo, not a render-time contract violation) — it throws,
 *  deliberately, so that gap is loud in dev rather than silently rendering nothing like a real
 *  unknown block would (those are two different failure classes and must not look the same).
 *
 * @param array<string,mixed> $props
 */
function gaiada_render_known_block(string $type, array $props): string
{
    // Fully-qualified, deliberately: `function_exists()`/`call_user_func()` resolve a BARE string
    // name against the GLOBAL namespace, never the caller's current namespace (PHP's own
    // documented behaviour for dynamic name resolution) — `__NAMESPACE__` here is
    // "GaiadaWebDesk\Theme", matching where block-templates.php actually declares these
    // functions. Confirmed the hard way: the bare form silently found nothing on a real Linux run.
    $fn = __NAMESPACE__ . '\\gaiada_render_block_' . $type;
    if (!function_exists($fn)) {
        throw new \RuntimeException(
            "gaiada_render_blocks: block type \"{$type}\" is in gaiada_known_block_types() but " .
            "has no {$fn}() template function — the theme's template set is out of sync with the " .
            "vendored vocabulary. Run scripts/vendor-block-vocabulary.mjs and add the missing " .
            "template, or this is a real theme bug, not a render-time contract violation."
        );
    }
    return (string) $fn($props);
}

function gaiada_h(mixed $value): string
{
    return htmlspecialchars(is_string($value) ? $value : (string) json_encode($value), ENT_QUOTES, 'UTF-8');
}

require_once __DIR__ . '/block-templates.php';
