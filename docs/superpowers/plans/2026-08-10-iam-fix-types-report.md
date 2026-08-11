# IAM-FIX-TYPES — report

**Status: DEV-VERIFIED** (typecheck gate green locally; not yet observed green in CI itself).

## Problem

`npm run typecheck` (`tsc --noEmit` against `tsconfig.json`, which includes `src/**/*.test.ts`)
reported 31 errors, all in five IAM test files added/edited the same day. The deploy path
(`tsc -p tsconfig.build.json`, which excludes tests) was already clean and stayed clean — this
was a CI-only gate, not a deployment risk.

## Fixes applied

1. **`js-yaml` missing types** (`iam-215-boundary-pin.test.ts`, `permission-arm-hazard-scan.test.ts`,
   `role-permission-parity.db.test.ts` — 3 errors): added `@types/js-yaml@^4.0.9` as a devDependency
   in `platform-nest/package.json` (matches the `js-yaml@^4.1.0` runtime dependency already
   resolved via the repo's transitive tree). Real upstream types, no ambient stub needed.

2. **Untyped `.mjs` import** (`role-permission-bundles.db.test.ts`, `role-permission-parity.db.test.ts`
   — 2 errors): added `platform-nest/scripts/generate-role-bundles.d.mts`, a hand-written sibling
   declaration file typing the script's actual exports:
   - `REAL_ROLES` as a `readonly` 20-element string-literal tuple (matches the script's real list),
     so `role-permission-parity.db.test.ts`'s `type RealRole = (typeof REAL_ROLES)[number]` derives
     real literal types instead of `any`.
   - `RoleBundleDoc` interface mirroring the actual `_meta`/`roles` shape `generate()` returns.
   - `generate(): RoleBundleDoc` and `serialize(doc: RoleBundleDoc): string`.

   TypeScript auto-resolves `.mjs` specifiers against a sibling `.d.mts` file, so no import-path
   change was needed in either test file. This import is IAM-02h's derived single source of truth
   for `REAL_ROLES` (replacing a hand-maintained list) — it is typed accurately rather than cast
   to `any`, per the ticket's explicit instruction.

3. **`TS2532: Object is possibly 'undefined'`** (`principal-permissions.db.test.ts` — 25 errors):
   `Principal.perms` is deliberately optional (`perms?: PermissionGrant[]`) on the untouched
   `principal.ts` type, because some call sites construct synthetic `Principal` literals that omit
   it (see the one test in this same file, line ~247, that does exactly that and correctly does
   NOT use `!`). Every one of the 25 flagged sites, though, reads `.perms` off a value returned by
   a real `assemblePrincipal()` call (or `before!`/`after!` from the same), where `perms` is always
   populated per `assemblePrincipal`'s own implementation (`principal.ts:158`). Added a second
   non-null assertion at each such site: `p!.perms.` → `p!.perms!.`, `for (const g of p!.perms)` →
   `for (const g of p!.perms!)`, and the two `before!.perms.`/`after!.perms.` occurrences at the
   end of the file — 25 sites total, mechanically verified against the exact TS2532 line list.
   **No assertion body was touched** — every `expect(...)` call keeps its original argument shape;
   only the type-narrowing punctuation changed.

4. **`it.each` arity mismatch** (`role-permission-parity.db.test.ts:301`, `TS2345`): resolved as a
   side effect of fix #2. With the untyped `.mjs` import, `REAL_ROLES` was an implicit `any[]`,
   which made vitest's `it.each` overload resolution pick the variadic-args overload
   (`(...args: any[] | [any]) => Awaitable<void>`) instead of the single-tuple-element overload,
   so the existing `(role) => {...}` callback shape mismatched. Typing `REAL_ROLES` as a concrete
   readonly tuple in the new `.d.mts` let TypeScript pick the correct `it.each<T>(cases: T[])`
   overload, and the callback signature needed no change. No test data or callback body was
   altered.

## Verification

- `npm run typecheck` (CI gate, `tsconfig.json`, includes tests): **31 errors → 0 errors.**
- `npx tsc -p tsconfig.build.json --noEmit` (deploy path, excludes tests): **exit 0 before and
  after** — no regression.
- `npx vitest run src/rbac/`:
  - **Before:** 17 files, 281 tests, 1 failing.
  - **After:** 17 files, 281 tests, 1 failing — identical.
  - The 1 failure (`principal-permissions.db.test.ts` — "company_admin @ companyA resolves
    exactly 199 perms" — got 200) is a pre-existing, reproducible (re-ran in isolation, same
    result) data/count mismatch unrelated to types — almost certainly the seeded `role_permissions`
    bundle for `company_admin` having drifted from the hardcoded expectation since this file was
    written. It is **out of scope for IAM-FIX-TYPES** (fixing it would mean touching test
    assertions or role/permission data, both explicitly excluded from this ticket) and was left
    untouched, with the same failure present before and after.

## Files touched

- `platform-nest/src/rbac/principal-permissions.db.test.ts` — 25 non-null assertions added, no
  assertion logic changed.
- `platform-nest/scripts/generate-role-bundles.d.mts` — new, hand-written type declaration for
  the existing `.mjs` script (script itself untouched).
- `platform-nest/package.json` — added `@types/js-yaml@^4.0.9` devDependency (+ lockfile update
  from `npm install`).
- `docs/superpowers/plans/2026-08-10-iam-fix-types-report.md` — this report.

No changes to `principal.ts`, `cerbos.ts`, `can.ts`, Cerbos policies, migrations,
`permission-catalog.json`, `role-permission-bundles.json`, `platform-ui/`, or any `tsconfig*.json`/
`build`/`typecheck` script.

## Follow-up (not in scope here)

- The pre-existing `company_admin` 199→200 perms count mismatch in
  `principal-permissions.db.test.ts` needs its own ticket: determine whether the seeded
  `role_permissions` bundle or the hardcoded `199` is stale, and fix the correct side.
