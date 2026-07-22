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

// ---- precise file+line allowlist for the other pre-existing sites (see header comment for
// the reasoning behind each). Line numbers are the line the `withTenants(` TOKEN starts on.
const ALLOWLIST = [
  {
    file: "src/core/core.controller.ts",
    line: 310,
    reason:
      "D12 cross-company rollups read: Cerbos-gated to platform_admin/group_executive only " +
      "(resource_rollup.yaml); tenant array is the platform's own companies table, not client input.",
  },
  {
    file: "src/core/service-scopes.ts",
    line: 42,
    reason:
      "GET /me serviceScopes: tenant array is the CALLER's own held user_roles.scope_id set " +
      "(self-derived — cannot contain a tenant the caller doesn't already hold a role in).",
  },
  {
    file: "src/events/relay.ts",
    line: 33,
    reason:
      "outbox->Redis relay poller: background job, no HTTP principal in scope; needs " +
      "cross-tenant outbox_events access by design instead of bypassing RLS (see file header).",
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

function main() {
  const files = walk(SRC);
  const findings = []; // { file, line, arg }
  const matchedAllowlist = new Set();

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
      const allowEntry = ALLOWLIST.find((a) => a.file === relFile && a.line === line);
      if (allowEntry) {
        matchedAllowlist.add(allowEntry);
        continue;
      }
      findings.push({ file: relFile, line, arg: trimmed });
    }
  }

  const staleAllowlistEntries = ALLOWLIST.filter((a) => !matchedAllowlist.has(a));
  for (const stale of staleAllowlistEntries) {
    console.warn(
      `[lint-withtenants] WARNING: allowlist entry ${stale.file}:${stale.line} did not match any ` +
        `flagged call — the code moved or no longer needs the exception. Update the allowlist.`,
    );
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
