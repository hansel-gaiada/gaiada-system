// Type declaration for `generate-scope-constrained-roles.mjs` (IAM-SEC-06). Kept hand-written (not
// generated) because the script is plain ESM run standalone via `node` and is intentionally not
// compiled/type-checked itself; this file exists solely so `.ts` importers
// (`scope-constrained-roles.test.ts`) get real types instead of an implicit `any`, matching the
// established convention `scripts/generate-role-bundles.d.mts` set for its own sibling script.
//
// Shape mirrors the script's actual exports (scripts/generate-scope-constrained-roles.mjs):
//   - `derive()`: role name -> sorted scope-type literal array, re-derived fresh from
//     `cerbos/policies/derived_roles.yaml` every call.
//   - `generate()`: wraps `derive()`'s output in the full checked-in document shape (with `_meta`).
//   - `serialize(doc)`: the exact `JSON.stringify(doc, null, 2) + "\n"` byte-for-byte serialization
//     the checked-in `scope-constrained-roles.json` must match.

export interface ScopeConstrainedRolesDoc {
  _meta: {
    title: string;
    status: string;
    source: string;
    generatedBy: string;
    regenerate: string;
    consumedBy: string;
    failOpenNote: string;
    rulings: string;
    companionDoc: string;
    keyOrder: string;
    counts: {
      roles: number;
    };
  };
  roles: Record<string, string[]>;
}

export function derive(): Record<string, string[]>;
export function generate(): ScopeConstrainedRolesDoc;
export function serialize(doc: ScopeConstrainedRolesDoc): string;
