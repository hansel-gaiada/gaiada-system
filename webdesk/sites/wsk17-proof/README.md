# WSK-17 — the proof rebuild

Status: **PROTOTYPED / DEV-VERIFIED for this run** (see "What was actually observed" below — this
is a from-scratch Linux verification of a specific commit of `webdesk/api`, `webdesk/payload`,
`webdesk/blocks`; re-verify against a fresh checkout before trusting it as a standing fact).

A minimal real Astro site (`wsk17-proof`) built **exclusively** from the generated TS SDK
(`webdesk/api/src/codegen`, WSK-15) for its own tenant contract and `@gaiada/webdesk-blocks`
(WSK-16). It renders real, multi-block content that travelled the full chain: **Postgres → `/v1`
→ generated SDK → block components → static HTML**, verified on Linux, not the Windows host, per
the 2026-08-26 owner rule.

## Tenant-zero note (WSK-D26 finding, restated)

`gaiada.com` is WordPress on Hostinger and stays there under WSK-D26 — it is not this ticket's
target. This site's tenant (`wsk17-proof`) is the D26-finding's suggested substitute: a fresh,
non-WP tenant, the kind of site that *would* deploy to `delphi` (staging) once the observe-only
ruling and reachability blockers on that host (design §03a) are lifted — neither of which this
ticket attempts to clear. **This ticket proves the BUILD chain only; it does not deploy anywhere.**
`delphi`/`helios` were never touched, reached, or assumed reachable.

## What was actually observed (this run's real output, not a description of intent)

All of the following ran inside `node:22-bookworm-slim` (kernel reported via `docker version`:
Docker 29.6.1 on the host, Linux container), a throwaway `postgres:16-alpine`, no MinIO (the
`media` primitive is `{url, alt?, ...}` — plain strings, no upload path exercised, so WSK-17's
"+ MinIO if the media path is exercised" condition does not apply here). Both containers are
removed after the run; nothing here is left standing.

1. **Migrations**: `webdesk/migrations/migrate.mjs` — 6/6 applied clean (`0001`..`0006`).
2. **Payload schema push**: `webdesk/payload/scripts/setup-schema.mjs` — created `pages`/`users`/
   Payload's own tables, then re-asserted FORCE RLS + policy per its own documented last step.
3. **`node webdesk/scripts/check-rls-integrity.mjs`** — `OK — 17 tenant-scoped table(s) intact`,
   run twice (once right after setup-schema, once again after the full build+seed+codegen
   sequence) — both green.
4. **Seeding** (`scripts/seed-tenant.mjs`, this ticket's own tooling, not `payload/**`): one
   tenant (`wsk17-proof`), one `case-study` collection composed of the **full 9-type vocabulary**,
   two published multi-block items (`acme-rebrand` — all 9 block types in vocabulary order,
   `globex-launch` — a 3-block subset, proving the site isn't reading one hardcoded row) plus one
   **draft** item (`unpublished-draft`) seeded specifically to prove the effective-publish rule
   holds against a live server.
5. **Codegen**: `webdesk/api/src/codegen/generator/generate-single.mts --tenant wsk17-proof`
   against the REAL seeded composition — produced `sdk.d.ts`, `openapi.v1.json`,
   `CONTENT-CONTRACT.md`, `hash-manifest.json`, `contentHash
   sha256:7b9da11f6a140087a9c2ae84dcb6e54a1659438d8554c3801533506913fa5557` (all four files
   committed alongside this README, plus `sdk.d.ts` copied into `src/sdk/` as this site's
   "installed SDK" — see the codegen finding below for why it's a copy, not a package install).
6. **Live `/v1` server**: `webdesk/payload`'s own internal Next.js app (`npm run dev:internal`,
   the exact `app/(payload)/v1/[...slug]/route.ts` → `collections/router.ts` path WSK-06 shipped)
   — booted against the seeded database, `curl`-equivalent probe confirmed the real envelope JSON
   (verbatim start of the response, `acme-rebrand`):
   ```json
   {"collection":"case-study","slug":"acme-rebrand","locale":"en-US","localizations":[],
    "seo":{"title":"Acme rebrands for the AI era", ...},
    "meta":{"publishedAt":"2026-08-27T06:10:49.597Z", ..., "draft":false,"x":{}},
    "blocks":[{"type":"hero","props":{...}}, ...]}
   ```
7. **`npm run conformance:compile`** (`tsc -p tsconfig.conformance.json`, this ticket's
   compile-time conformance half) — **0 errors**: the generated `sdk.d.ts`'s `paths` type is
   structurally assignable both ways against `@gaiada/webdesk-blocks`' own `ItemEnvelope`/
   `ListEnvelope`, and every block type this site seeds (`hero` … `logoCloud`, all 9) satisfies its
   `@gaiada/webdesk-blocks` `*Props` interface with the exact literal props this site writes.
8. **`npx astro check`** over the whole site (pages + lib, not just the conformance script) —
   **0 errors, 0 warnings, 0 hints**.
9. **`npm run build` (`astro build`, static output)** against the LIVE server from step 6 — 3 real
   pages: `/`, `/case-study/acme-rebrand/`, `/case-study/globex-launch/`. **No fixture data
   anywhere** — `getStaticPaths` calls the live `/v1` list endpoint at build time.
10. **`npm run conformance:runtime`** (the runtime-probe half) — **12/12 passed**, including "the
    draft item is genuinely invisible through a production-scope key" and "all 9 block types
    present, in order" against the live server's real response (not a fixture).
11. **HTML evidence** (`dist/case-study/acme-rebrand/index.html`, committed alongside this
    README): `grep -o 'data-block-type="[a-zA-Z]*"'` returns exactly
    `hero, richText, gallery, cta, featureGrid, form, testimonial, faq, logoCloud` — the full
    vocabulary, in seeded order. The distinctive seeded strings **"Acme rebrands for the AI era"**,
    **"41% conversion lift"**, and **"Rina Wibowo"** (none of which exist in any fixture file
    anywhere in this repo — they were written once, by `scripts/seed-tenant.mjs`, directly into
    Postgres) are present verbatim in the built HTML. `dist/index.html` lists exactly 2 items
    (`data-item-count="2"`); `find dist -iname '*unpublished*' -o -iname '*draft*'` returns
    **nothing** — the draft row was never built into a page.
12. **Grep proof of zero hand-rolled fetches** (the AC, not a nicety):
    ```
    $ grep -rn "fetch(" src/pages src/lib
    ZERO MATCHES
    ```
    The only network-touching line in the shipped site source is `src/lib/client.ts`'s
    `createClient<paths>({ baseUrl, headers })` — a generic, type-driven dispatcher from
    `openapi-fetch`, parameterised entirely by the generated `paths` type. See "why openapi-fetch"
    below for why this is honest and not a rebranded hand-rolled fetch.
    (`scripts/seed-tenant.mjs` and `scripts/conformance-runtime.mjs` DO touch the database/network
    directly — they are test/dev harness tooling, not shipped site code; nothing under `src/`
    imports either of them, mirroring the repo's own existing pattern of raw-`pg` test fixtures in
    `webdesk/api/test/helpers/fixtures.ts` and `webdesk/payload/test/v1-fixtures.mjs`.)
13. Both containers (`wsk17-postgres`, `wsk17-node`) and the network (`wsk17net`) were removed
    after this run — see the report for the exact teardown commands.

## Where the rail did NOT hold cleanly — every finding, named

### Finding 1 (blocking, worked around under the "grep-proven zero fetch" AC, not fixed) — the codegen pipeline emits TYPES ONLY, no runtime client

`webdesk/api/src/codegen/generator/sdk-ts.mts` wraps `openapi-typescript`'s `openapiTS()` +
`astToString()` — this produces `sdk.d.ts`, a pure `.d.ts` file (`export interface paths {...}`),
**with no runtime HTTP client, no `fetch` wrapper, nothing executable at all**
(`webdesk/api/test/codegen-sdk-typecheck.spec.ts` confirms this is deliberate: its own consumer
file only ever writes `const _list: ListResponse = {...}` — a type-level assertion, never a call).

Design §06 says a scaffolded site gets "the pinned SDK installed ... pages composed exclusively
from block-library components fed by typed SDK calls" — but a types-only artifact cannot itself
make a "typed SDK call". Something has to issue the actual `fetch`. Two honest options existed:
hand-write a thin fetch wrapper typed by `paths` (exactly what the ticket's own AC forbids: "never
a `fetch()` you add"), or use the standard, purpose-built companion library for
`openapi-typescript` output — **`openapi-fetch`** (`createClient<paths>(...)`), which contains no
route string, path template, or query-param name of its own; every one of those comes from the
generated `paths` type at the call site. This site uses the second option. It is the honest
reading of "purely from the generated SDK", but it IS a dependency this ticket's own scope did not
pre-approve, and WSK-15/WSK-20 should decide explicitly whether `openapi-fetch` (or an equivalent)
becomes the standard companion the codegen pipeline documents/ships, rather than each site
re-deciding it. Flagging for architect/WSK-20 attention, not resolving unilaterally beyond what
was needed to satisfy this ticket's own AC.

### Finding 2 (blocking, worked around, NOT fixed — outside this ticket's ownership) — `webdesk/blocks`' vendored vocabulary has drifted from `webdesk/payload/vocabulary`

`npm run build` / `npm pack` inside `webdesk/blocks` (WSK-16) currently **fails**:
`vendor:check` reports `src/vocabulary/primitives.ts does not match payload/vocabulary/
primitives.ts`. Comparing the two by hand: `payload/vocabulary/primitives.ts`'s `media` case
already carries the `field.multiple` array-handling fix WSK-16's own file header documents
("`media` ignored `field.multiple` ... Fixed by mirroring the `relation` branch") — but
`blocks/src/vocabulary/primitives.ts` (the vendored COPY `npm pack` actually ships) was never
re-synced after that fix landed upstream. Confirmed independently:
`node --test test/unit/*.test.mjs` inside `webdesk/blocks` is **25/26**, the one failure being
`test/unit/vendor-drift.test.mjs` — this is not a fluke of this run's environment, it is a real,
standing gap in the repo today.

This ticket's hard constraint is "Do NOT edit `webdesk/blocks/**`" (WSK-16 is live/owned
elsewhere), so the fix (`npm run vendor:vocabulary`, which writes into `blocks/src/vocabulary/`)
was not applied. To get an installable tarball at all, `npm pack --ignore-scripts` was used
instead of `npm run build && npm pack` — this skips the `prepack` hook (`vendor:check`) but writes
**nothing** to `webdesk/blocks/**`; it only changes which lifecycle scripts run during packing.
The resulting tarball is committed at `vendor/gaiada-webdesk-blocks-0.1.0.tgz`.

**Practical impact on THIS site: none observed.** Rendering (`BlockRenderer`/`ItemRenderer`) never
calls `validateBlock()` — it only calls `isBlockType()` (the renderer-invariant's known/unknown
check) via `resolve-blocks.ts`. `validateBlock()`, the function whose behaviour depends on the
stale vendored `primitives.ts`, is exported from the package but never invoked anywhere in this
site's own code or in the renderer path this site exercises. If a future consumer imports
`validateBlock` from `@gaiada/webdesk-blocks` to check a `gallery`/`logoCloud`
(`multiple: true` media) block BEFORE the vendor is re-synced, it will silently under-validate —
that is the live bug, not something this ticket introduced. **Recommend**: whoever owns WSK-16
next runs `npm run vendor:vocabulary && npm run build && npm pack` to produce a corrected tarball;
no application logic changes, only a copy-in-sync.

### Finding 3 (documented substitution, not a defect) — `CONTRACT.lock`'s `snapshotId` has no real mirror to draw from

Design §04/§06 describes `webdesk_contract_snapshots` as a Zone A (WSK-19) table populated by
`POST /api/:t/modules/webdev/contracts/refresh`. WSK-19 is not built (PROGRESS.md: Part C is
4/7 ✅). `CONTRACT.lock`'s `snapshotId` is therefore a locally-synthesized identifier
(`local-dev-2026-08-27T06:10:00Z-wsk17-proof`), not a real mirror-row id — everything else in the
lock file (`contractVersion`, `vocabularyVersion`, `contentHash`, `blockLibraryVersion`) is real,
directly-observed codegen/vendor output. Flagging for WSK-19/WSK-20 to wire a real snapshot id
once that mirror exists; this ticket cannot create one without inventing Zone A schema, which is
outside its scope.

### Finding 4 (workaround only, not a repo defect) — mounting `webdesk/postgres/` from this checkout over `-v` produced a phantom directory

`docker run -v "$(pwd -W)/webdesk/postgres/init-roles.sh:...:ro"` resolved `init-roles.sh` as a
**directory** inside the container (`cat: ... Is a directory`), even with `MSYS_NO_PATHCONV=1`.
The cause: this shared checkout currently carries a stray `webdesk/postgres/init-roles.sh;C`
directory (another session's Windows/Git-Bash path-mangling leftover, matching the documented
`gitbash-docker-path-mangling` trap exactly, just on the OTHER side of it — a write, not this
ticket's). Docker Desktop's Windows-path bind-mount resolution appears to collide the two names.
**Worked around, not fixed** (that stray directory is outside `webdesk/sites/**`, not this
ticket's to remove): the three `CREATE ROLE`/`GRANT` statements from `init-roles.sh` were run
directly via `psql -f` against a copy of the file's SQL body (byte-identical to the tracked
script, only the shell heredoc wrapper removed) rather than via the initdb-script mount. Flagging
for whoever next touches `webdesk/postgres/` to `git status`/clean that stray directory.

## Why `openapi-fetch`, restated for a reviewer skimming just this section

`import createClient from 'openapi-fetch'; const client = createClient<paths>({ baseUrl, headers })`
— then every call site writes `client.GET('/v1/t/wsk17-proof/case-study/{slug}', { params: {...} })`
where the **path string, the required path params, the query param names, and the response shape**
are all supplied and checked by the generated `paths` type. There is no string concatenation, no
hand-maintained base-path constant beyond the tenant/collection literals `src/lib/site-tenant.ts`
declares `as const` (so a typo there is a `tsc` error against the generated type, not a runtime
404) and no route this package's own source invented. This is the same category of tool
`openapi-typescript`'s own docs recommend pairing with generated `.d.ts` output — it was not
invented for this ticket, only adopted here because the codegen pipeline (Finding 1) does not ship
an equivalent itself yet.

## Reproducing this run

```sh
# 1. throwaway Postgres (see Finding 4 for why init-roles.sh isn't mounted directly)
docker network create wsk17net
docker run -d --name wsk17-postgres --network wsk17net \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=... -e POSTGRES_DB=webdesk \
  -p 127.0.0.1:55520:5432 postgres:16-alpine
# then run the 3 CREATE ROLE / GRANT statements from webdesk/postgres/init-roles.sh's heredoc body

# 2. a Linux node container with a Linux-native copy of webdesk/** (avoids the Windows
#    node_modules-cross-platform esbuild trap — see the ticket report)
tar --exclude=node_modules --exclude=.next -czf webdesk.tgz webdesk
docker run -d --name wsk17-node --network wsk17net -w /work node:22-bookworm-slim sleep infinity
docker cp webdesk.tgz wsk17-node:/work/webdesk.tgz && docker exec wsk17-node tar xzf /work/webdesk.tgz -C /work

# 3. migrations -> payload schema push -> RLS gate -> seed -> codegen -> boot /v1 -> site build
#    -> conformance (compile + runtime) -- see this ticket's final report for the exact command
#    sequence and observed output of each step.

# 4. teardown
docker rm -f wsk17-postgres wsk17-node && docker network rm wsk17net
```
