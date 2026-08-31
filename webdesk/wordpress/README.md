# `webdesk/wordpress/` — WSK-34 (PHP SDK) + WSK-35 (headless WP theme pattern)

Status: **PROTOTYPED**. The generator and renderer are DEV-VERIFIED on real Linux (see below); the
theme has never been deployed to a real WordPress install, and tenant zero's real site
(`gaiada.com`, Hostinger shared hosting) was **not touched** — see "Honest limits" at the bottom.

## WSK-34 — the PHP SDK is GENERATED, not written

`webdesk/api/src/codegen/generator/sdk-php.mts` (NEW file) derives `sdk.php` from the SAME
already-built OpenAPI document `sdk-ts.mts` derives the TS SDK from — same input, same
determinism contract, same "no timestamp in the hashed bytes" rule every other artifact in that
directory follows. It is a pure string-templating function (no new npm dependency — none exists
in `webdesk/api/package.json` today and the brief forbids adding one without a spec decision) over
`openApiDocument.paths` + the `x-webdesk-contract` extension. It reads nothing the OpenAPI
document does not already contain, so it cannot drift from what `openapi-builder.mts` describes.

**Regeneration is authoritative, not editable:** the emitted file's own header says
`GENERATED — DO NOT HAND-EDIT` and explains why (a hand-edit does not survive the next
`codegen:run`). There is no separate PHP source someone could edit instead — the ONLY input is
`openApiDocument`, exactly like every sibling artifact.

### Additive edits made under `webdesk/api/src/codegen/` (shared, contract-critical directory)

Per this ticket's brief ("you may add a PHP generator only if you keep every edit additive and say
so explicitly") — every edit below adds a field/case/line; nothing existing was removed or
renamed:

| File | Edit |
|---|---|
| `generator/sdk-php.mts` | **NEW file** — the generator itself |
| `generator/build-artifacts.mts` | added `sdkPhp` to `BuiltArtifacts`, computed alongside `sdkTs`, hashed into `ArtifactHashManifest` |
| `contract-manifest.types.ts` | added `sdkPhp` to `ArtifactHashManifest`/`ArtifactObjectKeys`; `ContractReadResponse.artifacts.sdkPhpUrl` type widened from the literal `null` to `string \| null` (still `null` for any pointer written before this ticket — an old `latest.json` object has no `artifactKeys.sdkPhp` key at all) |
| `artifact-keys.ts` | added `"sdkPhp"` to `ArtifactName` + `sdk.php` filename |
| `generator/generate-single.mts` | writes `sdk.php` alongside the other 4 files |
| `generator/double-run-gate.mts` | added `"sdk.php"` to `ARTIFACT_FILES` — WSK-15's OWN CI gate now byte-compares it too, so this ticket needed no second gate for the shared-DB path |
| `generator/storage-io.mts` | uploads `sdk.php` to MinIO under the same `<contractVersion>/` immutable prefix (`application/x-httpd-php`) |
| `contract-read.service.ts` | presigns `sdkPhpUrl` when the pointer has an `sdkPhp` key; falls back to `null` (never a broken URL) for an old pointer |
| `test/codegen-contract-controller.spec.ts`, `test/codegen-storage-and-contract-read.spec.ts` | the two `expect(...sdkPhpUrl).toBeNull()` assertions (correct pre-WSK-34 — WSK-D11's documented placeholder) now assert the real URL, since a freshly-generated tenant genuinely has one now |

Every other file in that directory (`fetch-composition.mts`, `openapi-builder.mts`,
`content-contract-md.mts`, `sdk-ts.mts`, `versioning.mts`, `run-codegen.mts`,
`cjs-interop.mts`, `canonical-json.mts`, `vocabulary-field-schema.mts`) is **untouched**.

### Determinism — byte-identical across two SEPARATELY SPAWNED processes, real run

`sdk-gate/generate-fixture-php.mts` + `sdk-gate/double-run-gate.mts` (this directory) are the
WSK-34-owned, DB-free equivalents of WSK-15's `generate-single.mts`/`double-run-gate.mts` and
WSK-18's `qa/p3-gate/generate-fixture-artifacts.mts` — same methodology (spawn as two independent
`node` child processes, `Buffer.compare` the output), narrowed to `sdk.php` alone, reusing
`buildContractArtifacts` and WSK-18's own static tenant fixtures UNCHANGED (read-only import —
this ticket touches neither `qa/p3-gate/**` nor `webdesk/api/test/p5-gate/**`).

Real run, Linux (`node:22-bookworm-slim`, `webdesk/api`'s own pinned `node_modules` — never a
Windows-built copy):

```
-- acme: run 1 (fresh process) --
wrote sdk.php (6269 bytes) to .../acme/run1 — sdkPhp hash 6faf735b458f3a7cbc02a05036168b2d9fcb1e37c1d2c1e24e4bfe91fc5964ad
-- acme: run 2 (fresh process) --
wrote sdk.php (6269 bytes) to .../acme/run2 — sdkPhp hash 6faf735b458f3a7cbc02a05036168b2d9fcb1e37c1d2c1e24e4bfe91fc5964ad
-- acme: sdk.php byte-identical across both runs (6277 bytes) --
-- globex: run 1 (fresh process) --
wrote sdk.php (5518 bytes) to .../globex/run1 — sdkPhp hash 999828510738d80eb496d40df0a5ddd0bd2103b554356e7a6cb69e58bffac341
-- globex: run 2 (fresh process) --
wrote sdk.php (5518 bytes) to .../globex/run2 — sdkPhp hash 999828510738d80eb496d40df0a5ddd0bd2103b554356e7a6cb69e58bffac341
-- globex: sdk.php byte-identical across both runs (5526 bytes) --
PHP SDK DETERMINISM GATE PASSED — 2 tenant(s), byte-identical across two separately spawned processes.
```

(The 6269→6277-byte difference between the CLI's own `.length`-based log line and the file's real
size is UTF-8 multi-byte em-dash characters in the generated comments — `String.prototype.length`
counts UTF-16 code units, `writeFileSync(..., "utf8")` counts bytes on disk. Cosmetic; the
determinism proof itself is `Buffer.compare` on the actual file bytes, unaffected.)

Additionally, WSK-15's OWN shared gate (`webdesk/api/src/codegen/generator/double-run-gate.mts`,
now including `sdk.php` in its `ARTIFACT_FILES`) was exercised against a REAL Postgres-backed
tenant via its own test (`test/codegen-double-run-gate.spec.ts`, unedited except for its
target list, real DB): **PASSED**, meaning the live-DB path also byte-compares `sdk.php`, not just
this ticket's own fixture-based gate.

`php -l` (PHP 8.3-cli and 8.2-cli, both real Linux containers) confirms every generated/hand-written
PHP file is syntactically valid — including the actual generated `sdk.php` this run produced.

### webdesk/api test suite — real Linux, real Postgres + MinIO

```
APP_DATABASE_URL / STORAGE_* set (see webdesk/api/README.md's WSK-15 runbook — same var names, no
shadow prefix) against a fresh Postgres 16 + MinIO on node:22-bookworm-slim:

npx tsc -p tsconfig.json --noEmit         -> 0 errors
npx vitest run test/codegen-*.spec.ts     -> 8 files, 46/46 passed
  including the two edited assertions (sdkPhpUrl now non-null for a fresh generation) and the
  live-DB double-run-gate spec (3/3, including its own negative control).
```

## WSK-35 — the render-time unknown-block proof (PHP side), by observation

`theme/gaiada-webdesk/inc/block-renderer.php` mirrors `webdesk/blocks/src/renderer/{resolve-blocks,report}.ts`
(WSK-16, frozen) function-for-function: `gaiada_resolve_blocks()` classifies every block against
the vendored vocabulary, never throwing; `gaiada_render_blocks()` renders every KNOWN block and
calls `gaiada_report_unknown_block()` (error_log + a drainable in-request collector) for every
UNKNOWN one, then keeps going. This is the render-time half of design §05 hard rule 2 — the
**opposite** of composition/authoring time (WSK-14's `validateCollectionComposition`, which
genuinely REJECTS an out-of-vocabulary block before it is ever saved). Getting these two moments
backwards is documented in WSK-18's own report as "the easiest mistake available" — this file does
NOT reject; it skips and reports.

### The vendored vocabulary (a second instance of WSK-16's own hazard, PHP-side)

`inc/block-vocabulary.php` is a vendored copy of `payload/vocabulary/blocks.ts`'s
`BLOCK_TYPE_NAMES` — PHP cannot `import` a `.ts` file at all (not an ESM-vs-commonjs problem like
WSK-15/32 hit; there is simply no cross-language import), so vendoring-with-a-drift-check is the
only mechanism available, not a workaround. `scripts/vendor-block-vocabulary.mjs --check` is that
gate (mirrors `webdesk/blocks/scripts/vendor-vocabulary.mjs` exactly). Run for real:

```
$ node scripts/vendor-block-vocabulary.mjs --check
OK       .../inc/block-vocabulary.php matches webdesk/payload/vocabulary/blocks.ts's BLOCK_TYPE_NAMES (9 types)
```

(Confirmed the check can also FAIL: ran it once with the destination file deleted — it exited 1
and printed `DRIFT`, before this session regenerated it. Also ran `webdesk/blocks`'s own
`vendor:check` afterward as a sanity check that this ticket's work did not disturb the OTHER
vendored copy — still `OK`, 4/4.)

### The render-time probe — REAL output, on real Linux, `php:8.3-cli`

`test/render-invariant-probe.php` feeds `gaiada_render_blocks()` a real block array — `hero`,
then `pricingTable` (NOT in the vocabulary), then `richText` — and asserts on the actual rendered
HTML string and the actual captured report, not on internal state:

```
[gaiada-webdesk] unknown block type "pricingTable" at blocks[1] in "article/welcome" — rendered
nothing. Renderer invariant (webdesk-design.md §05 hard rule 2): a vocabulary-MINOR addition must
reach a site pinned to an older renderer as a visible gap, never a crash.

--- rendered HTML ---
<section class="gaiada-block gaiada-block-hero"><h1>Welcome to Acme</h1><p>A distinctive seeded
string: WSK35-HERO-MARKER</p></section><div class="gaiada-block gaiada-block-richtext"><p>A
distinctive seeded string: WSK35-RICHTEXT-MARKER</p></div>
--- end HTML ---

--- unknown-block reports: [{"type":"pricingTable","index":1,"collection":"article","slug":"welcome"}] ---

PASS  known block BEFORE the unknown one still renders (hero)
PASS  known block AFTER the unknown one still renders (richText)
PASS  the unknown block type name appears ZERO times in the rendered HTML
PASS  the unknown block's PROPS never leak into the rendered HTML either
PASS  exactly one unknown-block report was captured (not zero, not swallowed silently)
PASS  the report names the exact unknown type, verbatim
PASS  the report carries the correct index in the original blocks array (1, not renumbered post-skip)
PASS  the report carries which collection/slug it happened in
PASS  positive control: an all-known blocks array produces ZERO unknown-block reports
PASS  positive control: both known blocks actually rendered
PASS  NEGATIVE CONTROL: with the vocabulary list forced empty, a normally-known type ("hero") IS
      classified unknown — proves the known/unknown branch is a real vocabulary lookup, not a
      hardcoded true
PASS  sanity: the vendored vocabulary still has all 9 known block types

ALL PASS — 12 checks run. exit code 0.
```

**A real bug found and fixed while proving this, on the FIRST Linux run** (the exact class of
finding this program's own hazard list warns about): `gaiada_render_known_block()` originally
called `function_exists('gaiada_render_block_' . $type)` with a BARE name. PHP resolves a bare
dynamic name against the GLOBAL namespace, never the caller's current namespace — since
`block-templates.php` declares its functions inside `namespace GaiadaWebDesk\Theme`, every lookup
silently found nothing and the very first (KNOWN) block in the probe threw. Fixed by qualifying
the lookup with `__NAMESPACE__`. Confirmed: this could not have been caught on Windows without
actually running PHP — `php -l` (syntax only) passed on the broken version too.

## How the theme consumes the SDK

`theme/gaiada-webdesk/functions.php` does `require_once __DIR__ . '/vendor/gaiada-sdk/sdk.php'`
and constructs one `GaiadaWebDesk\Sdk\WebDeskClient` from WordPress options /
`wp-config.php` constants (`GAIADA_WEBDESK_BASE_URL` / `GAIADA_WEBDESK_API_KEY` — never a value
baked into a generated file). `page.php` — the theme's only page template, since every page IS a
WebDesk item, not WP post content — resolves an item via the client and hands its `blocks` array
to `gaiada_render_blocks()`. `vendor/gaiada-sdk/sdk.php` is the exact generated bytes from WSK-34's
pipeline, vendored as a **plain file drop**, never a Composer dependency — see "Hostinger reality"
below for why.

## How `siteKind: "wp"` joins WSK-20 — without modifying `ai-agents/`

`ai-agents/src/code-scaffold/scaffold.ts` (read, not modified) **currently, deliberately, refuses**
`siteKind: "wp"` outright:

```
// scaffold.ts, lines ~33-36:
if (envelope.siteKind === "wp") {
  return rejectedResult("siteKind \"wp\" is out of scope for code.scaffold v2 (webdev-design.md
    §06: WP is P6/WSK-35, headless-WordPress via the PHP SDK — not this ticket). Refused before
    any file was composed.");
}
```

That refusal is WSK-20's correct, documented scoping and is left completely untouched, per this
ticket's brief. `scaffold-template/wp-site.ts` (this directory) is the template WSK-20 would call
INSTEAD of refusing, once a follow-up ticket replaces that branch with a dispatch to it — same
`GeneratedFile { path, content }` contract as `templates/{astro-site,node-site,common}.ts`, same
"every value here is a STRING the scaffolder composes; nothing is ever executed by this process"
invariant (WSK-D6). It cannot literally `import` from `ai-agents` (separate standalone projects,
per the repo root `CLAUDE.md`: "no monorepo, no shared package layer") — `GeneratedFile` is
restated as a structurally identical local type, not re-exported. `wpSiteFiles(args)` composes
`style.css` (WordPress's own theme-discovery file), the vendored `sdk.php`, `functions.php`,
`page.php`, and a `README.md`, mirroring `templates/common.ts`'s `readme()`/`envExample()` idiom
for the astro/node kinds exactly.

**Not done, honestly:** actually wiring `scaffold.ts`'s `wp` branch to call `wpSiteFiles()`. That
is a one-branch edit to a file this ticket was explicitly told not to modify
("`ai-agents/`, already ✅ — read what it does, do not modify it") — flagged as the follow-up, not
silently left implied.

### The whole assembled theme, materialized and syntax-checked together

`scaffold-template/wp-site.ts`'s `wpSiteFiles()` was actually run once (scratch script, not
shipped) against a real `built.sdkPhp` from the fixture pipeline, writing `style.css`,
`vendor/gaiada-sdk/sdk.php`, `functions.php`, `page.php`, `README.md` to disk, alongside a copy of
`theme/gaiada-webdesk/inc/*.php`. `php -l` on the whole assembled directory, real
`php:8.3-cli` container:

```
No syntax errors detected in /theme/functions.php
No syntax errors detected in /theme/inc/block-renderer.php
No syntax errors detected in /theme/inc/block-templates.php
No syntax errors detected in /theme/inc/block-vocabulary.php
No syntax errors detected in /theme/page.php
No syntax errors detected in /theme/vendor/gaiada-sdk/sdk.php
```

This is a syntax/composition proof, not a WordPress-runtime proof — see "Honest limits" for what
it does not claim.

## Astro↔WP parity — what this ticket can and cannot claim

WSK-36 (not this ticket) owns proving the two renderers agree. What this ticket CAN say: both
renderers now implement the identical decision function (known → render via a 1:1-named template
function; unknown → skip AND report, never throw, never silently drop) against the SAME 9-name
vocabulary, and neither renderer invents its own notion of "known." What it CANNOT say: the two
renderers' actual HTML output byte-for-byte matches (the PHP templates in
`inc/block-templates.php` are deliberately simple markup, not a pixel port of
`webdesk/blocks/src/components/*.astro` — visual parity is design-system work outside this
ticket's scope, and WSK-36's job to define precisely what "parity" means before grading it).

## Honest limits

- **Tenant zero's real site was never touched.** `gaiada.com` is WordPress on Hostinger shared
  hosting; this session had no credential and no reachability to it, and per
  `infra/runbooks/onboard-server.md` there is no shell-access model even if it had one. Nothing
  here was deployed anywhere real — every proof above ran in throwaway Docker containers.
- **The theme was never activated inside a real WordPress install.** `php -l` + the direct
  function-level probe prove the PHP is valid and the renderer invariant holds; they do not prove
  WordPress's own loader accepts this theme, that `get_query_var`/rewrite-rule wiring for
  `gaiada_collection`/`gaiada_slug` actually routes real URLs (that wiring is a real
  theme-authoring task this ticket did not build — flagged in `page.php`'s own comment, not
  hidden), or that the admin settings UI for the base URL/API key exists (it does not — only the
  `wp-config.php` constant fallback was built).
- **No live Zone B tenant.** Like every other WebDesk ticket this session (A-12: no box yet), the
  PHP SDK was generated against WSK-18's static fixtures and a fresh throwaway Postgres tenant —
  never a real, deployed `/v1` API a real HTTP client hit end-to-end. `WebDeskClient`'s `curl`
  calls were read, not exercised against a live server.
- **`scaffold.ts`'s `wp` branch is not wired** — see the WSK-20 section above.
- **Astro↔WP HTML parity is unmeasured** — see the section above; that is WSK-36's gate.
