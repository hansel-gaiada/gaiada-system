# WSK-18 — P3 QA gate

**Status: PROTOTYPED.** Every check below has been run for real, on Linux, with at least one
deliberate-break proof per condition. It has NOT been wired into CI (`.github/workflows/` is
another agent's area this ticket must stay out of) and has not been re-run against a live,
promoted tenant on the estate — so it is a working gate an operator can invoke, not yet a gate
that blocks a merge automatically. Do not call this DEV-VERIFIED at the program level until a CI
job actually invokes these scripts on every PR.

This ticket is a **P3 QA gate** over the already-shipped WSK-14 (vocabulary contract + composition
validator), WSK-15 (codegen pipeline), WSK-16 (block-renderer library), WSK-17 (the proof rebuild),
and WSK-20 (`code.scaffold` v2). It adds no product code — every file here is a check, a fixture,
or a DB-free re-derivation of an existing generator entrypoint, and none of them modify anything
outside `webdesk/qa/p3-gate/` and `webdesk/scripts/check-*.mjs`.

## The four conditions, what each one actually asserts, and where the proof is

### 1. Determinism double-run + cross-machine

**Asserts:** the generated SDK/contract artifacts are byte-identical across TWO SEPARATELY SPAWNED
processes, on two INDEPENDENT machines (not one process run twice in-memory, and not two children
of the same parent on the same filesystem), with the tool versions that produced them recorded and
compared, not merely assumed pinned.

WSK-15's own `codegen:gate` (`webdesk/api/src/codegen/generator/double-run-gate.mts`) already
proves "two separately spawned processes" — but both are children of the same `node`, on the same
container. This ticket's `webdesk/scripts/check-determinism-crossmachine.mjs` proves the harder
half: two **independent Docker containers**, each running its own fresh `npm ci` (no node_modules
copied between them — see "a bug of mine" below), each executing
`webdesk/qa/p3-gate/generate-fixture-artifacts.mts` (a DB-free sibling of WSK-15's
`generate-single.mts`, using the static fixtures in `fixtures/tenant-fixtures.mjs` so the
determinism claim is attributable only to `buildContractArtifacts` and the pinned toolchain, never
to two runs happening to read the same DB row at the same instant).

**Real run, Linux, both tenant fixtures:**

```
-- acme: byte-identical across 2 independent containers (4 artifacts), tool versions pinned identically:
   {"node":"v22.23.2","platform":"linux","arch":"x64","tsx":"4.19.0","openapi-typescript":"7.13.0"}
-- globex: byte-identical across 2 independent containers (4 artifacts), tool versions pinned identically:
   {"node":"v22.23.2","platform":"linux","arch":"x64","tsx":"4.19.0","openapi-typescript":"7.13.0"}
CROSS-MACHINE DETERMINISM GATE PASSED — 2 tenant(s), 2 independent containers each.
```

**Deliberate-break proof:** `--selftest` (no docker) exercises the compare/byte-diff and
version-diff logic with synthetic mismatches — a single-byte artifact difference, a truncated
artifact, and a drifted (unpinned) tool version — and confirms each is caught and named. All 4
selftest cases pass.

**A bug of mine, found and fixed while building this:** the first real run copied this
(Windows) checkout's `webdesk/api/node_modules` straight into the Linux containers via `docker cp`
and failed immediately — `esbuild`/`tsx` ship native platform binaries, and a Windows-built
`node_modules` copied into a Linux container throws `You installed esbuild for another platform`.
Fixed by having each container run its own `npm ci` from `package.json`/`package-lock.json` — which
is also the *more correct* proof: it demonstrates the **pinned lockfile versions**, not a copied
binary, are what make the two machines agree. A second bug (Node resolving `payload/vocabulary`'s
`.ts` files as CommonJS because `webdesk/payload/package.json`'s `"type": "module"` was not copied
alongside them) produced `does not provide an export named 'BLOCKS'` — fixed by copying that file too.

### 2. SDK ↔ OpenAPI ↔ contract coherence

**Asserts:** if a field/schema/path exists in one of `openapi.v1.json`, `sdk.d.ts`,
`CONTENT-CONTRACT.md` and not the others, the gate fails and **names** the field.

Why this is checkable at all: WSK-15 derives `sdk.d.ts` and `CONTENT-CONTRACT.md` from the SAME
`OpenApiBuilderInput` in one generation run — `sdk-ts.mts` derives the SDK from the built OpenAPI
document via `openapi-typescript`; `content-contract-md.mts` derives the markdown from the same
input, not by re-parsing the OpenAPI JSON. That makes the three artifacts unable to drift from each
other **within a single generation run, by construction**. What this check actually catches is the
gap the pipeline itself cannot see: a **stale** artifact set — `sdk.d.ts` served from an older
cached `latest.json` pointer while `openapi.v1.json` was regenerated, hand-edited, or uploaded out
of band. `webdesk/scripts/check-contract-coherence.mjs` cross-extracts schema names, path keys, and
collection keys from all three files and diffs the three sets pairwise.

**Real run, Linux, against a genuinely generated acme artifact set:**
```
[contract-coherence] OK — /work/artifacts-ok: schemas, paths and collection keys agree across
openapi.v1.json, sdk.d.ts, CONTENT-CONTRACT.md.
```

**Deliberate-break proof, on REAL generated artifacts (not synthetic fixtures), on Linux:** a
`ItemEnvelope_phantomCollection` schema was injected into a copy of `openapi.v1.json` only:
```
[contract-coherence] FAILED — 1 drift(s) in /work/artifacts-broken:
  - schema "ItemEnvelope_phantomCollection" exists in openapi.v1.json (components.schemas) but
    not in sdk.d.ts (components["schemas"])
```
`--selftest` additionally covers a stale-markdown collection and a partially-regenerated path,
against REAL fragments of `openapi-typescript`'s emitted shape (not an invented one) — pinned as
a regression guard for extraction itself.

**A bug of mine, found and fixed while building this:** the first real run against acme's actual
generated `sdk.d.ts` produced 11 false "missing from sdk.d.ts" findings for schemas that were
genuinely present. Cause: `openapi-typescript` emits a `/** @description ... */` JSDoc comment
ahead of most schema members (carrying this pipeline's own OpenAPI `description` text straight
through), and the extractor's statement-splitting scanner absorbed the comment text into the
following member's "statement," so the leading-identifier regex never matched anything. Fixed by
stripping block/line comments before scanning; the selftest's real-fragment case now includes a
JSDoc comment specifically to pin this regression.

### 3. Unknown-block probe

**Asserts (the ticket's own wording):** a block the vocabulary does not know must be REJECTED, not
silently dropped or passed through.

**This system has two different, DELIBERATE "unknown block" behaviours at two different moments,
and getting this gate right means probing the correct one:**

- **(a) Composition/authoring time** — a tenant declares which block types a collection may use
  (`collections.schema.blocks`, WSK-14's `validateCollectionComposition`). Proposing an
  out-of-vocabulary block type here is an authoring mistake (typo, hallucinated AI-drafted
  proposal, hand-edited schema) — `composition.ts`'s own header says it "must be rejected loudly
  with an actionable error." **This is condition 3's real target.**
- **(b) Read/render time** — a content item already stored under an older tenant contract carries a
  newer vocabulary-MINOR block type. Here the design's OWN frozen rule (§05 hard rule 2, "the
  renderer invariant") requires the OPPOSITE: skip and report, never throw — proven already by
  WSK-16's `resolve-blocks.ts`/`BlockRenderer.astro`. Forcing rejection here would violate a frozen
  design decision two tickets have already shipped against; this gate documents that distinction
  rather than "fixing" the wrong layer.

`webdesk/scripts/check-unknown-block-rejection.mjs` probes (a) with the real, unmodified
`validateCollectionComposition`/`validateTenantComposition` (single-collection AND whole-tenant,
plus a positive control that an all-known list is NOT rejected, plus a check that a valid sibling
collection does not false-positive), and separately confirms (b)'s permissiveness against the real
`resolveBlocks()`.

**Real run:**
```
[unknown-block-reject] OK —
  (a) composition/authoring: an out-of-vocabulary block type is REJECTED with an actionable error
      naming the exact path and type, single-collection AND whole-tenant, no false positives on
      valid siblings.
  (b) read/render: an out-of-vocabulary block type is skipped-and-reported, never thrown —
      confirmed intentional per design §05 hard rule 2 (WSK-16), NOT a gap condition 3 requires
      closing.
```

**Deliberate-break proof, on a REAL (not reimplemented) copy of the shipped validator:** a scratch
copy of `composition.ts` had its `isBlockType(b)` vocabulary check short-circuited
(`false && !isBlockType(b)`). Run against that copy:
```
[unknown-block-reject] FAILED — 2 finding(s):
  - validateCollectionComposition ACCEPTED an out-of-vocabulary block type ("pricingTable") in
    "article.blocks" — this must be rejected (composition.ts's own documented rule).
  - validateTenantComposition ACCEPTED a whole-tenant composition containing an out-of-vocabulary
    block type.
```
Confirmed both the intact and the broken run on real Linux containers, not just Windows.

**A bug of mine, found and fixed while building this:** `tsx`'s dynamic-import prescan
(`transformDynamicImport`) threw a parse error whose reported offset landed inside this file's own
header comment, no matter how the comment's wording changed — never resolved to a root cause worth
the time it would have cost. Worked around by using static relative imports (matching every other
consumer in this repo) and running with **plain `node`**, no `--import tsx` — Node 22.18+/24's
native TypeScript type-stripping imports these erasable-syntax `.ts` files directly, the same
choice WSK-16's own README documents for the same reason.

### 4. Artifact-URL expiry

**Asserts:** a presigned/artifact URL must actually stop working after its TTL, **proven by
observation** — not asserted from reading the TTL config.

`webdesk/scripts/check-artifact-url-expiry.mjs` drives the REAL production code path —
`S3StorageAdapter.presignGetObject` (`webdesk/api/src/storage/s3-storage.adapter.ts`, WSK-07), the
exact class `ContractReadService.readLatest` (WSK-15) calls to mint the
`sdkTsUrl`/`openapiUrl`/`contractMdUrl` a tenant's contract response carries — against a real,
throwaway MinIO instance. Not a signature-math unit test: an actual HTTP GET against an actual
presigned URL.

**Real run, entirely on Linux** (both the check's own runner process AND MinIO ran as Linux
containers on a shared Docker network — the strongest form of this proof this ticket could produce
without a live estate box):
```
-- presignGetObject(ttl=2s) — the SAME call ContractReadService.readLatest makes --
-- immediate GET: HTTP 200 -> valid --
-- waiting 5000ms (TTL + 3s margin) for REAL wall-clock expiry --
-- GET after TTL: HTTP 403 -> expired-or-refused
   body: <Error><Code>AccessDenied</Code><Message>Request has expired</Message>...
-- control: a FRESH presigned URL for the same object: HTTP 200 -> valid --
[artifact-url-expiry] OK — a presigned artifact URL worked before its TTL, was refused after it
(observed, not asserted), and a fresh URL for the same object still works.
```
Also re-run with `WSK18_PRESIGN_TTL_SECONDS=120` (still expired at the longer TTL, as expected,
since the wait margin scales with the TTL) — a second real observation, not a repeat of the same
number.

**Deliberate-break proof:** `--selftest` exercises the response-classification logic (`200` →
valid, `403` → expired-or-refused, and — the part a naive check gets wrong — a `404`/`500` must
NOT be conflated with expiry either way) with synthetic status codes, matching this program's own
house pattern (`check-rls-integrity.mjs`'s selftest is exactly this style: synthetic states, no
live infra). **What could not be produced as a live-infra deliberate-break:** MinIO's TTL
enforcement is inherent to the SigV4 signature math (an expired signature fails verification
regardless of application config), so there is no application-level knob to disable it and prove
the check fails against a genuinely broken live URL — the closest live-infra analogue (a TTL longer
than the wait margin) cannot actually produce a false "still valid after we expected expiry"
result, because this script's wait margin is derived FROM the TTL. Flagged rather than
manufactured: **the synthetic classifier selftest is the honest ceiling for this condition's
deliberate-break requirement**, not a compromise from a live one that could have been done instead.

## Files this ticket added

- `webdesk/qa/p3-gate/README.md` — this file
- `webdesk/qa/p3-gate/fixtures/tenant-fixtures.mjs` — two static, DB-free tenant compositions
- `webdesk/qa/p3-gate/generate-fixture-artifacts.mts` — DB-free sibling of WSK-15's
  `generate-single.mts`, for the cross-machine determinism run
- `webdesk/scripts/check-determinism-crossmachine.mjs` — condition 1
- `webdesk/scripts/check-contract-coherence.mjs` — condition 2
- `webdesk/scripts/check-unknown-block-rejection.mjs` — condition 3
- `webdesk/scripts/check-artifact-url-expiry.mjs` — condition 4

## What this gate could NOT verify, and why

- **Not wired into CI.** `.github/workflows/` is another concurrent agent's area (explicitly
  off-limits per this ticket's brief) — these scripts exist and pass but nothing invokes them on a
  PR yet. That wiring is a follow-up, not this ticket's scope.
- **Condition 1's "cross-machine" claim is two Docker containers, not two physically separate
  hosts.** That is the standard, and honestly the only practical, interpretation available in this
  environment (WSK-16 set the same precedent verifying "Linux" via `docker run`) — two independent
  containers with independently-installed toolchains and no shared process/filesystem is a
  materially stronger claim than WSK-15's own same-machine double-spawn, but it is not literally
  two racks.
- **Condition 2's coherence check cannot itself prove WSK-15's single-run derivation stays
  drift-free forever** — it proves the CURRENT artifact set is coherent and that a manufactured
  drift is caught; it does not replace WSK-15's own generation code as the thing that keeps them
  coherent in the first place.
- **Condition 4 has no live-infra deliberate-break** — see the condition-4 section above for
  exactly why, rather than a manufactured one.
- **None of these checks ran against a live, promoted Zone B tenant** — Zone B has no box yet
  (A-12, tracked in the program PROGRESS.md), so "the artifact URL a real tenant's console actually
  requests" has not been observed; every run here is against fixtures or a throwaway container.
