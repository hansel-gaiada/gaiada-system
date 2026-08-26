# `webdesk/api/src/codegen/generator/` — the ESM half of WSK-15

**Why this directory is `.mts`, not `.ts`, and why that matters.**

`webdesk/api` is a NestJS service compiled by `tsc -p tsconfig.json` under
`"module": "commonjs"`. `webdesk/payload/vocabulary/**` (WSK-06/WSK-14 — frozen, DEV-VERIFIED,
this ticket builds ON it per the brief, not around it) is ESM and every file in it imports its own
siblings with an explicit `.ts` extension (e.g. `blocks.ts`'s `import ... from './primitives.ts'`).
TypeScript's classic (`commonjs`/`node10`) module resolution — what `webdesk/api/tsconfig.json`
uses — rejects a relative import ending in `.ts` outright (`TS5097`) unless
`allowImportingTsExtensions` is set, which itself forces `noEmit: true` and would break
`npm run build` for the whole `api` service.

The fix applied here is **not** a `tsconfig.json` edit and **not** a vendored copy of the
vocabulary — both would either weaken the main build or violate "build ON WSK-06/14, don't
re-derive it." It is a **file-extension boundary**: every file in this directory that transitively
imports `webdesk/payload/vocabulary/**` is named `.mts`. `webdesk/api/tsconfig.json`'s `include` is
`["src/**/*.ts", "test/**/*.ts"]` — a glob that does **not** match `.mts` — so `tsc -p tsconfig.json`
never sees these files at all; they are executed directly by `tsx` (`node --import tsx ...`, the
same tool `webdesk/payload/scripts/*.mjs` already uses for the identical reason), which resolves
`.ts`-extension specifiers the way esbuild/Vite do — literally, no `TS5097` rule — and by `vitest`
(`test/codegen-*.spec.ts`), whose Vite-based transform does the same.

The NestJS-facing half of this ticket (`../contract-read.service.ts`, `../codegen.module.ts`,
`../contract-manifest.types.ts`, `../artifact-keys.ts`) is deliberately **plain commonjs-safe
`.ts`** with **zero vocabulary imports** — it only ever reads a JSON pointer object
(`contracts/<tenantSlug>/latest.json`) this directory's `run-codegen.mts` already wrote to MinIO,
and mints pre-signed GET URLs. Nothing under `src/control/**` (the NestJS graph) imports anything
from this directory.

## Layout

- `canonical-json.mts` — deterministic serialization (`stableStringify`: recursive sorted-key
  JSON) + `sha256Hex`. The whole determinism AC rests on this file being correct.
- `vocabulary-field-schema.mts` — maps a vocabulary `FieldDef`/`PrimitiveName` to a JSON Schema
  fragment. The one piece of "hand-authored OpenAPI" logic (WSK-D19) proper.
- `openapi-builder.mts` — `buildOpenApiDocument(input)`: composition × vocabulary →
  `openapi.v1.json` (a plain object; canonicalized by the caller before writing). Describes the
  REAL routes `webdesk/payload/collections/router.ts` serves — see that file and
  `content-read.ts`/`redirects.ts` for the routes this mirrors; this file's own header repeats the
  exact correspondence.
- `content-contract-md.mts` — renders `CONTENT-CONTRACT.md` from the same input the OpenAPI
  builder consumes (not from the OpenAPI JSON itself, to avoid a second, lossy parse step).
- `sdk-ts.mts` — wraps `openapi-typescript`'s Node API (`openapiTS` + `astToString`) to derive the
  TS SDK types from an already-built OpenAPI document (WSK-D19: derived, not hand-written).
- `versioning.mts` — thin wrapper over WSK-14's `breaking-change.ts` (`classifyTenantContractChange`,
  `bumpVersion`) — composition → next contract semver. No version logic is reimplemented here.
- `build-artifacts.mts` — orchestrates the four files above into one deterministic
  `BuiltArtifacts` result (openapi.v1.json bytes, sdk.d.ts bytes, CONTENT-CONTRACT.md bytes, the
  per-artifact hash manifest, and `contentHash`). Pure — no I/O.
- `fetch-composition.mts` — the ONLY file in this directory that touches Postgres: resolves a
  tenant slug → `{tenantId, defaultLocale, locales, composition}` under the real
  `webdesk.platform_ctx` / `webdesk.tenant_ctx` GUCs (same mechanism as every other Zone B
  service), `ORDER BY key` for deterministic iteration order.
- `storage-io.mts` — the ONLY file in this directory that touches MinIO: reads/writes
  `contracts/<tenantSlug>/latest.json` and the per-version artifact bodies, via WSK-07's
  `StorageAdapter` (`../../storage/s3-storage.adapter.ts` — imported directly; it is a plain class
  with no vocabulary/NestJS-DI dependency of its own, so it is safe to import from this ESM side
  too. This ticket does **not** write a second S3 client, per the brief).
- `run-codegen.mts` — the CLI entrypoint (`npm run codegen:run -- --tenant <slug>`): fetch →
  build → upload → (optionally) emit `contract.published` via WSK-12's
  `ZoneBEventEmitterService` (imported directly — it has no constructor parameters, so it needs no
  Nest DI container to construct).
- `generate-single.mts` — a narrower CLI used only by the double-run gate: fetch (real DB, real
  composition) → build (with no `previous` — baseline `1.0.0` every time, deliberately, so the
  determinism proof is about artifact BYTES, not the live versioning ledger) → write four files to
  `--out`. No storage/event I/O.
- `double-run-gate.mts` — the CI gate (`npm run codegen:gate -- --tenants <slugA>,<slugB>`): for
  each tenant, spawns `generate-single.mts` as **two separate `node` child processes** (not two
  in-process calls — a fresh process/module cache per run is the closest this ticket can get to
  the design's own "same input twice AND on a second machine/container" AC without a second
  physical machine), then byte-compares (`Buffer.compare`, not string `===`) every artifact file.
  Exits non-zero on ANY difference, in any tenant, in any file.
