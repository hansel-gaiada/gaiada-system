# webdesk/delivery -- the delivery vocabulary

The single source of what WebDesk's public `/v1` contract is made of (design §05, frozen, versioned by
`vocabulary/version.ts`): the field primitives, the block types and their props, the item and list
envelopes, cache tags, RFC 9457 problem details, locale resolution, tenant composition, item field
validation, and the breaking-change classifier that rates a vocabulary or contract change MAJOR / MINOR /
PATCH.

This directory was `webdesk/payload/` until WSK-48b (rulings WSK-D37: Payload is removed; WSK-D38: the
vocabulary keeps its own home, renamed `delivery`). Only the vocabulary and its tests survived the move;
the Payload app, its old `/v1` router and its tenancy shims are deleted. The first line of each source file
still names the old path: those files are frozen (`vocabulary/envelope.ts` is pinned by a sha256 in
`test/wsk64-classifier.test.mjs`), so the comment was left as written.

## One source, three vendored copies

Nothing outside this directory imports it across a package boundary at run time; each consumer that
cannot (CommonJS, an installable tarball, PHP) carries a mechanical copy, with a drift check that fails
CI when the copy and this source diverge:

| Consumer | Script (run it to refresh; `--check` to verify) |
|---|---|
| `webdesk/api` (`src/delivery/vocabulary/`) | `node src/delivery/vocabulary/vendor.mjs` (from `webdesk/api`); drift spec `test/delivery/vocabulary-vendor-drift.spec.ts` |
| `webdesk/blocks` (`src/vocabulary/`) | `npm run vendor:vocabulary` / `vendor:check` (`scripts/vendor-vocabulary.mjs`) |
| `webdesk/wordpress` (`theme/gaiada-webdesk/inc/block-vocabulary.php`) | `node scripts/vendor-block-vocabulary.mjs` (`--check`), from `webdesk/wordpress` |

The api's codegen (`webdesk/api/src/codegen/generator/*.mts`) and a few `webdesk/scripts/*.mjs` gates import
this directory directly under `tsx`.

## `package.json`

Just `{ "type": "module" }` and no dependencies, on purpose. Node decides whether a bare `.ts` file is ESM
or CommonJS from the nearest `package.json`; without this one the vocabulary's `from './x.ts'` imports
resolve as CommonJS under `tsx` ("does not provide an export named ...", seen once on Linux). There is
nothing to install here: the tests run with the `tsx` and `pg` that `webdesk/api` and `webdesk` already
install.

## Tests (`test/`)

`vocabulary`, `wsk14-*` and `wsk64-*` are plain `node` scripts (PASS / FAIL lines, non-zero exit on a
failure). Run them from `webdesk/api`, so `--import tsx` resolves from its `node_modules`:

```
cd webdesk/api && npm ci
for t in vocabulary wsk64-classifier wsk64-item-fields \
         wsk14-breaking-change wsk14-composition-validator wsk14-renderer-invariant; do
  node --import tsx ../delivery/test/$t.test.mjs
done
```

`webdesk/qa/linux-gate.sh` (suite `vocabulary`) runs the first three (`vocabulary`, `wsk64-classifier`,
`wsk64-item-fields`) and, since WSK-49a, `wsk49-client-editable` (CI's `webdesk-api` job runs the first three; it needs one
more line for the fourth, which is outside `webdesk/**`). The three `wsk14-*` scripts are pure unit checks of
the breaking-change ruleset, the composition validator and the renderer invariant; they were not in the
gate before the move either, and are run by hand. `wsk64-snapshot-probe.mjs` is a helper (the classifier
test imports it) and `test/fixtures/vocabulary-1.0.0.snapshot.json` is the 1.0.0 contract snapshot the
classifier compares against. (`wsk14-two-tenants.test.mjs`, which needed Payload's fixtures and its
redirect helper, was deleted with Payload.)

## Vocabulary 1.2.0 and client-editable fields (WSK-49a, ruling WSK-D59)

1.2.0 is a **MINOR**: one optional boolean, `clientEditable`, on the composition's `ui` object and on a FieldDef's `ui` object.
It is editor metadata only: no stored value changes and the `/v1` envelope is unchanged by a byte (`vocabulary/envelope.ts`
is still pinned by its sha256). The bump is **computed**, never asserted: `classifyVocabularyChange(<1.1.0 snapshot>, current)`
is `minor` (`test/fixtures/vocabulary-1.1.0.snapshot.json`, captured with `test/wsk64-snapshot-probe.mjs` against the untouched
1.1.0 tree). The 1.1.0 classifier was **blind** to this change (it rated it PATCH, "no structural change"), because the keys of the
two `ui` objects were not snapshot dimensions; `fieldUiKeys` and `collectionUiKeys` are since (a new key is MINOR, a removed one
MAJOR; a snapshot that has a `ui` object but not its key set is refused loudly). Inside a tenant contract a `clientEditable`
flip is a `ui` edit, so **PATCH**.

**The one rule** (`vocabulary/client-editable.ts`, `isClientEditable(composition, pointer)`; nothing else restates it):

```
field is client-editable  iff  field.ui.clientEditable ?? <its parent group's effective value> ?? collection.ui.clientEditable ?? false
```

A nested group's members inherit from the group (transitively); generic (non-`fields`) blocks are client-editable iff the collection
is; **`seo` is never client-editable** whatever any flag says (a design default: the agency keeps SEO-critical fields, which is
D59's reason for the mechanism); the `fields` block itself is structure; anything that does not resolve is not editable.
`collectionAcceptsClientCreate`, `changedContentPointers`, `clientEditViolations` and `clientCreateViolations` are built on it and
are what the write plane (`webdesk/api/README.md`, "Client editors (WSK-49)"), the ERP's portal BFF (49c) and the portal UI (49d)
call. The api's vendored copy gains `client-editable.ts`; the blocks and WordPress vendors re-vendored with no other change.
The schema-draft prompt teaches the new key (read from the vendored constants).
