#!/usr/bin/env node
// A1 (architect-mandated pre-flag): CI lint guarding the withTenants() tenant-scoping
// choke-point (src/db/index.ts). withTenants(tenantIds, fn) is what stamps
// `app.current_tenant_ids` for RLS — every row a query sees is bounded by that array. The
// codebase-wide convention (57 non-test call sites as of this writing) is a SINGLE-ELEMENT
// array literal, e.g. `withTenants([tenantId], ...)` / `withTenants([provider], ...)` /
// `withTenants([row.tenant_id], ...)` — one tenant per call, whatever that one id is has
// already been through authorize()/Cerbos or is read off a row the caller could already see.
// That shape can never WIDEN the RLS scope beyond one tenant, so it needs no special review.
//
// What this lint actually guards against: a call that passes a MULTI-tenant or
// computed/non-literal array (widening RLS to N tenants in one transaction) from a NEW call
// site added without the same scrutiny as the sites already audited and named below. Per the
// architect: service-reconciler.ts is the sanctioned home for this pattern (ORG-6/7 — it
// legitimately writes into both the provider's and target's tenant scope as part of
// materializing/tearing down a service assignment, gated by the propose/accept consent
// handshake + Cerbos `reconcile`/`propose` actions, never by raw client input). Three more
// PRE-EXISTING sites were found by this lint's own sweep of the tree (none of them are the
// reconciler) — each is independently justified below and listed as a real, reported finding
// rather than silently swept in:
//
//   1. src/core/core.controller.ts — GET /rollups (D12, the cross-company rollup read path).
//      Tenant array is "every company id", but the endpoint is Cerbos-gated to
//      platform_admin/group_executive ONLY (cerbos/policies/resource_rollup.yaml) and the id
//      list itself comes from the platform's own `companies` table, never from client input.
//   2. src/core/service-scopes.ts — GET /me's serviceScopes. Tenant array is the CALLER's own
//      held user_roles.scope_id set (managed_by IS NOT NULL rows for THIS userId) — this is
//      MORE principal-derived than a route :tenantId param, not less; it can never contain a
//      tenant the caller doesn't already hold a role in.
//   3. src/events/relay.ts — the outbox->Redis relay poller. Runs with no HTTP principal at
//      all (it's a background job started from main.ts); its own file header documents why it
//      legitimately needs cross-tenant outbox_events access instead of bypassing RLS.
//
// These are captured as explicit, reasoned allowlist entries below (not a blanket bypass) so a
// reviewer sees exactly what was found and why. If you are adding a NEW multi-tenant/computed
// withTenants() call, don't add yourself here — get an architect-approved allowlist entry with
// the same kind of justification as above, or (preferably) refactor into a per-tenant fan-out
// of single-element calls the way service-assignments.controller.ts's envelope endpoints do.
//
// Design notes (why grep/AST-lite, not a real TS parser): the check only needs to classify the
// FIRST argument of each withTenants(...) call as "single-element array literal" (always
// fine) vs. "anything else" (needs an allowlist entry). A depth/string-aware scanner that
// finds the first top-level comma or closing paren is enough for that — no need for a full
// TS AST or a new devDependency.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, ".."); // platform-nest/
const SRC = join(ROOT, "src");

// ---- the reconciler is a blanket-allowed FILE per the architect's mandate: it is the
// sanctioned home for cross-tenant withTenants() calls, present or future. (It happens to only
// use single-element arrays today — see the header comment — so this entry currently allows
// zero findings; it exists so a future multi-tenant call added there doesn't need a new PR
// review of THIS lint.)
const ALLOWED_FILES = new Set(["src/admin/service-reconciler.ts"]);

// ---- content-keyed allowlist for pre-existing sites (see header comment for the reasoning
// behind each). Each entry is keyed by file + normalized tenant-array argument pattern +
// expected match count, so code motion does not break the exemption, while a NEW cross-tenant
// call in the same file WILL be caught (if the count no longer matches).
const ALLOWLIST = [
  {
    file: "src/core/core.controller.ts",
    argPattern: "all",
    maxMatches: 1,
    reason:
      "D12 cross-company rollups read: Cerbos-gated to platform_admin/group_executive only " +
      "(resource_rollup.yaml); tenant array is the platform's own companies table, not client input. " +
      "Must stay READ-ONLY: this is GET /rollups only. The mutating counterpart -- POST " +
      "/:tenantId/rollups/recompute -- is per-tenant (single :tenantId route param, one company's " +
      "rollup_metrics written per call) and does not and must not adopt this multi-tenant array.",
  },
  {
    file: "src/core/service-scopes.ts",
    argPattern: "targetIds",
    maxMatches: 1,
    reason:
      "GET /me serviceScopes: tenant array starts as the CALLER's own held user_roles.scope_id " +
      "set, then is explicitly INTERSECTED with principal.companies (the caller's live company " +
      "memberships) before this call — see the file header's 'Hardening' note. So the array " +
      "passed here is provably a SUBSET of the caller's already-authorized tenant set, closing " +
      "the stale-managed_by-grant GUC-widening gap an architect gate flagged pre-flip.",
  },
  {
    file: "src/events/relay.ts",
    argPattern: "tenantIds",
    maxMatches: 1,
    reason:
      "outbox->Redis relay poller: background job, no HTTP principal in scope; needs " +
      "cross-tenant outbox_events access by design instead of bypassing RLS (see file header).",
  },
  {
    file: "src/modules/search/providers/ledger.ts",
    argPattern: "ids",
    maxMatches: 1,
    reason:
      "SM-04 global provider-spend ceiling (seo-sem-design.md §05): the LAST tier of the dispatch " +
      "stop-loss is a platform-wide monthly cap, so by definition it cannot be computed from one " +
      "tenant. The array is the platform's own companies table (never caller input), the query is a " +
      "single SELECT COALESCE(sum(cost_usd),0) returning ONE SCALAR, and it touches no " +
      "client-private column and returns no rows — same shape as the core.controller.ts D12 rollups " +
      "entry above. Must stay READ-ONLY and aggregate-only. A per-tenant fan-out was rejected " +
      "deliberately: this runs on EVERY paid dispatch, so fanning out would put one query per " +
      "company on the hot money path. RATIFIED at the SM-04 contract gate (2026-07-28). The " +
      "SECURITY DEFINER alternative was also rejected, and for a reason worth keeping: it would " +
      "move the cross-tenant read INTO the database, out of this linter's sight — trading a " +
      "reviewed, visible exception for an invisible one. Ratification is conditional on the " +
      "read-only/aggregate-only shape above; widening this callback to select rows needs a new " +
      "gate, not an edit. Related: dispatch.ts fails CLOSED when this aggregate throws " +
      "(GlobalCeilingUnavailableError) — it must never degrade to a $0 month-to-date, which would " +
      "silently disable the platform ceiling this query exists to enforce. Content-keyed per " +
      "SM-43 (2026-07-29): re-keying from line-based to pattern-based to prevent silent " +
      "mismatches when file edits shift the line number. The query text itself is exported " +
      "GLOBAL_MTD_QUERY_SQL constant, shape-pinned by ledger.test.ts so a future widening fails a " +
      "test rather than only this lint. The ceiling is mode-filtered per addendum §A4.1 — the " +
      "query uses PARAMETERIZED `AND simulated = $1` (never interpolated) and the TTL cache is " +
      "keyed per mode, so simulated and real spend bind their own disjoint ledgers. The ratified " +
      "shape is unchanged and still pinned: ONE scalar aggregate column, read-only, single " +
      "statement, no client-private column. Nothing about the cross-tenant exposure changed — the " +
      "array is still the companies table and the result is still one number.",
  },
  {
    file: "src/modules/search/providers/ledger.ts",
    argPattern: "companyIds",
    maxMatches: 1,
    reason:
      "SM-40 per-provider monthly ceiling (design addendum §A3.5): a SECOND cross-tenant aggregate " +
      "in this file, sumProviderMonthToDate(), for the new 'provider' tier of the dispatch stop-loss " +
      "cascade (engagement -> tenant -> provider -> global). Structurally identical to the ratified " +
      "sumGlobalMonthToDate() entry immediately above -- same companies-table source (never caller " +
      "input), same single COALESCE(sum(cost_usd),0) scalar aggregate, same read-only/no-row shape, " +
      "same reason a per-tenant fan-out was rejected (this also runs pre-lock, on the hot money " +
      "path, for every dispatch to a provider that HAS a configured cap) -- but a DELIBERATELY " +
      "DIFFERENT variable name (companyIds, not ids) so this entry cannot silently inherit the " +
      "other call's ratification or inflate its match count; SM-43's content-keyed scheme is " +
      "designed to catch exactly this pattern with its own entry, not a shared one. Query text is " +
      "the exported PROVIDER_MTD_QUERY_SQL constant, shape-pinned by ledger.test.ts the same way " +
      "GLOBAL_MTD_QUERY_SQL is (structure anchored, not a table-name token, per the §6d lesson). " +
      "Mode-filtered AND provider-filtered per addendum §A4.1/§A3.5 -- both predicates PARAMETERIZED " +
      "(`AND simulated = $1 AND provider = $2`), never interpolated; the TTL cache is keyed per " +
      "(provider, mode) for the same reason the global cache is keyed per mode (a shared slot would " +
      "let one vendor's dispatch be evaluated against another vendor's -- or the other mode's -- " +
      "month-to-date for up to the TTL window). Fails CLOSED on the identical §4d reasoning: " +
      "dispatch.ts throws ProviderCeilingUnavailableError rather than degrading to a $0 " +
      "month-to-date if this aggregate throws. Ratification is conditional on the same " +
      "read-only/aggregate-only shape as the entry above; widening this callback to select rows " +
      "needs a new gate, not an edit.",
  },
];

function walk(dir, out = []) {
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
  return out;
}

/** From `src[start]` (expected to be right after the opening `(` of the call), scan forward
 *  string/nesting-aware and return the source text of the FIRST top-level argument, i.e. up to
 *  the first depth-0 `,` or the call's closing `)`. Depth is tracked uniformly across
 *  (), [], {} — we only need the boundary, not a real parse tree. */
function extractFirstArg(src, start) {
  let i = start;
  let depth = 0;
  let inStr = null; // one of ' " ` while inside a string/template literal
  const argStart = i;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (ch === "\\") { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { inStr = ch; continue; }
    if (ch === "(" || ch === "[" || ch === "{") { depth++; continue; }
    if (ch === ")") {
      if (depth === 0) return src.slice(argStart, i);
      depth--;
      continue;
    }
    if (ch === "]" || ch === "}") { depth--; continue; }
    if (ch === "," && depth === 0) return src.slice(argStart, i);
  }
  return null; // malformed / unterminated — treat as a parse failure upstream
}

/** Count top-level elements of an array literal's inner content (already stripped of the outer
 *  `[` `]`). Same depth/string-aware scan, just counting depth-0 commas + 1. Empty content -> 0. */
function countTopLevelElements(inner) {
  const trimmed = inner.trim();
  if (trimmed === "") return 0;
  let depth = 0;
  let inStr = null;
  let commas = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inStr) {
      if (ch === "\\") { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { inStr = ch; continue; }
    if (ch === "(" || ch === "[" || ch === "{") { depth++; continue; }
    if (ch === ")" || ch === "]" || ch === "}") { depth--; continue; }
    if (ch === "," && depth === 0) commas++;
  }
  return commas + 1;
}

function lineOf(src, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (src[i] === "\n") line++;
  return line;
}

function isCommentReference(src, matchIndex) {
  const lineStart = src.lastIndexOf("\n", matchIndex) + 1;
  const prefix = src.slice(lineStart, matchIndex);
  return prefix.includes("//");
}

function normalizePattern(arg) {
  // Normalize whitespace in the argument for consistent matching, but preserve
  // the essential structure so different args don't collide (e.g., 'all' vs 'all.filter(...)').
  // This handles simple variable names and small transformations, but NOT complex expressions.
  return arg.trim();
}

function main() {
  const files = walk(SRC);
  const findings = []; // { file, line, arg }
  const allowlistMatchCounts = new Map(); // keyed by allowlist entry, counts how many times matched

  // Initialize match counters for each allowlist entry
  for (const entry of ALLOWLIST) {
    const key = `${entry.file}#${entry.argPattern}`;
    allowlistMatchCounts.set(key, 0);
  }

  for (const abs of files) {
    const relFile = relative(ROOT, abs).split("\\").join("/");
    const src = readFileSync(abs, "utf8");
    const re = /\bwithTenants\s*\(/g;
    let m;
    while ((m = re.exec(src))) {
      const matchIndex = m.index;
      if (isCommentReference(src, matchIndex)) continue;
      const openParenIdx = matchIndex + m[0].length - 1; // index of the '('
      const arg = extractFirstArg(src, openParenIdx + 1);
      if (arg === null) {
        findings.push({ file: relFile, line: lineOf(src, matchIndex), arg: "<unparseable>", reason: "could not parse call arguments" });
        continue;
      }
      const trimmed = arg.trim();
      let safe = false;
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        const inner = trimmed.slice(1, -1);
        safe = countTopLevelElements(inner) === 1;
      }
      if (safe) continue;

      if (ALLOWED_FILES.has(relFile)) continue;

      const line = lineOf(src, matchIndex);
      const normalized = normalizePattern(trimmed);

      // Try to find a matching allowlist entry
      const allowEntry = ALLOWLIST.find((a) => a.file === relFile && normalizePattern(a.argPattern) === normalized);
      if (allowEntry) {
        const key = `${allowEntry.file}#${allowEntry.argPattern}`;
        allowlistMatchCounts.set(key, (allowlistMatchCounts.get(key) || 0) + 1);
        continue;
      }
      findings.push({ file: relFile, line, arg: trimmed });
    }
  }

  // Check for stale or mismatched allowlist entries (count doesn't match expected)
  const staleOrMismatched = [];
  for (const entry of ALLOWLIST) {
    const key = `${entry.file}#${entry.argPattern}`;
    const actualCount = allowlistMatchCounts.get(key) || 0;
    if (actualCount === 0) {
      staleOrMismatched.push({ entry, reason: "did not match any flagged call" });
    } else if (actualCount !== entry.maxMatches) {
      staleOrMismatched.push({
        entry,
        reason: `expected ${entry.maxMatches} match(es), but found ${actualCount}`
      });
    }
  }

  // SM-43 follow-up: a count mismatch is a FAILURE, not a warning. This is the single load-bearing
  // check in the content-keyed scheme. Line-keying identified exactly one call; content-keying
  // matches by (file, argument source text), which is intentionally position-independent — so a
  // SECOND cross-tenant call in the same file reusing the same variable name (`ids`, `all`,
  // `tenantIds` — all short and eminently reusable) would be matched by the same entry and silently
  // inherit a ratified exemption it was never reviewed for. `maxMatches` is what bounds that, and a
  // bound that only prints to stderr while the process exits 0 is not a bound: CI passes, nobody
  // reads the log, and the exemption has quietly widened. Failing here is also right for the stale
  // (count 0) case — these entries are architect-ratified security exceptions, so one that no longer
  // matches any call is an exemption granted to nothing, and deleting it is the correct response
  // rather than leaving it lying around to be re-pointed at some future call by accident.
  if (staleOrMismatched.length > 0) {
    console.error(
      `[lint-withtenants] FAIL: ${staleOrMismatched.length} allowlist entr(ies) do not match the code ` +
        `exactly as ratified.\n`,
    );
    for (const { entry, reason } of staleOrMismatched) {
      console.error(`  ${entry.file} (pattern: ${entry.argPattern}) — ${reason}`);
    }
    console.error(
      "\nAn allowlist entry is an architect-ratified exception to the one-tenant-per-call rule, so it " +
        "must correspond to exactly the call(s) that were reviewed. If a NEW cross-tenant call appeared " +
        "in one of these files, it needs its own review — it does not inherit this entry's ratification " +
        "just because it happens to use the same variable name. If the reviewed call is gone, delete " +
        "the entry.",
    );
    process.exit(1);
  }

  if (findings.length > 0) {
    console.error(
      `[lint-withtenants] FAIL: ${findings.length} withTenants() call(s) pass a non-single-element ` +
        `tenant argument without an allowlist entry. Every OTHER call site in platform-nest passes a ` +
        `single-element array (one tenant per call, cannot widen RLS scope); the reconciler ` +
        `(src/admin/service-reconciler.ts) is the only file exempt from that rule by architect mandate.\n`,
    );
    for (const f of findings) {
      console.error(`  ${f.file}:${f.line}  withTenants(${f.arg}${f.arg.length > 60 ? "…" : ""}`);
    }
    console.error(
      "\nEither refactor to a single-element withTenants([...]) per tenant (see " +
        "service-assignments.controller.ts's envelope fan-out for the pattern), or get an " +
        "architect-approved allowlist entry in scripts/lint-withtenants.mjs with the same kind " +
        "of justification as the existing entries.",
    );
    process.exit(1);
  }

  console.log(
    `[lint-withtenants] OK — scanned ${files.length} files; all withTenants() calls are ` +
      `single-tenant, or an explicitly reasoned allowlist entry.`,
  );
}

main();
