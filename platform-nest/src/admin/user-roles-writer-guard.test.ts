// IAM-SEC-05 / IAM-SEC-07 (writer-coverage half) — every INSERT INTO user_roles that can mint a
// caller-chosen role must run through the ONE shared scope guard (`assertRoleScopeAllowed()` in
// admin-identity.controller.ts), or be on this file's own explicit TRUSTED allowlist, with a
// stated reason the caller cannot actually choose an unsafe (role, scope) pair through it.
//
// WHY THIS EXISTS: IAM-SEC-05 found `inviteUser` minting `user_roles` rows from a caller-supplied
// `roleId` at a hardcoded scope, entirely unchecked — `assignRole` already had the scope guard
// (`ROLE_SCOPE_CONSTRAINTS`), `inviteUser` simply never called it. Routing `inviteUser` through the
// shared `assertRoleScopeAllowed()` helper closes THAT writer. It does nothing, by itself, to stop
// a THIRD writer from reintroducing the same defect class next month — that is what this file
// pins. Same discipline as `managed-by-invariant.test.ts`'s Part 6 (a fresh source sweep on every
// run, not a hand-maintained "known good" snapshot that silently stops mattering once written).
//
// STATIC ONLY — no DB, no live app. Walks `src/`, finds every `INSERT INTO user_roles(...)` whose
// column list includes `role_id`, and classifies the file it lives in as GUARDED or TRUSTED. A
// file that is neither fails the sweep — that is the teeth: add a fourth writer with a raw
// caller-controlled roleId and no scope check, and this test goes red without anyone having to
// remember this ticket.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "..");
const SRC = join(ROOT, "src");

/** Every non-test source file. Deliberately its own walk (not imported from
 *  `managed-by-invariant.test.ts`) — this program's static rbac/admin tests each re-derive their
 *  own parse rather than share plumbing, so one file's refactor can never silently blind another's
 *  sweep (`permission-arm-hazard-scan.test.ts`'s header explains the same choice, "G1"). */
function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      walk(p, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")) {
      out.push(p);
    }
  }
}

/** Files whose `INSERT INTO user_roles` column list includes `role_id` — i.e. every file that
 *  MINTS a role grant, as opposed to a file that only reads, deletes, or clears `managed_by`
 *  (service-reconciler.ts's revoke/adopt paths do the latter and are correctly NOT hits here). */
function findRoleGrantWriters(): string[] {
  const files: string[] = [];
  walk(SRC, files);
  const offenders: string[] = [];
  const re = /INSERT INTO user_roles\s*\(([^)]*)\)/g;
  for (const p of files) {
    const src = readFileSync(p, "utf8");
    let m: RegExpExecArray | null;
    let hit = false;
    while ((m = re.exec(src))) {
      if (m[1].includes("role_id")) hit = true;
    }
    if (hit) offenders.push(relative(ROOT, p).split("\\").join("/"));
  }
  return [...new Set(offenders)].sort();
}

// ── TRUSTED writers — bypass the shared guard on purpose, each for a stated reason that the
// caller cannot actually choose the (role, scope) pair through this specific path. Every entry
// was verified against its own source at IAM-SEC-05 time (2026-08-12, see
// docs/superpowers/plans/2026-08-12-iam-04c-ruling.md §2's enumeration) and must be RE-justified,
// not just re-added, if the file's write path changes shape.
const TRUSTED_WRITERS: Record<string, string> = {
  "src/admin/service-reconciler.ts":
    "role_id resolves ONLY to <module>_staff/<module>_manager via moduleRoleId(), derived from the " +
    "service assignment's OWN module contract — never from request input — and scope_type/scope_id " +
    "are hardcoded to 'company'/the served tenant. No caller-chosen role or scope reaches this INSERT.",
  "src/core/client-contacts.controller.ts":
    "the role is looked up by the LITERAL name 'client' (`WHERE company_id IS NULL AND name = " +
    "'client'`), never by a caller-supplied roleId, and scope_type is hardcoded 'company'. A client " +
    "contact accepting their own portal invite cannot choose a different role or scope through it.",
  "src/seed/portal-clients.ts":
    "seed script (owner/migrator execution context, never a request handler) — the identical " +
    "hardcoded 'client'-by-name + 'company'-scope shape as client-contacts.controller.ts above.",
  "src/testing/fixtures.ts":
    "test-only `grantRole()` helper — its role/scope arguments come from TEST code, never from a " +
    "live request, and the file is never imported by production code. `src/testing/personas.ts` " +
    "calls through this helper rather than writing SQL directly, so it produces no separate hit.",
};

// ── GUARDED writers — must call the shared helper. Kept as an explicit set (not just "found ==
// trusted-or-not") so a writer that quietly stops calling the guard is caught by name, not folded
// into a generic pass/fail.
const GUARDED_WRITERS = new Set(["src/admin/admin-identity.controller.ts"]);

describe("IAM-SEC-05/07 — every user_roles writer that can mint a role grant is covered", () => {
  const writers = findRoleGrantWriters();

  it("the sweep actually finds writers (a regex that silently matches nothing is not a passing guard)", () => {
    expect(writers.length).toBeGreaterThan(0);
    // The two production writers this ticket's investigation named, at minimum, must still be found
    // — if either disappears from `writers`, either the code moved (update this list) or the sweep
    // itself broke (fix the regex), but either way this must not pass silently.
    expect(writers).toContain("src/admin/admin-identity.controller.ts");
    expect(writers).toContain("src/admin/service-reconciler.ts");
  });

  it("every writer is either GUARDED (calls assertRoleScopeAllowed) or explicitly TRUSTED with a stated reason", () => {
    for (const file of writers) {
      const isTrusted = file in TRUSTED_WRITERS;
      const isGuarded = GUARDED_WRITERS.has(file);
      expect(
        isTrusted || isGuarded,
        `"${file}" INSERTs into user_roles with a role_id column and is NEITHER on the TRUSTED ` +
          `allowlist NOR in GUARDED_WRITERS. This is exactly the IAM-SEC-05 defect class: a NEW ` +
          `writer minting a role grant with no scope check. Either route it through ` +
          `assertRoleScopeAllowed() (admin-identity.controller.ts) and add it to GUARDED_WRITERS, ` +
          `or — ONLY if the role and scope it inserts are fully code-controlled and never ` +
          `caller-chosen — add it to TRUSTED_WRITERS here with the reason why, same as the ` +
          `existing entries.`,
      ).toBe(true);
      if (isGuarded) {
        const src = readFileSync(join(ROOT, file), "utf8");
        expect(
          src.includes("assertRoleScopeAllowed("),
          `"${file}" is listed in GUARDED_WRITERS but no longer references assertRoleScopeAllowed() ` +
            `at all — the guard call was removed (or renamed) without updating this list. That is ` +
            `the exact regression this test exists to catch.`,
        ).toBe(true);
      }
    }
  });

  it("no stale entries: every TRUSTED/GUARDED file listed here is still a writer the sweep actually finds", () => {
    for (const file of [...Object.keys(TRUSTED_WRITERS), ...GUARDED_WRITERS]) {
      expect(
        writers,
        `"${file}" is listed as a known user_roles writer in this test, but the sweep no longer ` +
          `finds an INSERT INTO user_roles(...role_id...) there. Either the write path moved/was ` +
          `deleted (remove the stale entry) or the sweep's regex needs updating — a stale TRUSTED ` +
          `entry that no longer corresponds to real code hides real coverage loss.`,
      ).toContain(file);
    }
  });

  // ── per-method teeth-proof on the one file with TWO independent writers ──────────────────────
  //
  // The file-level check above only proves admin-identity.controller.ts references the guard
  // SOMEWHERE — it would stay green even if `assignRole` kept calling it but `inviteUser` (the
  // writer IAM-SEC-05 was actually about) silently lost its call during some future refactor. This
  // extracts each method's own body and checks each one, independently, so THAT regression is
  // caught by name rather than laundered through a file-wide OR.
  function extractMethodBody(src: string, methodName: string): string {
    const startIdx = src.indexOf(`async ${methodName}(`);
    if (startIdx === -1) throw new Error(`method "${methodName}" not found in admin-identity.controller.ts`);
    const rest = src.slice(startIdx);
    // Next sibling method starts at a decorator on its own line at the class's 2-space indent.
    const nextDecoratorIdx = rest.search(/\n {2}@(Get|Post|Patch|Delete)\(/);
    return nextDecoratorIdx === -1 ? rest : rest.slice(0, nextDecoratorIdx);
  }

  /** Strips `//`-to-end-of-line comments before a containment check. Without this, commenting OUT
   *  a call (`// assertRoleScopeAllowed(...)`) still satisfies a plain `.toContain()` — proven by
   *  this ticket's own teeth-proof, which stayed green against a commented-out call until this
   *  strip was added. Line-based and not a real tokenizer, but adequate for this one controller
   *  file (no `//` occurs inside a string literal or template literal here). */
  function stripLineComments(text: string): string {
    return text
      .split("\n")
      .map((line) => {
        const idx = line.indexOf("//");
        return idx === -1 ? line : line.slice(0, idx);
      })
      .join("\n");
  }

  it("inviteUser's own LIVE (non-comment) body calls assertRoleScopeAllowed (the IAM-SEC-05 writer)", () => {
    const src = readFileSync(join(SRC, "admin/admin-identity.controller.ts"), "utf8");
    const body = stripLineComments(extractMethodBody(src, "inviteUser"));
    expect(body).toContain("assertRoleScopeAllowed(");
  });

  it("assignRole's own LIVE (non-comment) body calls assertRoleScopeAllowed (the pre-existing writer)", () => {
    const src = readFileSync(join(SRC, "admin/admin-identity.controller.ts"), "utf8");
    const body = stripLineComments(extractMethodBody(src, "assignRole"));
    expect(body).toContain("assertRoleScopeAllowed(");
  });
});
