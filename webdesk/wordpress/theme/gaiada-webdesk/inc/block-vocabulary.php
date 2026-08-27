<?php
// VENDORED — copied from webdesk/payload/vocabulary/blocks.ts's BLOCK_TYPE_NAMES (WSK-06/
// WSK-14, frozen per webdesk-design.md §05). DO NOT HAND-EDIT.
//
// PHP cannot import a TypeScript module, so this is a vendored copy of the NAME LIST only
// (never a restatement of validation rules — those stay TS-side, WSK-06/14's job) — same
// vendor-with-a-drift-check pattern webdesk/blocks (WSK-16) already established for its own
// language-boundary problem. Regenerate with `node scripts/vendor-block-vocabulary.mjs` from
// webdesk/wordpress/. Check for drift with `node scripts/vendor-block-vocabulary.mjs --check`.
declare(strict_types=1);

namespace GaiadaWebDesk\Theme;

/** @return string[] */
function gaiada_known_block_types(): array
{
    return [
    'hero',
    'richText',
    'gallery',
    'cta',
    'featureGrid',
    'form',
    'testimonial',
    'faq',
    'logoCloud',
    ];
}
