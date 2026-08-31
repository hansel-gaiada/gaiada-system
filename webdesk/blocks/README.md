# @gaiada/webdesk-blocks

**WSK-16 — the block-renderer library v0.** The FE half of the content contract (`webdesk-design.md`
§05): one Astro component per `/v1` vocabulary block type, plus a renderer that implements
**the renderer invariant (§05 hard rule 2)**: an unknown block type renders nothing and reports —
never throws.

Status: **PROTOTYPED** (built + verified — no repo integration point exists yet: WSK-17 is the
ticket that rebuilds gaiada.com against this package, WSK-20 is the ticket that wires it into the
scaffolder template). Do not call this `DEV-VERIFIED` at the program level until WSK-17 exercises
it against a live `/v1` response, not just fixtures.

## What this is, in one paragraph

Nine `.astro` components (`Hero`, `RichText`, `Gallery`, `Cta`, `FeatureGrid`, `Form`,
`Testimonial`, `Faq`, `LogoCloud`) — one per block type in
[`webdesk/payload/vocabulary/blocks.ts`](../payload/vocabulary/blocks.ts) — plus two renderer
components (`BlockRenderer`, `ItemRenderer`) that take a `/v1` item envelope and render its
`blocks` array in order. `BlockRenderer` is where the invariant lives: it resolves every block
against the vocabulary's own `isBlockType`, renders the known ones through their component, and
for anything it doesn't recognise, **renders nothing for that entry and calls a report hook**
(default: `console.warn`) instead of throwing. `ItemRenderer` wraps that with the two other
envelope-level behaviours WSK-16 is scoped to: it shows a draft banner when `meta.draft` is true,
and a visible notice when `meta.x.localeFallback` is present (§05/WSK-D18's locale rule — "silently
serving the wrong language is worse than an honest fallback flag").

## Why it vendors a copy of the vocabulary (read this before touching `src/vocabulary/`)

The ticket instruction is "import the block prop schemas [from `webdesk/payload/vocabulary`] — do
not restate them." That is exactly right for every other consumer shipped so far (WSK-15's codegen
imports the vocabulary with a relative path, because it runs inside this repo forever). This
package is different: constraint 3 of WSK-16 requires `npm pack` to produce a tarball a
**scaffolded site outside this repo** can install by path (OQ-6 — no registry infra). Once
installed into some other project's `node_modules`, a relative import like
`../../payload/vocabulary/blocks.ts` resolves to nothing.

So `src/vocabulary/*.ts` is a **byte-identical, mechanically-verified copy** of four files from
`webdesk/payload/vocabulary/` (`primitives.ts`, `blocks.ts`, `envelope.ts`, `version.ts`),
produced by `scripts/vendor-vocabulary.mjs`. The single source of truth stays
`webdesk/payload/vocabulary` — this script has never hand-edited a line of what it copies, and
`npm run vendor:check` (wired into `prepack` and `build`) fails loudly the moment the two drift.
See the script's own header comment for the full reasoning, and the "Needed changes / open items"
section below for the longer-term recommendation this constraint points at.

## Commands (real names — no env vars needed at all for this package)

This package is pure static Astro/TypeScript — no database, no ports, no `.env` file. Every
command below is exactly what CI or a developer would run; nothing is abbreviated.

```sh
# from webdesk/blocks/
npm install               # installs astro + @astrojs/check + typescript (devDependencies only)
npm run vendor:vocabulary # (re)copies webdesk/payload/vocabulary/{primitives,blocks,envelope,version}.ts
npm run vendor:check      # fails (exit 1) if the vendored copies have drifted — CI gate
npm run test:unit         # node --test test/unit/*.test.mjs — 26 assertions, no Astro build needed
npm run typecheck         # astro check — typechecks every .astro/.ts file, 0 errors expected
npm run build             # vendor:check && test:unit && typecheck, in that order
npm pack                  # produces gaiada-webdesk-blocks-0.1.0.tgz — the installable artifact
```

`test:unit` requires no Astro build step because `src/renderer/resolve-blocks.ts` (the renderer
invariant's decision logic) is deliberately plain TypeScript with zero Astro dependency — it is
`node --test`-able directly. Node's native TypeScript type-stripping (stable by default since
Node ~22.18/23.6, confirmed here on both v24.18.0 and v22.23.2) is what lets `.ts` files run
without `tsx` or a build step; if an older Node is ever the target, prefix with
`node --import tsx` (already a devDependency one level up in `webdesk/api` and `webdesk/payload`,
not pulled in here to keep this package's own dependency list minimal — add it if needed).

## The tarball-install proof (`demo/`)

`demo/` is a throwaway Astro app, **excluded from the published package** (`package.json`'s
`"files"` list only ships `src` + this README), that exists solely to prove constraint 3 — "a
scaffolded site can install [the tarball] by path" — for real, not by assertion:

```sh
npm run build && npm pack                       # from webdesk/blocks/
cd demo && npm install                           # demo/package.json depends on
                                                   #   "@gaiada/webdesk-blocks": "file:../gaiada-webdesk-blocks-0.1.0.tgz"
npx astro build                                   # builds 3 real static pages against the INSTALLED tarball
```

`demo/src/pages/full.astro` imports `ItemRenderer` from `@gaiada/webdesk-blocks` (resolved through
`node_modules`, never a relative path into the sibling package source) and renders a full 9-block
fixture. `demo/src/pages/unknown.astro` and `unknown-default-hook.astro` render a fixture with a
`pricingTable` block — a type from a hypothetical future vocabulary MINOR — sandwiched between two
known blocks, proving the invariant two ways: a custom `onUnknownBlock` hook that persists a JSON
QA report, and the package's own default `console.warn` channel with no hook supplied at all.

### What was actually observed (this ticket's real run, not a description of intent)

**`full.astro`'s built HTML** contains exactly the 9 `data-block-type="…"` markers, in vocabulary
order: `hero`, `richText`, `gallery`, `cta`, `featureGrid`, `form`, `testimonial`, `faq`,
`logoCloud`.

**`unknown.astro` / `unknown-default-hook.astro`'s built HTML** contains exactly 2 markers
(`hero`, `richText`) — the string `pricingTable` appears **zero times** anywhere in the rendered
output. The custom-hook page wrote:

```json
[{ "type": "pricingTable", "index": 1, "collection": "article", "slug": "pricing-2027" }]
```

to `demo/qa-reports/unknown-block-reports.json`. The default-hook page's build log printed (verbatim):

```
[@gaiada/webdesk-blocks] unknown block type "pricingTable" at blocks[1] in "article/pricing-2027" — rendered nothing. This is the renderer invariant (webdesk-design.md §05 hard rule 2): a vocabulary-MINOR addition must reach a site pinned to an older renderer as a visible gap, never a crash. {
  type: 'pricingTable', index: 1, collection: 'article', slug: 'pricing-2027'
}
```

Both pages also carry `data-webdesk-draft="true"` and `data-webdesk-locale-fallback="true"` markers
(the fixture sets `meta.draft: true` and a `meta.x.localeFallback`) — `ItemRenderer`'s other two
scoped behaviours, confirmed in the same build.

**The whole chain above was run twice: once on Windows (dev iteration) and once for real inside a
Linux container** (`node:22-bookworm-slim`, kernel `6.18.33.2-microsoft-standard-WSL2`), per the
owner's 2026-08-26 rule that verification never counts from the local Windows box. `docker cp` was
used to move the package into the container rather than a `-v` bind mount, to sidestep the known
Git-Bash path-mangling trap on Windows (`docs/...gitbash-docker-path-mangling.md`) — a first attempt
using bare POSIX paths in `docker run`/`docker exec` arguments reproduced exactly that trap (`/work`
silently became `C:` inside the container) until every invocation was prefixed with
`MSYS_NO_PATHCONV=1`. On Linux: `vendor:check` OK (4/4), `test:unit` 26/26, `astro check` 0
errors/0 warnings/0 hints, `npm pack` produced the same 23-file/14.6kB tarball shape, and the demo
build against that tarball reproduced byte-identical `data-block-type` markers, the same "0 matches
for pricingTable", the same QA report JSON, and the same console.warn line as the Windows run.

## The renderer invariant — how it actually holds together

- `src/renderer/resolve-blocks.ts` — pure logic, no Astro. `resolveBlocks()` walks a raw `blocks`
  array and tags each entry `known: true|false` using the vendored vocabulary's own `isBlockType`
  (the same function `webdesk/payload/vocabulary/blocks.ts`'s `validateBlock` uses server-side —
  this renderer's notion of "known" can never diverge from the vocabulary's). Never throws, even
  on a non-string `type` or a missing `props` — proven in `test/unit/resolve-blocks.test.mjs`.
- `src/renderer/report.ts` — the report hook's shape (`UnknownBlockReportHook`) and its default
  implementation (a `console.warn` naming the vocabulary hard rule it exists for).
- `src/renderer/BlockRenderer.astro` — resolves every block, reports every unknown one (before
  rendering anything, so a host that wants to fail a build on the first report sees the whole
  picture, not one-at-a-time), then renders known blocks through a `Record<BlockType, Component>`
  map that TypeScript enforces is exhaustive — adding a 10th vocabulary block type without adding
  it here is a compile error here, not a silent runtime gap.
- `src/renderer/ItemRenderer.astro` — the top-level export a site actually imports; wraps
  `BlockRenderer` with the draft banner and locale-fallback notice.

## Props typed from the vocabulary — what "typed from" actually means here

TypeScript cannot reflect the vocabulary's runtime `BLOCKS: Record<BlockType, BlockDef>` (whose
`fields` arrays are plain data, not `as const` literal tuples) into compile-time interfaces
automatically — that would be a code-generation step this ticket does not own (it is closer to
WSK-15's job). So `src/types.ts` hand-declares one `Props` interface per block type, each a 1:1
transcription of `BLOCKS[type].fields` (same field names, same required-ness, same multiplicity),
and `test/unit/props-coherence.test.mjs` makes that a **mechanically checked** claim rather than an
assertion in a comment:

1. **Structural diff** — `EXPECTED_FIELDS` (a plain-data mirror of the Props interfaces) is
   compared field-by-field against the live `BLOCKS[type].fields` from the vendored vocabulary.
   Any drift fails the test.
2. **Runtime round-trip** — for every block type, a minimal valid props object is generated
   *purely from the vocabulary's own primitive definitions* (never from `src/types.ts`) and passed
   through the vocabulary's own `validateBlock()`. This proves the values these types describe are
   genuinely accepted by the vocabulary's real validator, not merely similarly named.

### A real vocabulary gap this round-trip test found (reported, not fixed here)

`webdesk/payload/vocabulary/primitives.ts`'s `validate()` for the `media` primitive never consults
`field.multiple` — unlike `relation`, whose validator branches on `field?.multiple` and validates
each array item. A field declared `{ primitive: 'media', multiple: true }` — `gallery.items` and
`logoCloud.logos`, both genuinely declared that way in `blocks.ts` — can therefore never pass
`validateBlock`: an array fails `isPlainObject(v)` outright ("expected a media object"). The
block's declared *shape* (an array of media) is unambiguous from `blocks.ts` itself; only the
runtime validator disagrees with its own declaration. `Gallery.astro` / `LogoCloud.astro` and their
`GalleryProps.items: MediaValue[]` / `LogoCloudProps.logos: MediaValue[]` types are still built to
the *declared* (array) shape, since that is what the vocabulary actually specifies — the test suite
documents the gap as a named regression guard (`KNOWN_MULTIPLE_MEDIA_VALIDATION_GAP` in
`test/unit/props-coherence.test.mjs`) rather than silently working around it, so it starts failing
(and says exactly what to do) the moment `webdesk/payload/vocabulary` fixes it upstream.
**This file cannot be edited from this ticket (`webdesk/payload/**` is out of scope) — reported to
the coordinator for the vocabulary-owning ticket to pick up.**

## §05 items that could not be built exactly as specified

- **RichText's Lexical case is not serialized to HTML in v0.** §05 says `richtext` "round-trips
  through the envelope as structured content" but does not mandate an HTML serialization strategy.
  `RichText.astro` renders a plain-string `content` value directly (the common case any hand-typed
  or AI-drafted copy will produce) but, for the `{ root: ... }` Lexical-document case, emits the
  raw JSON inertly (`<script type="application/json">`) rather than walking Lexical's node tree
  into HTML — a real Lexical-to-HTML serializer is a separable, non-trivial piece of work (Payload
  ships one for its own admin preview; reusing or reimplementing it is a bigger scope than "one
  component per block type"). Flagged, not silently shipped as if it round-trips.
- **`Form.astro` does not fetch or render `form_defs.schema`.** It renders the block's identity
  (`data-form-key`) and a slot a host can fill with real fields from its own SDK call. A static
  component library has no business making a live data call on the vocabulary's behalf, and
  `form_defs.schema` is WSK-10's live data, not something a fixture-driven renderer package should
  invent a shape for.
- **`FeatureGrid.astro` / `Faq.astro` render relation pointers, not resolved content.** The
  vocabulary's `relation` primitive resolves to `{ collection, slug }` (envelope.ts's own
  documented shape) — there is no "resolved feature object" in the frozen envelope for these two
  blocks to receive. A host resolving those relations through its own data layer is the only
  option the frozen contract allows; inventing an unfrozen resolved shape here would be scope
  creep past what §05 actually freezes.

## Needed changes / open items for the coordinator (not done here — out of `webdesk/blocks/**`)

1. **The `media`+`multiple` validation gap** in `webdesk/payload/vocabulary/primitives.ts`
   (above) — belongs to whichever ticket owns `webdesk/payload/vocabulary/**` next.
2. **Longer term, `payload/vocabulary` becoming its own publishable package** (rather than each
   downstream consumer inventing its own answer to "how do I reach code across a package boundary
   that may or may not survive an install") would remove the need for `scripts/vendor-vocabulary.mjs`
   entirely and let this package (and WSK-34's future PHP SDK) depend on it formally. That is a
   cross-cutting architecture call outside this ticket's `webdesk/blocks/**` scope — recommended,
   not decided here.
3. **No integration point exists yet.** Nothing in this repo imports `@gaiada/webdesk-blocks` —
   WSK-17 (rebuild gaiada.com from the generated SDK + this library) and WSK-20 (the scaffolder
   template) are the tickets that make that true. Until then this package is correct and verified
   in isolation, not proven against a live site.

## Versioning

Package version `0.1.0` — pre-1.0 while WSK-17 has not yet exercised it against a real site.
`webdesk-design.md` §05's "Block-renderer library semver" axis is already encoded, machine-checked,
as `classifyRendererChange()` in the vendored `src/vocabulary/version.ts`'s sibling
`breaking-change.ts` — not vendored here (renderer-axis classification is a WSK-14/19 concern about
*this* library's own version number, not something the render components themselves need at
runtime); see `webdesk/payload/vocabulary/breaking-change.ts` for the real one this package's own
future version bumps should be checked against by hand until a ticket wires that check up
mechanically.
