// SM-39 — the egress-inventory test (design addendum §A5, rules B-1..B-4; tracker §6 SM-39). This
// is the DURABLE half of the boundary audit: a shape assertion over the source tree, not a one-time
// reading. It answers one question mechanically, on every future `vitest run`: does every outbound
// network reference anywhere under src/modules/search/ resolve to one of the three approved egress
// classes — (a) a vendor SearchDataProvider driver, dispatched only through dispatchProviderOp
// (B-1), (b) ai-gateway-go via providers/gateway-client.ts (B-2), or (c) the sibling WS8 knowledge
// service via knowledge-client.ts (an internal ERP service, not a vendor and not an AI call —
// see that file's header)?
//
// WHY STATIC ANALYSIS OVER A DYNAMIC TRACE: a dynamic egress capture (monkey-patch global.fetch,
// drive every code path at runtime, assert on captured hosts) only proves what THIS suite's fixtures
// happen to exercise — a rogue call behind an untested branch, or one this suite doesn't drive
// (e.g. a rarely-hit error path), would sail through invisibly. It would also need to re-derive, at
// every run, which call site is "vendor" vs "gateway" vs "rogue" from the captured URL alone — the
// exact classification problem this test instead pins structurally, once, against the SOURCE. A
// static AST walk sees every call site that exists in the code, executed or not, and the "approved
// file" allowlist below is the durable pin: adding a new fetch() anywhere else in this directory
// fails this test by NAME, on the next run, with no fixture required to trip it.
//
// SCOPE: production (non-`.test.ts`) files under src/modules/search/ (this file's own directory and
// its providers/ subdirectory). Test files legitimately reference `fetch`-shaped fakes (mockServer
// helpers, vi.fn stand-ins for `fetchImpl`) that do not originate any real outbound call — including
// them would defeat the point of the test by making its own fixtures the majority of "findings".
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import * as ts from "typescript";

const SEARCH_MODULE_ROOT = __dirname; // this file lives at src/modules/search/egress-inventory.test.ts

/** Bare identifiers that themselves denote a network-call capability, wherever they appear (not
 *  just when immediately invoked) — this deliberately also catches a driver's own
 *  `opts.fetchImpl ?? fetch` default-value handoff, which is where the REAL egress happens even
 *  though the token `fetch` isn't the thing being called at that exact node. Kept broad (not just
 *  `fetch`) so a future contributor reaching for axios/got/XHR/WebSocket to "just get this vendor
 *  call working" trips the same wire as a bare `fetch(`. */
const NETWORK_IDENTIFIERS = new Set(["fetch", "axios", "got", "XMLHttpRequest", "WebSocket", "undici"]);

/** Raw socket/HTTP module specifiers — importing any of these here is itself the violation (this
 *  module has no legitimate reason to build its own HTTP/socket client below the level of `fetch`
 *  or the two sanctioned client files). Checked at the ImportDeclaration level (not as bare
 *  identifiers) because `net`/`http`-shaped local variable names are plausible in a cost/billing
 *  module and would otherwise be a false-positive risk; an import specifier string has none. */
const NETWORK_MODULE_SPECIFIERS = new Set(["http", "https", "net", "tls", "dgram", "dns", "undici", "axios", "got", "node-fetch"]);

/** SearchDataProvider methods that a vendor driver implements (dataforseo.ts/semrush.ts/ahrefs.ts/
 *  simulation.ts/mock-provider.ts) and that dispatch.ts's invokeProvider() is the SOLE caller of
 *  (design §05/B-1: "dispatched only through dispatchProviderOp"). A CALL to one of these outside
 *  dispatch.ts would be a second, unmetered path to a vendor driver's network method. */
const PROVIDER_METHOD_NAMES = new Set(["postSerpTasks", "fetchSerpResults", "getKeywordMetrics", "getBacklinkSummary", "getAiVisibility"]);

/** The ONLY files in this module permitted to reference a network primitive at all, and the
 *  destination class each one is approved for. Exact-set equality below (not "at least these") —
 *  a driver that stops using fetch (or a new one that starts) must update this list DELIBERATELY,
 *  same discipline as this codebase's other shape-pinned allowlists (ledger.test.ts's
 *  GLOBAL_MTD_QUERY_SQL pin, lint-withtenants.mjs's ratified allowlist). */
const APPROVED_EGRESS: Record<string, string> = {
  "providers/gateway-client.ts": "ai-gateway-go (/embed, /complete) — B-2",
  "knowledge-client.ts": "WS8 knowledge service sibling API (/ingest, /search) — internal, not a vendor",
  "providers/dataforseo.ts": "vendor: DataForSEO (config.search.dataforseo.baseUrl)",
  "providers/semrush.ts": "vendor: Semrush (config.search.semrush.baseUrl)",
  "providers/ahrefs.ts": "vendor: Ahrefs (config.search.ahrefs.baseUrl)",
};

/** Each approved egress file's OWN config namespace, and the namespaces it must NEVER reference —
 *  a cross-contamination guard. If dataforseo.ts ever started reading config.services.gateway (or
 *  vice versa), that would be a second cost meter / a driver quietly gaining a second egress
 *  target — exactly the defect class SM-28's re-scope (addendum §A5) was written to prevent. */
const CONFIG_NAMESPACES = [
  "config.services.gateway",
  "config.services.knowledge",
  "config.search.dataforseo",
  "config.search.semrush",
  "config.search.ahrefs",
];
const OWN_NAMESPACE: Record<string, string> = {
  "providers/gateway-client.ts": "config.services.gateway",
  "knowledge-client.ts": "config.services.knowledge",
  "providers/dataforseo.ts": "config.search.dataforseo",
  "providers/semrush.ts": "config.search.semrush",
  "providers/ahrefs.ts": "config.search.ahrefs",
};

interface Finding {
  file: string; // relative to SEARCH_MODULE_ROOT, forward-slash
  line: number;
  snippet: string;
}

function listProductionSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listProductionSourceFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

function toRel(filePath: string): string {
  return relative(SEARCH_MODULE_ROOT, filePath).split("\\").join("/");
}

/** Parses one file's AST and returns every network-primitive reference + every direct call to a
 *  SearchDataProvider method. Uses the TypeScript compiler API (already a devDependency here) rather
 *  than regex/text search specifically so comments and string literals never produce false
 *  positives/negatives — the AST only contains real identifier/call-expression nodes. */
function scanFile(filePath: string): { network: Finding[]; providerMethodCalls: Finding[] } {
  const text = readFileSync(filePath, "utf8");
  const src = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const rel = toRel(filePath);
  const network: Finding[] = [];
  const providerMethodCalls: Finding[] = [];

  function lineOf(node: ts.Node): number {
    return src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1;
  }
  function snippetOf(node: ts.Node): string {
    return src.getFullText().slice(node.getStart(src), node.getEnd()).trim().replace(/\s+/g, " ").slice(0, 140);
  }

  function visit(node: ts.Node) {
    // Bare identifier reference to a network primitive (fetch/axios/got/XHR/WebSocket/undici) —
    // excludes the identifier's own declaration site as a PROPERTY NAME (e.g. `{ fetch: 1 }`, not
    // applicable to any file here today, kept as a safety exclusion so a `fetchImpl` field literally
    // NAMED `fetch` in some future object shape wouldn't misfire this on its declaration).
    if (ts.isIdentifier(node) && NETWORK_IDENTIFIERS.has(node.text)) {
      const parent = node.parent;
      const isDeclNameOnly =
        (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent) || ts.isParameter(parent)) &&
        parent.name === node;
      if (!isDeclNameOnly) {
        network.push({ file: rel, line: lineOf(node), snippet: snippetOf(node.parent ?? node) });
      }
    }
    // Raw socket/HTTP module imports — the specifier text itself is the violation.
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (NETWORK_MODULE_SPECIFIERS.has(node.moduleSpecifier.text)) {
        network.push({ file: rel, line: lineOf(node), snippet: snippetOf(node) });
      }
    }
    // Direct calls to a SearchDataProvider method (`provider.postSerpTasks(...)` etc) — a
    // MethodDeclaration (`async postSerpTasks(...) {`) is a different node kind and never matches
    // isCallExpression, so implementing classes (dataforseo.ts/semrush.ts/ahrefs.ts/simulation.ts/
    // mock-provider.ts) are naturally excluded; only actual invocations are flagged.
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.text;
      if (PROVIDER_METHOD_NAMES.has(name)) {
        providerMethodCalls.push({ file: rel, line: lineOf(node), snippet: snippetOf(node) });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(src);
  return { network, providerMethodCalls };
}

const files = listProductionSourceFiles(SEARCH_MODULE_ROOT);
const perFile = new Map(files.map((f) => [toRel(f), scanFile(f)]));

describe("search module egress inventory (SM-39, design addendum §A5)", () => {
  it("B-1/B-2/B-3: every network-primitive reference in src/modules/search/ is in an approved egress file", () => {
    const offenders: Finding[] = [];
    const approvedFilesSeen = new Set<string>();
    for (const [rel, { network }] of perFile) {
      if (network.length === 0) continue;
      if (APPROVED_EGRESS[rel]) {
        approvedFilesSeen.add(rel);
      } else {
        offenders.push(...network);
      }
    }
    if (offenders.length > 0) {
      const detail = offenders.map((f) => `  ${f.file}:${f.line}  ${f.snippet}`).join("\n");
      throw new Error(
        `Found network-call reference(s) OUTSIDE the approved egress files. Every vendor SEO API call ` +
          `must go through a SearchDataProvider driver via dispatchProviderOp (B-1); every AI call must go ` +
          `through providers/gateway-client.ts (B-2); MCP Hub must never be a client-side transport to a ` +
          `vendor (B-3). Offending reference(s):\n${detail}`,
      );
    }

    // Exact-set equality (not "at least these"): a driver dropping its fetch call, or a new one
    // added, must update APPROVED_EGRESS deliberately — same discipline as this repo's other
    // shape-pinned allowlists (see file header).
    const expected = new Set(Object.keys(APPROVED_EGRESS));
    expect(approvedFilesSeen).toEqual(expected);
  });

  it("B-1: no SearchDataProvider method is invoked anywhere except dispatch.ts's invokeProvider()", () => {
    const offenders: Finding[] = [];
    for (const [rel, { providerMethodCalls }] of perFile) {
      if (rel === "providers/dispatch.ts") continue;
      offenders.push(...providerMethodCalls);
    }
    if (offenders.length > 0) {
      const detail = offenders.map((f) => `  ${f.file}:${f.line}  ${f.snippet}`).join("\n");
      throw new Error(
        `Found a direct call to a SearchDataProvider method outside providers/dispatch.ts — this bypasses ` +
          `the scope/budget/ceiling gates and the ledger (design §05's single money choke-point). ` +
          `Offending call(s):\n${detail}`,
      );
    }
  });

  it("cross-contamination guard: each approved egress file references ONLY its own config namespace", () => {
    for (const [rel, ownNs] of Object.entries(OWN_NAMESPACE)) {
      const text = readFileSync(join(SEARCH_MODULE_ROOT, rel), "utf8");
      expect(text, `${rel} should reference its own config namespace ${ownNs}`).toContain(ownNs);
      for (const other of CONFIG_NAMESPACES) {
        if (other === ownNs) continue;
        expect(text, `${rel} must NOT reference ${other} — that would be a second egress target`).not.toContain(other);
      }
    }
  });

  it("sanity: the scanner actually walked the expected file set (a scanner that finds nothing proves nothing)", () => {
    // Pin the production file count so a future file addition/removal is a deliberate, visible edit
    // to this test rather than a silent expansion of what "everything" means above.
    expect(files.length).toBeGreaterThanOrEqual(19);
    for (const approved of Object.keys(APPROVED_EGRESS)) {
      expect(perFile.has(approved), `expected to find ${approved} under src/modules/search/`).toBe(true);
      expect(perFile.get(approved)!.network.length, `expected ${approved} to actually contain a network reference`).toBeGreaterThan(0);
    }
  });
});
