# `webdesk/wordpress/` — WSK-34 (PHP SDK) + WSK-35 (headless WP theme pattern)

Status: **PROTOTYPED**. The generator and renderer are DEV-VERIFIED on real Linux (see below); M6-P5a
(below) completed the theme as one canonical copy with a router, config and a settings page, proven with
php-cli only. The theme has never been deployed to a real WordPress install, and tenant zero's real site
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

`inc/block-vocabulary.php` is a vendored copy of `delivery/vocabulary/blocks.ts`'s
`BLOCK_TYPE_NAMES` — PHP cannot `import` a `.ts` file at all (not an ESM-vs-commonjs problem like
WSK-15/32 hit; there is simply no cross-language import), so vendoring-with-a-drift-check is the
only mechanism available, not a workaround. `scripts/vendor-block-vocabulary.mjs --check` is that
gate (mirrors `webdesk/blocks/scripts/vendor-vocabulary.mjs` exactly). Run for real:

```
$ node scripts/vendor-block-vocabulary.mjs --check
OK       .../inc/block-vocabulary.php matches webdesk/delivery/vocabulary/blocks.ts's BLOCK_TYPE_NAMES (10 types)
```

The 10 are the 9 generic blocks plus `fields`, the composition-typed block of vocabulary 1.1.0
(WSK-64). `fields` is KNOWN but NON-VISUAL, exactly as in `webdesk/blocks`' renderer
(`resolve-blocks.ts`'s `NON_VISUAL_BLOCK_TYPES`): `inc/block-templates.php`'s
`gaiada_render_block_fields()` returns the empty string, and it is never reported as unknown. This
theme once vendored only 9 names (a stale copy from before 1.1.0); the probe now also asserts that
every vendored name has a template function, so a re-vendor that adds a type fails there first.

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
PASS  sanity: the vendored vocabulary has all 10 known block types (...)
PASS  `fields` is a known block type in the vendored vocabulary
PASS  a `fields` block does NOT throw (a template exists for every known type)
PASS  a `fields` block is NOT reported as unknown
PASS  a `fields` block's values never reach the rendered HTML
PASS  the block AFTER a `fields` block still renders
PASS  the `fields` template returns the empty string
PASS  a blocks array holding only a `fields` block renders to the empty string
PASS  template coverage: gaiada_render_block_<type>() exists   (x10, one per known type)

ALL PASS — 29 checks run. exit code 0.
```

**A real bug found and fixed while proving this, on the FIRST Linux run** (the exact class of
finding this program's own hazard list warns about): `gaiada_render_known_block()` originally
called `function_exists('gaiada_render_block_' . $type)` with a BARE name. PHP resolves a bare
dynamic name against the GLOBAL namespace, never the caller's current namespace — since
`block-templates.php` declares its functions inside `namespace GaiadaWebDesk\Theme`, every lookup
silently found nothing and the very first (KNOWN) block in the probe threw. Fixed by qualifying
the lookup with `__NAMESPACE__`. Confirmed: this could not have been caught on Windows without
actually running PHP — `php -l` (syntax only) passed on the broken version too.

## M6-P5a — the complete theme, one canonical copy

`theme/gaiada-webdesk/` IS the theme (activate it as-is in WordPress):

| File | Role |
|---|---|
| `style.css`, `index.php`, `functions.php` | WordPress entry files. `functions.php` is thin glue: it hooks `template_redirect` at priority 0, hands the request path to `Router`, sends the status/headers and the HTML, and `exit`s — so content never falls through to WordPress posts. WordPress's own robots.txt, favicon and feeds are left alone. |
| `inc/config.php` | `Config`: reads settings (below). Pure PHP. |
| `inc/router.php` | `Router` + `ItemNotFound` / `UpstreamUnavailable`. Pure PHP; the transport is injected. |
| `inc/layout.php` | The one escaped HTML document wrapper. Pure PHP. |
| `inc/sdk-transport.php` | The production transport: adapts the generated `WebDeskClient` to the router, plus the "Test connection" call. |
| `inc/settings-page.php` | Settings -> WebDesk (read-only), loaded only in wp-admin. |
| `inc/block-*.php` | The WSK-35 renderer, unchanged. |
| `vendor/gaiada-sdk/sdk.php` | A **FIXTURE** (the WSK-18 `qa-p3-acme` tenant, from `sdk-gate/generate-fixture-php.mts --tenant acme`); its header says so. A scaffolded site vendors its own tenant's SDK over it. The fixture has no `pages` collection, so with it every default route is a 404. |

**How a request is routed.** `template_redirect` -> `Router::handle(method, path)`. Default map: `/` ->
collection `pages`, slug `home`; `/{slug}/` -> `pages`, `{slug}`. Slugs must match `[A-Za-z0-9][A-Za-z0-9._-]*`
(anything else is a 404 without a `/v1` call). With `GAIADA_WEBDESK_LOCALES=en,id`, an optional `/id/` prefix
selects the locale (any listed locale incl. the default is accepted; unprefixed = the first). The item is
fetched with the SDK's own `get<Collection>($slug, ['locale' => ...])` (no URL is built by the theme).
`GAIADA_WEBDESK_ROUTES` (JSON list of `{"pattern":"/blog/{slug}","collection":"article"}` or
`{"pattern":"/","collection":"pages","slug":"home"}`) replaces the default map; first match wins.

| Outcome | Status |
|---|---|
| blocks rendered | 200 |
| no route, item absent, or collection absent from the SDK | 404 (theme page) |
| `/v1` error, timeout, unreachable | 502 (static text; the key, upstream bodies and curl errors are never echoed; the log gets the exception class only) |
| a required setting missing or invalid | 503 "WebDesk is not configured" (names the settings, never values) |
| method other than GET/HEAD | 405 |
| a template bug while rendering | 500 |

**Configuration** is never stored in the WordPress database: `GAIADA_WEBDESK_BASE_URL`,
`GAIADA_WEBDESK_TENANT`, `GAIADA_WEBDESK_API_KEY` (required) and `GAIADA_WEBDESK_LOCALES`,
`GAIADA_WEBDESK_ROUTES` (optional) are read from `wp-config.php` constants, falling back to `getenv()`.
There are no `get_option()` fallbacks (the old key fallback is removed), and the probe asserts that no
option-API call exists in the theme. **Settings -> WebDesk** shows the base URL, tenant, locales, whether a
key is present (never the key) and a "Test connection" button (nonce + `manage_options`, one `sitemap.xml`
call, reports the status code). It registers and writes no option.

**No caching layer.** Apart from a per-request memo in `Router`, nothing is cached; CDN purge is WSK-70.

**Tests (php-cli only, no WordPress).** `test/render-invariant-probe.php` (29 checks) and
`test/router-probe.php` (64 checks: config, route matching, locale prefix, override map, 200/404/502/503/405,
secret-leak and escaping checks, with a stub transport). Run in `php:8.3-cli`:
`php -l` on every file, then `php test/render-invariant-probe.php && php test/router-probe.php`.

**One copy, drift-gated.** The ai-agents `siteKind: "wp"` template
(`ai-agents/src/code-scaffold/templates/wp-site.ts`) emits exactly this directory with the tenant's own
`sdk.php`, vendored as strings in `wp-theme-files.generated.ts` (regenerate with
`node ai-agents/scripts/sync-wp-theme.mjs`). `templates/wp-site.test.ts` reads this directory and asserts the
same file set and byte-for-byte content (CRLF-normalised), except `sdk.php`. The former
`scaffold-template/wp-site.ts` is deleted. (Before M6-P5a the template omitted `inc/` entirely, so a scaffolded
site had no renderer, and its `page.php` read the key from WordPress options.)

## The P5 gate: a real WordPress renders entirely from `/v1`

`webdesk/qa/p5-wp-gate.sh` (helpers in `webdesk/qa/p5-wp-gate/`) is the harness that proves it. **Status: written,
not yet run** (it needs a Linux Docker host; it was authored without one). Run it on the Linux gate host, never on
production and never on a loaded box (it builds the api image):

```
git -c core.autocrlf=false archive --format=tar <ref> > /tmp/src.tar     # never a Windows-checkout tar (CRLF)
bash webdesk/qa/p5-wp-gate.sh <run-id> /tmp/src.tar                      # last line: ### done <run-id> PASS|FAIL
```

One docker network per run, no host ports, everything removed by an EXIT trap (containers, anonymous volumes,
network, source volume, the built api image, the scratch build context). Logs: `~/wg-p5-<run-id>/`. What it does:

1. Starts Postgres (`init-roles.sh`), Redis and RustFS exactly as `linux-gate.sh`, plus `mysql:8.4`; builds the api
   with `docker build -f webdesk/api/Dockerfile webdesk`; runs storage-bootstrap and the migrations; starts the api.
2. Seeds a tenant (`seed.mjs`, run in the api image as the DB superuser): a `pages` collection listing the eight
   vocabulary blocks; items `home`, `about` (en + id) and `contact` (en) published; every item holds an unknown
   `pricingTable` block and a `javascript:` CTA href. Items go in as SQL fixtures, not through the control plane
   (publish there needs a WS4 approval assertion; the gate proves the READ side). One production read key is minted
   the way `ApiKeysService` does (`sha256(key + pepper)` at rest) and never printed.
3. Generates the contract live with the image's compiled generator (`generate.mjs` calls `generateTenantContract`)
   and reads `contracts/<slug>/<version>/sdk.php` back out of RustFS; it must equal what the generator built.
4. Starts `wordpress:php8.3-apache`, copies in the theme, replaces `vendor/gaiada-sdk/sdk.php` with the tenant's
   generated file, sets `GAIADA_WEBDESK_BASE_URL/TENANT/API_KEY/LOCALES` via `WORDPRESS_CONFIG_EXTRA`, then
   `wp core install`, `wp theme activate gaiada-webdesk` and pretty permalinks with `wordpress:cli`.
5. Curls the site from inside the WordPress container and asserts: `/` (200, `lang="en"`, hero heading, all eight
   known block classes), `/about/` (also beats a colliding WP page of the same slug), `/id/about/` (`lang="id"`,
   id text), the third slug, a missing slug (404 with the theme's not-found page), the unknown block (renders
   nothing, no leak, neighbours still render), the `javascript:` CTA (renders `#`), `/v1` without a key and with
   another tenant's slug (401), WordPress's own posts never served (a native post's permalink, `/?p=<id>`,
   `/hello-world/`), then the api stopped (502 with the static unavailable page) and restarted (200 again).

Pinned images: `wordpress:php8.3-apache`, `mysql:8.4` and `wordpress:cli` by multi-arch index digest, RustFS as in
`linux-gate.sh`. To bump one, read the new digest from the registry and edit the constant at the top of the script.

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
- **The theme was never activated inside a real WordPress install.** `php -l` + the php-cli probes
  prove the PHP is valid and the router/renderer behave; they do not prove WordPress's loader accepts
  the theme, that the `template_redirect` glue and the settings page work in a real wp-admin, or that
  the SDK's real HTTP path works. The P5 gate does that on the Linux server. The SDK's own request
  timeout is a fixed 10 s (generated code; not changed here), longer than a "short" timeout.
- **No live Zone B tenant.** Like every other WebDesk ticket this session (A-12: no box yet), the
  PHP SDK was generated against WSK-18's static fixtures and a fresh throwaway Postgres tenant —
  never a real, deployed `/v1` API a real HTTP client hit end-to-end. `WebDeskClient`'s `curl`
  calls were read, not exercised against a live server.
- **`scaffold.ts`'s `wp` branch** — *superseded 2026-10-11:* the branch is now wired in
  `ai-agents/src/code-scaffold/scaffold.ts` (it composes the theme from its own copy,
  `templates/wp-site.ts`, and refuses when the pinned snapshot carries no `sdkPhpSource`). The WSK-20
  section above describes the code as it was. `code.scaffold` itself still has no live caller (M6-P4b).
- **Astro↔WP HTML parity is unmeasured** — see the section above; that is WSK-36's gate.
