// IAM-07b — the meta-test the design ruling calls for (docs/superpowers/plans/2026-08-10-iam-05b-
// design.md §4): "assert the chain has no unpinned link (a meta-test enumerating the six)". This is
// that enumeration. It does NOT re-derive any authorization fact — every link's actual proof lives
// in the guard file it names. What this file guarantees is narrower and easier to let rot silently:
// that the guard file for every link in the chain still EXISTS, still has content, and has not been
// quietly deleted, emptied, or renamed out from under the chain map this ticket documents.
//
// Chain (docs/superpowers/plans/2026-08-10-iam-05b-design.md §4, plus the two links that design's
// own §4 explicitly left unpinned and this ticket closes):
//
//   Cerbos policies <-(1)-> catalog <-(2)-> DB permissions <-(3)-> role_permissions <-(4)->
//     role-permission-bundles.json <-(5)-> CAPABILITY_MAP+ROLE_CAPS <-(6, tsc)-> Capability type
//   + role axis: derived_roles.yaml <-> Role union
//   + catalog <-> permission-groups.json (the second gap this ticket found and closed)
//
// If a future refactor deletes or empties one of these files, THIS test fails immediately, naming
// the link — even though the deletion might otherwise look like a harmless cleanup (a test file
// with no import from any other production code, easy to mistake for dead scaffolding).
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const NEST_ROOT = join(__dirname, "../..");
const UI_ROOT = join(NEST_ROOT, "../platform-ui");

interface LinkGuard {
  link: string;
  description: string;
  guardPath: string;
  needsServices: "none" | "postgres" | "postgres+cerbos";
}

const CHAIN: LinkGuard[] = [
  {
    link: "1 · Cerbos policies <-> permission-catalog.json",
    description: "the wave-3 manual alignment audit, promoted to CI by this ticket",
    guardPath: join(NEST_ROOT, "src/rbac/cerbos-catalog-alignment.test.ts"),
    needsServices: "none",
  },
  {
    link: "2 · permission-catalog.json <-> DB permissions (0093)",
    description: "catalog seed migration regression guard",
    guardPath: join(NEST_ROOT, "src/rbac/permission-catalog.db.test.ts"),
    needsServices: "postgres",
  },
  {
    link: "3 · role_permissions (0094) <-> live Cerbos decisions",
    description: "the IAM-02b bundle parity suite — the phase's headline safety net",
    guardPath: join(NEST_ROOT, "src/rbac/role-permission-parity.db.test.ts"),
    needsServices: "postgres+cerbos",
  },
  {
    link: "4 · role-permission-bundles.json <-> DB role_permissions, regen-no-diff",
    description: "IAM-05b-1's artifact guard",
    guardPath: join(NEST_ROOT, "src/rbac/role-permission-bundles.db.test.ts"),
    needsServices: "postgres",
  },
  {
    link: "5 · CAPABILITY_MAP + ROLE_CAPS <-> bundles, under declared semantics",
    description: "IAM-05b-3's generated capability-axis parity test (platform-ui)",
    guardPath: join(UI_ROOT, "src/lib/rbac-capability-parity.test.ts"),
    needsServices: "none",
  },
  {
    link: "role axis · derived_roles.yaml <-> Role union",
    description: "the pre-existing role-axis drift guard (platform-ui) that IAM-05b's design ruling cites as precedent",
    guardPath: join(UI_ROOT, "src/lib/rbac-cerbos-parity.test.ts"),
    needsServices: "none",
  },
  {
    link: "215/15 boundary · exempt-kind registry",
    description: "IAM-04c-1's static boundary pin — not one of the six named links, but load-bearing for the same contract and worth keeping enumerated here",
    guardPath: join(NEST_ROOT, "src/rbac/iam-215-boundary-pin.test.ts"),
    needsServices: "none",
  },
  {
    link: "catalog <-> permission-groups.json (NEW — closed by this ticket)",
    description: "the groups-authoring layer had zero test coverage before this ticket; a key rename anywhere in the catalog would silently orphan a group entry",
    guardPath: join(NEST_ROOT, "src/rbac/permission-groups-catalog-parity.test.ts"),
    needsServices: "none",
  },
];

describe("IAM-07b · chain meta-test — no link in the permission-contract chain is unpinned", () => {
  it.each(CHAIN)("link \"$link\" has a guard file that exists and is non-empty: $guardPath", ({ guardPath }) => {
    expect(existsSync(guardPath), `guard file does not exist: ${guardPath}`).toBe(true);
    const text = readFileSync(guardPath, "utf8");
    expect(text.length, `guard file is empty: ${guardPath}`).toBeGreaterThan(0);
    // A minimal "this is actually a test file, not a stub" check — every real guard in this repo
    // declares at least one `it(` or `it.each(`.
    expect(/\bit(\.\w+)?\(/.test(text), `guard file has no test cases: ${guardPath}`).toBe(true);
  });

  it("link 6 (Capability type <-> 188 UI call sites) is enforced by tsc, by construction — no runtime test exists or is needed", () => {
    // Documented, not asserted: CAPABILITY_MAP is declared `satisfies Record<Capability, CapabilityDef>`
    // in platform-ui/src/lib/rbac-capability-map.ts, which makes both directions (a capability
    // without a map entry; a map entry for a non-capability) a COMPILE error. `npm run typecheck`
    // in the platform-ui CI job is therefore this link's guard — there is nothing for a vitest
    // suite to add. Recorded here so the meta-test's enumeration is honest about "guarded by tsc,
    // not by a test file" rather than silently omitting the link.
    expect(true).toBe(true);
  });

  it("sanity: this enumeration lists at least 8 links — a shrinking count here is itself a signal", () => {
    expect(CHAIN.length).toBeGreaterThanOrEqual(8);
  });
});
