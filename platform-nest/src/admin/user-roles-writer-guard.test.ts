// IAM-SEC-05 / IAM-SEC-07 (writer-coverage half) → EXTENDED by P2-04 (design §6.1).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS FILE PINS, AND HOW THE BAR MOVED
//
// ORIGINALLY (IAM-SEC-05, 2026-08-12): every `INSERT INTO user_roles` that can mint a
// caller-chosen role must CALL the one shared scope guard (`assertRoleScopeAllowed`), or be on an
// explicit TRUSTED allowlist. That closed the writer IAM-SEC-05 found (`inviteUser`, which minted
// a caller-supplied `roleId` at a hardcoded scope with no scope check while `assignRole` had one —
// two hand-written copies of one rule that drifted).
//
// NOW (P2-04): calling a shared helper is no longer enough. A writer that calls the guard and
// then writes its OWN bespoke INSERT is still a writer whose next author can forget the call.
// The bar is now STRUCTURAL: every production INSERT/DELETE of a `user_roles` row must LIVE IN
// `src/admin/grant-write.service.ts` — the single choke point — and nowhere else in `src/`.
// Plant a bespoke `INSERT INTO user_roles` in any other production file and this suite goes red
// without anyone having to remember this ticket.
//
// THREE SWEEPS, because there are three ways to hand someone a role they should not have:
//   1. MINT   — `INSERT INTO user_roles (... role_id ...)`.
//   2. REVOKE — `DELETE FROM user_roles`. Not swept before P2-04; a bespoke deleter is how a
//               revocation path forgets the reconciler-ownership guard (`AND managed_by IS NOT
//               NULL`) and tears down a manual grant, or forgets to pin `user_id` and lets a
//               grant id from another user be revoked through a mismatched route param.
//   3. REPOINT — `UPDATE user_roles SET ...` touching `role_id` / `scope_type` / `scope_id`.
//               Never swept before. Re-pointing an EXISTING row at a different role is the same
//               escalation as minting one, and it would sail past a sweep that only looks at
//               INSERTs. Provenance-only updates (`SET managed_by = NULL`, the A14 adoption
//               path) are deliberately NOT flagged: they change who OWNS a grant, never what it
//               confers.
//
// STATIC ONLY — no DB, no live app. Walks `src/`, classifies every hit, and fails on anything
// unclassified. Same discipline as `managed-by-invariant.test.ts`'s Part 6: a fresh source sweep
// on every run, never a hand-maintained "known good" snapshot that silently stops mattering.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "..");
const SRC = join(ROOT, "src");

/** THE choke point. The one production file permitted to contain a `user_roles` write. */
const CHOKE_POINT = "src/admin/grant-write.service.ts";

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

interface SourceFile {
  path: string; // repo-relative, forward slashes
  src: string;
}

function readAllSources(): SourceFile[] {
  const files: string[] = [];
  walk(SRC, files);
  return files.map((p) => ({
    path: relative(ROOT, p).split("\\").join("/"),
    src: readFileSync(p, "utf8"),
  }));
}

// ── the three classifiers, as PURE functions over (path, source) ─────────────────────────────
// Pure on purpose: the teeth tests at the bottom feed them a SYNTHETIC file to prove each sweep
// actually rejects a planted writer, without touching the real tree. A guard whose rejection path
// has never been executed is a guard nobody has tested.

/** MINT: files whose `INSERT INTO user_roles` column list includes `role_id`. */
export function findMinters(files: SourceFile[]): string[] {
  const re = /INSERT INTO user_roles\s*\(([^)]*)\)/g;
  const hits: string[] = [];
  for (const f of files) {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(f.src))) {
      if (m[1].includes("role_id")) {
        hits.push(f.path);
        break;
      }
    }
  }
  return [...new Set(hits)].sort();
}

/** REVOKE: files containing a `DELETE FROM user_roles`. */
export function findDeleters(files: SourceFile[]): string[] {
  const re = /DELETE FROM user_roles\b/;
  return [...new Set(files.filter((f) => re.test(f.src)).map((f) => f.path))].sort();
}

/** REPOINT: files whose `UPDATE user_roles ... SET <assignments>` touch what the grant CONFERS
 *  (`role_id`, `scope_type`, `scope_id`) rather than only who owns it (`managed_by`,
 *  `managed_by_position`, `expires_at`, timestamps). The SET list is taken as the text between
 *  `SET` and the statement's `WHERE` (or the end of the template literal), which is adequate for
 *  this repo's single-statement query literals. */
export function findRepointers(files: SourceFile[]): string[] {
  const re = /UPDATE user_roles\s+SET\s+([\s\S]*?)(?:\bWHERE\b|`)/g;
  const hits: string[] = [];
  for (const f of files) {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(f.src))) {
      if (/\b(role_id|scope_type|scope_id)\s*=/.test(m[1])) {
        hits.push(f.path);
        break;
      }
    }
  }
  return [...new Set(hits)].sort();
}

// ── TRUSTED writers — permitted to hold their OWN `user_roles` write, outside the choke point.
// Each entry states why the (role, scope) pair it writes is not caller-choosable. Every entry was
// re-verified against its own source at P2-04 time (2026-08-13) and must be RE-justified, not just
// re-added, if the file's write path changes shape.
//
// ⚠ The bar for this list is now HIGHER than it was at IAM-SEC-05 time. "The role is hardcoded"
// is no longer sufficient on its own to stay OUT of the choke point — the two production paths
// that used to qualify on that basis (`service-reconciler.ts`, `client-contacts.controller.ts`)
// were ROUTED THROUGH the service by P2-04 as TRUSTED_INTERNAL callers instead, because the
// structural property ("every production write is in one file") is worth more than the
// convenience. What is left here is only what CANNOT route: code that does not run in the
// application's request/consumer path at all.
const TRUSTED_WRITERS: Record<string, string> = {
  "src/seed/portal-clients.ts":
    "seed script — owner/migrator execution context, never a request handler, never imported by " +
    "the running app. Design §6.1 keeps seeds and migrations OUT of the choke point on purpose: " +
    "they are the trusted bootstrap that has to be able to write the rows the guarded surfaces " +
    "cannot (the elevated tier's own grants among them). It writes the LITERAL 'client' role by " +
    "name at hardcoded 'company' scope regardless.",
  "src/seed/client-logins.ts":
    "seed script, same execution context and same write as `seed/portal-clients.ts` above — and the " +
    "same LITERAL role: `SELECT id FROM roles WHERE company_id IS NULL AND name = 'client'`, at " +
    "hardcoded 'company' scope, for a contact resolved from `client_contacts`. Nothing caller-chosen " +
    "reaches the role or the scope. It exists because portal-clients grants that role and this " +
    "script did not: it created a contact and a Keycloak account without it, producing a login that " +
    "authenticated fine and then got `403 cerbos denied read on portal` on every route — a login " +
    "into an empty portal, which reads as success from the outside. Verified on the live estate " +
    "before and after. It re-asserts the grant for EVERY seeded contact, not only newly created " +
    "ones, so a contact that predates the fix is repaired rather than left quietly broken.",
  "src/testing/fixtures.ts":
    "test-only `grantRole()` helper — its role/scope arguments come from TEST code, never from a " +
    "live request, and the file is never imported by production code. `src/testing/personas.ts` " +
    "calls through this helper rather than writing SQL directly, so it produces no separate hit. " +
    "Routing fixtures through the choke point would make the guards untestable from the inside: " +
    "several suites must SEED exactly the mis-scoped grants the guards refuse.",
};

// ── TRUSTED_INTERNAL callers — files permitted to invoke the choke point with
// `origin: "trusted_internal"`, which runs NO caller-choice validation. This list is the teeth on
// the origin itself: without it, a new writer could route through the service (satisfying the
// sweeps above) and then pick the origin that skips every invariant. Adding a file here is a
// deliberate, reviewed act with a stated reason, exactly like TRUSTED_WRITERS.
const TRUSTED_INTERNAL_CALLERS: Record<string, string> = {
  "src/admin/service-reconciler.ts":
    "role_id resolves ONLY to <module>_staff/<module>_manager via moduleRoleId(), derived from the " +
    "service assignment's OWN module contract — never from request input — and scope_type/scope_id " +
    "are hardcoded 'company'/the served tenant. No caller-chosen role or scope reaches this write.",
  "src/admin/position-reconciler.ts":
    "P2-05 — role_id comes from `position_roles`, a STORED template row guarded at its own write " +
    "time by 0109's position_roles_guard() trigger, never from request input. The scope is derived " +
    "from position_roles.scope_kind, whose CHECK admits only 'company' (-> the position's own " +
    "tenant) and 'own_unit' (-> the position's own unit_node_id) — there is deliberately no " +
    "'global' member, which is the entire structural enforcement of \"a position can never confer " +
    "platform tier\" (design §2.3). No caller-chosen role or scope reaches this write. Its DELETE " +
    "goes through revokeGrantById() under a FOR UPDATE lock plus an in-transaction " +
    "`managed_by_position IS NOT NULL` ownership re-check — see that file's header deviation (1) " +
    "for why the guard is not in the statement, and the standing follow-up to move it there.",
  "src/core/client-contacts.controller.ts":
    "the role is looked up by the LITERAL name 'client' (`WHERE company_id IS NULL AND name = " +
    "'client'`), never by a caller-supplied roleId, and scope_type is hardcoded 'company'/the " +
    "invite's own tenant. A client contact accepting their own portal invite cannot choose a " +
    "different role or scope through it. It is also the ONE legitimate path that puts a principal " +
    "inside the client portal, so it must not take the `ui` origin, whose allow-list and elevated " +
    "fence both exist to keep STAFF roles out of that portal.",
};

describe("P2-04 — every production user_roles write lives in the ONE choke point", () => {
  const files = readAllSources();
  const minters = findMinters(files);
  const deleters = findDeleters(files);
  const repointers = findRepointers(files);

  it("the sweeps actually find writers (a regex that silently matches nothing is not a passing guard)", () => {
    expect(minters.length).toBeGreaterThan(0);
    expect(deleters.length).toBeGreaterThan(0);
    // The choke point itself must be found by BOTH — if it is not, either the service's statements
    // moved out of it (the regression this whole file exists to catch) or the sweep broke.
    expect(minters).toContain(CHOKE_POINT);
    expect(deleters).toContain(CHOKE_POINT);
  });

  it("every file that MINTS a role grant is the choke point, or explicitly TRUSTED with a stated reason", () => {
    for (const file of minters) {
      expect(
        file === CHOKE_POINT || file in TRUSTED_WRITERS,
        `"${file}" INSERTs into user_roles with a role_id column and is NEITHER the choke point ` +
          `(${CHOKE_POINT}) NOR on the TRUSTED allowlist. This is the IAM-SEC-05 defect class: a ` +
          `NEW writer minting a role grant outside the one guarded path. Route it through ` +
          `insertGrantRow() in ${CHOKE_POINT} — picking the origin that matches where the grant ` +
          `comes from — or, ONLY if it does not run in the application's request/consumer path at ` +
          `all (a seed, a fixture), add it to TRUSTED_WRITERS here with the reason why.`,
      ).toBe(true);
    }
  });

  it("every file that DELETES a user_roles row is the choke point, or explicitly TRUSTED", () => {
    for (const file of deleters) {
      expect(
        file === CHOKE_POINT || file in TRUSTED_WRITERS,
        `"${file}" contains a bespoke DELETE FROM user_roles outside ${CHOKE_POINT}. A revoke ` +
          `path written by hand is how the reconciler-ownership guard (AND managed_by IS NOT NULL) ` +
          `or the user_id pin gets forgotten — the first tears down a MANUAL grant, the second lets ` +
          `a grant id be revoked through a mismatched route param. Use revokeGrantById() or ` +
          `revokeManagedGrant().`,
      ).toBe(true);
    }
  });

  it("no file REPOINTS an existing grant at a different role or scope outside the choke point", () => {
    for (const file of repointers) {
      expect(
        file === CHOKE_POINT || file in TRUSTED_WRITERS,
        `"${file}" runs an UPDATE user_roles that assigns role_id / scope_type / scope_id. ` +
          `Re-pointing an existing grant at a different role is the SAME escalation as minting ` +
          `one, and it bypasses every INSERT-shaped guard in this program. Provenance-only ` +
          `updates (managed_by, managed_by_position, expires_at) are fine and are not flagged.`,
      ).toBe(true);
    }
  });

  it("no stale entries: every TRUSTED file listed here is still a writer the sweeps actually find", () => {
    const found = new Set([...minters, ...deleters, ...repointers]);
    for (const file of Object.keys(TRUSTED_WRITERS)) {
      expect(
        [...found],
        `"${file}" is listed as a known user_roles writer in this test, but no sweep finds a write ` +
          `there any more. Either the write path moved/was deleted (remove the stale entry) or a ` +
          `regex needs updating — a stale TRUSTED entry that no longer corresponds to real code ` +
          `hides real coverage loss.`,
      ).toContain(file);
    }
  });

  // ── the origin teeth: `trusted_internal` skips every invariant, so who may ASK for it is pinned
  it("only the named files invoke the choke point with origin: \"trusted_internal\"", () => {
    const callers = files
      .filter((f) => f.path !== CHOKE_POINT && /origin:\s*"trusted_internal"/.test(f.src))
      .map((f) => f.path)
      .sort();
    for (const file of callers) {
      expect(
        file in TRUSTED_INTERNAL_CALLERS,
        `"${file}" calls the choke point with origin: "trusted_internal", which runs NO ` +
          `caller-choice validation — no scope guard, no self-target refusal, no allow-list, no ` +
          `ceiling, no elevated fence. That origin exists only for paths where neither the role ` +
          `NOR the scope can be steered by a caller. If that is genuinely true here, add the file ` +
          `to TRUSTED_INTERNAL_CALLERS with the reason. If it is not, use "legacy_admin" or "ui".`,
      ).toBe(true);
    }
    // and no stale entries in the other direction
    for (const file of Object.keys(TRUSTED_INTERNAL_CALLERS)) {
      expect(
        callers,
        `"${file}" is listed as a trusted-internal caller but no longer uses that origin — remove ` +
          `the stale entry, or the list stops describing the real trust surface.`,
      ).toContain(file);
    }
  });

  // ── per-method teeth-proof on the controller with TWO independent writers ────────────────────
  //
  // A file-level check only proves admin-identity.controller.ts references the choke point
  // SOMEWHERE — it would stay green if `assignRole` routed through it but `inviteUser` (the writer
  // IAM-SEC-05 was actually about) silently regained a bespoke write during some future refactor.
  // This extracts each method's own body and checks each one independently, so THAT regression is
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
   *  a call (`// insertGrantRow(...)`) still satisfies a plain `.toContain()` — proven by
   *  IAM-SEC-07's own teeth-proof, which stayed green against a commented-out call until this
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

  const controllerSrc = () => readFileSync(join(SRC, "admin/admin-identity.controller.ts"), "utf8");

  it("inviteUser's own LIVE (non-comment) body routes its grant through the choke point (the IAM-SEC-05 writer)", () => {
    const body = stripLineComments(extractMethodBody(controllerSrc(), "inviteUser"));
    expect(body).toContain("insertGrantRow(");
    // and still refuses BEFORE any write, so a refusal leaves no half-onboarded user behind
    expect(body).toContain("assertGrantAllowed(");
  });

  it("assignRole's own LIVE (non-comment) body routes its grant through the choke point", () => {
    const body = stripLineComments(extractMethodBody(controllerSrc(), "assignRole"));
    expect(body).toContain("insertGrantRow(");
    expect(body).toContain("assertGrantAllowed(");
  });

  it("revokeRole's own LIVE (non-comment) body routes its delete through the choke point", () => {
    const body = stripLineComments(extractMethodBody(controllerSrc(), "revokeRole"));
    expect(body).toContain("revokeGrantById(");
  });

  it("the choke point still calls the shared scope guard — the IAM-SEC-02/04/05 fix, unmoved", () => {
    const src = stripLineComments(readFileSync(join(ROOT, CHOKE_POINT), "utf8"));
    expect(src).toContain("assertRoleScopeAllowed(");
    expect(src).toContain("assertRoleUiGrantable(");
  });

  // ── TEETH: each sweep is proven to REJECT a planted writer ───────────────────────────────────
  //
  // The suite above is only worth anything if its rejection path actually fires. These feed each
  // classifier a SYNTHETIC source file — the same in-memory-clone discipline
  // `ui-grantable-catalog.test.ts` uses for its catalog pins — and assert the planted writer is
  // found, followed by a REVERT assertion that the real tree is still clean. (The ticket's own
  // end-to-end proof — planting a real file, watching CI go red, removing it — was also performed;
  // this is the version that keeps running forever afterwards.)
  const planted = (sql: string): SourceFile[] => [{ path: "src/modules/evil/backdoor.ts", src: sql }];

  it("TEETH: a planted bespoke INSERT is caught by the mint sweep", () => {
    const hits = findMinters(
      planted("await c.query(`INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id) VALUES ($1,$2,$3,$4,$5)`);"),
    );
    expect(hits).toEqual(["src/modules/evil/backdoor.ts"]);
    expect(hits[0] === CHOKE_POINT || hits[0] in TRUSTED_WRITERS, "and it is classified as an OFFENDER").toBe(false);
  });

  it("TEETH: a planted bespoke DELETE is caught by the revoke sweep", () => {
    const hits = findDeleters(planted("await c.query(`DELETE FROM user_roles WHERE user_id = $1`);"));
    expect(hits).toEqual(["src/modules/evil/backdoor.ts"]);
  });

  it("TEETH: a planted role-repointing UPDATE is caught, and a provenance-only UPDATE is NOT", () => {
    const evil = findRepointers(planted("await c.query(`UPDATE user_roles SET role_id = $2 WHERE id = $1`);"));
    expect(evil).toEqual(["src/modules/evil/backdoor.ts"]);
    // the A14 adoption path's real statement must stay unflagged — a guard that cries wolf on
    // legitimate provenance writes gets weakened by the next person who has to ship past it
    const benign = findRepointers(planted("await c.query(`UPDATE user_roles SET managed_by = NULL WHERE id = $1`);"));
    expect(benign).toEqual([]);
  });

  it("REVERT: the real, checked-in tree still classifies clean under all three sweeps", () => {
    const offenders = [...new Set([...minters, ...deleters, ...repointers])].filter(
      (f) => f !== CHOKE_POINT && !(f in TRUSTED_WRITERS),
    );
    expect(offenders).toEqual([]);
  });
});
